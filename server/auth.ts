// Accounts: a unique username plus one or more passkeys (WebAuthn). No passwords, no email.
// Challenges and sessions live in the database so any Cloud Run instance can finish what another
// started. Passkeys are registered as discoverable, so sign-in needs no username (but accepts one).

import crypto from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { db, str, blob } from "./db";
import { APP_NAME, type Author } from "../shared/links";

const site = new URL(process.env.SITE_URL || "https://murmur.johanboissard.me");
export const rpID = site.hostname;
export const expectedOrigin = site.origin;

/** Username of the site owner: may moderate, receives legacy posts, and is who ADMIN_TOKEN acts as. */
export const OWNER_USERNAME = (process.env.OWNER_USERNAME || "johan").toLowerCase();

const CHALLENGE_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 90 * 24 * 3600_000;
export const SESSION_COOKIE = "session";

export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const RESERVED = new Set(["admin", "root", "me", "login", "logout", "register", "settings", "share", "api", "rpc", "p", "u", "feed", "previews", "murmur", "system", "null", "undefined"]);

export const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);
const rand = () => crypto.randomBytes(24).toString("base64url");
const now = () => new Date().toISOString();
const after = (ms: number) => new Date(Date.now() + ms).toISOString();

export class AuthError extends Error {}

const toAuthor = (row: { id: string; username: string; display_name: string }): Author => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
});

// ---------- users ----------

export const normalizeUsername = (u: string) => u.trim().toLowerCase();

export const validateUsername = (u: string) => {
  const n = normalizeUsername(u);
  if (!USERNAME_RE.test(n)) throw new AuthError("username: 3 to 20 characters, letters, digits and _ only");
  if (RESERVED.has(n)) throw new AuthError("that username is reserved");
  return n;
};

export const userByUsername = async (username: string): Promise<Author | null> => {
  const res = await db.execute({ sql: `SELECT id, username, display_name FROM users WHERE username = ?`, args: [normalizeUsername(username)] });
  const r = res.rows[0];
  return r ? toAuthor({ id: str(r, "id")!, username: str(r, "username")!, display_name: str(r, "display_name")! }) : null;
};

export const userById = async (id: string): Promise<Author | null> => {
  const res = await db.execute({ sql: `SELECT id, username, display_name FROM users WHERE id = ?`, args: [id] });
  const r = res.rows[0];
  return r ? toAuthor({ id: str(r, "id")!, username: str(r, "username")!, display_name: str(r, "display_name")! }) : null;
};

export const usernameAvailable = async (username: string) => (await userByUsername(username)) === null;

export const isOwner = (user: Author | null | undefined) => !!user && user.username === OWNER_USERNAME;

/** Posts from the single-admin version have no user: hand them to the owner once they exist. */
export const adoptLegacyPosts = async () => {
  await db.execute({
    sql: `UPDATE posts SET user_id = (SELECT id FROM users WHERE username = ?)
          WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM users WHERE username = ?)`,
    args: [OWNER_USERNAME, OWNER_USERNAME],
  });
};

// ---------- challenges ----------

type ChallengeKind = "register" | "add" | "login";

const storeChallenge = async (challenge: string, kind: ChallengeKind, extra: { username?: string; userId?: string } = {}) => {
  const id = rand();
  await db.execute({
    sql: `INSERT INTO challenges (id, challenge, kind, username, user_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [id, challenge, kind, extra.username ?? null, extra.userId ?? null, after(CHALLENGE_TTL_MS)],
  });
  return id;
};

/** One-shot: returns the challenge row and deletes it; throws if unknown, expired or the wrong kind. */
const takeChallenge = async (id: string, kind: ChallengeKind) => {
  const res = await db.execute({ sql: `SELECT challenge, kind, username, user_id, expires_at FROM challenges WHERE id = ?`, args: [id] });
  await db.execute({ sql: `DELETE FROM challenges WHERE id = ? OR expires_at < ?`, args: [id, now()] });
  const row = res.rows[0];
  if (!row || str(row, "expires_at")! < now() || str(row, "kind") !== kind) throw new AuthError("challenge expired, try again");
  return { challenge: str(row, "challenge")!, username: str(row, "username"), userId: str(row, "user_id") };
};

// ---------- registration (new account) and adding passkeys ----------

const registrationOptionsFor = async (userId: string, username: string, kind: "register" | "add") => {
  const existing = kind === "add" ? await db.execute({ sql: `SELECT id, transports FROM passkeys WHERE user_id = ?`, args: [userId] }) : { rows: [] };
  const options = await generateRegistrationOptions({
    rpName: APP_NAME,
    rpID,
    userID: new TextEncoder().encode(userId),
    userName: username,
    userDisplayName: username,
    attestationType: "none",
    excludeCredentials: existing.rows.map((r) => ({ id: str(r, "id")!, transports: JSON.parse(str(r, "transports") || "[]") })),
    // discoverable, so sign-in works without typing the username
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  });
  return { challengeId: await storeChallenge(options.challenge, kind, { username, userId }), options };
};

export const registrationOptions = async (rawUsername: string) => {
  const username = validateUsername(rawUsername);
  if (!(await usernameAvailable(username))) throw new AuthError("that username is taken");
  return registrationOptionsFor(newId(), username, "register");
};

export const register = async (challengeId: string, response: RegistrationResponseJSON, deviceName: string | null): Promise<Author> => {
  const ch = await takeChallenge(challengeId, "register");
  const v = await verifyRegistrationResponse({ response, expectedChallenge: ch.challenge, expectedOrigin, expectedRPID: rpID });
  if (!v.verified) throw new AuthError("registration could not be verified");
  const c = v.registrationInfo.credential;
  const user: Author = { id: ch.userId!, username: ch.username!, displayName: ch.username! };
  try {
    await db.batch(
      [
        { sql: `INSERT INTO users (id, username, display_name, created_at) VALUES (?, ?, ?, ?)`, args: [user.id, user.username, user.displayName, now()] },
        {
          sql: `INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [c.id, user.id, c.publicKey, c.counter, JSON.stringify(c.transports || []), deviceName, now()],
        },
      ],
      "write"
    );
  } catch (e) {
    if (/UNIQUE/i.test(String((e as Error)?.message))) throw new AuthError("that username is taken");
    throw e;
  }
  if (user.username === OWNER_USERNAME) await adoptLegacyPosts();
  return user;
};

export const addPasskeyOptions = (user: Author) => registrationOptionsFor(user.id, user.username, "add");

export const addPasskey = async (user: Author, challengeId: string, response: RegistrationResponseJSON, deviceName: string | null) => {
  const ch = await takeChallenge(challengeId, "add");
  if (ch.userId !== user.id) throw new AuthError("challenge does not belong to you");
  const v = await verifyRegistrationResponse({ response, expectedChallenge: ch.challenge, expectedOrigin, expectedRPID: rpID });
  if (!v.verified) throw new AuthError("registration could not be verified");
  const c = v.registrationInfo.credential;
  await db.execute({
    sql: `INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [c.id, user.id, c.publicKey, c.counter, JSON.stringify(c.transports || []), deviceName, now()],
  });
  return c.id;
};

// ---------- sign-in ----------

export const authenticationOptions = async (rawUsername?: string | null) => {
  let allow: { id: string; transports?: string[] }[] | undefined;
  if (rawUsername) {
    const user = await userByUsername(rawUsername);
    if (!user) throw new AuthError("unknown username");
    const res = await db.execute({ sql: `SELECT id, transports FROM passkeys WHERE user_id = ?`, args: [user.id] });
    allow = res.rows.map((r) => ({ id: str(r, "id")!, transports: JSON.parse(str(r, "transports") || "[]") }));
  }
  const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred", allowCredentials: allow });
  return { challengeId: await storeChallenge(options.challenge, "login"), options };
};

export const authenticate = async (challengeId: string, response: AuthenticationResponseJSON): Promise<Author> => {
  const ch = await takeChallenge(challengeId, "login");
  const res = await db.execute({
    sql: `SELECT p.id, p.public_key, p.counter, p.transports, u.id AS uid, u.username, u.display_name
          FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.id = ?`,
    args: [response.id],
  });
  const row = res.rows[0];
  if (!row) throw new AuthError("unknown passkey");
  const v = await verifyAuthenticationResponse({
    response,
    expectedChallenge: ch.challenge,
    expectedOrigin,
    expectedRPID: rpID,
    credential: {
      id: str(row, "id")!,
      publicKey: new Uint8Array(blob(row, "public_key")!),
      counter: Number(row["counter"] ?? 0),
      transports: JSON.parse(str(row, "transports") || "[]"),
    },
  });
  if (!v.verified) throw new AuthError("sign-in could not be verified");
  await db.execute({ sql: `UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?`, args: [v.authenticationInfo.newCounter, now(), response.id] });
  return toAuthor({ id: str(row, "uid")!, username: str(row, "username")!, display_name: str(row, "display_name")! });
};

// ---------- passkeys of a user ----------

export interface PasskeyInfo {
  id: string;
  name: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export const listPasskeys = async (userId: string): Promise<PasskeyInfo[]> => {
  const res = await db.execute({ sql: `SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at`, args: [userId] });
  return res.rows.map((r) => ({ id: str(r, "id")!, name: str(r, "name"), createdAt: str(r, "created_at")!, lastUsedAt: str(r, "last_used_at") }));
};

export const removePasskey = async (userId: string, id: string) => {
  const count = await db.execute({ sql: `SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?`, args: [userId] });
  if (Number(count.rows[0]?.["n"] ?? 0) <= 1) throw new AuthError("you need at least one passkey to sign in");
  const res = await db.execute({ sql: `DELETE FROM passkeys WHERE id = ? AND user_id = ?`, args: [id, userId] });
  return res.rowsAffected > 0;
};

// ---------- sessions ----------

export const createSession = async (userId: string) => {
  const id = rand();
  await db.execute({ sql: `INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`, args: [id, userId, now(), after(SESSION_TTL_MS)] });
  return id;
};

export const sessionUser = async (id: string | undefined): Promise<Author | null> => {
  if (!id) return null;
  const res = await db.execute({
    sql: `SELECT u.id, u.username, u.display_name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?`,
    args: [id, now()],
  });
  const r = res.rows[0];
  return r ? toAuthor({ id: str(r, "id")!, username: str(r, "username")!, display_name: str(r, "display_name")! }) : null;
};

export const deleteSession = async (id: string | undefined) => {
  if (id) await db.execute({ sql: `DELETE FROM sessions WHERE id = ?`, args: [id] });
};

/** Drop expired sessions and challenges; called on boot. */
export const pruneAuth = () =>
  db.batch(
    [
      { sql: `DELETE FROM sessions WHERE expires_at < ?`, args: [now()] },
      { sql: `DELETE FROM challenges WHERE expires_at < ?`, args: [now()] },
    ],
    "write"
  );

// ---------- cookies ----------

const secure = site.protocol === "https:";

export const sessionCookie = (id: string) =>
  `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure ? "; Secure" : ""}`;

export const clearSessionCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;

export const readCookie = (req: Request, name: string): string | undefined => {
  for (const part of (req.headers.get("cookie") || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
};
