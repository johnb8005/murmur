//! The post model, link extraction, tag normalization and the feed generators: the Rust side of
//! `shared/links.ts`. The client keeps the TypeScript copy for tag highlighting and the composer,
//! so `normalize_tag` and `extract_links` must agree with it.

use std::collections::HashSet;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use specta::Type;

pub const APP_NAME: &str = "Murmur";
pub const POST_MAX: usize = 500;
pub const COMMENT_MAX: usize = 500;
pub const TAG_MAX: usize = 30;
pub const TAGS_MAX: usize = 10;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Author {
    pub id: String,
    pub username: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub title: Option<String>,
    pub description: Option<String>,
    /// site-relative (/previews/<hash>.jpg) or absolute (og:image)
    pub image: Option<String>,
    pub site_name: Option<String>,
}

/// A picture attached to a post, served by the app (members only, like previews).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PostImage {
    /// site-relative: /images/<post id>
    pub src: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Post {
    pub id: String,
    pub text: String,
    /// first URL in the text: gets a preview card
    pub link: Option<String>,
    /// second URL, if any
    #[serde(rename = "ref")]
    pub reference: Option<String>,
    /// the picture, if one was attached
    pub image: Option<PostImage>,
    /// labels: the #hashtags in the text plus any set separately, normalized
    pub tags: Vec<String>,
    /// only the author sees it
    pub private: bool,
    pub created_at: String,
    pub author: Author,
    pub preview: Option<Preview>,
    pub ref_preview: Option<Preview>,
    pub likes: u32,
    pub comments: u32,
    pub liked_by_me: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub post_id: String,
    pub text: String,
    pub created_at: String,
    pub author: Author,
}

pub struct FeedOptions<'a> {
    pub site_url: &'a str,
    pub title: &'a str,
    pub description: &'a str,
    /// the reader's feed token: feeds and preview images need an account, so it rides along in the URLs
    pub token: Option<&'a str>,
}

// ---------- links ----------

static URL_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r#"(?i)https?://[^\s<>"')\]]+"#).unwrap());

fn strip_trailing_punct(u: &str) -> &str {
    u.trim_end_matches(['.', ',', ';', ':', '!', '?'])
}

/// The links in a post's text: first is the main link (previewed), second the ref.
pub fn extract_links(text: &str) -> (Option<String>, Option<String>) {
    let mut seen = HashSet::new();
    let mut urls = Vec::new();
    for m in URL_RE.find_iter(text) {
        let u = strip_trailing_punct(m.as_str()).to_string();
        if seen.insert(u.clone()) {
            urls.push(u);
        }
    }
    let mut it = urls.into_iter();
    (it.next(), it.next())
}

// ---------- tags ----------

static TAG_CHARS: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[\p{L}\p{N}_-]+$").unwrap());
static ONLY_PUNCT: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[_-]+$").unwrap());
/// A #tag in text. Not preceded by a word character, `&`, `/` or `#`, so URL fragments and `&#x27;` don't count.
static HASHTAG_RE: LazyLock<fancy_regex::Regex> =
    LazyLock::new(|| fancy_regex::Regex::new(r"(?<![\p{L}\p{N}_&/#])#([\p{L}\p{N}_-]+)").unwrap());

/// Lower-cased, without the leading #; None when it isn't a usable tag.
pub fn normalize_tag(raw: &str) -> Option<String> {
    let t = raw.trim().trim_start_matches('#').to_lowercase();
    if t.is_empty()
        || t.chars().count() > TAG_MAX
        || !TAG_CHARS.is_match(&t)
        || ONLY_PUNCT.is_match(&t)
    {
        return None;
    }
    Some(t)
}

fn unique_tags(tags: impl IntoIterator<Item = Option<String>>) -> Vec<String> {
    let mut seen = HashSet::new();
    tags.into_iter()
        .flatten()
        .filter(|t| seen.insert(t.clone()))
        .take(TAGS_MAX)
        .collect()
}

/// The #hashtags in a post's text (URLs are skipped), in order of appearance.
pub fn extract_tags(text: &str) -> Vec<String> {
    let without_urls = URL_RE.replace_all(text, " ");
    unique_tags(
        HASHTAG_RE
            .captures_iter(&without_urls)
            .filter_map(|c| c.ok())
            .map(|c| normalize_tag(c.get(1).map(|m| m.as_str()).unwrap_or(""))),
    )
}

/// Everything a post is labelled with: hashtags in the text first, then the separate list; at most TAGS_MAX.
pub fn post_tags(text: &str, extra: &[String]) -> Vec<String> {
    unique_tags(
        extract_tags(text)
            .into_iter()
            .map(Some)
            .chain(extra.iter().map(|t| normalize_tag(t))),
    )
}

pub fn host(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| {
            u.host_str()
                .map(|h| h.trim_start_matches("www.").to_string())
        })
        .unwrap_or_else(|| url.to_string())
}

pub fn permalink(site_url: &str, id: &str) -> String {
    format!("{site_url}/p/{id}")
}

// ---------- feeds ----------

pub fn escape_xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '\'' => out.push_str("&apos;"),
            '"' => out.push_str("&quot;"),
            c => out.push(c),
        }
    }
    out
}

pub fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            c => out.push(c),
        }
    }
    out
}

fn token_query(token: Option<&str>) -> String {
    token
        .map(|t| format!("?token={}", urlencode(t)))
        .unwrap_or_default()
}

pub fn urlencode(s: &str) -> String {
    percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string()
}

fn absolute(opts: &FeedOptions, src: &str) -> String {
    if src.starts_with('/') {
        format!("{}{}{}", opts.site_url, src, token_query(opts.token))
    } else {
        src.to_string()
    }
}

fn feed_url(opts: &FeedOptions, file: &str) -> String {
    format!("{}/{}{}", opts.site_url, file, token_query(opts.token))
}

/// First N chars with an ellipsis when cut (like `s.slice(0, n - 1) + "…"` in the TS).
pub fn clip(s: &str, n: usize) -> String {
    if s.chars().count() > n {
        let cut: String = s.chars().take(n - 1).collect();
        format!("{}…", cut.trim_end())
    } else {
        s.to_string()
    }
}

pub fn item_title(p: &Post) -> String {
    let first = p.text.lines().next().unwrap_or("").trim();
    let t = if first.chars().count() > 90 {
        format!("{}…", first.chars().take(87).collect::<String>().trim_end())
    } else {
        first.to_string()
    };
    if !t.is_empty() {
        return t;
    }
    if let Some(title) = p.preview.as_ref().and_then(|v| v.title.clone()) {
        return title;
    }
    if let Some(link) = &p.link {
        return host(link);
    }
    if p.image.is_some() {
        return format!("A picture from @{}", p.author.username);
    }
    format!("@{}", p.author.username)
}

fn item_html(p: &Post, opts: &FeedOptions) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !p.text.is_empty() {
        parts.push(format!(
            "<p>{}</p>",
            escape_html(&p.text).replace('\n', "<br>")
        ));
    }
    if let Some(img) = &p.image {
        parts.push(format!(
            r#"<p><img src="{}" width="{}" height="{}" alt=""></p>"#,
            escape_html(&absolute(opts, &img.src)),
            img.width,
            img.height
        ));
    }
    if let Some(link) = &p.link {
        let t = p
            .preview
            .as_ref()
            .and_then(|v| v.title.clone())
            .unwrap_or_else(|| host(link));
        let desc = p
            .preview
            .as_ref()
            .and_then(|v| v.description.as_ref())
            .map(|d| format!("<br>{}", escape_html(d)))
            .unwrap_or_default();
        parts.push(format!(
            r#"<p><a href="{}"><strong>{}</strong></a>{}<br><small>{}</small></p>"#,
            escape_html(link),
            escape_html(&t),
            desc,
            escape_html(&host(link))
        ));
        if let Some(image) = p.preview.as_ref().and_then(|v| v.image.as_ref()) {
            parts.push(format!(
                r#"<p><a href="{}"><img src="{}" alt=""></a></p>"#,
                escape_html(link),
                escape_html(&absolute(opts, image))
            ));
        }
    }
    parts.push(format!(
        r#"<p><small>@{} · <a href="{}">{} likes, {} comments</a></small></p>"#,
        escape_html(&p.author.username),
        escape_html(&permalink(opts.site_url, &p.id)),
        p.likes,
        p.comments
    ));
    parts.join("\n")
}

fn rfc2822(iso: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(iso)
        .map(|d| {
            d.with_timezone(&chrono::Utc)
                .format("%a, %d %b %Y %H:%M:%S GMT")
                .to_string()
        })
        .unwrap_or_else(|_| iso.to_string())
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn to_rss(posts: &[Post], opts: &FeedOptions) -> String {
    let items: Vec<String> = posts
        .iter()
        .map(|p| {
            let link = escape_xml(&permalink(opts.site_url, &p.id));
            let cats: String = p.tags.iter().map(|t| format!("      <category>{}</category>\n", escape_xml(t))).collect();
            let enclosure = p
                .image
                .as_ref()
                .map(|img| format!("      <enclosure url=\"{}\" type=\"{}\" length=\"0\" />\n", escape_xml(&absolute(opts, &img.src)), escape_xml(&img.kind)))
                .unwrap_or_default();
            format!(
                "    <item>\n      <title>{}</title>\n      <link>{}</link>\n      <guid isPermaLink=\"true\">{}</guid>\n      <dc:creator>{}</dc:creator>\n{}      <pubDate>{}</pubDate>\n{}      <description><![CDATA[{}]]></description>\n    </item>",
                escape_xml(&item_title(p)),
                link,
                link,
                escape_xml(&p.author.display_name),
                cats,
                rfc2822(&p.created_at),
                enclosure,
                item_html(p, opts)
            )
        })
        .collect();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<rss version=\"2.0\" xmlns:atom=\"http://www.w3.org/2005/Atom\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\">\n  <channel>\n    <title>{}</title>\n    <link>{}/</link>\n    <atom:link href=\"{}\" rel=\"self\" type=\"application/rss+xml\" />\n    <description>{}</description>\n    <language>en</language>\n    <lastBuildDate>{}</lastBuildDate>\n{}\n  </channel>\n</rss>\n",
        escape_xml(opts.title),
        escape_xml(opts.site_url),
        escape_xml(&feed_url(opts, "feed.xml")),
        escape_xml(opts.description),
        chrono::Utc::now().format("%a, %d %b %Y %H:%M:%S GMT"),
        items.join("\n")
    )
}

pub fn to_json_feed(posts: &[Post], opts: &FeedOptions) -> String {
    let items: Vec<serde_json::Value> = posts
        .iter()
        .map(|p| {
            let mut item = serde_json::Map::new();
            let url = permalink(opts.site_url, &p.id);
            item.insert("id".into(), url.clone().into());
            item.insert("url".into(), url.into());
            if let Some(link) = &p.link {
                item.insert("external_url".into(), link.clone().into());
            }
            item.insert("title".into(), item_title(p).into());
            item.insert("content_html".into(), item_html(p, opts).into());
            item.insert("content_text".into(), p.text.clone().into());
            item.insert(
                "authors".into(),
                serde_json::json!([{ "name": p.author.display_name, "url": format!("{}/u/{}", opts.site_url, p.author.username) }]),
            );
            if !p.tags.is_empty() {
                item.insert("tags".into(), p.tags.clone().into());
            }
            if let Some(img) = &p.image {
                item.insert("image".into(), absolute(opts, &img.src).into());
            } else if let Some(image) = p.preview.as_ref().and_then(|v| v.image.as_ref()) {
                item.insert("image".into(), absolute(opts, image).into());
            }
            item.insert("date_published".into(), p.created_at.clone().into());
            serde_json::Value::Object(item)
        })
        .collect();
    let feed = serde_json::json!({
        "version": "https://jsonfeed.org/version/1.1",
        "title": opts.title,
        "description": opts.description,
        "home_page_url": format!("{}/", opts.site_url),
        "feed_url": feed_url(opts, "feed.json"),
        "items": items,
    });
    serde_json::to_string_pretty(&feed).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links() {
        let (a, b) = extract_links(
            "see https://a.example/x, and https://b.example/y. https://a.example/x again",
        );
        assert_eq!(a.as_deref(), Some("https://a.example/x"));
        assert_eq!(b.as_deref(), Some("https://b.example/y"));
        assert_eq!(extract_links("nothing"), (None, None));
    }

    #[test]
    fn tags() {
        assert_eq!(normalize_tag(" #Rust "), Some("rust".into()));
        assert_eq!(normalize_tag("--"), None);
        assert_eq!(normalize_tag("a b"), None);
        assert_eq!(
            extract_tags("hi #Rust and #rust, see https://x.y/#frag &#x27; #ok_1"),
            vec!["rust", "ok_1"]
        );
        assert_eq!(
            post_tags("#a", &["B".into(), "#a".into(), "".into()]),
            vec!["a", "b"]
        );
    }

    #[test]
    fn hosts_and_titles() {
        assert_eq!(host("https://www.example.com/p?q=1"), "example.com");
        assert_eq!(host("nope"), "nope");
        assert_eq!(clip("abcdef", 4), "abc…");
        assert_eq!(clip("abc", 4), "abc");
    }
}
