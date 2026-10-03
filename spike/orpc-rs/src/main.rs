// Spike: can orpc-rs serve murmur's API shape to the existing @orpc/client?
// Exercises: cookie-reading context, set-cookie from a procedure, authed middleware,
// optional input, multipart file upload, ORPCError with data, OpenAPI routes with
// path params and query strings, specta type export.

use std::sync::{Arc, Mutex};

use axum::{extract::Request, middleware::Next, response::Response};
use http::{HeaderName, HeaderValue};
use orpc::*;
use orpc_specta::{Type, specta};
use serde::{Deserialize, Serialize};
use specta::datatype::DataType;

// ---------- response headers: the one thing orpc-axum lacks ----------

/// Shared per-request list of headers a procedure wants on the response (set-cookie).
/// Lives in the request extensions; `res_headers_layer` copies it onto the response.
#[derive(Clone, Default)]
struct ResHeaders(Arc<Mutex<Vec<(HeaderName, HeaderValue)>>>);

impl ResHeaders {
    fn append(&self, name: &'static str, value: String) {
        if let Ok(v) = HeaderValue::from_str(&value) {
            self.0
                .lock()
                .unwrap()
                .push((HeaderName::from_static(name), v));
        }
    }
}

async fn res_headers_layer(mut req: Request, next: Next) -> Response {
    let rh = ResHeaders::default();
    req.extensions_mut().insert(rh.clone());
    let mut res = next.run(req).await;
    for (k, v) in rh.0.lock().unwrap().drain(..) {
        res.headers_mut().append(k, v);
    }
    res
}

// ---------- context ----------

#[derive(Clone)]
struct Ctx {
    session_id: Option<String>,
    token: Option<String>,
    res: ResHeaders,
}

#[derive(Clone)]
struct Authed {
    user: Author,
    #[allow(dead_code)]
    base: Ctx,
}

fn ctx_from(parts: &http::request::Parts) -> Ctx {
    let cookie = parts
        .headers
        .get("cookie")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let session_id = cookie
        .split(';')
        .map(str::trim)
        .find_map(|p| p.strip_prefix("session=").map(str::to_string));
    let token = parts
        .headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_string);
    Ctx {
        session_id,
        token,
        res: parts
            .extensions
            .get::<ResHeaders>()
            .cloned()
            .unwrap_or_default(),
    }
}

fn resolve_user(ctx: &Ctx) -> Option<Author> {
    // stand-in for the sessions table / ADMIN_TOKEN lookup
    match (&ctx.session_id, &ctx.token) {
        (Some(s), _) if s == "s3cret" => Some(Author::johan()),
        (_, Some(t)) if t == "admin-token" => Some(Author::johan()),
        _ => None,
    }
}

fn authed() -> Builder<Ctx, Authed> {
    os::<Ctx>().use_middleware(middleware_fn(
        |ctx: Ctx, mw: MiddlewareCtx<Authed>| async move {
            match resolve_user(&ctx) {
                Some(user) => mw.next(Authed { user, base: ctx }).await,
                None => Err(ORPCError::unauthorized("sign in first").into()),
            }
        },
    ))
}

// ---------- types ----------

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
struct Author {
    id: String,
    username: String,
    #[serde(rename = "displayName")]
    display_name: String,
}
impl Author {
    fn johan() -> Self {
        Author {
            id: "u1".into(),
            username: "johan".into(),
            display_name: "Johan".into(),
        }
    }
}

#[derive(Serialize, Deserialize, Type)]
struct StatusOut {
    user: Option<Author>,
}

#[derive(Serialize, Deserialize, Type)]
struct UserOut {
    user: Author,
}

#[derive(Serialize, Deserialize, Type)]
struct Health {
    status: String,
    db: String,
    uptime: u32,
}

#[derive(Serialize, Deserialize, Type)]
struct UsernameIn {
    username: String,
}

#[derive(Serialize, Deserialize, Type)]
struct Availability {
    available: bool,
    reason: Option<String>,
}

/// `loginOptions` takes an optional object with an optional username.
#[derive(Serialize, Deserialize, Type)]
struct LoginOptionsIn {
    #[serde(default)]
    username: Option<String>,
}

#[derive(Serialize, Deserialize, Type)]
struct ChallengeOut {
    #[serde(rename = "challengeId")]
    challenge_id: String,
    /// WebAuthn options: passed through untyped, like `z.any()` today
    options: AnyJson,
}

/// A number that may arrive as a JSON number (RPC) or a query-string string (OpenAPI).
fn lenient_u32<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<u32>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum NumOrStr {
        N(u32),
        S(String),
    }
    Ok(match Option::<NumOrStr>::deserialize(d)? {
        None => None,
        Some(NumOrStr::N(n)) => Some(n),
        Some(NumOrStr::S(s)) => Some(s.parse().map_err(serde::de::Error::custom)?),
    })
}

#[derive(Serialize, Deserialize, Type)]
struct ListIn {
    #[serde(default, deserialize_with = "lenient_u32")]
    limit: Option<u32>,
    #[serde(default)]
    before: Option<String>,
    #[serde(default)]
    tag: Option<String>,
}

/// Untyped JSON, like `z.any()`: exports as `any`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(transparent)]
struct AnyJson(serde_json::Value);
impl Type for AnyJson {
    fn inline(_: &mut specta::TypeCollection, _: specta::Generics) -> DataType {
        DataType::Any
    }
}

/// An uploaded file. specta has no notion of `File`, so it exports as `any`; the
/// browser passes a `File` and @orpc/client puts it in a multipart part.
#[derive(Debug, Deserialize, Serialize)]
#[serde(transparent)]
struct Upload(ORPCFile);
impl Type for Upload {
    fn inline(_: &mut specta::TypeCollection, _: specta::Generics) -> DataType {
        DataType::Any
    }
}

#[derive(Serialize, Deserialize, Type)]
struct CreateIn {
    #[serde(default)]
    text: String,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    private: Option<bool>,
    #[serde(default)]
    image: Option<Upload>,
    #[serde(rename = "imageWidth", default, deserialize_with = "lenient_u32")]
    image_width: Option<u32>,
}

#[derive(Serialize, Deserialize, Type)]
struct CreateOut {
    id: String,
    text: String,
    tags: Vec<String>,
    private: bool,
    author: Author,
    image: Option<ImageInfo>,
}

#[derive(Serialize, Deserialize, Type)]
struct ImageInfo {
    bytes: u32,
    #[serde(rename = "type")]
    kind: String,
    name: Option<String>,
    width: Option<u32>,
    sha_prefix: String,
}

#[derive(Serialize, Deserialize, Type)]
struct Ok_ {
    ok: bool,
}

// ---------- handlers ----------

async fn health(_: Ctx, _: ()) -> Result<Health, ORPCError> {
    Ok(Health {
        status: "ok".into(),
        db: "ok".into(),
        uptime: 1,
    })
}

/// What `health` does when the database is down: 503 with a degraded body in `data`.
async fn boom(_: Ctx, _: ()) -> Result<Health, ORPCError> {
    Err(ORPCError::new(ErrorCode::ServiceUnavailable, "database error: connection refused")
        .with_data(serde_json::json!({ "status": "degraded", "db": "error: connection refused", "storage": "database" })))
}

async fn status(ctx: Ctx, _: ()) -> Result<StatusOut, ORPCError> {
    Ok(StatusOut {
        user: resolve_user(&ctx),
    })
}

async fn check_username(_: Ctx, input: UsernameIn) -> Result<Availability, ORPCError> {
    let taken = input.username == "johan";
    Ok(Availability {
        available: !taken,
        reason: taken.then(|| "that username is taken".to_string()),
    })
}

async fn login_options(_: Ctx, input: Option<LoginOptionsIn>) -> Result<ChallengeOut, ORPCError> {
    let who = input.and_then(|i| i.username);
    Ok(ChallengeOut {
        challenge_id: "ch1".into(),
        options: AnyJson(
            serde_json::json!({ "challenge": "abc", "rpId": "localhost", "allowCredentials": who.map(|u| vec![u]) }),
        ),
    })
}

async fn login(ctx: Ctx, _: ()) -> Result<UserOut, ORPCError> {
    ctx.res.append(
        "set-cookie",
        "session=s3cret; Path=/; HttpOnly; SameSite=Lax; Max-Age=7776000".into(),
    );
    Ok(UserOut {
        user: Author::johan(),
    })
}

async fn logout(ctx: Ctx, _: ()) -> Result<Ok_, ORPCError> {
    ctx.res.append(
        "set-cookie",
        "session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0".into(),
    );
    Ok(Ok_ { ok: true })
}

async fn list(ctx: Authed, input: Option<ListIn>) -> Result<Vec<CreateOut>, ORPCError> {
    let limit = input.as_ref().and_then(|i| i.limit).unwrap_or(30) as usize;
    let tag = input.as_ref().and_then(|i| i.tag.clone());
    Ok((0..limit.min(3))
        .map(|i| CreateOut {
            id: format!("p{i}"),
            text: format!("post {i}"),
            tags: tag.iter().cloned().collect(),
            private: false,
            author: ctx.user.clone(),
            image: None,
        })
        .collect())
}

async fn create(ctx: Authed, input: CreateIn) -> Result<CreateOut, ORPCError> {
    if input.text.is_empty() && input.image.is_none() {
        return Err(ORPCError::bad_request("say something or attach a picture"));
    }
    let image = input.image.map(|Upload(f)| ImageInfo {
        bytes: f.data.len() as u32,
        kind: f.content_type.clone().unwrap_or_default(),
        name: f.name.clone(),
        width: input.image_width,
        sha_prefix: format!(
            "{:02x}{:02x}",
            f.data.first().copied().unwrap_or(0),
            f.data.get(1).copied().unwrap_or(0)
        ),
    });
    Ok(CreateOut {
        id: "p-new".into(),
        text: input.text,
        tags: input.tags.unwrap_or_default(),
        private: input.private.unwrap_or(false),
        author: ctx.user,
        image,
    })
}

// ---------- router (built twice: one instance per transport, procedures are not Clone) ----------

fn build() -> Router<Ctx> {
    router! {
        "health" => os::<Ctx>().route(Route::get("/health")).output(specta::<Health>()).handler(health),
        "boom" => os::<Ctx>().route(Route::get("/boom")).output(specta::<Health>()).handler(boom),
        "auth" => {
            "status" => os::<Ctx>().route(Route::get("/auth/status")).output(specta::<StatusOut>()).handler(status),
            "checkUsername" => os::<Ctx>().route(Route::get("/auth/username/{username}"))
                .input(specta::<UsernameIn>()).output(specta::<Availability>()).handler(check_username),
            "loginOptions" => os::<Ctx>().route(Route::post("/auth/login/options"))
                .input(specta::<Option<LoginOptionsIn>>()).output(specta::<ChallengeOut>()).handler(login_options),
            "login" => os::<Ctx>().route(Route::post("/auth/login")).output(specta::<UserOut>()).handler(login),
            "logout" => os::<Ctx>().route(Route::post("/auth/logout")).output(specta::<Ok_>()).handler(logout),
        },
        "posts" => {
            "list" => authed().route(Route::get("/posts")).input(specta::<Option<ListIn>>()).output(specta::<Vec<CreateOut>>()).handler(list),
            "create" => authed().route(Route::post("/posts")).input(specta::<CreateIn>()).output(specta::<CreateOut>()).handler(create),
        },
    }
}

#[tokio::main]
async fn main() {
    let out = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "bindings.ts".into());
    orpc_specta::export_ts(&build(), &out).expect("export types");
    eprintln!("wrote {out}");

    let rpc = orpc_axum::into_router(build(), ctx_from);
    let api =
        orpc_axum::into_openapi_router(build(), ctx_from, orpc_axum::OpenAPIConfig::default());
    let app = axum::Router::new()
        .nest("/rpc", rpc)
        .nest("/api", api)
        .layer(axum::middleware::from_fn(res_headers_layer));

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8081);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .unwrap();
    eprintln!("spike listening on http://127.0.0.1:{port}");
    axum::serve(listener, app).await.unwrap();
}
