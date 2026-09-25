// Turso / libSQL. Set TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN) in production; falls back to a local file.

import { createClient, type Row } from "@libsql/client";

export const db = createClient({
  url: process.env.TURSO_DATABASE_URL || "file:local.db",
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const createTables = () =>
  db.batch(
    [
      `CREATE TABLE IF NOT EXISTS users (
         id           TEXT PRIMARY KEY,
         username     TEXT NOT NULL UNIQUE,
         display_name TEXT NOT NULL,
         created_at   TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS passkeys (
         id           TEXT PRIMARY KEY,
         user_id      TEXT,
         public_key   BLOB NOT NULL,
         counter      INTEGER NOT NULL DEFAULT 0,
         transports   TEXT,
         name         TEXT,
         created_at   TEXT NOT NULL,
         last_used_at TEXT
       )`,
      `CREATE TABLE IF NOT EXISTS challenges (
         id         TEXT PRIMARY KEY,
         challenge  TEXT NOT NULL,
         kind       TEXT NOT NULL DEFAULT 'login',
         username   TEXT,
         user_id    TEXT,
         expires_at TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS sessions (
         id         TEXT PRIMARY KEY,
         user_id    TEXT,
         created_at TEXT NOT NULL,
         expires_at TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS posts (
         id         TEXT PRIMARY KEY,
         user_id    TEXT,
         date       TEXT,
         text       TEXT NOT NULL DEFAULT '',
         link       TEXT,
         ref        TEXT,
         created_at TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS posts_created ON posts (created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS likes (
         post_id    TEXT NOT NULL,
         user_id    TEXT NOT NULL,
         created_at TEXT NOT NULL,
         PRIMARY KEY (post_id, user_id)
       )`,
      `CREATE TABLE IF NOT EXISTS comments (
         id         TEXT PRIMARY KEY,
         post_id    TEXT NOT NULL,
         user_id    TEXT NOT NULL,
         text       TEXT NOT NULL,
         created_at TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS comments_post ON comments (post_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS post_tags (
         post_id TEXT NOT NULL,
         tag     TEXT NOT NULL,
         PRIMARY KEY (post_id, tag)
       )`,
      `CREATE INDEX IF NOT EXISTS post_tags_tag ON post_tags (tag, post_id)`,
      `CREATE TABLE IF NOT EXISTS images (
         post_id TEXT PRIMARY KEY,
         bytes   BLOB NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS previews (
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
       )`,
    ],
    "write"
  );

// Columns added after a table first shipped. SQLite has no "ADD COLUMN IF NOT EXISTS", so each is
// attempted and only duplicate-column is swallowed. Covers databases from the single-admin version.
const LATER_COLUMNS: [table: string, column: string][] = [
  ["previews", "image_key TEXT"],
  ["previews", "image_type TEXT"],
  ["passkeys", "user_id TEXT"],
  ["sessions", "user_id TEXT"],
  ["posts", "user_id TEXT"],
  ["challenges", "kind TEXT NOT NULL DEFAULT 'login'"],
  ["challenges", "username TEXT"],
  ["challenges", "user_id TEXT"],
  ["challenges", "link TEXT"],
  ["users", "feed_token TEXT"],
  ["posts", "image_key TEXT"],
  ["posts", "image_type TEXT"],
  ["posts", "image_w INTEGER"],
  ["posts", "image_h INTEGER"],
  ["posts", "private INTEGER NOT NULL DEFAULT 0"],
];

// Indexes on columns that were added later must come after the column migrations: on a database
// from the single-admin version, `posts` exists without `user_id` when createTables runs.
const LATER_INDEXES = [`CREATE INDEX IF NOT EXISTS posts_user ON posts (user_id, created_at DESC)`];

export const migrate = async () => {
  await createTables();
  for (const [table, col] of LATER_COLUMNS) {
    await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col}`).catch((e) => {
      if (!/duplicate column/i.test(String((e as Error)?.message ?? e))) throw e;
    });
  }
  for (const sql of LATER_INDEXES) await db.execute(sql);
  // single-admin leftovers: passkeys and sessions without a user can't be used any more
  await db.batch([`DELETE FROM passkeys WHERE user_id IS NULL`, `DELETE FROM sessions WHERE user_id IS NULL`], "write");
};

// libsql rows are loosely typed; these keep the casts in one place
export const str = (row: Row, col: string): string | null => {
  const v = row[col];
  return v == null ? null : String(v);
};
export const num = (row: Row, col: string): number => Number(row[col] ?? 0);
export const blob = (row: Row, col: string): Uint8Array | null => {
  const v = row[col];
  if (v == null) return null;
  return v instanceof ArrayBuffer ? new Uint8Array(v) : (v as unknown as Uint8Array);
};
