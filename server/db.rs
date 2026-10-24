//! Turso / libSQL. Set TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN) in production; falls back to a local file.

use std::sync::Arc;

use anyhow::{Context, Result};
use libsql::{Connection, Value};

#[derive(Clone)]
pub struct Db {
    conn: Connection,
    pub remote: bool,
}

/// One row with its values by column name; libsql rows are positional.
#[derive(Clone, Debug)]
pub struct Rec {
    cols: Arc<Vec<String>>,
    vals: Vec<Value>,
}

impl Rec {
    fn value(&self, col: &str) -> Option<&Value> {
        self.cols
            .iter()
            .position(|c| c == col)
            .and_then(|i| self.vals.get(i))
    }
    pub fn str(&self, col: &str) -> Option<String> {
        match self.value(col) {
            Some(Value::Text(s)) => Some(s.clone()),
            Some(Value::Integer(i)) => Some(i.to_string()),
            Some(Value::Real(f)) => Some(f.to_string()),
            Some(Value::Blob(b)) => Some(String::from_utf8_lossy(b).into_owned()),
            _ => None,
        }
    }
    pub fn req(&self, col: &str) -> String {
        self.str(col).unwrap_or_default()
    }
    pub fn num(&self, col: &str) -> i64 {
        match self.value(col) {
            Some(Value::Integer(i)) => *i,
            Some(Value::Real(f)) => *f as i64,
            Some(Value::Text(s)) => s.parse().unwrap_or(0),
            _ => 0,
        }
    }
    pub fn blob(&self, col: &str) -> Option<Vec<u8>> {
        match self.value(col) {
            Some(Value::Blob(b)) => Some(b.clone()),
            Some(Value::Text(s)) => Some(s.as_bytes().to_vec()),
            _ => None,
        }
    }
}

/// A statement with its positional parameters, for `batch`.
pub struct Stmt(pub String, pub Vec<Value>);

pub fn stmt(sql: &str, args: Vec<Value>) -> Stmt {
    Stmt(sql.to_string(), args)
}

/// SQL value helpers: `v(x)` for anything libsql converts, `opt(Option<String>)` for nullable text.
pub fn v<T: Into<Value>>(x: T) -> Value {
    x.into()
}
pub fn opt(x: Option<String>) -> Value {
    x.map(Value::Text).unwrap_or(Value::Null)
}

impl Db {
    /// Opens Turso when TURSO_DATABASE_URL is set, else a local SQLite file (`file:local.db` or a path).
    pub async fn open() -> Result<Db> {
        let url = std::env::var("TURSO_DATABASE_URL")
            .ok()
            .filter(|s| !s.is_empty());
        let (db, remote) = match url {
            Some(url) if url.starts_with("file:") => (
                libsql::Builder::new_local(url.trim_start_matches("file:"))
                    .build()
                    .await?,
                false,
            ),
            Some(url) => {
                let token = std::env::var("TURSO_AUTH_TOKEN").unwrap_or_default();
                (libsql::Builder::new_remote(url, token).build().await?, true)
            }
            None => {
                let path = std::env::var("LOCAL_DB_PATH")
                    .ok()
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "local.db".into());
                (libsql::Builder::new_local(path).build().await?, false)
            }
        };
        let conn = db.connect().context("connect")?;
        Ok(Db { conn, remote })
    }

    pub async fn query(&self, sql: &str, args: Vec<Value>) -> Result<Vec<Rec>> {
        let mut rows = self
            .conn
            .query(sql, args)
            .await
            .with_context(|| format!("query: {}", first_line(sql)))?;
        let cols: Arc<Vec<String>> = Arc::new(
            (0..rows.column_count())
                .map(|i| rows.column_name(i).unwrap_or("").to_string())
                .collect(),
        );
        let mut out = Vec::new();
        while let Some(row) = rows.next().await? {
            let vals = (0..cols.len() as i32)
                .map(|i| row.get_value(i).unwrap_or(Value::Null))
                .collect();
            out.push(Rec {
                cols: cols.clone(),
                vals,
            });
        }
        Ok(out)
    }

    pub async fn one(&self, sql: &str, args: Vec<Value>) -> Result<Option<Rec>> {
        Ok(self.query(sql, args).await?.into_iter().next())
    }

    /// Runs a statement, returns the rows affected.
    pub async fn exec(&self, sql: &str, args: Vec<Value>) -> Result<u64> {
        self.conn
            .execute(sql, args)
            .await
            .with_context(|| format!("exec: {}", first_line(sql)))
    }

    /// Runs statements in one transaction.
    pub async fn batch(&self, stmts: Vec<Stmt>) -> Result<()> {
        let tx = self.conn.transaction().await.context("begin")?;
        for Stmt(sql, args) in stmts {
            if let Err(e) = tx.execute(&sql, args).await {
                let _ = tx.rollback().await;
                return Err(anyhow::Error::new(e).context(format!("batch: {}", first_line(&sql))));
            }
        }
        tx.commit().await.context("commit")
    }

    /// Creates the schema and applies the additive migrations, unless `meta` says this schema
    /// version is already in: one round trip on a warm start instead of one per statement.
    pub async fn migrate(&self) -> Result<()> {
        let current = self
            .one("SELECT value FROM meta WHERE key = 'schema'", vec![])
            .await
            .ok()
            .flatten()
            .and_then(|r| r.str("value"))
            .and_then(|s| s.parse::<usize>().ok());
        if current.is_some_and(|n| n >= SCHEMA_VERSION) {
            return Ok(());
        }
        for sql in CREATE_TABLES {
            self.exec(sql, vec![]).await?;
        }
        // SQLite has no "ADD COLUMN IF NOT EXISTS": each is attempted and duplicate-column is swallowed
        for (table, col) in LATER_COLUMNS {
            if let Err(e) = self
                .exec(&format!("ALTER TABLE {table} ADD COLUMN {col}"), vec![])
                .await
                && !format!("{e:#}").to_lowercase().contains("duplicate column")
            {
                return Err(e);
            }
        }
        for sql in LATER_INDEXES {
            self.exec(sql, vec![]).await?;
        }
        // single-admin leftovers: passkeys and sessions without a user can't be used any more
        self.exec("DELETE FROM passkeys WHERE user_id IS NULL", vec![])
            .await?;
        self.exec("DELETE FROM sessions WHERE user_id IS NULL", vec![])
            .await?;
        self.exec(
            "INSERT INTO meta (key, value) VALUES ('schema', ?)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            vec![v(SCHEMA_VERSION.to_string())],
        )
        .await?;
        Ok(())
    }
}

fn first_line(sql: &str) -> String {
    sql.trim()
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .chars()
        .take(80)
        .collect()
}

/// True for the error SQLite raises on a UNIQUE constraint.
pub fn is_unique_violation(e: &anyhow::Error) -> bool {
    format!("{e:#}").to_uppercase().contains("UNIQUE")
}

/// Grows with every table, column and index added, which is why the schema is additive only.
const SCHEMA_VERSION: usize = CREATE_TABLES.len() + LATER_COLUMNS.len() + LATER_INDEXES.len();

const CREATE_TABLES: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS meta (
       key   TEXT PRIMARY KEY,
       value TEXT NOT NULL
     )",
    "CREATE TABLE IF NOT EXISTS users (
       id           TEXT PRIMARY KEY,
       username     TEXT NOT NULL UNIQUE,
       display_name TEXT NOT NULL,
       created_at   TEXT NOT NULL
     )",
    "CREATE TABLE IF NOT EXISTS passkeys (
       id           TEXT PRIMARY KEY,
       user_id      TEXT,
       public_key   BLOB NOT NULL,
       counter      INTEGER NOT NULL DEFAULT 0,
       transports   TEXT,
       name         TEXT,
       created_at   TEXT NOT NULL,
       last_used_at TEXT
     )",
    "CREATE TABLE IF NOT EXISTS challenges (
       id         TEXT PRIMARY KEY,
       challenge  TEXT NOT NULL,
       kind       TEXT NOT NULL DEFAULT 'login',
       username   TEXT,
       user_id    TEXT,
       expires_at TEXT NOT NULL
     )",
    "CREATE TABLE IF NOT EXISTS sessions (
       id         TEXT PRIMARY KEY,
       user_id    TEXT,
       created_at TEXT NOT NULL,
       expires_at TEXT NOT NULL
     )",
    "CREATE TABLE IF NOT EXISTS posts (
       id         TEXT PRIMARY KEY,
       user_id    TEXT,
       date       TEXT,
       text       TEXT NOT NULL DEFAULT '',
       link       TEXT,
       ref        TEXT,
       created_at TEXT NOT NULL
     )",
    "CREATE INDEX IF NOT EXISTS posts_created ON posts (created_at DESC)",
    "CREATE TABLE IF NOT EXISTS likes (
       post_id    TEXT NOT NULL,
       user_id    TEXT NOT NULL,
       created_at TEXT NOT NULL,
       PRIMARY KEY (post_id, user_id)
     )",
    "CREATE TABLE IF NOT EXISTS comments (
       id         TEXT PRIMARY KEY,
       post_id    TEXT NOT NULL,
       user_id    TEXT NOT NULL,
       text       TEXT NOT NULL,
       created_at TEXT NOT NULL
     )",
    "CREATE INDEX IF NOT EXISTS comments_post ON comments (post_id, created_at)",
    "CREATE TABLE IF NOT EXISTS post_tags (
       post_id TEXT NOT NULL,
       tag     TEXT NOT NULL,
       PRIMARY KEY (post_id, tag)
     )",
    "CREATE INDEX IF NOT EXISTS post_tags_tag ON post_tags (tag, post_id)",
    "CREATE TABLE IF NOT EXISTS images (
       post_id TEXT PRIMARY KEY,
       bytes   BLOB NOT NULL
     )",
    "CREATE TABLE IF NOT EXISTS previews (
       url         TEXT PRIMARY KEY,
       hash        TEXT NOT NULL UNIQUE,
       title       TEXT,
       description TEXT,
       excerpt     TEXT,
       image       TEXT,
       site_name   TEXT,
       screenshot  BLOB,
       error       TEXT,
       fetched_at  TEXT NOT NULL
     )",
    "CREATE TABLE IF NOT EXISTS slack_webhooks (
       id         TEXT PRIMARY KEY,
       user_id    TEXT NOT NULL,
       name       TEXT NOT NULL,
       url        TEXT NOT NULL,
       created_at TEXT NOT NULL
     )",
    "CREATE INDEX IF NOT EXISTS slack_webhooks_user ON slack_webhooks (user_id, created_at)",
];

/// Columns added after a table first shipped. Covers databases from the single-admin version.
const LATER_COLUMNS: &[(&str, &str)] = &[
    ("previews", "image_key TEXT"),
    ("previews", "image_type TEXT"),
    ("passkeys", "user_id TEXT"),
    ("sessions", "user_id TEXT"),
    ("posts", "user_id TEXT"),
    ("challenges", "kind TEXT NOT NULL DEFAULT 'login'"),
    ("challenges", "username TEXT"),
    ("challenges", "user_id TEXT"),
    ("challenges", "link TEXT"),
    ("users", "feed_token TEXT"),
    ("posts", "image_key TEXT"),
    ("posts", "image_type TEXT"),
    ("posts", "image_w INTEGER"),
    ("posts", "image_h INTEGER"),
    ("posts", "private INTEGER NOT NULL DEFAULT 0"),
];

// Indexes on columns that were added later must come after the column migrations.
const LATER_INDEXES: &[&str] =
    &["CREATE INDEX IF NOT EXISTS posts_user ON posts (user_id, created_at DESC)"];

/// Placeholders for an `IN (...)` list.
pub fn placeholders(n: usize) -> String {
    vec!["?"; n].join(",")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn migrate_records_the_schema_version_and_skips_next_time() {
        let db = libsql::Builder::new_local(":memory:")
            .build()
            .await
            .unwrap();
        let db = Db {
            conn: db.connect().unwrap(),
            remote: false,
        };
        db.migrate().await.unwrap();
        let row = db
            .one("SELECT value FROM meta WHERE key = 'schema'", vec![])
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.str("value"), Some(SCHEMA_VERSION.to_string()));
        // a second start finds the version and returns before any DDL
        db.exec("DROP TABLE posts", vec![]).await.unwrap();
        db.migrate().await.unwrap();
        assert!(db.one("SELECT 1 FROM posts", vec![]).await.is_err());
    }
}
