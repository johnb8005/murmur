//! Cross-posting to Slack through incoming webhooks. Each member keeps their own webhook URLs
//! (`slack_webhooks`, settings page); the composer picks which ones a murmur also goes to. The URL
//! is a secret (anyone holding it can post to the channel), so it never leaves the server: the app
//! only sees a name and a hint. Private murmurs are never sent.

use std::time::Duration;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::app::App;
use crate::auth::{self, AuthError};
use crate::db::{Db, Rec, v};
use crate::links::{Post, now_iso, permalink};

pub const WEBHOOKS_MAX: usize = 10;
pub const NAME_MAX: usize = 40;
const URL_MAX: usize = 500;
const SEND_TIMEOUT: Duration = Duration::from_secs(10);

/// Where webhook URLs may point: `SLACK_WEBHOOK_HOSTS` (comma separated), else Slack's own host.
/// Keeps the server from being made to POST anywhere a member types.
pub fn hosts_from_env() -> Vec<String> {
    std::env::var("SLACK_WEBHOOK_HOSTS")
        .ok()
        .map(|s| {
            s.split(',')
                .map(|h| h.trim().to_lowercase())
                .filter(|h| !h.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| vec!["hooks.slack.com".into()])
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SlackWebhook {
    pub id: String,
    pub name: String,
    /// enough of the URL to tell webhooks apart, not enough to use it
    pub hint: String,
    pub created_at: String,
}

/// What happened to one webhook when a murmur went out.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SlackSent {
    pub id: String,
    pub name: String,
    pub error: Option<String>,
}

fn bad<T>(msg: &str) -> Result<T> {
    Err(anyhow::Error::new(AuthError(msg.to_string())))
}

/// A webhook URL the server may call: https on an allowed host (plain http only for localhost).
pub fn check_url(raw: &str, hosts: &[String]) -> std::result::Result<String, &'static str> {
    let raw = raw.trim();
    if raw.len() > URL_MAX {
        return Err("that webhook URL is too long");
    }
    let url = url::Url::parse(raw).map_err(|_| "not a URL")?;
    let host = url.host_str().unwrap_or("").to_lowercase();
    let local = matches!(host.as_str(), "localhost" | "127.0.0.1");
    if !(url.scheme() == "https" || (url.scheme() == "http" && local)) {
        return Err("webhook URLs start with https://");
    }
    if !hosts.contains(&host) {
        return Err("that is not a Slack webhook URL (https://hooks.slack.com/services/…)");
    }
    if url.path().trim_matches('/').is_empty() || !url.username().is_empty() {
        return Err("that is not a Slack webhook URL (https://hooks.slack.com/services/…)");
    }
    Ok(url.to_string())
}

/// "hooks.slack.com/…/AbCd": the host and the last four characters.
pub fn hint(url: &str) -> String {
    let host = url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(String::from))
        .unwrap_or_default();
    let path = url.trim_end_matches('/');
    let tail: String = path
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("{host}/…{tail}")
}

fn webhook(r: &Rec) -> SlackWebhook {
    SlackWebhook {
        id: r.req("id"),
        name: r.req("name"),
        hint: hint(&r.req("url")),
        created_at: r.req("created_at"),
    }
}

pub async fn list(db: &Db, user_id: &str) -> Result<Vec<SlackWebhook>> {
    Ok(db
        .query(
            "SELECT id, name, url, created_at FROM slack_webhooks WHERE user_id = ? ORDER BY created_at ASC",
            vec![v(user_id)],
        )
        .await?
        .iter()
        .map(webhook)
        .collect())
}

pub async fn add(app: &App, user_id: &str, name: &str, url: &str) -> Result<SlackWebhook> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > NAME_MAX {
        return bad(&format!("name: 1 to {NAME_MAX} characters"));
    }
    let url = match check_url(url, &app.slack_hosts) {
        Ok(u) => u,
        Err(e) => return bad(e),
    };
    let existing = list(&app.db, user_id).await?;
    if existing.len() >= WEBHOOKS_MAX {
        return bad(&format!("up to {WEBHOOKS_MAX} webhooks"));
    }
    let id = auth::new_id();
    let created_at = now_iso();
    app.db
        .exec(
            "INSERT INTO slack_webhooks (id, user_id, name, url, created_at) VALUES (?, ?, ?, ?, ?)",
            vec![v(id.clone()), v(user_id), v(name), v(url.clone()), v(created_at.clone())],
        )
        .await?;
    Ok(SlackWebhook {
        id,
        name: name.to_string(),
        hint: hint(&url),
        created_at,
    })
}

pub async fn remove(db: &Db, user_id: &str, id: &str) -> Result<bool> {
    Ok(db
        .exec(
            "DELETE FROM slack_webhooks WHERE id = ? AND user_id = ?",
            vec![v(id), v(user_id)],
        )
        .await?
        > 0)
}

/// The user's webhooks among `ids`, with their URLs. Unknown or someone else's ids are an error.
pub async fn resolve(
    db: &Db,
    user_id: &str,
    ids: &[String],
) -> Result<Vec<(SlackWebhook, String)>> {
    let mut out: Vec<(SlackWebhook, String)> = Vec::new();
    for id in ids {
        if out.iter().any(|(w, _)| &w.id == id) {
            continue;
        }
        let row = db
            .one(
                "SELECT id, name, url, created_at FROM slack_webhooks WHERE id = ? AND user_id = ?",
                vec![v(id.clone()), v(user_id)],
            )
            .await?;
        match row {
            Some(r) => out.push((webhook(&r), r.req("url"))),
            None => return bad("unknown Slack webhook"),
        }
    }
    Ok(out)
}

/// Slack's mrkdwn wants these three escaped; everything else (URLs included) passes through.
pub fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The Slack message for a murmur: its text, a note when it carries a picture (pictures are
/// members only, Slack could not show it), and a link back.
pub fn message(post: &Post, site_url: &str) -> String {
    let mut parts = Vec::new();
    if !post.text.is_empty() {
        parts.push(escape(&post.text));
    }
    let mut footer = format!("— @{}", post.author.username);
    if post.image.is_some() {
        footer.push_str(" · with a picture");
    }
    footer.push_str(&format!(
        " · <{}|Open in {}>",
        permalink(site_url, &post.id),
        crate::links::APP_NAME
    ));
    parts.push(footer);
    parts.join("\n\n")
}

/// POSTs `text` to one webhook. Slack answers 200 "ok"; anything else is the error shown to the user.
pub async fn send(app: &App, url: &str, text: &str) -> Option<String> {
    let body = serde_json::json!({ "text": text });
    let res = app
        .http
        .post(url)
        .header("content-type", "application/json")
        .body(body.to_string())
        .timeout(SEND_TIMEOUT)
        .send()
        .await;
    match res {
        Ok(r) if r.status().is_success() => None,
        Ok(r) => {
            let status = r.status().as_u16();
            let detail = r.text().await.unwrap_or_default();
            let detail: String = detail.trim().chars().take(100).collect();
            Some(if detail.is_empty() {
                format!("Slack answered {status}")
            } else {
                format!("Slack answered {status}: {detail}")
            })
        }
        Err(e) if e.is_timeout() => Some("Slack did not answer in time".into()),
        Err(_) => Some("could not reach Slack".into()),
    }
}

/// Sends a murmur to each webhook at once; one failing does not stop the others.
pub async fn cross_post(
    app: &App,
    post: &Post,
    hooks: Vec<(SlackWebhook, String)>,
) -> Vec<SlackSent> {
    let text = message(post, &app.site_url);
    let sends = hooks.into_iter().map(|(w, url)| {
        let text = &text;
        async move {
            let error = send(app, &url, text).await;
            if let Some(e) = &error {
                eprintln!("[slack] {} ({}): {e}", w.name, w.id);
            }
            SlackSent {
                id: w.id,
                name: w.name,
                error,
            }
        }
    });
    futures_util::future::join_all(sends).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::links::{Author, PostImage};

    fn slack() -> Vec<String> {
        vec!["hooks.slack.com".into()]
    }

    #[test]
    fn webhook_urls_must_be_slack_over_https() {
        let ok = "https://hooks.slack.com/services/T000/B000/XXXXabcd";
        assert_eq!(check_url(ok, &slack()).as_deref(), Ok(ok));
        assert_eq!(check_url(&format!("  {ok} "), &slack()).as_deref(), Ok(ok));
        assert!(check_url("http://hooks.slack.com/services/T/B/X", &slack()).is_err());
        assert!(check_url("https://example.com/services/T/B/X", &slack()).is_err());
        assert!(check_url("https://hooks.slack.com.evil.test/x", &slack()).is_err());
        assert!(check_url("https://hooks.slack.com/", &slack()).is_err());
        assert!(check_url("https://u:p@hooks.slack.com/services/x", &slack()).is_err());
        assert!(check_url("not a url", &slack()).is_err());
        // plain http only for a local test server, and only when its host is allowed
        let local = vec!["localhost".to_string()];
        assert!(check_url("http://localhost:9999/hook", &local).is_ok());
        assert!(check_url("http://localhost:9999/hook", &slack()).is_err());
    }

    #[test]
    fn hints_hide_the_secret() {
        assert_eq!(
            hint("https://hooks.slack.com/services/T000/B000/XXXXabcd"),
            "hooks.slack.com/…abcd"
        );
    }

    #[test]
    fn messages_escape_text_and_link_back() {
        let mut post = Post {
            id: "abc123".into(),
            text: "a <b> & c https://example.com/?x=1".into(),
            link: None,
            reference: None,
            image: None,
            tags: vec![],
            private: false,
            created_at: now_iso(),
            author: Author {
                id: "u1".into(),
                username: "john".into(),
                display_name: "John".into(),
            },
            preview: None,
            ref_preview: None,
            likes: 0,
            comments: 0,
            liked_by_me: false,
        };
        assert_eq!(
            message(&post, "https://m.test"),
            "a &lt;b&gt; &amp; c https://example.com/?x=1\n\n— @john · <https://m.test/p/abc123|Open in Murmur>"
        );
        post.text = String::new();
        post.image = Some(PostImage {
            src: "/images/abc123".into(),
            kind: "image/jpeg".into(),
            width: 1,
            height: 1,
        });
        assert_eq!(
            message(&post, "https://m.test"),
            "— @john · with a picture · <https://m.test/p/abc123|Open in Murmur>"
        );
    }
}
