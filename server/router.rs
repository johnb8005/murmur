//! oRPC router: the whole API. Served at /rpc (oRPC protocol, used by the app) and /api (plain
//! HTTP/OpenAPI, handy for curl). Signed-in calls carry the session cookie; scripts may instead
//! send `Authorization: Bearer $ADMIN_TOKEN`, which acts as the owner account.
//! The network is private: everything but health and the sign-in / sign-up / device-link
//! procedures needs a signed-in user.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use http::{HeaderName, HeaderValue};
use orpc::{
    ErrorCode, MiddlewareCtx, ORPCError, ORPCFile, Route, Router, middleware_fn, os, router,
};
use orpc_specta::{Type, specta};
use serde::{Deserialize, Serialize};
use specta::datatype::DataType;

use crate::app::App;
use crate::auth::{self, AuthError, DeviceLink, PasskeyInfo, Site};
use crate::db::{Db, Stmt, opt, stmt, v};
use crate::links::{
    Author, COMMENT_MAX, Comment, POST_MAX, Post, PostImage, TAGS_MAX, extract_links,
    normalize_tag, now_iso, post_tags,
};
use crate::preview::{ensure_previews, previews_for, prune_previews, refresh_preview};

// ---------- context ----------

/// Headers a procedure wants on the response (set-cookie). Lives in the request extensions; the
/// `res_headers` layer in http.rs copies them onto the response. orpc-axum has no hook for this.
#[derive(Clone, Default)]
pub struct ResHeaders(pub Arc<Mutex<Vec<(HeaderName, HeaderValue)>>>);

impl ResHeaders {
    pub fn append(&self, name: &'static str, value: &str) {
        if let Ok(v) = HeaderValue::from_str(value) {
            self.0
                .lock()
                .unwrap()
                .push((HeaderName::from_static(name), v));
        }
    }
}

#[derive(Clone)]
pub struct Ctx {
    pub app: Arc<App>,
    /// bearer token from the request, if any
    pub token: Option<String>,
    /// session cookie from the request, if any
    pub session_id: Option<String>,
    pub res: ResHeaders,
}

#[derive(Clone)]
pub struct Authed {
    pub user: Author,
    pub ctx: Ctx,
}

impl Ctx {
    fn db(&self) -> &Db {
        &self.app.db
    }
    fn site(&self) -> &Site {
        &self.app.site
    }
    async fn resolve_user(&self) -> Result<Option<Author>> {
        if let (Some(t), Some(admin)) = (&self.token, &self.app.admin_token)
            && constant_time_eq(t.as_bytes(), admin.as_bytes())
        {
            return auth::user_by_username(self.db(), &self.site().owner_username).await;
        }
        auth::session_user(self.db(), self.session_id.as_deref()).await
    }
    async fn start_session(&self, user: &Author) -> Result<()> {
        let id = auth::create_session(self.db(), &user.id).await?;
        self.res
            .append("set-cookie", &auth::session_cookie(self.site(), &id));
        Ok(())
    }
}

/// Compares secrets without leaking, through timing, how much of a guess was right.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Requires a signed-in user.
fn authed() -> orpc::Builder<Ctx, Authed> {
    os::<Ctx>().use_middleware(middleware_fn(
        |ctx: Ctx, mw: MiddlewareCtx<Authed>| async move {
            match ctx.resolve_user().await {
                Ok(Some(user)) => mw.next(Authed { user, ctx }).await,
                Ok(None) => Err(ORPCError::unauthorized("sign in first").into()),
                Err(e) => Err(internal(e).into()),
            }
        },
    ))
}

// ---------- errors ----------

/// Auth-domain errors become 400s with their message; anything else is logged and a bare 500.
fn guard(e: anyhow::Error) -> ORPCError {
    if let Some(a) = e.downcast_ref::<AuthError>() {
        return ORPCError::bad_request(a.0.clone());
    }
    internal(e)
}

fn internal(e: anyhow::Error) -> ORPCError {
    eprintln!("[api] {e:#}");
    ORPCError::internal_server_error("Internal server error")
}

// ---------- types ----------

/// Untyped JSON, like `z.any()`: WebAuthn options and responses pass through untouched.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AnyJson(pub serde_json::Value);
impl Type for AnyJson {
    fn inline(_: &mut specta::TypeCollection, _: specta::Generics) -> DataType {
        DataType::Any
    }
}

/// An uploaded file. specta has no `File`, so it exports as `any`; the browser passes a `File`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Upload(pub ORPCFile);
impl Type for Upload {
    fn inline(_: &mut specta::TypeCollection, _: specta::Generics) -> DataType {
        DataType::Any
    }
}

/// A number that may arrive as a JSON number (RPC) or a query-string string (OpenAPI).
fn lenient_u32<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<u32>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum NumOrStr {
        N(u32),
        F(f64),
        S(String),
    }
    Ok(match Option::<NumOrStr>::deserialize(d)? {
        None => None,
        Some(NumOrStr::N(n)) => Some(n),
        Some(NumOrStr::F(f)) => Some(f as u32),
        Some(NumOrStr::S(s)) => Some(s.trim().parse().map_err(serde::de::Error::custom)?),
    })
}

/// A boolean that may arrive as JSON or as a query-string string.
fn lenient_bool<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<bool>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum BoolOrStr {
        B(bool),
        S(String),
    }
    Ok(match Option::<BoolOrStr>::deserialize(d)? {
        None => None,
        Some(BoolOrStr::B(b)) => Some(b),
        Some(BoolOrStr::S(s)) => Some(matches!(s.as_str(), "true" | "1")),
    })
}

#[derive(Serialize, Deserialize, Type)]
pub struct Health {
    pub status: String,
    pub db: String,
    pub storage: String,
    pub uptime: u32,
    pub sha: Option<String>,
    pub version: Option<String>,
    pub date: Option<String>,
}

#[derive(Serialize, Deserialize, Type)]
pub struct StatusOut {
    pub user: Option<Author>,
}

#[derive(Serialize, Deserialize, Type)]
pub struct UserOut {
    pub user: Author,
}

#[derive(Serialize, Deserialize, Type)]
pub struct UsernameIn {
    pub username: String,
}

#[derive(Serialize, Deserialize, Type)]
pub struct Availability {
    pub available: bool,
    pub reason: Option<String>,
}

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChallengeOut {
    pub challenge_id: String,
    pub options: AnyJson,
}

impl From<auth::Options> for ChallengeOut {
    fn from(o: auth::Options) -> Self {
        ChallengeOut {
            challenge_id: o.challenge_id,
            options: AnyJson(o.options),
        }
    }
}

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RegisterIn {
    pub challenge_id: String,
    pub response: AnyJson,
    #[serde(default)]
    pub device_name: Option<String>,
}

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AssertionIn {
    pub challenge_id: String,
    pub response: AnyJson,
}

#[derive(Serialize, Deserialize, Type)]
pub struct LoginOptionsIn {
    #[serde(default)]
    pub username: Option<String>,
}

#[derive(Serialize, Deserialize, Type)]
pub struct OkOut {
    pub ok: bool,
}

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProfileIn {
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
}

#[derive(Serialize, Deserialize, Type)]
pub struct IdIn {
    pub id: String,
}

#[derive(Serialize, Deserialize, Type)]
pub struct IdOut {
    pub id: String,
}

#[derive(Serialize, Deserialize, Type)]
pub struct DeletedOut {
    pub deleted: bool,
}

#[derive(Serialize, Deserialize, Type)]
pub struct TokenIn {
    pub token: String,
}

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinkInfoOut {
    pub user: Author,
    pub expires_at: String,
}

#[derive(Serialize, Deserialize, Type)]
pub struct FeedOut {
    pub token: String,
    pub rss: String,
    pub json: String,
}

#[derive(Serialize, Deserialize, Type)]
pub struct ListIn {
    #[serde(default, deserialize_with = "lenient_u32")]
    pub limit: Option<u32>,
    #[serde(default)]
    pub before: Option<String>,
    #[serde(default)]
    pub tag: Option<String>,
}

#[derive(Serialize, Deserialize, Type)]
pub struct TagCount {
    pub tag: String,
    pub count: u32,
}

#[derive(Serialize, Deserialize, Type)]
pub struct PostOut {
    pub post: Post,
    pub comments: Vec<Comment>,
}

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateIn {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default, deserialize_with = "lenient_bool")]
    pub private: Option<bool>,
    #[serde(default)]
    pub image: Option<Upload>,
    /// pixel size of `image`, as measured by the client (layout hint only)
    #[serde(default, deserialize_with = "lenient_u32")]
    pub image_width: Option<u32>,
    #[serde(default, deserialize_with = "lenient_u32")]
    pub image_height: Option<u32>,
}

#[derive(Serialize, Deserialize, Type)]
pub struct CreateOut {
    pub post: Post,
    pub previews: HashMap<String, Option<String>>,
}

#[derive(Serialize, Deserialize, Type)]
pub struct LikeOut {
    pub liked: bool,
    pub likes: u32,
}

#[derive(Serialize, Deserialize, Type)]
pub struct CommentIn {
    pub id: String,
    pub text: String,
}

#[derive(Serialize, Deserialize, Type)]
pub struct UserIn {
    pub username: String,
    #[serde(default)]
    pub before: Option<String>,
}

#[derive(Serialize, Deserialize, Type)]
pub struct UserPostsOut {
    pub user: Author,
    pub posts: Vec<Post>,
}

#[derive(Serialize, Deserialize, Type)]
pub struct RefreshIn {
    pub url: String,
}

#[derive(Serialize, Deserialize, Type)]
pub struct RefreshOut {
    pub error: Option<String>,
}

// ---------- loading ----------

const POST_SELECT: &str = "
  SELECT p.id, p.text, p.link, p.ref, p.private, p.created_at, p.image_type, p.image_w, p.image_h,
         u.id AS uid, u.username, u.display_name,
         (SELECT group_concat(tag, ' ') FROM (SELECT tag FROM post_tags t WHERE t.post_id = p.id ORDER BY tag)) AS tags,
         (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS likes,
         (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comments,
         EXISTS (SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = ?) AS liked
  FROM posts p JOIN users u ON u.id = p.user_id";

/// Posts the viewer may see: everyone's public ones plus the viewer's own private ones.
const VISIBLE: &str = "(p.private = 0 OR p.user_id = ?)";

#[derive(Default)]
pub struct LoadOpts {
    /// who is looking: private posts are only loaded for their author
    pub viewer_id: Option<String>,
    pub limit: Option<u32>,
    pub before: Option<String>,
    pub author_id: Option<String>,
    pub id: Option<String>,
    pub tag: Option<String>,
}

pub async fn load_posts(app: &App, o: LoadOpts) -> Result<Vec<Post>> {
    let viewer = o.viewer_id.unwrap_or_default();
    let mut where_: Vec<&str> = vec![VISIBLE];
    let mut args = vec![v(viewer.clone()), v(viewer)];
    if let Some(id) = o.id {
        where_.push("p.id = ?");
        args.push(v(id));
    }
    if let Some(a) = o.author_id {
        where_.push("p.user_id = ?");
        args.push(v(a));
    }
    if let Some(t) = o.tag {
        where_.push("EXISTS (SELECT 1 FROM post_tags t WHERE t.post_id = p.id AND t.tag = ?)");
        args.push(v(t));
    }
    if let Some(b) = o.before {
        where_.push("p.created_at < ?");
        args.push(v(b));
    }
    args.push(v(o.limit.unwrap_or(50) as i64));
    let sql = format!(
        "{POST_SELECT} WHERE {} ORDER BY p.created_at DESC LIMIT ?",
        where_.join(" AND ")
    );
    let rows = app.db.query(&sql, args).await?;
    let mut posts: Vec<Post> = rows
        .iter()
        .map(|r| Post {
            id: r.req("id"),
            text: r.str("text").unwrap_or_default(),
            link: r.str("link"),
            reference: r.str("ref"),
            image: r.str("image_type").map(|kind| PostImage {
                src: format!("/images/{}", r.req("id")),
                kind,
                width: r.num("image_w") as u32,
                height: r.num("image_h") as u32,
            }),
            tags: r
                .str("tags")
                .unwrap_or_default()
                .split(' ')
                .filter(|t| !t.is_empty())
                .map(String::from)
                .collect(),
            private: r.num("private") > 0,
            created_at: r.req("created_at"),
            author: Author {
                id: r.req("uid"),
                username: r.req("username"),
                display_name: r.req("display_name"),
            },
            preview: None,
            ref_preview: None,
            likes: r.num("likes") as u32,
            comments: r.num("comments") as u32,
            liked_by_me: r.num("liked") > 0,
        })
        .collect();
    let urls: Vec<String> = posts
        .iter()
        .flat_map(|p| [p.link.clone(), p.reference.clone()])
        .flatten()
        .collect();
    let previews = previews_for(app, &urls).await?;
    for p in &mut posts {
        p.preview = p.link.as_ref().and_then(|l| previews.get(l).cloned());
        p.ref_preview = p.reference.as_ref().and_then(|l| previews.get(l).cloned());
    }
    Ok(posts)
}

async fn load_comments(db: &Db, post_id: &str) -> Result<Vec<Comment>> {
    Ok(db
        .query(
            "SELECT c.id, c.post_id, c.text, c.created_at, u.id AS uid, u.username, u.display_name
             FROM comments c JOIN users u ON u.id = c.user_id WHERE c.post_id = ? ORDER BY c.created_at ASC LIMIT 500",
            vec![v(post_id)],
        )
        .await?
        .iter()
        .map(|r| Comment {
            id: r.req("id"),
            post_id: r.req("post_id"),
            text: r.req("text"),
            created_at: r.req("created_at"),
            author: Author { id: r.req("uid"), username: r.req("username"), display_name: r.req("display_name") },
        })
        .collect())
}

async fn post_owner_id(db: &Db, id: &str) -> Result<Option<String>> {
    Ok(db
        .one("SELECT user_id FROM posts WHERE id = ?", vec![v(id)])
        .await?
        .and_then(|r| r.str("user_id")))
}

/// The post's author id if `viewer` may see the post (it exists and is public or theirs), else None.
async fn visible_post_owner_id(db: &Db, id: &str, viewer: &Author) -> Result<Option<String>> {
    Ok(db
        .one(
            &format!("SELECT user_id FROM posts p WHERE p.id = ? AND {VISIBLE}"),
            vec![v(id), v(viewer.id.clone())],
        )
        .await?
        .and_then(|r| r.str("user_id")))
}

// ---------- pictures ----------
//
// One picture per post, shrunk by the browser first (src/image.ts). Bytes go to R2 under
// images/<post id>; without R2 (local dev, the e2e run) they sit in the `images` table. Served at
// /images/<post id> by http.rs to members who may see the post.

const IMAGE_MAX_BYTES: usize = 10 * 1024 * 1024;
const IMAGE_TYPES: [&str; 4] = ["image/jpeg", "image/png", "image/webp", "image/gif"];

async fn store_post_image(app: &App, post_id: &str, file: &ORPCFile) -> Result<Option<String>> {
    let kind = file.content_type.clone().unwrap_or_default();
    let key = match &app.r2 {
        Some(r2) => {
            r2.put(&format!("images/{post_id}"), &file.data, &kind)
                .await
        }
        None => None,
    };
    if key.is_none() {
        app.db
            .exec(
                "INSERT OR REPLACE INTO images (post_id, bytes) VALUES (?, ?)",
                vec![v(post_id), v(file.data.clone())],
            )
            .await?;
    }
    Ok(key)
}

async fn drop_post_image(app: &App, post_id: &str) -> Result<()> {
    let key = app
        .db
        .one("SELECT image_key FROM posts WHERE id = ?", vec![v(post_id)])
        .await?
        .and_then(|r| r.str("image_key"));
    if let (Some(key), Some(r2)) = (key, &app.r2) {
        r2.delete(&key).await;
    }
    app.db
        .exec("DELETE FROM images WHERE post_id = ?", vec![v(post_id)])
        .await?;
    Ok(())
}

/// The picture of post `id` if `viewer` may see the post; None otherwise (also when there is none).
pub async fn post_image(app: &App, id: &str, viewer: &Author) -> Result<Option<(Vec<u8>, String)>> {
    let row = app
        .db
        .one(
            &format!("SELECT image_key, image_type FROM posts p WHERE p.id = ? AND {VISIBLE}"),
            vec![v(id), v(viewer.id.clone())],
        )
        .await?;
    let (key, kind) = match row {
        Some(r) => match r.str("image_type") {
            Some(t) => (r.str("image_key"), t),
            None => return Ok(None),
        },
        None => return Ok(None),
    };
    if let (Some(key), Some(r2)) = (key, &app.r2)
        && let Some((bytes, _)) = r2.get(&key).await
    {
        return Ok(Some((bytes, kind)));
    }
    let local = app
        .db
        .one("SELECT bytes FROM images WHERE post_id = ?", vec![v(id)])
        .await?
        .and_then(|r| r.blob("bytes"));
    Ok(local.map(|b| (b, kind)))
}

/// Tags on posts the viewer may see, most used first.
async fn load_tags(db: &Db, viewer_id: &str) -> Result<Vec<TagCount>> {
    Ok(db
        .query(
            &format!("SELECT t.tag, COUNT(*) AS n FROM post_tags t JOIN posts p ON p.id = t.post_id WHERE {VISIBLE} GROUP BY t.tag ORDER BY n DESC, t.tag ASC LIMIT 200"),
            vec![v(viewer_id)],
        )
        .await?
        .iter()
        .map(|r| TagCount { tag: r.req("tag"), count: r.num("n") as u32 })
        .collect())
}

// ---------- health ----------

/// A round trip to the database, bounded so a hung connection cannot hang the probe.
pub async fn db_check(db: &Db, timeout: std::time::Duration) -> String {
    match tokio::time::timeout(timeout, db.query("SELECT 1", vec![])).await {
        Ok(Ok(_)) => "ok".into(),
        Ok(Err(e)) => format!("error: {e:#}"),
        Err(_) => format!("error: no answer in {} ms", timeout.as_millis()),
    }
}

/// Liveness, readiness and build info in one place. Answers 503 when the database does not, but
/// stays 200 without R2 (pictures and previews then live in the database, which works).
async fn health(ctx: Ctx, _: ()) -> std::result::Result<Health, ORPCError> {
    let app = &ctx.app;
    let db = db_check(&app.db, std::time::Duration::from_secs(3)).await;
    let body = Health {
        status: "ok".into(),
        db: db.clone(),
        storage: if app.r2.is_some() {
            "r2".into()
        } else {
            "database".into()
        },
        uptime: app.started.elapsed().as_secs() as u32,
        sha: app.build.sha.clone(),
        version: app.build.version.clone(),
        date: app.build.date.clone(),
    };
    if db != "ok" {
        let mut data = serde_json::to_value(&body).unwrap_or_default();
        data["status"] = "degraded".into();
        return Err(
            ORPCError::new(ErrorCode::ServiceUnavailable, format!("database {db}")).with_data(data),
        );
    }
    Ok(body)
}

// ---------- auth ----------

async fn status(ctx: Ctx, _: ()) -> std::result::Result<StatusOut, ORPCError> {
    Ok(StatusOut {
        user: ctx.resolve_user().await.map_err(internal)?,
    })
}

async fn check_username(
    ctx: Ctx,
    input: UsernameIn,
) -> std::result::Result<Availability, ORPCError> {
    let u = match auth::validate_username(&input.username) {
        Ok(u) => u,
        Err(e) => {
            return Ok(Availability {
                available: false,
                reason: Some(e.to_string()),
            });
        }
    };
    let available = auth::username_available(ctx.db(), &u)
        .await
        .map_err(internal)?;
    Ok(Availability {
        available,
        reason: (!available).then(|| "that username is taken".to_string()),
    })
}

async fn register_options(
    ctx: Ctx,
    input: UsernameIn,
) -> std::result::Result<ChallengeOut, ORPCError> {
    Ok(
        auth::registration_options(ctx.db(), ctx.site(), &input.username)
            .await
            .map_err(guard)?
            .into(),
    )
}

async fn register(ctx: Ctx, input: RegisterIn) -> std::result::Result<UserOut, ORPCError> {
    let user = auth::register(
        ctx.db(),
        ctx.site(),
        &input.challenge_id,
        &input.response.0,
        input.device_name.as_deref(),
    )
    .await
    .map_err(guard)?;
    ctx.start_session(&user).await.map_err(internal)?;
    Ok(UserOut { user })
}

async fn login_options(
    ctx: Ctx,
    input: Option<LoginOptionsIn>,
) -> std::result::Result<ChallengeOut, ORPCError> {
    let username = input.and_then(|i| i.username);
    Ok(
        auth::authentication_options(ctx.db(), ctx.site(), username.as_deref())
            .await
            .map_err(guard)?
            .into(),
    )
}

async fn login(ctx: Ctx, input: AssertionIn) -> std::result::Result<UserOut, ORPCError> {
    let user = match auth::authenticate(
        ctx.db(),
        ctx.site(),
        &input.challenge_id,
        &input.response.0,
    )
    .await
    {
        Ok(u) => u,
        Err(e) => {
            return Err(match e.downcast_ref::<AuthError>() {
                Some(a) => ORPCError::unauthorized(a.0.clone()),
                None => internal(e), // database errors are logged, not shown
            });
        }
    };
    ctx.start_session(&user).await.map_err(internal)?;
    Ok(UserOut { user })
}

async fn logout(ctx: Ctx, _: ()) -> std::result::Result<OkOut, ORPCError> {
    auth::delete_session(ctx.db(), ctx.session_id.as_deref())
        .await
        .map_err(internal)?;
    ctx.res
        .append("set-cookie", &auth::clear_session_cookie(ctx.site()));
    Ok(OkOut { ok: true })
}

async fn update_profile(a: Authed, input: ProfileIn) -> std::result::Result<UserOut, ORPCError> {
    if let Some(u) = &input.username
        && u.chars().count() > 40
    {
        return Err(ORPCError::bad_request(
            "username: 3 to 20 characters, letters, digits and _ only",
        ));
    }
    if let Some(d) = &input.display_name
        && d.chars().count() > auth::DISPLAY_NAME_MAX
    {
        return Err(ORPCError::bad_request(format!(
            "display name: 1 to {} characters",
            auth::DISPLAY_NAME_MAX
        )));
    }
    let user = auth::update_profile(
        a.ctx.db(),
        &a.user,
        input.username.as_deref(),
        input.display_name.as_deref(),
    )
    .await
    .map_err(guard)?;
    Ok(UserOut { user })
}

async fn add_passkey_options(a: Authed, _: ()) -> std::result::Result<ChallengeOut, ORPCError> {
    Ok(auth::add_passkey_options(a.ctx.db(), a.ctx.site(), &a.user)
        .await
        .map_err(guard)?
        .into())
}

async fn add_passkey(a: Authed, input: RegisterIn) -> std::result::Result<IdOut, ORPCError> {
    let id = auth::add_passkey(
        a.ctx.db(),
        a.ctx.site(),
        &a.user,
        &input.challenge_id,
        &input.response.0,
        input.device_name.as_deref(),
    )
    .await
    .map_err(guard)?;
    Ok(IdOut { id })
}

async fn passkeys(a: Authed, _: ()) -> std::result::Result<Vec<PasskeyInfo>, ORPCError> {
    auth::list_passkeys(a.ctx.db(), &a.user.id)
        .await
        .map_err(internal)
}

async fn remove_passkey(a: Authed, input: IdIn) -> std::result::Result<DeletedOut, ORPCError> {
    Ok(DeletedOut {
        deleted: auth::remove_passkey(a.ctx.db(), &a.user.id, &input.id)
            .await
            .map_err(guard)?,
    })
}

// device links: add a device that has no passkey yet (see auth.rs). Minting one needs a fresh
// passkey check on the inviting device: linkChallenge, then linkCreate with the assertion.

async fn link_challenge(a: Authed, _: ()) -> std::result::Result<ChallengeOut, ORPCError> {
    Ok(
        auth::device_link_challenge(a.ctx.db(), a.ctx.site(), &a.user)
            .await
            .map_err(guard)?
            .into(),
    )
}

async fn link_create(a: Authed, input: AssertionIn) -> std::result::Result<DeviceLink, ORPCError> {
    auth::create_device_link(
        a.ctx.db(),
        a.ctx.site(),
        &a.user,
        &input.challenge_id,
        &input.response.0,
    )
    .await
    .map_err(guard)
}

async fn link_info(ctx: Ctx, input: TokenIn) -> std::result::Result<LinkInfoOut, ORPCError> {
    let (user, expires_at) = auth::device_link_info(ctx.db(), &input.token)
        .await
        .map_err(guard)?;
    Ok(LinkInfoOut { user, expires_at })
}

async fn link_options(ctx: Ctx, input: TokenIn) -> std::result::Result<ChallengeOut, ORPCError> {
    Ok(
        auth::device_link_options(ctx.db(), ctx.site(), &input.token)
            .await
            .map_err(guard)?
            .into(),
    )
}

async fn link_finish(ctx: Ctx, input: RegisterIn) -> std::result::Result<UserOut, ORPCError> {
    let user = auth::finish_device_link(
        ctx.db(),
        ctx.site(),
        &input.challenge_id,
        &input.response.0,
        input.device_name.as_deref(),
    )
    .await
    .map_err(guard)?;
    ctx.start_session(&user).await.map_err(internal)?;
    Ok(UserOut { user })
}

async fn feed(a: Authed, _: ()) -> std::result::Result<FeedOut, ORPCError> {
    let token = auth::feed_token(a.ctx.db(), &a.user.id)
        .await
        .map_err(guard)?;
    let q = format!("?token={}", crate::links::urlencode(&token));
    let origin = &a.ctx.site().origin;
    Ok(FeedOut {
        token,
        rss: format!("{origin}/feed.xml{q}"),
        json: format!("{origin}/feed.json{q}"),
    })
}

// ---------- posts ----------

async fn list(a: Authed, input: Option<ListIn>) -> std::result::Result<Vec<Post>, ORPCError> {
    let input = input.unwrap_or(ListIn {
        limit: None,
        before: None,
        tag: None,
    });
    let limit = input.limit.unwrap_or(30).clamp(1, 100);
    let tag = match &input.tag {
        Some(t) => match normalize_tag(t) {
            Some(t) => Some(t),
            None => return Ok(vec![]),
        },
        None => None,
    };
    load_posts(
        &a.ctx.app,
        LoadOpts {
            viewer_id: Some(a.user.id.clone()),
            limit: Some(limit),
            before: input.before,
            tag,
            ..Default::default()
        },
    )
    .await
    .map_err(internal)
}

async fn tags(a: Authed, _: ()) -> std::result::Result<Vec<TagCount>, ORPCError> {
    load_tags(a.ctx.db(), &a.user.id).await.map_err(internal)
}

async fn get(a: Authed, input: IdIn) -> std::result::Result<PostOut, ORPCError> {
    let post = load_posts(
        &a.ctx.app,
        LoadOpts {
            viewer_id: Some(a.user.id.clone()),
            id: Some(input.id),
            limit: Some(1),
            ..Default::default()
        },
    )
    .await
    .map_err(internal)?
    .into_iter()
    .next()
    .ok_or_else(|| ORPCError::not_found("no such post"))?;
    let comments = load_comments(a.ctx.db(), &post.id)
        .await
        .map_err(internal)?;
    Ok(PostOut { post, comments })
}

async fn create(a: Authed, input: CreateIn) -> std::result::Result<CreateOut, ORPCError> {
    let app = &a.ctx.app;
    let text = input.text.trim().to_string();
    if text.chars().count() > POST_MAX {
        return Err(ORPCError::bad_request(format!(
            "posts are limited to {POST_MAX} characters"
        )));
    }
    if let Some(Upload(f)) = &input.image {
        if f.data.len() > IMAGE_MAX_BYTES {
            return Err(ORPCError::bad_request("pictures are limited to 10 MB"));
        }
        if !IMAGE_TYPES.contains(&f.content_type.as_deref().unwrap_or("")) {
            return Err(ORPCError::bad_request("JPEG, PNG, WebP or GIF only"));
        }
    }
    if text.is_empty() && input.image.is_none() {
        return Err(ORPCError::bad_request("say something or attach a picture"));
    }
    let extra = input.tags.unwrap_or_default();
    if extra.len() > TAGS_MAX * 2
        || extra
            .iter()
            .any(|t| t.trim().is_empty() || t.chars().count() > crate::links::TAG_MAX + 1)
    {
        return Err(ORPCError::bad_request("bad tag list"));
    }
    let id = auth::new_id();
    let (link, reference) = extract_links(&text);
    let tags = post_tags(&text, &extra);
    let created_at = now_iso();
    let image_key = match &input.image {
        Some(Upload(f)) => store_post_image(app, &id, f).await.map_err(internal)?,
        None => None,
    };
    let (image_type, image_w, image_h) = match &input.image {
        Some(Upload(f)) => (
            f.content_type.clone(),
            Some(input.image_width.unwrap_or(0) as i64),
            Some(input.image_height.unwrap_or(0) as i64),
        ),
        None => (None, None, None),
    };
    // `date` is a leftover from the single-admin version; databases created by it have it NOT NULL
    let mut stmts = vec![stmt(
        "INSERT INTO posts (id, user_id, date, text, link, ref, private, created_at, image_key, image_type, image_w, image_h) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        vec![
            v(id.clone()),
            v(a.user.id.clone()),
            v(created_at[..10].to_string()),
            v(text.clone()),
            opt(link.clone()),
            opt(reference.clone()),
            v(if input.private.unwrap_or(false) {
                1i64
            } else {
                0
            }),
            v(created_at.clone()),
            opt(image_key),
            opt(image_type),
            image_w.map(v).unwrap_or(libsql::Value::Null),
            image_h.map(v).unwrap_or(libsql::Value::Null),
        ],
    )];
    for tag in &tags {
        stmts.push(stmt(
            "INSERT INTO post_tags (post_id, tag) VALUES (?, ?)",
            vec![v(id.clone()), v(tag.clone())],
        ));
    }
    app.db.batch(stmts).await.map_err(internal)?;
    let urls: Vec<String> = [link, reference].into_iter().flatten().collect();
    let previews = ensure_previews(app, &urls).await.map_err(internal)?;
    let post = load_posts(
        app,
        LoadOpts {
            viewer_id: Some(a.user.id.clone()),
            id: Some(id),
            limit: Some(1),
            ..Default::default()
        },
    )
    .await
    .map_err(internal)?
    .into_iter()
    .next()
    .ok_or_else(|| ORPCError::internal_server_error("post vanished"))?;
    Ok(CreateOut { post, previews })
}

async fn remove(a: Authed, input: IdIn) -> std::result::Result<DeletedOut, ORPCError> {
    let app = &a.ctx.app;
    let owner = match post_owner_id(app.db(), &input.id).await.map_err(internal)? {
        Some(o) => o,
        None => return Ok(DeletedOut { deleted: false }),
    };
    if owner != a.user.id && !app.site.is_owner(&a.user) {
        return Err(ORPCError::forbidden("not your post"));
    }
    drop_post_image(app, &input.id).await.map_err(internal)?;
    let stmts: Vec<Stmt> = [
        "DELETE FROM likes WHERE post_id = ?",
        "DELETE FROM comments WHERE post_id = ?",
        "DELETE FROM post_tags WHERE post_id = ?",
        "DELETE FROM posts WHERE id = ?",
    ]
    .iter()
    .map(|sql| stmt(sql, vec![v(input.id.clone())]))
    .collect();
    app.db.batch(stmts).await.map_err(internal)?;
    prune_previews(app).await.map_err(internal)?;
    Ok(DeletedOut { deleted: true })
}

async fn like(a: Authed, input: IdIn) -> std::result::Result<LikeOut, ORPCError> {
    let db = a.ctx.db();
    if visible_post_owner_id(db, &input.id, &a.user)
        .await
        .map_err(internal)?
        .is_none()
    {
        return Err(ORPCError::not_found("no such post"));
    }
    let deleted = db
        .exec(
            "DELETE FROM likes WHERE post_id = ? AND user_id = ?",
            vec![v(input.id.clone()), v(a.user.id.clone())],
        )
        .await
        .map_err(internal)?;
    let liked = deleted == 0;
    if liked {
        db.exec(
            "INSERT INTO likes (post_id, user_id, created_at) VALUES (?, ?, ?)",
            vec![v(input.id.clone()), v(a.user.id.clone()), v(now_iso())],
        )
        .await
        .map_err(internal)?;
    }
    let likes = db
        .one(
            "SELECT COUNT(*) AS n FROM likes WHERE post_id = ?",
            vec![v(input.id)],
        )
        .await
        .map_err(internal)?
        .map(|r| r.num("n"))
        .unwrap_or(0);
    Ok(LikeOut {
        liked,
        likes: likes as u32,
    })
}

async fn comment(a: Authed, input: CommentIn) -> std::result::Result<Comment, ORPCError> {
    let db = a.ctx.db();
    let text = input.text.trim().to_string();
    if text.is_empty() || text.chars().count() > COMMENT_MAX {
        return Err(ORPCError::bad_request(format!(
            "comments are 1 to {COMMENT_MAX} characters"
        )));
    }
    if visible_post_owner_id(db, &input.id, &a.user)
        .await
        .map_err(internal)?
        .is_none()
    {
        return Err(ORPCError::not_found("no such post"));
    }
    let id = auth::new_id();
    let created_at = now_iso();
    db.exec(
        "INSERT INTO comments (id, post_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)",
        vec![
            v(id.clone()),
            v(input.id.clone()),
            v(a.user.id.clone()),
            v(text.clone()),
            v(created_at.clone()),
        ],
    )
    .await
    .map_err(internal)?;
    Ok(Comment {
        id,
        post_id: input.id,
        text,
        created_at,
        author: a.user,
    })
}

async fn delete_comment(a: Authed, input: IdIn) -> std::result::Result<DeletedOut, ORPCError> {
    let db = a.ctx.db();
    let row = db
        .one("SELECT c.user_id, p.user_id AS post_user FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.id = ?", vec![v(input.id.clone())])
        .await
        .map_err(internal)?;
    let row = match row {
        Some(r) => r,
        None => return Ok(DeletedOut { deleted: false }),
    };
    let allowed = row.str("user_id").as_deref() == Some(&a.user.id)
        || row.str("post_user").as_deref() == Some(&a.user.id)
        || a.ctx.site().is_owner(&a.user);
    if !allowed {
        return Err(ORPCError::forbidden("not your comment"));
    }
    let n = db
        .exec("DELETE FROM comments WHERE id = ?", vec![v(input.id)])
        .await
        .map_err(internal)?;
    Ok(DeletedOut { deleted: n > 0 })
}

// ---------- users ----------

async fn get_user(a: Authed, input: UserIn) -> std::result::Result<UserPostsOut, ORPCError> {
    let user = auth::user_by_username(a.ctx.db(), &input.username)
        .await
        .map_err(internal)?
        .ok_or_else(|| ORPCError::not_found("no such user"))?;
    let posts = load_posts(
        &a.ctx.app,
        LoadOpts {
            viewer_id: Some(a.user.id.clone()),
            author_id: Some(user.id.clone()),
            before: input.before,
            limit: Some(50),
            ..Default::default()
        },
    )
    .await
    .map_err(internal)?;
    Ok(UserPostsOut { user, posts })
}

// ---------- previews ----------

async fn refresh(a: Authed, input: RefreshIn) -> std::result::Result<RefreshOut, ORPCError> {
    let app = &a.ctx.app;
    if input.url.len() > 2000
        || url::Url::parse(&input.url)
            .map(|u| !matches!(u.scheme(), "http" | "https"))
            .unwrap_or(true)
    {
        return Err(ORPCError::bad_request("not a valid URL"));
    }
    if !app.site.is_owner(&a.user) {
        let mine = app
            .db
            .one(
                "SELECT 1 FROM posts WHERE user_id = ? AND (link = ? OR ref = ?) LIMIT 1",
                vec![
                    v(a.user.id.clone()),
                    v(input.url.clone()),
                    v(input.url.clone()),
                ],
            )
            .await
            .map_err(internal)?;
        if mine.is_none() {
            return Err(ORPCError::forbidden(
                "that link is not in one of your posts",
            ));
        }
    }
    Ok(RefreshOut {
        error: refresh_preview(app, &input.url).await.map_err(internal)?,
    })
}

trait DbOf {
    fn db(&self) -> &Db;
}
impl DbOf for App {
    fn db(&self) -> &Db {
        &self.db
    }
}

// ---------- the router ----------

/// Procedures are not Clone, so this is called once per transport (/rpc and /api).
pub fn build_router() -> Router<Ctx> {
    router! {
        "health" => os::<Ctx>().route(Route::get("/health").summary("Liveness + readiness (database round trip) + build info"))
            .output(specta::<Health>()).handler(health),
        "auth" => {
            "status" => os::<Ctx>().route(Route::get("/auth/status").summary("Who am I?")).output(specta::<StatusOut>()).handler(status),
            "checkUsername" => os::<Ctx>().route(Route::get("/auth/username/{username}").summary("Is a username available?"))
                .input(specta::<UsernameIn>()).output(specta::<Availability>()).handler(check_username),
            "registerOptions" => os::<Ctx>().route(Route::post("/auth/register/options").summary("Start creating an account"))
                .input(specta::<UsernameIn>()).output(specta::<ChallengeOut>()).handler(register_options),
            "register" => os::<Ctx>().route(Route::post("/auth/register").summary("Finish creating an account; signs you in"))
                .input(specta::<RegisterIn>()).output(specta::<UserOut>()).handler(register),
            "loginOptions" => os::<Ctx>().route(Route::post("/auth/login/options").summary("Start a passkey sign-in (username optional)"))
                .input(specta::<Option<LoginOptionsIn>>()).output(specta::<ChallengeOut>()).handler(login_options),
            "login" => os::<Ctx>().route(Route::post("/auth/login").summary("Finish a passkey sign-in; sets the session cookie"))
                .input(specta::<AssertionIn>()).output(specta::<UserOut>()).handler(login),
            "logout" => os::<Ctx>().route(Route::post("/auth/logout").summary("End the session")).output(specta::<OkOut>()).handler(logout),
            "updateProfile" => authed().route(Route::patch("/auth/me").summary("Change my username and/or display name"))
                .input(specta::<ProfileIn>()).output(specta::<UserOut>()).handler(update_profile),
            "addPasskeyOptions" => authed().route(Route::post("/auth/passkeys/options").summary("Start adding a passkey to my account"))
                .output(specta::<ChallengeOut>()).handler(add_passkey_options),
            "addPasskey" => authed().route(Route::post("/auth/passkeys").summary("Finish adding a passkey"))
                .input(specta::<RegisterIn>()).output(specta::<IdOut>()).handler(add_passkey),
            "passkeys" => authed().route(Route::get("/auth/passkeys").summary("My passkeys")).output(specta::<Vec<PasskeyInfo>>()).handler(passkeys),
            "removePasskey" => authed().route(Route::delete("/auth/passkeys/{id}").summary("Remove one of my passkeys"))
                .input(specta::<IdIn>()).output(specta::<DeletedOut>()).handler(remove_passkey),
            "linkChallenge" => authed().route(Route::post("/auth/link/challenge").summary("Start adding another device: a passkey check on this one"))
                .output(specta::<ChallengeOut>()).handler(link_challenge),
            "linkCreate" => authed().route(Route::post("/auth/link").summary("Make a short-lived link that adds another device to my account (answers linkChallenge)"))
                .input(specta::<AssertionIn>()).output(specta::<DeviceLink>()).handler(link_create),
            "linkInfo" => os::<Ctx>().route(Route::get("/auth/link/{token}").summary("Whose account a device link adds to"))
                .input(specta::<TokenIn>()).output(specta::<LinkInfoOut>()).handler(link_info),
            "linkOptions" => os::<Ctx>().route(Route::post("/auth/link/{token}/options").summary("Start registering this device's passkey through a device link"))
                .input(specta::<TokenIn>()).output(specta::<ChallengeOut>()).handler(link_options),
            "linkFinish" => os::<Ctx>().route(Route::post("/auth/link/finish").summary("Finish a device link: stores the passkey and signs this device in"))
                .input(specta::<RegisterIn>()).output(specta::<UserOut>()).handler(link_finish),
            "feed" => authed().route(Route::get("/auth/feed").summary("My private feed URLs (the token in them is a secret)"))
                .output(specta::<FeedOut>()).handler(feed),
        },
        "posts" => {
            "list" => authed().route(Route::get("/posts").summary("Timeline, newest first (your private posts included; ?tag= filters by label)"))
                .input(specta::<Option<ListIn>>()).output(specta::<Vec<Post>>()).handler(list),
            "get" => authed().route(Route::get("/posts/{id}").summary("One post with its comments"))
                .input(specta::<IdIn>()).output(specta::<PostOut>()).handler(get),
            "create" => authed().route(Route::post("/posts").summary("Post. Tags come from #hashtags in the text and/or `tags`; `private` keeps it to yourself; `image` (multipart) attaches a picture, then `text` may be empty"))
                .input(specta::<CreateIn>()).output(specta::<CreateOut>()).handler(create),
            "delete" => authed().route(Route::delete("/posts/{id}").summary("Delete my post (the owner may delete any)"))
                .input(specta::<IdIn>()).output(specta::<DeletedOut>()).handler(remove),
            "like" => authed().route(Route::post("/posts/{id}/like").summary("Toggle my like"))
                .input(specta::<IdIn>()).output(specta::<LikeOut>()).handler(like),
            "comment" => authed().route(Route::post("/posts/{id}/comments").summary("Comment on a post"))
                .input(specta::<CommentIn>()).output(specta::<Comment>()).handler(comment),
            "deleteComment" => authed().route(Route::delete("/comments/{id}").summary("Delete my comment (post author and owner may too)"))
                .input(specta::<IdIn>()).output(specta::<DeletedOut>()).handler(delete_comment),
            "tags" => authed().route(Route::get("/tags").summary("Labels in use, most used first")).output(specta::<Vec<TagCount>>()).handler(tags),
        },
        "users" => {
            "get" => authed().route(Route::get("/users/{username}").summary("A user and their posts (private ones only when they are you)"))
                .input(specta::<UserIn>()).output(specta::<UserPostsOut>()).handler(get_user),
        },
        "previews" => {
            "refresh" => authed().route(Route::post("/previews/refresh").summary("Re-capture the preview of a link in one of my posts"))
                .input(specta::<RefreshIn>()).output(specta::<RefreshOut>()).handler(refresh),
        },
    }
}

/// The TypeScript side of the router, for `src/api.ts`.
pub fn bindings_ts() -> Result<String> {
    orpc_specta::generate_ts(&build_router()).map_err(|e| anyhow::anyhow!("{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `src/bindings.ts` is checked in so the frontend builds without Rust; regenerate it with
    /// `cargo run -- export-types src/bindings.ts` when the API changes.
    #[test]
    fn bindings_are_current() {
        let expected = bindings_ts().unwrap();
        let actual =
            std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/bindings.ts"))
                .unwrap_or_default();
        assert!(
            actual == expected,
            "src/bindings.ts is stale: run `cargo run -- export-types src/bindings.ts`"
        );
    }

    #[tokio::test]
    async fn health_reports_a_hung_database() {
        // a database that never answers: the probe gives up after the timeout
        let never = async { std::future::pending::<Result<()>>().await };
        let res = tokio::time::timeout(std::time::Duration::from_millis(50), never).await;
        assert!(res.is_err());
    }
}
