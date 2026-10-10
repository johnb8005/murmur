//! Accounts: a unique username plus one or more passkeys (WebAuthn). No passwords, no email.
//! Challenges and sessions live in the database so any instance can finish what another started.
//! Passkeys are registered as discoverable, so sign-in needs no username (but accepts one).
//! A signed-in device can mint a short-lived device link after a fresh passkey check: opened on
//! another device, it registers a passkey there for the same account and signs it in. Feed tokens
//! let RSS readers in.

use std::collections::HashSet;
use std::sync::LazyLock;

use anyhow::Result;
use base64::Engine;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::{Db, Rec, is_unique_violation, opt, stmt, v};
use crate::links::{APP_NAME, Author, now_iso};
use crate::webauthn::{self, AuthenticationResponse, RegistrationResponse, Relying, StoredPasskey};

const CHALLENGE_TTL_MS: i64 = 5 * 60_000;
const DEVICE_LINK_TTL_MS: i64 = 10 * 60_000;
const SESSION_TTL_MS: i64 = 90 * 24 * 3_600_000;
pub const SESSION_COOKIE: &str = "session";
pub const DISPLAY_NAME_MAX: usize = 40;

static USERNAME_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[a-z0-9_]{3,20}$").unwrap());
static RESERVED: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        "admin",
        "root",
        "me",
        "login",
        "logout",
        "register",
        "settings",
        "share",
        "link",
        "api",
        "rpc",
        "p",
        "u",
        "feed",
        "previews",
        "murmur",
        "system",
        "null",
        "undefined",
    ]
    .into_iter()
    .collect()
});

/// Site identity: the WebAuthn relying party and who owns the place.
#[derive(Clone)]
pub struct Site {
    /// public origin, e.g. https://murmur.example (the WebAuthn origin)
    pub origin: String,
    pub rp_id: String,
    pub secure_cookies: bool,
    /// username of the site owner: may moderate, receives legacy posts, and is who ADMIN_TOKEN acts as
    pub owner_username: String,
}

impl Site {
    pub fn from_env() -> Site {
        let site_url = std::env::var("SITE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "https://murmur.johanboissard.me".into());
        let url = url::Url::parse(&site_url)
            .unwrap_or_else(|_| url::Url::parse("https://murmur.johanboissard.me").unwrap());
        Site {
            origin: url.origin().ascii_serialization(),
            rp_id: url.host_str().unwrap_or("localhost").to_string(),
            secure_cookies: url.scheme() == "https",
            owner_username: std::env::var("OWNER_USERNAME")
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "johan".into())
                .to_lowercase(),
        }
    }
    fn rp(&self) -> Relying<'_> {
        Relying {
            name: APP_NAME,
            id: &self.rp_id,
            origin: &self.origin,
        }
    }
    pub fn is_owner(&self, user: &Author) -> bool {
        user.username == self.owner_username
    }
}

/// A user-facing auth failure (400 in the API) as opposed to a database or bug (500).
#[derive(Debug)]
pub struct AuthError(pub String);
impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for AuthError {}

fn auth_err<T>(msg: &str) -> Result<T> {
    Err(anyhow::Error::new(AuthError(msg.to_string())))
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
}

fn rand_token() -> String {
    let mut bytes = [0u8; 24];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn after(ms: i64) -> String {
    (chrono::Utc::now() + chrono::Duration::milliseconds(ms))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn to_author(r: &Rec) -> Author {
    Author {
        id: r.req("id"),
        username: r.req("username"),
        display_name: r.req("display_name"),
    }
}

// ---------- users ----------

pub fn normalize_username(u: &str) -> String {
    u.trim().to_lowercase()
}

pub fn validate_username(u: &str) -> Result<String> {
    let n = normalize_username(u);
    if !USERNAME_RE.is_match(&n) {
        return auth_err("username: 3 to 20 characters, letters, digits and _ only");
    }
    if RESERVED.contains(n.as_str()) {
        return auth_err("that username is reserved");
    }
    Ok(n)
}

pub async fn user_by_username(db: &Db, username: &str) -> Result<Option<Author>> {
    Ok(db
        .one(
            "SELECT id, username, display_name FROM users WHERE username = ?",
            vec![v(normalize_username(username))],
        )
        .await?
        .as_ref()
        .map(to_author))
}

pub async fn user_by_id(db: &Db, id: &str) -> Result<Option<Author>> {
    Ok(db
        .one(
            "SELECT id, username, display_name FROM users WHERE id = ?",
            vec![v(id)],
        )
        .await?
        .as_ref()
        .map(to_author))
}

pub async fn username_available(db: &Db, username: &str) -> Result<bool> {
    Ok(user_by_username(db, username).await?.is_none())
}

/// Change username and/or display name. Posts, likes, comments and passkeys follow the user id.
pub async fn update_profile(
    db: &Db,
    user: &Author,
    username: Option<&str>,
    display_name: Option<&str>,
) -> Result<Author> {
    let mut next = user.clone();
    if let Some(u) = username {
        let u = validate_username(u)?;
        if u != user.username && !username_available(db, &u).await? {
            return auth_err("that username is taken");
        }
        next.username = u;
    }
    if let Some(d) = display_name {
        let d = d.split_whitespace().collect::<Vec<_>>().join(" ");
        if d.is_empty() || d.chars().count() > DISPLAY_NAME_MAX {
            return auth_err(&format!("display name: 1 to {DISPLAY_NAME_MAX} characters"));
        }
        next.display_name = d;
    }
    match db
        .exec(
            "UPDATE users SET username = ?, display_name = ? WHERE id = ?",
            vec![
                v(next.username.clone()),
                v(next.display_name.clone()),
                v(user.id.clone()),
            ],
        )
        .await
    {
        Ok(_) => Ok(next),
        Err(e) if is_unique_violation(&e) => auth_err("that username is taken"),
        Err(e) => Err(e),
    }
}

/// Posts from the single-admin version have no user: hand them to the owner once they exist.
pub async fn adopt_legacy_posts(db: &Db, site: &Site) -> Result<()> {
    db.exec(
        "UPDATE posts SET user_id = (SELECT id FROM users WHERE username = ?)
         WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM users WHERE username = ?)",
        vec![
            v(site.owner_username.clone()),
            v(site.owner_username.clone()),
        ],
    )
    .await?;
    Ok(())
}

// ---------- challenges ----------

// "reauth" is a sign-in challenge for an already signed-in user. "device-link" rows are not
// WebAuthn challenges but device links; "link-add" is the registration challenge a device link
// turns into, and remembers the link it came from.

struct Challenge {
    challenge: String,
    username: Option<String>,
    user_id: Option<String>,
    link: Option<String>,
    expires_at: String,
}

async fn store_challenge(
    db: &Db,
    challenge: &str,
    kind: &str,
    username: Option<&str>,
    user_id: Option<&str>,
    link: Option<&str>,
    ttl: i64,
) -> Result<String> {
    let id = rand_token();
    db.exec(
        "INSERT INTO challenges (id, challenge, kind, username, user_id, link, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        vec![v(id.clone()), v(challenge), v(kind), opt(username.map(String::from)), opt(user_id.map(String::from)), opt(link.map(String::from)), v(after(ttl))],
    )
    .await?;
    Ok(id)
}

async fn read_challenge(db: &Db, id: &str, kind: &str) -> Result<Option<Challenge>> {
    let row = db.one("SELECT challenge, kind, username, user_id, link, expires_at FROM challenges WHERE id = ?", vec![v(id)]).await?;
    Ok(row
        .filter(|r| r.req("expires_at") >= now_iso() && r.req("kind") == kind)
        .map(|r| Challenge {
            challenge: r.req("challenge"),
            username: r.str("username"),
            user_id: r.str("user_id"),
            link: r.str("link"),
            expires_at: r.req("expires_at"),
        }))
}

/// One-shot: returns the challenge row and deletes it; fails if unknown, expired or the wrong kind.
async fn take_challenge(db: &Db, id: &str, kind: &str) -> Result<Challenge> {
    let row = read_challenge(db, id, kind).await?;
    db.exec(
        "DELETE FROM challenges WHERE id = ? OR expires_at < ?",
        vec![v(id), v(now_iso())],
    )
    .await?;
    match row {
        Some(c) => Ok(c),
        None => auth_err("challenge expired, try again"),
    }
}

// ---------- passkeys ----------

async fn passkeys_of(db: &Db, user_id: &str) -> Result<Vec<StoredPasskey>> {
    Ok(db
        .query(
            "SELECT id, public_key, counter, transports FROM passkeys WHERE user_id = ?",
            vec![v(user_id)],
        )
        .await?
        .iter()
        .map(|r| StoredPasskey {
            id: r.req("id"),
            public_key: r.blob("public_key").unwrap_or_default(),
            counter: r.num("counter"),
            transports: parse_transports(r.str("transports")),
        })
        .collect())
}

fn parse_transports(s: Option<String>) -> Vec<String> {
    s.and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub struct Options {
    pub challenge_id: String,
    pub options: serde_json::Value,
}

async fn registration_options_for(
    db: &Db,
    site: &Site,
    user_id: &str,
    username: &str,
    kind: &str,
    link: Option<&str>,
) -> Result<Options> {
    let existing = if kind == "register" {
        vec![]
    } else {
        passkeys_of(db, user_id).await?
    };
    let challenge = webauthn::new_challenge();
    let options =
        webauthn::registration_options(&site.rp(), &challenge, user_id, username, &existing);
    let challenge_id = store_challenge(
        db,
        &challenge,
        kind,
        Some(username),
        Some(user_id),
        link,
        CHALLENGE_TTL_MS,
    )
    .await?;
    Ok(Options {
        challenge_id,
        options,
    })
}

pub async fn registration_options(db: &Db, site: &Site, raw_username: &str) -> Result<Options> {
    let username = validate_username(raw_username)?;
    if !username_available(db, &username).await? {
        return auth_err("that username is taken");
    }
    registration_options_for(db, site, &new_id(), &username, "register", None).await
}

fn parse_registration(response: &serde_json::Value) -> Result<RegistrationResponse> {
    match serde_json::from_value(response.clone()) {
        Ok(r) => Ok(r),
        Err(_) => auth_err("registration could not be verified"),
    }
}

fn parse_authentication(response: &serde_json::Value) -> Result<AuthenticationResponse> {
    match serde_json::from_value(response.clone()) {
        Ok(r) => Ok(r),
        Err(_) => auth_err("sign-in could not be verified"),
    }
}

fn verified_registration(
    site: &Site,
    challenge: &str,
    response: &serde_json::Value,
) -> Result<StoredPasskey> {
    let resp = parse_registration(response)?;
    match webauthn::verify_registration(&site.rp(), challenge, &resp) {
        Ok(p) => Ok(p),
        Err(e) => {
            eprintln!("registration rejected: {e:#}");
            auth_err("registration could not be verified")
        }
    }
}

pub async fn register(
    db: &Db,
    site: &Site,
    challenge_id: &str,
    response: &serde_json::Value,
    device_name: Option<&str>,
) -> Result<Author> {
    let ch = take_challenge(db, challenge_id, "register").await?;
    let c = verified_registration(site, &ch.challenge, response)?;
    let user = Author {
        id: ch.user_id.unwrap_or_default(),
        username: ch.username.clone().unwrap_or_default(),
        display_name: ch.username.unwrap_or_default(),
    };
    let now = now_iso();
    let res = db
        .batch(vec![
            stmt(
                "INSERT INTO users (id, username, display_name, created_at) VALUES (?, ?, ?, ?)",
                vec![v(user.id.clone()), v(user.username.clone()), v(user.display_name.clone()), v(now.clone())],
            ),
            stmt(
                "INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                vec![
                    v(c.id),
                    v(user.id.clone()),
                    v(c.public_key),
                    v(c.counter),
                    v(serde_json::to_string(&c.transports).unwrap_or_else(|_| "[]".into())),
                    opt(device_name.map(String::from)),
                    v(now),
                ],
            ),
        ])
        .await;
    if let Err(e) = res {
        if is_unique_violation(&e) {
            return auth_err("that username is taken");
        }
        return Err(e);
    }
    if user.username == site.owner_username {
        adopt_legacy_posts(db, site).await?;
    }
    Ok(user)
}

pub async fn add_passkey_options(db: &Db, site: &Site, user: &Author) -> Result<Options> {
    registration_options_for(db, site, &user.id, &user.username, "add", None).await
}

/// Verify a registration response against its challenge and store the passkey for `user_id`.
async fn store_verified_passkey(
    db: &Db,
    site: &Site,
    user_id: &str,
    challenge: &str,
    response: &serde_json::Value,
    device_name: Option<&str>,
) -> Result<String> {
    let c = verified_registration(site, challenge, response)?;
    db.exec(
        "INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        vec![
            v(c.id.clone()),
            v(user_id),
            v(c.public_key),
            v(c.counter),
            v(serde_json::to_string(&c.transports).unwrap_or_else(|_| "[]".into())),
            opt(device_name.map(String::from)),
            v(now_iso()),
        ],
    )
    .await?;
    Ok(c.id)
}

pub async fn add_passkey(
    db: &Db,
    site: &Site,
    user: &Author,
    challenge_id: &str,
    response: &serde_json::Value,
    device_name: Option<&str>,
) -> Result<String> {
    let ch = take_challenge(db, challenge_id, "add").await?;
    if ch.user_id.as_deref() != Some(&user.id) {
        return auth_err("challenge does not belong to you");
    }
    store_verified_passkey(db, site, &user.id, &ch.challenge, response, device_name).await
}

// ---------- device links: add a new device to an account without any passkey on it ----------
//
// 1. A signed-in device asks for a re-authentication challenge (device_link_challenge) and answers
//    it with one of the account's passkeys: a stolen session cookie or an unlocked phone left on a
//    table is not enough to invite a new device. create_device_link checks the assertion and mints
//    a random, single-use token valid for ten minutes, shown as a URL / QR code.
// 2. The new device opens /link/<token>: device_link_info shows whose account it is,
//    device_link_options starts a passkey registration for that account (the link stays valid, so
//    a cancelled prompt can be retried).
// 3. finish_device_link verifies the passkey, stores it, consumes the link and signs the device in.

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLink {
    pub token: String,
    pub expires_at: String,
}

pub async fn device_link_challenge(db: &Db, site: &Site, user: &Author) -> Result<Options> {
    reauthentication_options(db, site, user).await
}

pub async fn create_device_link(
    db: &Db,
    site: &Site,
    user: &Author,
    challenge_id: &str,
    response: &serde_json::Value,
) -> Result<DeviceLink> {
    reauthenticate(db, site, user, challenge_id, response).await?;
    let token = store_challenge(
        db,
        "",
        "device-link",
        Some(&user.username),
        Some(&user.id),
        None,
        DEVICE_LINK_TTL_MS,
    )
    .await?;
    Ok(DeviceLink {
        token,
        expires_at: after(DEVICE_LINK_TTL_MS),
    })
}

async fn device_link(db: &Db, token: &str) -> Result<(Author, String)> {
    let row = read_challenge(db, token, "device-link").await?;
    let user = match &row {
        Some(r) => match &r.user_id {
            Some(id) => user_by_id(db, id).await?,
            None => None,
        },
        None => None,
    };
    match (row, user) {
        (Some(r), Some(u)) => Ok((u, r.expires_at)),
        _ => {
            auth_err("this link has expired or was already used; make a new one from your profile")
        }
    }
}

pub async fn device_link_info(db: &Db, token: &str) -> Result<(Author, String)> {
    device_link(db, token).await
}

pub async fn device_link_options(db: &Db, site: &Site, token: &str) -> Result<Options> {
    let (user, _) = device_link(db, token).await?;
    registration_options_for(db, site, &user.id, &user.username, "link-add", Some(token)).await
}

pub async fn finish_device_link(
    db: &Db,
    site: &Site,
    challenge_id: &str,
    response: &serde_json::Value,
    device_name: Option<&str>,
) -> Result<Author> {
    let ch = take_challenge(db, challenge_id, "link-add").await?;
    let link = match ch.link {
        Some(l) => l,
        None => return auth_err("challenge expired, try again"),
    };
    let (user, _) = device_link(db, &link).await?; // still valid: not consumed by another device meanwhile
    store_verified_passkey(db, site, &user.id, &ch.challenge, response, device_name).await?;
    db.exec("DELETE FROM challenges WHERE id = ?", vec![v(link)])
        .await?;
    Ok(user)
}

// ---------- sign-in ----------

pub async fn authentication_options(
    db: &Db,
    site: &Site,
    raw_username: Option<&str>,
) -> Result<Options> {
    let allow = match raw_username.filter(|u| !u.is_empty()) {
        Some(u) => match user_by_username(db, u).await? {
            Some(user) => Some(passkeys_of(db, &user.id).await?),
            None => return auth_err("unknown username"),
        },
        None => None,
    };
    let challenge = webauthn::new_challenge();
    let options = webauthn::authentication_options(&site.rp(), &challenge, allow.as_deref());
    let challenge_id =
        store_challenge(db, &challenge, "login", None, None, None, CHALLENGE_TTL_MS).await?;
    Ok(Options {
        challenge_id,
        options,
    })
}

/// Verify an assertion against a challenge string, bump the passkey's counter and return its owner.
async fn verify_assertion(
    db: &Db,
    site: &Site,
    challenge: &str,
    response: &serde_json::Value,
) -> Result<Author> {
    let resp = parse_authentication(response)?;
    let row = db
        .one(
            "SELECT p.id, p.public_key, p.counter, p.transports, u.id AS uid, u.username, u.display_name
             FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.id = ?",
            vec![v(resp.id.clone())],
        )
        .await?;
    let row = match row {
        Some(r) => r,
        None => return auth_err("unknown passkey"),
    };
    let cred = StoredPasskey {
        id: row.req("id"),
        public_key: row.blob("public_key").unwrap_or_default(),
        counter: row.num("counter"),
        transports: parse_transports(row.str("transports")),
    };
    let new_counter = match webauthn::verify_authentication(&site.rp(), challenge, &cred, &resp) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("assertion rejected: {e:#}");
            return auth_err("sign-in could not be verified");
        }
    };
    db.exec(
        "UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?",
        vec![v(new_counter), v(now_iso()), v(resp.id)],
    )
    .await?;
    Ok(Author {
        id: row.req("uid"),
        username: row.req("username"),
        display_name: row.req("display_name"),
    })
}

pub async fn authenticate(
    db: &Db,
    site: &Site,
    challenge_id: &str,
    response: &serde_json::Value,
) -> Result<Author> {
    let ch = take_challenge(db, challenge_id, "login").await?;
    verify_assertion(db, site, &ch.challenge, response).await
}

// ---------- re-authentication: a fresh passkey check on a device that is already signed in ----------

/// Only this account's passkeys are offered, so the prompt cannot be answered with someone else's.
pub async fn reauthentication_options(db: &Db, site: &Site, user: &Author) -> Result<Options> {
    let allow = passkeys_of(db, &user.id).await?;
    let challenge = webauthn::new_challenge();
    let options = webauthn::authentication_options(&site.rp(), &challenge, Some(&allow));
    let challenge_id = store_challenge(
        db,
        &challenge,
        "reauth",
        None,
        Some(&user.id),
        None,
        CHALLENGE_TTL_MS,
    )
    .await?;
    Ok(Options {
        challenge_id,
        options,
    })
}

/// Fails unless `response` answers a "reauth" challenge issued to `user` with one of `user`'s passkeys.
pub async fn reauthenticate(
    db: &Db,
    site: &Site,
    user: &Author,
    challenge_id: &str,
    response: &serde_json::Value,
) -> Result<()> {
    let ch = take_challenge(db, challenge_id, "reauth").await?;
    if ch.user_id.as_deref() != Some(&user.id) {
        return auth_err("challenge does not belong to you");
    }
    let who = verify_assertion(db, site, &ch.challenge, response).await?;
    if who.id != user.id {
        return auth_err("that passkey belongs to another account");
    }
    Ok(())
}

// ---------- passkeys of a user ----------

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PasskeyInfo {
    pub id: String,
    pub name: Option<String>,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

pub async fn list_passkeys(db: &Db, user_id: &str) -> Result<Vec<PasskeyInfo>> {
    Ok(db
        .query("SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at", vec![v(user_id)])
        .await?
        .iter()
        .map(|r| PasskeyInfo { id: r.req("id"), name: r.str("name"), created_at: r.req("created_at"), last_used_at: r.str("last_used_at") })
        .collect())
}

pub async fn remove_passkey(db: &Db, user_id: &str, id: &str) -> Result<bool> {
    let count = db
        .one(
            "SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?",
            vec![v(user_id)],
        )
        .await?
        .map(|r| r.num("n"))
        .unwrap_or(0);
    if count <= 1 {
        return auth_err("you need at least one passkey to sign in");
    }
    Ok(db
        .exec(
            "DELETE FROM passkeys WHERE id = ? AND user_id = ?",
            vec![v(id), v(user_id)],
        )
        .await?
        > 0)
}

// ---------- feed tokens ----------
//
// Feeds and preview images need an account but RSS readers cannot sign in, so each user gets a
// secret token to put in the feed URL. Created on first use.

pub async fn feed_token(db: &Db, user_id: &str) -> Result<String> {
    for _ in 0..2 {
        let existing = db
            .one(
                "SELECT feed_token FROM users WHERE id = ?",
                vec![v(user_id)],
            )
            .await?
            .and_then(|r| r.str("feed_token"))
            .filter(|t| !t.is_empty());
        if let Some(t) = existing {
            return Ok(t);
        }
        db.exec(
            "UPDATE users SET feed_token = ? WHERE id = ? AND feed_token IS NULL",
            vec![v(rand_token()), v(user_id)],
        )
        .await?;
    }
    auth_err("could not create a feed token")
}

pub async fn user_by_feed_token(db: &Db, token: Option<&str>) -> Result<Option<Author>> {
    let token = match token.filter(|t| !t.is_empty()) {
        Some(t) => t,
        None => return Ok(None),
    };
    Ok(db
        .one(
            "SELECT id, username, display_name FROM users WHERE feed_token = ?",
            vec![v(token)],
        )
        .await?
        .as_ref()
        .map(to_author))
}

// ---------- sessions ----------

pub async fn create_session(db: &Db, user_id: &str) -> Result<String> {
    let id = rand_token();
    db.exec(
        "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        vec![
            v(id.clone()),
            v(user_id),
            v(now_iso()),
            v(after(SESSION_TTL_MS)),
        ],
    )
    .await?;
    Ok(id)
}

pub async fn session_user(db: &Db, id: Option<&str>) -> Result<Option<Author>> {
    let id = match id.filter(|s| !s.is_empty()) {
        Some(s) => s,
        None => return Ok(None),
    };
    Ok(db
        .one("SELECT u.id, u.username, u.display_name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?", vec![v(id), v(now_iso())])
        .await?
        .as_ref()
        .map(to_author))
}

pub async fn delete_session(db: &Db, id: Option<&str>) -> Result<()> {
    if let Some(id) = id.filter(|s| !s.is_empty()) {
        db.exec("DELETE FROM sessions WHERE id = ?", vec![v(id)])
            .await?;
    }
    Ok(())
}

/// Drop expired sessions and challenges; called on boot.
pub async fn prune_auth(db: &Db) -> Result<()> {
    db.exec(
        "DELETE FROM sessions WHERE expires_at < ?",
        vec![v(now_iso())],
    )
    .await?;
    db.exec(
        "DELETE FROM challenges WHERE expires_at < ?",
        vec![v(now_iso())],
    )
    .await?;
    Ok(())
}

// ---------- cookies ----------

pub fn session_cookie(site: &Site, id: &str) -> String {
    format!(
        "{SESSION_COOKIE}={id}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}{}",
        SESSION_TTL_MS / 1000,
        if site.secure_cookies { "; Secure" } else { "" }
    )
}

pub fn clear_session_cookie(site: &Site) -> String {
    format!(
        "{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{}",
        if site.secure_cookies { "; Secure" } else { "" }
    )
}

pub fn read_cookie(headers: &http::HeaderMap, name: &str) -> Option<String> {
    let cookie = headers.get("cookie")?.to_str().ok()?;
    cookie.split(';').map(str::trim).find_map(|part| {
        let (k, val) = part.split_once('=')?;
        (k == name).then(|| val.to_string())
    })
}
