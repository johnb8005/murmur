//! Link previews from a page's meta tags: og:title, og:description, og:image, og:site_name, with
//! the first visible paragraph as a fallback description. The og:image is copied to R2 so the card
//! outlives the source. No browser: a page that declares no image gets a text card.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use anyhow::Result;
use futures_util::StreamExt;
use scraper::{Html, Selector};
use sha1::Digest;

use crate::app::App;
use crate::db::{opt, placeholders, v};
use crate::links::{Preview, clip, host, now_iso};

const META_TIMEOUT: Duration = Duration::from_secs(12);
const IMAGE_TIMEOUT: Duration = Duration::from_secs(15);
const HTML_MAX_BYTES: usize = 5_000_000;
const IMAGE_MAX_BYTES: usize = 5_000_000;
const EXCERPT_CHARS: usize = 300;
const RETRY_FAILED_AFTER_MS: i64 = 24 * 3_600_000;
pub const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 links-feed/1.0";

pub fn preview_hash(url: &str) -> String {
    format!("{:x}", sha1::Sha1::digest(url.as_bytes()))[..12].to_string()
}

struct MetaTags {
    title: Option<String>,
    description: Option<String>,
    excerpt: Option<String>,
    image: Option<String>,
    site_name: Option<String>,
}

/// Reads a response body up to `max` bytes; None when it is longer or the read fails.
async fn body_capped(res: reqwest::Response, max: usize) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.ok()?;
        if out.len() + chunk.len() > max {
            return None;
        }
        out.extend_from_slice(&chunk);
    }
    Some(out)
}

/// Visible text under `root`, skipping navigation and scripts, up to about 2000 characters.
fn visible_text(root: scraper::ElementRef, out: &mut String) {
    const NOISE: [&str; 10] = [
        "script", "style", "noscript", "nav", "header", "footer", "aside", "svg", "template",
        "iframe",
    ];
    for child in root.children() {
        if out.len() > 2000 {
            return;
        }
        if let Some(el) = scraper::ElementRef::wrap(child) {
            if NOISE.contains(&el.value().name()) || el.value().attr("aria-hidden") == Some("true")
            {
                continue;
            }
            visible_text(el, out);
        } else if let Some(t) = child.value().as_text() {
            let s = t.split_whitespace().collect::<Vec<_>>().join(" ");
            if !s.is_empty() {
                if !out.is_empty() {
                    out.push(' ');
                }
                out.push_str(&s);
            }
        }
    }
}

fn parse_meta(html: &str) -> MetaTags {
    let doc = Html::parse_document(html);
    let mut found: HashMap<String, String> = HashMap::new();
    let meta = Selector::parse("meta").unwrap();
    for el in doc.select(&meta) {
        let key = el
            .value()
            .attr("property")
            .or_else(|| el.value().attr("name"));
        let content = el.value().attr("content");
        if let (Some(k), Some(c)) = (key, content) {
            let k = k.to_lowercase();
            let c = c.trim();
            if !c.is_empty() {
                found.entry(k).or_insert_with(|| c.to_string());
            }
        }
    }
    let pick = |keys: &[&str]| keys.iter().find_map(|k| found.get(*k).cloned());
    let title_tag = Selector::parse("title").unwrap();
    let title_text = doc
        .select(&title_tag)
        .next()
        .map(|t| t.text().collect::<String>().trim().to_string())
        .filter(|t| !t.is_empty());
    let main_sel = Selector::parse("main, article, [role=main]").unwrap();
    let body_sel = Selector::parse("body").unwrap();
    let mut text = String::new();
    if let Some(root) = doc
        .select(&main_sel)
        .next()
        .or_else(|| doc.select(&body_sel).next())
    {
        visible_text(root, &mut text);
    }
    MetaTags {
        title: pick(&["og:title", "twitter:title"]).or(title_text),
        description: pick(&["og:description", "twitter:description", "description"]),
        excerpt: (!text.is_empty()).then(|| clip(&text, EXCERPT_CHARS)),
        image: pick(&[
            "og:image",
            "og:image:url",
            "og:image:secure_url",
            "twitter:image",
            "twitter:image:src",
        ]),
        site_name: pick(&["og:site_name"]),
    }
}

/// Fetch the html and read its meta tags. Err with a short reason when the page can't be read.
async fn fetch_meta_tags(app: &App, url: &str) -> std::result::Result<(MetaTags, String), String> {
    let res = app
        .http
        .get(url)
        .header("user-agent", UA)
        .header("accept", "text/html,application/xhtml+xml")
        .timeout(META_TIMEOUT)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "timeout".to_string()
            } else {
                e.to_string()
                    .lines()
                    .next()
                    .unwrap_or("fetch failed")
                    .to_string()
            }
        })?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status().as_u16()));
    }
    let ct = res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if !ct.contains("text/html") && !ct.contains("xhtml") {
        return Err(format!(
            "not html ({})",
            ct.split(';').next().unwrap_or("").trim()
        ));
    }
    let final_url = res.url().to_string();
    let body = body_capped(res, HTML_MAX_BYTES)
        .await
        .ok_or_else(|| "page too large".to_string())?;
    let html = String::from_utf8_lossy(&body).into_owned();
    Ok((parse_meta(&html), final_url))
}

/// Pull down the og:image and put it in R2. Failure here is not preview failure: the remote url is
/// still stored as a fallback.
async fn store_remote_image(app: &App, url: &str, image_url: &str) -> Option<(String, String)> {
    let r2 = app.r2.as_ref()?;
    let res = app
        .http
        .get(image_url)
        .header("user-agent", UA)
        .header("referer", url)
        .timeout(IMAGE_TIMEOUT)
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let kind = res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if !kind.starts_with("image/") {
        return None;
    }
    let bytes = body_capped(res, IMAGE_MAX_BYTES).await?;
    if bytes.is_empty() {
        return None;
    }
    let key = r2
        .put(&format!("previews/{}", preview_hash(url)), &bytes, &kind)
        .await?;
    Some((key, kind))
}

struct Captured {
    title: Option<String>,
    description: Option<String>,
    excerpt: Option<String>,
    image: Option<String>,
    site_name: Option<String>,
    image_key: Option<String>,
    image_type: Option<String>,
    error: Option<String>,
}

async fn capture(app: &App, url: &str) -> Captured {
    match fetch_meta_tags(app, url).await {
        Ok((tags, final_url)) => {
            let image = tags
                .image
                .as_ref()
                .and_then(|i| url::Url::parse(&final_url).ok()?.join(i).ok())
                .map(|u| u.to_string());
            let stored = match &image {
                Some(i) => store_remote_image(app, url, i).await,
                None => None,
            };
            Captured {
                title: tags.title.map(|t| clip(&t, 200)),
                description: tags.description.map(|d| clip(&d, 300)),
                excerpt: tags.excerpt,
                image,
                site_name: tags.site_name.or_else(|| Some(host(url))),
                image_key: stored.as_ref().map(|s| s.0.clone()),
                image_type: stored.map(|s| s.1),
                error: None,
            }
        }
        Err(e) => Captured {
            title: None,
            description: None,
            excerpt: None,
            image: None,
            site_name: None,
            image_key: None,
            image_type: None,
            error: Some(e),
        },
    }
}

/// Fetch (or re-fetch) the preview for one url and store it. Returns the error, if any.
pub async fn refresh_preview(app: &App, url: &str) -> Result<Option<String>> {
    let c = capture(app, url).await;
    app.db
        .exec(
            "INSERT INTO previews (url, hash, title, description, excerpt, image, site_name, screenshot, image_key, image_type, error, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
             ON CONFLICT(url) DO UPDATE SET
               title = excluded.title, description = excluded.description, excerpt = excluded.excerpt,
               image = excluded.image, site_name = excluded.site_name,
               image_key = COALESCE(excluded.image_key, previews.image_key),
               image_type = COALESCE(excluded.image_type, previews.image_type),
               error = excluded.error, fetched_at = excluded.fetched_at",
            vec![
                v(url),
                v(preview_hash(url)),
                opt(c.title),
                opt(c.description),
                opt(c.excerpt),
                opt(c.image),
                opt(c.site_name),
                opt(c.image_key),
                opt(c.image_type),
                opt(c.error.clone()),
                v(now_iso()),
            ],
        )
        .await?;
    Ok(c.error)
}

/// Fetch previews for urls that have none yet (or whose last attempt failed more than a day ago).
pub async fn ensure_previews(
    app: &App,
    urls: &[String],
) -> Result<HashMap<String, Option<String>>> {
    let mut seen = HashSet::new();
    let unique: Vec<String> = urls
        .iter()
        .filter(|u| seen.insert((*u).clone()))
        .cloned()
        .collect();
    let mut result = HashMap::new();
    if unique.is_empty() {
        return Ok(result);
    }
    let rows = app
        .db
        .query(
            &format!(
                "SELECT url, error, fetched_at FROM previews WHERE url IN ({})",
                placeholders(unique.len())
            ),
            unique.iter().map(|u| v(u.clone())).collect(),
        )
        .await?;
    let known: HashMap<String, (Option<String>, String)> = rows
        .iter()
        .map(|r| (r.req("url"), (r.str("error"), r.req("fetched_at"))))
        .collect();
    let now = chrono::Utc::now();
    for url in unique {
        if let Some((error, fetched_at)) = known.get(&url) {
            let fresh = chrono::DateTime::parse_from_rfc3339(fetched_at)
                .map(|t| {
                    (now - t.with_timezone(&chrono::Utc)).num_milliseconds() < RETRY_FAILED_AFTER_MS
                })
                .unwrap_or(false);
            if error.is_none() || fresh {
                result.insert(url, error.clone());
                continue;
            }
        }
        let err = refresh_preview(app, &url).await?;
        result.insert(url, err);
    }
    Ok(result)
}

/// Previews for many urls, keyed by url, shaped for the client and the feeds.
pub async fn previews_for(app: &App, urls: &[String]) -> Result<HashMap<String, Preview>> {
    let mut seen = HashSet::new();
    let unique: Vec<String> = urls
        .iter()
        .filter(|u| seen.insert((*u).clone()))
        .cloned()
        .collect();
    let mut out = HashMap::new();
    if unique.is_empty() {
        return Ok(out);
    }
    let rows = app
        .db
        .query(
            &format!(
                "SELECT url, hash, title, description, excerpt, image, site_name, image_key, (screenshot IS NOT NULL) AS has_shot, error
                 FROM previews WHERE url IN ({})",
                placeholders(unique.len())
            ),
            unique.iter().map(|u| v(u.clone())).collect(),
        )
        .await?;
    for r in rows {
        if r.str("error").is_some() {
            continue;
        }
        // Our own R2 copy first, so the card outlives the source. Then the site's og:image. The
        // Turso blob is last: a screenshot from before the og:image change.
        let image = if r.str("image_key").is_some() {
            Some(format!("/previews/{}.jpg", r.req("hash")))
        } else if let Some(i) = r.str("image") {
            Some(i)
        } else if r.num("has_shot") > 0 {
            Some(format!("/previews/{}.jpg", r.req("hash")))
        } else {
            None
        };
        out.insert(
            r.req("url"),
            Preview {
                title: r.str("title"),
                description: r.str("description").or_else(|| r.str("excerpt")),
                image,
                site_name: r.str("site_name"),
            },
        );
    }
    Ok(out)
}

pub async fn screenshot_by_hash(app: &App, hash: &str) -> Result<Option<(Vec<u8>, String)>> {
    let row = match app
        .db
        .one(
            "SELECT screenshot, image_key, image_type FROM previews WHERE hash = ?",
            vec![v(hash)],
        )
        .await?
    {
        Some(r) => r,
        None => return Ok(None),
    };
    if let (Some(key), Some(r2)) = (row.str("image_key"), app.r2.as_ref())
        && let Some((bytes, kind)) = r2.get(&key).await
    {
        return Ok(Some((bytes, row.str("image_type").unwrap_or(kind))));
    }
    Ok(row
        .blob("screenshot")
        .map(|b| (b, "image/jpeg".to_string())))
}

/// Drop previews no post references any more.
pub async fn prune_previews(app: &App) -> Result<()> {
    app.db
        .exec(
            "DELETE FROM previews WHERE url NOT IN (SELECT link FROM posts WHERE link IS NOT NULL)
                                   AND url NOT IN (SELECT ref FROM posts WHERE ref IS NOT NULL)",
            vec![],
        )
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meta_tags_and_excerpt() {
        let html = r#"<html><head><title>Fallback &amp; title</title>
          <meta property="og:title" content="Fermat&#x27;s Last Theorem">
          <meta name="description" content="A theorem.">
          <meta property="og:image" content="/pic.jpg"></head>
          <body><nav>Menu</nav><main><script>x()</script><p>First  para.</p><aside>no</aside><p>Second.</p></main></body></html>"#;
        let m = parse_meta(html);
        assert_eq!(m.title.as_deref(), Some("Fermat's Last Theorem"));
        assert_eq!(m.description.as_deref(), Some("A theorem."));
        assert_eq!(m.image.as_deref(), Some("/pic.jpg"));
        assert_eq!(m.excerpt.as_deref(), Some("First para. Second."));
        assert_eq!(preview_hash("https://x.y").len(), 12);
    }
}
