//! What every request can reach: the database, R2, an HTTP client and the site configuration.

use std::path::PathBuf;
use std::time::Instant;

use crate::auth::Site;
use crate::db::Db;
use crate::r2::R2;

pub struct BuildInfo {
    pub sha: Option<String>,
    pub version: Option<String>,
    pub date: Option<String>,
}

pub struct App {
    pub db: Db,
    pub r2: Option<R2>,
    pub http: reqwest::Client,
    pub site: Site,
    /// public origin without a trailing slash: links in feeds and Open Graph tags
    pub site_url: String,
    pub admin_token: Option<String>,
    pub dist: PathBuf,
    pub build: BuildInfo,
    pub started: Instant,
}

impl App {
    pub async fn from_env() -> anyhow::Result<App> {
        let env = |k: &str| std::env::var(k).ok().filter(|s| !s.is_empty());
        let site = Site::from_env();
        let site_url = env("SITE_URL")
            .unwrap_or_else(|| "https://murmur.johanboissard.me".into())
            .trim_end_matches('/')
            .to_string();
        let dist = env("DIST_DIR").map(PathBuf::from).unwrap_or_else(|| {
            std::env::current_dir()
                .map(|d| d.join("dist"))
                .unwrap_or_else(|_| "dist".into())
        });
        Ok(App {
            db: Db::open().await?,
            r2: R2::from_env(),
            http: crate::net::public_client()?,
            site,
            site_url,
            admin_token: env("ADMIN_TOKEN"),
            dist,
            build: BuildInfo {
                sha: env("GIT_SHA"),
                version: env("GIT_VERSION"),
                date: env("BUILD_DATE"),
            },
            started: Instant::now(),
        })
    }
}
