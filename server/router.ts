// oRPC router: the whole API. Served at /rpc (oRPC protocol, used by the app) and /api (plain
// HTTP/OpenAPI, handy for curl). Signed-in calls carry the session cookie; scripts may instead
// send `Authorization: Bearer $ADMIN_TOKEN`, which acts as the owner account.
// The network is private: everything but health and the sign-in / sign-up / device-link
// procedures needs a signed-in user.

import { os, ORPCError } from "@orpc/server";
import * as z from "zod";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { db, str, num, blob } from "./db";
import * as auth from "./auth";
import { ensurePreviews, previewsFor, prunePreviews, refreshPreview } from "./preview";
import { deleteImage, getImage, putImage } from "./r2";
import { extractLinks, postTags, normalizeTag, POST_MAX, COMMENT_MAX, TAG_MAX, TAGS_MAX, type Author, type Post, type Comment } from "../shared/links";

export interface Context {
  /** bearer token from the request, if any */
  token?: string;
  /** session cookie from the request, if any */
  sessionId?: string;
  /** response headers, injected by ResponseHeadersPlugin (set-cookie goes here) */
  resHeaders?: Headers;
}

const base = os.$context<Context>();

const resolveUser = async (ctx: Context): Promise<Author | null> => {
  if (ctx.token && process.env.ADMIN_TOKEN && ctx.token === process.env.ADMIN_TOKEN) return auth.userByUsername(auth.OWNER_USERNAME);
  return auth.sessionUser(ctx.sessionId);
};

/** Adds `user` (or null) to the context. */
const withUser = base.use(async ({ context, next }) => next({ context: { user: await resolveUser(context) } }));

/** Requires a signed-in user. */
const authed = withUser.use(({ context, next }) => {
  if (!context.user) throw new ORPCError("UNAUTHORIZED", { message: "sign in first" });
  return next({ context: { user: context.user } });
});

/** Turn auth-domain errors into 400s with their message; anything else bubbles up as 500. */
const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof auth.AuthError) throw new ORPCError("BAD_REQUEST", { message: e.message });
    throw e;
  }
};

const startSession = async (context: Context, user: Author) => {
  const id = await auth.createSession(user.id);
  context.resHeaders?.append("set-cookie", auth.sessionCookie(id));
};

const now = () => new Date().toISOString();

// ---------- schemas ----------

// WebAuthn JSON payloads (from @simplewebauthn) have no index signature, so they pass through untyped
const WebAuthnJson = z.any();
const Username = z.string().min(1).max(40);
const AuthorSchema = z.object({ id: z.string(), username: z.string(), displayName: z.string() });
const PreviewSchema = z.object({
  title: z.string().nullable(),
  description: z.string().nullable(),
  image: z.string().nullable(),
  siteName: z.string().nullable(),
});
const Tag = z.string().trim().min(1).max(TAG_MAX + 1);
const PostImageSchema = z.object({ src: z.string(), type: z.string(), width: z.number(), height: z.number() });
const PostSchema = z.object({
  id: z.string(),
  text: z.string(),
  link: z.string().nullable(),
  ref: z.string().nullable(),
  image: PostImageSchema.nullable(),
  tags: z.array(z.string()),
  private: z.boolean(),
  createdAt: z.string(),
  author: AuthorSchema,
  preview: PreviewSchema.nullable(),
  refPreview: PreviewSchema.nullable(),
  likes: z.number(),
  comments: z.number(),
  likedByMe: z.boolean(),
});
const CommentSchema = z.object({ id: z.string(), postId: z.string(), text: z.string(), createdAt: z.string(), author: AuthorSchema });
const PasskeySchema = z.object({ id: z.string(), name: z.string().nullable(), createdAt: z.string(), lastUsedAt: z.string().nullable() });

// ---------- loading ----------

const POST_SELECT = `
  SELECT p.id, p.text, p.link, p.ref, p.private, p.created_at, p.image_type, p.image_w, p.image_h,
         u.id AS uid, u.username, u.display_name,
         (SELECT group_concat(tag, ' ') FROM (SELECT tag FROM post_tags t WHERE t.post_id = p.id ORDER BY tag)) AS tags,
         (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS likes,
         (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comments,
         EXISTS (SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = ?) AS liked
  FROM posts p JOIN users u ON u.id = p.user_id`;

interface LoadOpts {
  /** who is looking: private posts are only loaded for their author */
  viewerId?: string | null;
  limit?: number;
  before?: string;
  authorId?: string;
  id?: string;
  tag?: string;
}

/** Posts the viewer may see: everyone's public ones plus the viewer's own private ones. */
const VISIBLE = "(p.private = 0 OR p.user_id = ?)";

export const loadPosts = async ({ viewerId = null, limit = 50, before, authorId, id, tag }: LoadOpts): Promise<Post[]> => {
  const where: string[] = [VISIBLE];
  const args: (string | number | null)[] = [viewerId ?? "", viewerId ?? ""];
  if (id) where.push("p.id = ?"), args.push(id);
  if (authorId) where.push("p.user_id = ?"), args.push(authorId);
  if (tag) where.push("EXISTS (SELECT 1 FROM post_tags t WHERE t.post_id = p.id AND t.tag = ?)"), args.push(tag);
  if (before) where.push("p.created_at < ?"), args.push(before);
  const sql = `${POST_SELECT} WHERE ${where.join(" AND ")} ORDER BY p.created_at DESC LIMIT ?`;
  args.push(limit);
  const res = await db.execute({ sql, args });

  const rows = res.rows.map((r) => ({
    id: str(r, "id")!,
    text: str(r, "text") || "",
    link: str(r, "link"),
    ref: str(r, "ref"),
    image: str(r, "image_type") ? { src: `/images/${str(r, "id")}`, type: str(r, "image_type")!, width: num(r, "image_w"), height: num(r, "image_h") } : null,
    tags: (str(r, "tags") || "").split(" ").filter(Boolean),
    private: num(r, "private") > 0,
    createdAt: str(r, "created_at")!,
    author: { id: str(r, "uid")!, username: str(r, "username")!, displayName: str(r, "display_name")! },
    likes: num(r, "likes"),
    comments: num(r, "comments"),
    likedByMe: num(r, "liked") > 0,
  }));
  const previews = await previewsFor(rows.flatMap((r) => [r.link, r.ref]).filter((u): u is string => !!u));
  return rows.map((r) => ({
    ...r,
    preview: r.link ? previews.get(r.link) || null : null,
    refPreview: r.ref ? previews.get(r.ref) || null : null,
  }));
};

const loadComments = async (postId: string): Promise<Comment[]> => {
  const res = await db.execute({
    sql: `SELECT c.id, c.post_id, c.text, c.created_at, u.id AS uid, u.username, u.display_name
          FROM comments c JOIN users u ON u.id = c.user_id WHERE c.post_id = ? ORDER BY c.created_at ASC LIMIT 500`,
    args: [postId],
  });
  return res.rows.map((r) => ({
    id: str(r, "id")!,
    postId: str(r, "post_id")!,
    text: str(r, "text")!,
    createdAt: str(r, "created_at")!,
    author: { id: str(r, "uid")!, username: str(r, "username")!, displayName: str(r, "display_name")! },
  }));
};

const postOwnerId = async (id: string) => {
  const res = await db.execute({ sql: `SELECT user_id FROM posts WHERE id = ?`, args: [id] });
  return res.rows[0] ? str(res.rows[0], "user_id") : null;
};

/** The post's author id if `viewer` may see the post (it exists and is public or theirs), else null. */
const visiblePostOwnerId = async (id: string, viewer: Author) => {
  const res = await db.execute({ sql: `SELECT user_id FROM posts p WHERE p.id = ? AND ${VISIBLE}`, args: [id, viewer.id] });
  return res.rows[0] ? str(res.rows[0], "user_id") : null;
};

// ---------- pictures ----------
//
// One picture per post, shrunk by the browser first (src/image.ts). Bytes go to R2 under
// images/<post id>; without R2 (local dev, the e2e run) they sit in the `images` table. Served at
// /images/<post id> by server/index.ts to members who may see the post.

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

const storePostImage = async (postId: string, file: File) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const key = await putImage(`images/${postId}`, bytes, file.type);
  if (!key) await db.execute({ sql: `INSERT OR REPLACE INTO images (post_id, bytes) VALUES (?, ?)`, args: [postId, bytes] });
  return key;
};

const dropPostImage = async (postId: string) => {
  const res = await db.execute({ sql: `SELECT image_key FROM posts WHERE id = ?`, args: [postId] });
  const key = res.rows[0] ? str(res.rows[0], "image_key") : null;
  if (key) await deleteImage(key);
  await db.execute({ sql: `DELETE FROM images WHERE post_id = ?`, args: [postId] });
};

/** The picture of post `id` if `viewer` may see the post; null otherwise (also when there is none). */
export const postImage = async (id: string, viewer: Author): Promise<{ bytes: Uint8Array; type: string } | null> => {
  const res = await db.execute({ sql: `SELECT image_key, image_type FROM posts p WHERE p.id = ? AND ${VISIBLE}`, args: [id, viewer.id] });
  const row = res.rows[0];
  const type = row ? str(row, "image_type") : null;
  if (!row || !type) return null;
  const key = str(row, "image_key");
  if (key) {
    const stored = await getImage(key);
    if (stored) return { bytes: stored.bytes, type };
  }
  const local = await db.execute({ sql: `SELECT bytes FROM images WHERE post_id = ?`, args: [id] });
  const bytes = local.rows[0] ? blob(local.rows[0], "bytes") : null;
  return bytes ? { bytes, type } : null;
};

/** Tags on posts the viewer may see, most used first. */
const loadTags = async (viewerId: string): Promise<{ tag: string; count: number }[]> => {
  const res = await db.execute({
    sql: `SELECT t.tag, COUNT(*) AS n FROM post_tags t JOIN posts p ON p.id = t.post_id WHERE ${VISIBLE}
          GROUP BY t.tag ORDER BY n DESC, t.tag ASC LIMIT 200`,
    args: [viewerId],
  });
  return res.rows.map((r) => ({ tag: str(r, "tag")!, count: num(r, "n") }));
};

// ---------- health ----------

/** Build info injected by the deploy workflow (cloud-run.yml); unset in local dev. */
const BUILD = {
  sha: process.env.GIT_SHA || null,
  version: process.env.GIT_VERSION || null,
  date: process.env.BUILD_DATE || null,
};

const health = base
  .route({ method: "GET", path: "/health", summary: "Liveness + build info" })
  .output(z.object({ status: z.literal("ok"), sha: z.string().nullable(), version: z.string().nullable(), date: z.string().nullable() }))
  .handler(() => ({ status: "ok" as const, ...BUILD }));

// ---------- auth ----------

const status = withUser
  .route({ method: "GET", path: "/auth/status", summary: "Who am I?" })
  .output(z.object({ user: AuthorSchema.nullable() }))
  .handler(({ context }) => ({ user: context.user }));

const checkUsername = base
  .route({ method: "GET", path: "/auth/username/{username}", summary: "Is a username available?" })
  .input(z.object({ username: Username }))
  .output(z.object({ available: z.boolean(), reason: z.string().nullable() }))
  .handler(async ({ input }) => {
    try {
      const u = auth.validateUsername(input.username);
      const available = await auth.usernameAvailable(u);
      return { available, reason: available ? null : "that username is taken" };
    } catch (e) {
      if (e instanceof auth.AuthError) return { available: false, reason: e.message };
      throw e;
    }
  });

const registerOptions = base
  .route({ method: "POST", path: "/auth/register/options", summary: "Start creating an account" })
  .input(z.object({ username: Username }))
  .output(z.object({ challengeId: z.string(), options: WebAuthnJson }))
  .handler(({ input }) => guard(() => auth.registrationOptions(input.username)));

const register = base
  .route({ method: "POST", path: "/auth/register", summary: "Finish creating an account; signs you in" })
  .input(z.object({ challengeId: z.string(), response: WebAuthnJson, deviceName: z.string().max(100).nullish() }))
  .output(z.object({ user: AuthorSchema }))
  .handler(async ({ input, context }) => {
    const user = await guard(() => auth.register(input.challengeId, input.response as RegistrationResponseJSON, input.deviceName ?? null));
    await startSession(context, user);
    return { user };
  });

const loginOptions = base
  .route({ method: "POST", path: "/auth/login/options", summary: "Start a passkey sign-in (username optional)" })
  .input(z.object({ username: Username.nullish() }).optional())
  .output(z.object({ challengeId: z.string(), options: WebAuthnJson }))
  .handler(({ input }) => guard(() => auth.authenticationOptions(input?.username)));

const login = base
  .route({ method: "POST", path: "/auth/login", summary: "Finish a passkey sign-in; sets the session cookie" })
  .input(z.object({ challengeId: z.string(), response: WebAuthnJson }))
  .output(z.object({ user: AuthorSchema }))
  .handler(async ({ input, context }) => {
    let user: Author;
    try {
      user = await auth.authenticate(input.challengeId, input.response as AuthenticationResponseJSON);
    } catch (e) {
      throw new ORPCError("UNAUTHORIZED", { message: e instanceof Error ? e.message : String(e) });
    }
    await startSession(context, user);
    return { user };
  });

const logout = base
  .route({ method: "POST", path: "/auth/logout", summary: "End the session" })
  .output(z.object({ ok: z.literal(true) }))
  .handler(async ({ context }) => {
    await auth.deleteSession(context.sessionId);
    context.resHeaders?.append("set-cookie", auth.clearSessionCookie());
    return { ok: true as const };
  });

const updateProfile = authed
  .route({ method: "PATCH", path: "/auth/me", summary: "Change my username and/or display name" })
  .input(z.object({ username: Username.optional(), displayName: z.string().max(auth.DISPLAY_NAME_MAX).optional() }))
  .output(z.object({ user: AuthorSchema }))
  .handler(({ input, context }) => guard(async () => ({ user: await auth.updateProfile(context.user, input) })));

const addPasskeyOptions = authed
  .route({ method: "POST", path: "/auth/passkeys/options", summary: "Start adding a passkey to my account" })
  .output(z.object({ challengeId: z.string(), options: WebAuthnJson }))
  .handler(({ context }) => auth.addPasskeyOptions(context.user));

const addPasskey = authed
  .route({ method: "POST", path: "/auth/passkeys", summary: "Finish adding a passkey" })
  .input(z.object({ challengeId: z.string(), response: WebAuthnJson, deviceName: z.string().max(100).nullish() }))
  .output(z.object({ id: z.string() }))
  .handler(({ input, context }) =>
    guard(async () => ({ id: await auth.addPasskey(context.user, input.challengeId, input.response as RegistrationResponseJSON, input.deviceName ?? null) }))
  );

const passkeys = authed
  .route({ method: "GET", path: "/auth/passkeys", summary: "My passkeys" })
  .output(z.array(PasskeySchema))
  .handler(({ context }) => auth.listPasskeys(context.user.id));

const removePasskey = authed
  .route({ method: "DELETE", path: "/auth/passkeys/{id}", summary: "Remove one of my passkeys" })
  .input(z.object({ id: z.string() }))
  .output(z.object({ deleted: z.boolean() }))
  .handler(({ input, context }) => guard(async () => ({ deleted: await auth.removePasskey(context.user.id, input.id) })));

// device links: add a device that has no passkey yet (see server/auth.ts). Minting one needs a
// fresh passkey check on the inviting device: linkChallenge, then linkCreate with the assertion.

const linkChallenge = authed
  .route({ method: "POST", path: "/auth/link/challenge", summary: "Start adding another device: a passkey check on this one" })
  .output(z.object({ challengeId: z.string(), options: WebAuthnJson }))
  .handler(({ context }) => auth.deviceLinkChallenge(context.user));

const linkCreate = authed
  .route({ method: "POST", path: "/auth/link", summary: "Make a short-lived link that adds another device to my account (answers linkChallenge)" })
  .input(z.object({ challengeId: z.string(), response: WebAuthnJson }))
  .output(z.object({ token: z.string(), expiresAt: z.string() }))
  .handler(({ input, context }) => guard(() => auth.createDeviceLink(context.user, input.challengeId, input.response as AuthenticationResponseJSON)));

const linkInfo = base
  .route({ method: "GET", path: "/auth/link/{token}", summary: "Whose account a device link adds to" })
  .input(z.object({ token: z.string().max(100) }))
  .output(z.object({ user: AuthorSchema, expiresAt: z.string() }))
  .handler(({ input }) => guard(() => auth.deviceLinkInfo(input.token)));

const linkOptions = base
  .route({ method: "POST", path: "/auth/link/{token}/options", summary: "Start registering this device's passkey through a device link" })
  .input(z.object({ token: z.string().max(100) }))
  .output(z.object({ challengeId: z.string(), options: WebAuthnJson }))
  .handler(({ input }) => guard(() => auth.deviceLinkOptions(input.token)));

const linkFinish = base
  .route({ method: "POST", path: "/auth/link/finish", summary: "Finish a device link: stores the passkey and signs this device in" })
  .input(z.object({ challengeId: z.string(), response: WebAuthnJson, deviceName: z.string().max(100).nullish() }))
  .output(z.object({ user: AuthorSchema }))
  .handler(async ({ input, context }) => {
    const user = await guard(() => auth.finishDeviceLink(input.challengeId, input.response as RegistrationResponseJSON, input.deviceName ?? null));
    await startSession(context, user);
    return { user };
  });

const feed = authed
  .route({ method: "GET", path: "/auth/feed", summary: "My private feed URLs (the token in them is a secret)" })
  .output(z.object({ token: z.string(), rss: z.string(), json: z.string() }))
  .handler(async ({ context }) => {
    const token = await auth.feedToken(context.user.id);
    const q = `?token=${encodeURIComponent(token)}`;
    return { token, rss: `${auth.expectedOrigin}/feed.xml${q}`, json: `${auth.expectedOrigin}/feed.json${q}` };
  });

// ---------- posts ----------

const list = authed
  .route({ method: "GET", path: "/posts", summary: "Timeline, newest first (your private posts included; ?tag= filters by label)" })
  .input(z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), before: z.string().optional(), tag: Tag.optional() }).optional())
  .output(z.array(PostSchema))
  .handler(({ input, context }) => {
    const tag = input?.tag ? normalizeTag(input.tag) : undefined;
    if (input?.tag && !tag) return [];
    return loadPosts({ viewerId: context.user.id, limit: input?.limit ?? 30, before: input?.before, tag: tag ?? undefined });
  });

const tags = authed
  .route({ method: "GET", path: "/tags", summary: "Labels in use, most used first" })
  .output(z.array(z.object({ tag: z.string(), count: z.number() })))
  .handler(({ context }) => loadTags(context.user.id));

const get = authed
  .route({ method: "GET", path: "/posts/{id}", summary: "One post with its comments" })
  .input(z.object({ id: z.string() }))
  .output(z.object({ post: PostSchema, comments: z.array(CommentSchema) }))
  .handler(async ({ input, context }) => {
    const [post] = await loadPosts({ viewerId: context.user.id, id: input.id, limit: 1 });
    if (!post) throw new ORPCError("NOT_FOUND", { message: "no such post" });
    return { post, comments: await loadComments(post.id) };
  });

const create = authed
  .route({
    method: "POST",
    path: "/posts",
    summary: "Post. Tags come from #hashtags in the text and/or `tags`; `private` keeps it to yourself; `image` (multipart) attaches a picture, then `text` may be empty",
  })
  .input(
    z.object({
      text: z.string().trim().max(POST_MAX).default(""),
      tags: z.array(Tag).max(TAGS_MAX * 2).optional(),
      private: z.boolean().optional(),
      image: z.file().max(IMAGE_MAX_BYTES, "pictures are limited to 10 MB").mime(IMAGE_TYPES, "JPEG, PNG, WebP or GIF only").optional(),
      /** pixel size of `image`, as measured by the client (layout hint only) */
      imageWidth: z.coerce.number().int().min(1).max(20000).optional(),
      imageHeight: z.coerce.number().int().min(1).max(20000).optional(),
    })
  )
  .output(z.object({ post: PostSchema, previews: z.record(z.string(), z.string().nullable()) }))
  .handler(async ({ input, context }) => {
    if (!input.text && !input.image) throw new ORPCError("BAD_REQUEST", { message: "say something or attach a picture" });
    const id = auth.newId();
    const { link, ref } = extractLinks(input.text);
    const tags = postTags(input.text, input.tags ?? []);
    const createdAt = now();
    const imageKey = input.image ? await storePostImage(id, input.image) : null;
    // `date` is a leftover from the single-admin version; databases created by it have it NOT NULL
    await db.batch(
      [
        {
          sql: `INSERT INTO posts (id, user_id, date, text, link, ref, private, created_at, image_key, image_type, image_w, image_h) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            id,
            context.user.id,
            createdAt.slice(0, 10),
            input.text,
            link,
            ref,
            input.private ? 1 : 0,
            createdAt,
            imageKey,
            input.image ? input.image.type : null,
            input.image ? (input.imageWidth ?? 0) : null,
            input.image ? (input.imageHeight ?? 0) : null,
          ],
        },
        ...tags.map((tag) => ({ sql: `INSERT INTO post_tags (post_id, tag) VALUES (?, ?)`, args: [id, tag] })),
      ],
      "write"
    );
    const previews = await ensurePreviews([link, ref].filter((u): u is string => !!u));
    const [post] = await loadPosts({ viewerId: context.user.id, id, limit: 1 });
    return { post, previews };
  });

const remove = authed
  .route({ method: "DELETE", path: "/posts/{id}", summary: "Delete my post (the owner may delete any)" })
  .input(z.object({ id: z.string() }))
  .output(z.object({ deleted: z.boolean() }))
  .handler(async ({ input, context }) => {
    const ownerId = await postOwnerId(input.id);
    if (!ownerId) return { deleted: false };
    if (ownerId !== context.user.id && !auth.isOwner(context.user)) throw new ORPCError("FORBIDDEN", { message: "not your post" });
    await dropPostImage(input.id);
    await db.batch(
      [
        { sql: `DELETE FROM likes WHERE post_id = ?`, args: [input.id] },
        { sql: `DELETE FROM comments WHERE post_id = ?`, args: [input.id] },
        { sql: `DELETE FROM post_tags WHERE post_id = ?`, args: [input.id] },
        { sql: `DELETE FROM posts WHERE id = ?`, args: [input.id] },
      ],
      "write"
    );
    await prunePreviews();
    return { deleted: true };
  });

const like = authed
  .route({ method: "POST", path: "/posts/{id}/like", summary: "Toggle my like" })
  .input(z.object({ id: z.string() }))
  .output(z.object({ liked: z.boolean(), likes: z.number() }))
  .handler(async ({ input, context }) => {
    if (!(await visiblePostOwnerId(input.id, context.user))) throw new ORPCError("NOT_FOUND", { message: "no such post" });
    const del = await db.execute({ sql: `DELETE FROM likes WHERE post_id = ? AND user_id = ?`, args: [input.id, context.user.id] });
    const liked = del.rowsAffected === 0;
    if (liked) await db.execute({ sql: `INSERT INTO likes (post_id, user_id, created_at) VALUES (?, ?, ?)`, args: [input.id, context.user.id, now()] });
    const c = await db.execute({ sql: `SELECT COUNT(*) AS n FROM likes WHERE post_id = ?`, args: [input.id] });
    return { liked, likes: num(c.rows[0]!, "n") };
  });

const comment = authed
  .route({ method: "POST", path: "/posts/{id}/comments", summary: "Comment on a post" })
  .input(z.object({ id: z.string(), text: z.string().trim().min(1).max(COMMENT_MAX) }))
  .output(CommentSchema)
  .handler(async ({ input, context }) => {
    if (!(await visiblePostOwnerId(input.id, context.user))) throw new ORPCError("NOT_FOUND", { message: "no such post" });
    const id = auth.newId();
    const createdAt = now();
    await db.execute({ sql: `INSERT INTO comments (id, post_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)`, args: [id, input.id, context.user.id, input.text, createdAt] });
    return { id, postId: input.id, text: input.text, createdAt, author: context.user };
  });

const deleteComment = authed
  .route({ method: "DELETE", path: "/comments/{id}", summary: "Delete my comment (post author and owner may too)" })
  .input(z.object({ id: z.string() }))
  .output(z.object({ deleted: z.boolean() }))
  .handler(async ({ input, context }) => {
    const res = await db.execute({ sql: `SELECT c.user_id, p.user_id AS post_user FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.id = ?`, args: [input.id] });
    const row = res.rows[0];
    if (!row) return { deleted: false };
    const allowed = str(row, "user_id") === context.user.id || str(row, "post_user") === context.user.id || auth.isOwner(context.user);
    if (!allowed) throw new ORPCError("FORBIDDEN", { message: "not your comment" });
    const del = await db.execute({ sql: `DELETE FROM comments WHERE id = ?`, args: [input.id] });
    return { deleted: del.rowsAffected > 0 };
  });

// ---------- users ----------

const getUser = authed
  .route({ method: "GET", path: "/users/{username}", summary: "A user and their posts (private ones only when they are you)" })
  .input(z.object({ username: Username, before: z.string().optional() }))
  .output(z.object({ user: AuthorSchema, posts: z.array(PostSchema) }))
  .handler(async ({ input, context }) => {
    const user = await auth.userByUsername(input.username);
    if (!user) throw new ORPCError("NOT_FOUND", { message: "no such user" });
    return { user, posts: await loadPosts({ viewerId: context.user.id, authorId: user.id, before: input.before, limit: 50 }) };
  });

// ---------- previews ----------

const refresh = authed
  .route({ method: "POST", path: "/previews/refresh", summary: "Re-capture the preview of a link in one of my posts" })
  .input(z.object({ url: z.string().url().max(2000) }))
  .output(z.object({ error: z.string().nullable() }))
  .handler(async ({ input, context }) => {
    if (!auth.isOwner(context.user)) {
      const mine = await db.execute({ sql: `SELECT 1 FROM posts WHERE user_id = ? AND (link = ? OR ref = ?) LIMIT 1`, args: [context.user.id, input.url, input.url] });
      if (!mine.rows.length) throw new ORPCError("FORBIDDEN", { message: "that link is not in one of your posts" });
    }
    return { error: await refreshPreview(input.url) };
  });

export const router = {
  health,
  auth: {
    status,
    checkUsername,
    registerOptions,
    register,
    loginOptions,
    login,
    logout,
    updateProfile,
    addPasskeyOptions,
    addPasskey,
    passkeys,
    removePasskey,
    linkChallenge,
    linkCreate,
    linkInfo,
    linkOptions,
    linkFinish,
    feed,
  },
  posts: { list, get, create, delete: remove, like, comment, deleteComment, tags },
  users: { get: getUser },
  previews: { refresh },
};

export type AppRouter = typeof router;
