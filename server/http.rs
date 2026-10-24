//! Everything that is not the oRPC API: the built app with its Open Graph tags, static files, the
//! feeds, post pictures, preview images and the share-target fallback. The network is private:
//! feeds and images need a session cookie or a feed token (?token=), and pages carry only generic
//! Open Graph tags so a shared post URL reveals nothing to link unfurlers.

use std::path::{Component, PathBuf};
use std::sync::{Arc, LazyLock};

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Redirect, Response};
use http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header};

use crate::app::App;
use crate::auth::{self, SESSION_COOKIE};
use crate::links::{APP_NAME, Author, FeedOptions, escape_html, to_json_feed, to_rss};
use crate::preview::screenshot_by_hash;
use crate::router::{Ctx, LoadOpts, ResHeaders, build_router, load_posts, post_image};

pub const DESCRIPTION: &str = "Links worth sharing, from people worth following. No algorithm.";

/// Copies the headers procedures asked for (set-cookie) onto the response.
pub async fn res_headers(mut req: Request, next: Next) -> Response {
    let rh = ResHeaders::default();
    req.extensions_mut().insert(rh.clone());
    let mut res = next.run(req).await;
    for (k, v) in rh.0.lock().unwrap().drain(..) {
        res.headers_mut().append(k, v);
    }
    res
}

fn ctx_from(
    app: Arc<App>,
) -> impl Fn(&http::request::Parts) -> Ctx + Clone + Send + Sync + 'static {
    move |parts| {
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| {
                v.strip_prefix("Bearer ")
                    .or_else(|| v.strip_prefix("bearer "))
            })
            .map(|t| t.trim().to_string());
        Ctx {
            app: app.clone(),
            token,
            session_id: auth::read_cookie(&parts.headers, SESSION_COOKIE),
            res: parts
                .extensions
                .get::<ResHeaders>()
                .cloned()
                .unwrap_or_default(),
        }
    }
}

/// The whole server as one axum router.
pub fn app_router(app: Arc<App>) -> axum::Router {
    let limits = |prefix: &str| orpc_axum::ORPCConfig {
        prefix: prefix.into(),
        max_body_size: 12 * 1024 * 1024,
        max_file_size: 11 * 1024 * 1024,
        max_files: 1,
    };
    let rpc = orpc_axum::into_router_with_config(build_router(), ctx_from(app.clone()), limits(""));
    let api = orpc_axum::into_openapi_router(
        build_router(),
        ctx_from(app.clone()),
        orpc_axum::OpenAPIConfig {
            max_body_size: 12 * 1024 * 1024,
            max_file_size: 11 * 1024 * 1024,
            max_files: 1,
            ..Default::default()
        },
    );
    let pages = axum::Router::<Arc<App>>::new()
        .route("/feed.xml", axum::routing::get(feed))
        .route("/feed.json", axum::routing::get(feed))
        .route("/images/{id}", axum::routing::get(image))
        .route("/previews/{file}", axum::routing::get(preview_image))
        .route("/share", axum::routing::post(share))
        .fallback(fallback)
        .with_state(app.clone());
    axum::Router::new()
        .nest("/rpc", rpc)
        .nest("/api", api)
        .merge(pages)
        .layer(axum::middleware::from_fn(res_headers))
        .layer(axum::middleware::from_fn_with_state(app, guard_requests))
}

/// Baseline security headers on every response, and a same-origin check on API calls that change
/// something: the session cookie is SameSite=Lax, which still lets sibling subdomains (same site)
/// post. Requests without an Origin header (curl with ADMIN_TOKEN) are let through.
pub async fn guard_requests(State(app): State<Arc<App>>, req: Request, next: Next) -> Response {
    let path = req.uri().path();
    let api = path.starts_with("/rpc/") || path.starts_with("/api/");
    let safe = matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    if api
        && !safe
        && let Some(origin) = req.headers().get(header::ORIGIN)
        && origin.as_bytes() != app.site.origin.as_bytes()
    {
        return text(StatusCode::FORBIDDEN, "cross-origin request refused");
    }
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("same-origin"),
    );
    res
}

#[allow(dead_code)]
fn assert_app_is_shareable() {
    fn check<T: Send + Sync + 'static>() {}
    check::<App>();
}

fn text(status: StatusCode, body: &'static str) -> Response {
    (status, [(header::CACHE_CONTROL, "no-store")], body).into_response()
}

/// Who is asking for a feed or an image: the session cookie, or a feed token in the URL.
async fn viewer(app: &App, headers: &HeaderMap, uri: &Uri) -> Option<(Author, Option<String>)> {
    if let Ok(Some(user)) = auth::session_user(
        &app.db,
        auth::read_cookie(headers, SESSION_COOKIE).as_deref(),
    )
    .await
    {
        return Some((user, None));
    }
    let token = uri.query().and_then(|q| {
        url::form_urlencoded::parse(q.as_bytes())
            .find(|(k, _)| k == "token")
            .map(|(_, v)| v.into_owned())
    });
    match auth::user_by_feed_token(&app.db, token.as_deref()).await {
        Ok(Some(user)) => Some((user, token)),
        _ => None,
    }
}

async fn feed(State(app): State<Arc<App>>, headers: HeaderMap, uri: Uri) -> Response {
    let Some((user, token)) = viewer(&app, &headers, &uri).await else {
        return text(
            StatusCode::UNAUTHORIZED,
            "sign in, or use the feed URL from Settings",
        );
    };
    let posts = match load_posts(
        &app,
        LoadOpts {
            viewer_id: Some(user.id),
            limit: Some(100),
            ..Default::default()
        },
    )
    .await
    {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[feed] {e:#}");
            return text(StatusCode::INTERNAL_SERVER_ERROR, "feed failed");
        }
    };
    let xml = uri.path() == "/feed.xml";
    let opts = FeedOptions {
        site_url: &app.site_url,
        title: APP_NAME,
        description: DESCRIPTION,
        token: token.as_deref(),
    };
    let (body, ct) = if xml {
        (to_rss(&posts, &opts), "application/rss+xml; charset=utf-8")
    } else {
        (
            to_json_feed(&posts, &opts),
            "application/feed+json; charset=utf-8",
        )
    };
    (
        [
            (header::CONTENT_TYPE, ct),
            (header::CACHE_CONTROL, "private, max-age=300"),
        ],
        body,
    )
        .into_response()
}

static ID_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[A-Za-z0-9]{6,32}$").unwrap());
static SHOT_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^([0-9a-f]{12})\.jpg$").unwrap());

/// A post's picture: members only, and only if they may see the post (private ones are the author's).
async fn image(
    State(app): State<Arc<App>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    if !ID_RE.is_match(&id) {
        return text(StatusCode::NOT_FOUND, "not found");
    }
    let Some((user, _)) = viewer(&app, &headers, &uri).await else {
        return text(StatusCode::UNAUTHORIZED, "unauthorized");
    };
    match post_image(&app, &id, &user).await {
        Ok(Some((bytes, kind))) => (
            [
                (header::CONTENT_TYPE, kind.as_str()),
                (
                    header::CACHE_CONTROL,
                    "private, max-age=31536000, immutable",
                ),
            ],
            bytes,
        )
            .into_response(),
        Ok(None) => text(StatusCode::NOT_FOUND, "not found"),
        Err(e) => {
            eprintln!("[images] {e:#}");
            text(StatusCode::INTERNAL_SERVER_ERROR, "failed")
        }
    }
}

async fn preview_image(
    State(app): State<Arc<App>>,
    axum::extract::Path(file): axum::extract::Path<String>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let Some(hash) = SHOT_RE.captures(&file).map(|c| c[1].to_string()) else {
        return text(StatusCode::NOT_FOUND, "not found");
    };
    if viewer(&app, &headers, &uri).await.is_none() {
        return text(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    match screenshot_by_hash(&app, &hash).await {
        Ok(Some((bytes, kind))) => (
            [
                (header::CONTENT_TYPE, kind.as_str()),
                (header::CACHE_CONTROL, "private, max-age=86400"),
            ],
            bytes,
        )
            .into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, "not found").into_response(),
        Err(e) => {
            eprintln!("[previews] {e:#}");
            text(StatusCode::INTERNAL_SERVER_ERROR, "failed")
        }
    }
}

/// The share sheet's POST lands in the service worker (public/share-target.js); without one, drop
/// the file and open the composer with the text fields.
async fn share(State(app): State<Arc<App>>, mut multipart: axum::extract::Multipart) -> Response {
    let mut pairs: Vec<(String, String)> = Vec::new();
    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        if matches!(name.as_str(), "title" | "text" | "url")
            && let Ok(value) = field.text().await
            && !value.is_empty()
        {
            pairs.push((name, value));
        }
    }
    let q = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs)
        .finish();
    Redirect::to(&format!("{}/share?{q}", app.site_url)).into_response()
}

// ---------- html with Open Graph tags ----------

/// The built index.html, with the `<!-- og -->` placeholder swapped for the app's generic tags.
/// Every page gets the same card on purpose: posts and profiles are only for signed-in members,
/// so a post URL pasted in a chat must not unfurl into its content.
async fn html(app: &App, pathname: &str) -> Response {
    let index = match tokio::fs::read_to_string(app.dist.join("index.html")).await {
        Ok(s) => s,
        Err(_) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                "dist/ not built. Run `bun run build`.",
            )
                .into_response();
        }
    };
    let site = &app.site_url;
    let url = format!("{site}{pathname}");
    let is_post = pathname.starts_with("/p/")
        && pathname[3..].chars().all(|c| c != '/')
        && pathname.len() > 3;
    let description = if is_post {
        format!("A murmur was shared with you. {APP_NAME} is members only: sign in to read it.")
    } else {
        DESCRIPTION.to_string()
    };
    let tags = [
        format!(r#"<meta property="og:site_name" content="{APP_NAME}">"#),
        r#"<meta property="og:type" content="website">"#.to_string(),
        format!(r#"<meta property="og:title" content="{APP_NAME}">"#),
        format!(
            r#"<meta property="og:description" content="{}">"#,
            escape_html(&description)
        ),
        format!(
            r#"<meta property="og:url" content="{}">"#,
            escape_html(&url)
        ),
        format!(r#"<meta property="og:image" content="{site}/og.jpg">"#),
        format!(r#"<meta property="og:image:secure_url" content="{site}/og.jpg">"#),
        r#"<meta property="og:image:type" content="image/jpeg">"#.to_string(),
        r#"<meta property="og:image:width" content="1200">"#.to_string(),
        r#"<meta property="og:image:height" content="630">"#.to_string(),
        format!(
            r#"<meta property="og:image:alt" content="{APP_NAME}: {}">"#,
            escape_html(DESCRIPTION)
        ),
        r#"<meta name="twitter:card" content="summary_large_image">"#.to_string(),
        format!(r#"<meta name="twitter:title" content="{APP_NAME}">"#),
        format!(
            r#"<meta name="twitter:description" content="{}">"#,
            escape_html(&description)
        ),
        format!(r#"<meta name="twitter:image" content="{site}/og.jpg">"#),
        format!(
            r#"<meta name="description" content="{}">"#,
            escape_html(&description)
        ),
        r#"<meta name="robots" content="noindex">"#.to_string(),
    ]
    .join("\n    ");
    let body = index.replace("<!-- og -->", &tags);
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        body,
    )
        .into_response()
}

// ---------- static ----------

/// A file under dist/, or None. Rejects anything that would leave dist/.
async fn static_file(app: &App, pathname: &str) -> Option<Response> {
    let decoded = percent_encoding::percent_decode_str(pathname)
        .decode_utf8()
        .ok()?;
    let mut rel = PathBuf::new();
    for c in std::path::Path::new(decoded.as_ref()).components() {
        match c {
            Component::Normal(n) => rel.push(n),
            Component::RootDir | Component::CurDir => {}
            _ => return None,
        }
    }
    if rel.as_os_str().is_empty() {
        return None;
    }
    let file = app.dist.join(&rel);
    let bytes = tokio::fs::read(&file).await.ok()?;
    let rel_s = rel.to_string_lossy();
    let immutable = rel_s.starts_with("assets/");
    let sw = matches!(
        rel_s.as_ref(),
        "sw.js" | "registerSW.js" | "manifest.webmanifest"
    ) || (rel_s.starts_with("workbox-") && rel_s.ends_with(".js"));
    let cache = if immutable {
        "public, max-age=31536000, immutable"
    } else if sw {
        "no-cache"
    } else {
        "public, max-age=300"
    };
    let mime = if rel_s.ends_with(".webmanifest") {
        "application/manifest+json".to_string()
    } else {
        mime_guess::from_path(&file)
            .first_or_octet_stream()
            .to_string()
    };
    Some(
        (
            [
                (header::CONTENT_TYPE, mime.as_str()),
                (header::CACHE_CONTROL, cache),
            ],
            bytes,
        )
            .into_response(),
    )
}

async fn fallback(State(app): State<Arc<App>>, method: Method, uri: Uri) -> Response {
    let p = uri.path().to_string();
    if method == Method::GET || method == Method::HEAD {
        if p != "/"
            && let Some(f) = static_file(&app, &p).await
        {
            return f;
        }
        // app routes (/, /p/<id>, /u/<name>, /link/<token>, ...): the shell, the app takes it from there
        return html(&app, &p).await;
    }
    (StatusCode::METHOD_NOT_ALLOWED, "method not allowed").into_response()
}
