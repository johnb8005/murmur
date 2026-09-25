// Bun server: the built app (dist/), feeds, preview images and the oRPC API. The network is
// private: feeds and preview images need a session cookie or a feed token (?token=), and pages
// carry only generic Open Graph tags so a shared post URL reveals nothing to link unfurlers.

import path from "node:path";
import { ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ResponseHeadersPlugin } from "@orpc/server/plugins";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { db, migrate } from "./db";
import { router, loadPosts, postImage, type Context } from "./router";
import { screenshotByHash, closeBrowser } from "./preview";
import { readCookie, pruneAuth, adoptLegacyPosts, sessionUser, userByFeedToken, SESSION_COOKIE } from "./auth";
import { toRss, toJsonFeed, escapeHtml, APP_NAME, type Author, type FeedOptions } from "../shared/links";

const PORT = Number(process.env.PORT) || 8080;
const DIST = path.resolve(import.meta.dir, "..", "dist");
const SITE_URL = (process.env.SITE_URL || "https://murmur.johanboissard.me").replace(/\/$/, "");
const DESCRIPTION = "Links worth sharing, from people worth following. No algorithm.";
const feedOptions: FeedOptions = { siteUrl: SITE_URL, title: APP_NAME, description: DESCRIPTION };

/** Who is asking for a feed or preview image: the session cookie, or a feed token in the URL. */
const viewer = async (req: Request, url: URL): Promise<{ user: Author; token: string | null } | null> => {
  const user = await sessionUser(readCookie(req, SESSION_COOKIE));
  if (user) return { user, token: null };
  const token = url.searchParams.get("token");
  const byToken = await userByFeedToken(token);
  return byToken ? { user: byToken, token } : null;
};

// ResponseHeadersPlugin hands procedures a `resHeaders` Headers object (used for set-cookie).
// onError: oRPC turns unexpected exceptions into a bare 500; log them so Cloud Run shows the cause.
const logError = (pathname: string, error: unknown) => {
  if (error instanceof ORPCError && error.status < 500) return; // expected: 400/401/403/404
  console.error(`[${pathname}]`, error instanceof Error ? (error.stack ?? error.message) : error);
};
const rpc = new RPCHandler(router, {
  plugins: [new ResponseHeadersPlugin()],
  interceptors: [async (o) => { try { return await o.next(); } catch (e) { logError(o.request.url.pathname, e); throw e; } }],
});
const api = new OpenAPIHandler(router, {
  plugins: [new ResponseHeadersPlugin()],
  interceptors: [async (o) => { try { return await o.next(); } catch (e) { logError(o.request.url.pathname, e); throw e; } }],
});

const contextFrom = (req: Request): Context => {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") || "");
  return { token: m?.[1]?.trim(), sessionId: readCookie(req, SESSION_COOKIE) };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

// ---------- html with Open Graph tags ----------

/**
 * The built index.html, with the `<!-- og -->` placeholder swapped for the app's generic tags.
 * Every page gets the same card on purpose: posts and profiles are only for signed-in members,
 * so a post URL pasted in a chat must not unfurl into its content. The card is still a good one
 * (WhatsApp, iMessage, Slack show `/og.jpg`, 1200x630, under 300 KB); a post URL says a murmur
 * was shared and that signing in shows it, nothing about the murmur itself.
 */
const html = async (pathname: string): Promise<Response> => {
  const index = Bun.file(path.join(DIST, "index.html"));
  if (!(await index.exists())) return new Response("dist/ not built. Run `bun run build`.", { status: 503 });
  const url = SITE_URL + pathname;
  const isPost = /^\/p\/[^/]+$/.test(pathname);
  const description = isPost ? `A murmur was shared with you. ${APP_NAME} is members only: sign in to read it.` : DESCRIPTION;
  const tags = [
    `<meta property="og:site_name" content="${APP_NAME}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${APP_NAME}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    `<meta property="og:image" content="${SITE_URL}/og.jpg">`,
    `<meta property="og:image:secure_url" content="${SITE_URL}/og.jpg">`,
    `<meta property="og:image:type" content="image/jpeg">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="${APP_NAME}: ${escapeHtml(DESCRIPTION)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${APP_NAME}">`,
    `<meta name="twitter:description" content="${escapeHtml(description)}">`,
    `<meta name="twitter:image" content="${SITE_URL}/og.jpg">`,
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<meta name="robots" content="noindex">`,
  ].join("\n    ");
  const body = (await index.text()).replace("<!-- og -->", tags);
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
};

// ---------- static ----------

const staticFile = async (pathname: string): Promise<Response | null> => {
  const rel = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = path.join(DIST, rel);
  if (!file.startsWith(DIST + path.sep)) return null;
  const f = Bun.file(file);
  if (!(await f.exists())) return null;
  const immutable = rel.startsWith("assets" + path.sep) || rel.startsWith("assets/");
  const sw = /^(sw|workbox-[^/]*|registerSW)\.js$/.test(rel) || rel === "manifest.webmanifest";
  return new Response(f, {
    headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : sw ? "no-cache" : "public, max-age=300" },
  });
};

await migrate();
await pruneAuth();
await adoptLegacyPosts();

const server = Bun.serve({
  port: PORT,
  idleTimeout: 120, // preview capture can take a while
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;

    // (health is router.health, served at /api/health; Cloud Run's frontend swallows "/healthz")
    if (p === "/rpc" || p.startsWith("/rpc/")) {
      const r = await rpc.handle(req, { prefix: "/rpc", context: contextFrom(req) });
      return r.matched ? r.response : json({ error: "not found" }, 404);
    }
    if (p === "/api" || p.startsWith("/api/")) {
      const r = await api.handle(req, { prefix: "/api", context: contextFrom(req) });
      return r.matched ? r.response : json({ error: "not found" }, 404);
    }
    if (p === "/feed.xml" || p === "/feed.json") {
      const who = await viewer(req, url);
      if (!who) return new Response("sign in, or use the feed URL from Settings", { status: 401, headers: { "cache-control": "no-store" } });
      const posts = await loadPosts({ viewerId: who.user.id, limit: 100 });
      const xml = p === "/feed.xml";
      const opts = who.token ? { ...feedOptions, token: who.token } : feedOptions;
      return new Response(xml ? toRss(posts, opts) : toJsonFeed(posts, opts), {
        headers: {
          "content-type": xml ? "application/rss+xml; charset=utf-8" : "application/feed+json; charset=utf-8",
          "cache-control": "private, max-age=300",
        },
      });
    }

    // a post's picture: members only, and only if they may see the post (private ones are the author's)
    const pic = /^\/images\/([A-Za-z0-9]{6,32})$/.exec(p);
    if (pic) {
      const who = await viewer(req, url);
      if (!who) return new Response("unauthorized", { status: 401, headers: { "cache-control": "no-store" } });
      const img = await postImage(pic[1], who.user);
      if (!img) return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
      return new Response(img.bytes.buffer as ArrayBuffer, {
        headers: { "content-type": img.type, "cache-control": "private, max-age=31536000, immutable" },
      });
    }

    // the share sheet's POST lands in the service worker (public/share-target.js); without one, drop the file and open the composer
    if (req.method === "POST" && p === "/share") {
      const form = await req.formData().catch(() => null);
      const q = new URLSearchParams();
      for (const k of ["title", "text", "url"]) {
        const v = form?.get(k);
        if (typeof v === "string" && v) q.set(k, v);
      }
      return Response.redirect(`${SITE_URL}/share?${q}`, 303);
    }

    const shot = /^\/previews\/([0-9a-f]{12})\.jpg$/.exec(p);
    if (shot) {
      if (!(await viewer(req, url))) return new Response("unauthorized", { status: 401, headers: { "cache-control": "no-store" } });
      const img = await screenshotByHash(shot[1]);
      if (!img) return new Response("not found", { status: 404 });
      return new Response(img.bytes.buffer as ArrayBuffer, {
        headers: { "content-type": img.type, "cache-control": "private, max-age=86400" },
      });
    }

    if (req.method === "GET" || req.method === "HEAD") {
      if (p !== "/") {
        const f = await staticFile(p);
        if (f) return f;
      }
      // app routes (/, /p/<id>, /u/<name>, /link/<token>, ...): the shell, the app takes it from there
      return html(p);
    }
    return new Response("method not allowed", { status: 405 });
  },
});

console.log(`${APP_NAME} listening on http://localhost:${server.port} (db: ${process.env.TURSO_DATABASE_URL ? "turso" : "local file"}, origin: ${SITE_URL})`);

const shutdown = async () => {
  await closeBrowser();
  db.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
