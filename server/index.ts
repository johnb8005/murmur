// Bun server: the built app (dist/), feeds, preview images, the oRPC API, and server-rendered
// Open Graph tags on post and profile URLs so WhatsApp, Slack and friends show a card.

import path from "node:path";
import { RPCHandler } from "@orpc/server/fetch";
import { ResponseHeadersPlugin } from "@orpc/server/plugins";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { db, migrate } from "./db";
import { router, loadPosts, type Context } from "./router";
import { screenshotByHash, closeBrowser } from "./preview";
import { readCookie, pruneAuth, adoptLegacyPosts, userByUsername, SESSION_COOKIE } from "./auth";
import { toRss, toJsonFeed, escapeHtml, itemTitle, APP_NAME, type FeedOptions } from "../shared/links";

const PORT = Number(process.env.PORT) || 8080;
const DIST = path.resolve(import.meta.dir, "..", "dist");
const SITE_URL = (process.env.SITE_URL || "https://murmur.johanboissard.me").replace(/\/$/, "");
const DESCRIPTION = "Links worth sharing, from people worth following. No algorithm.";
const feedOptions: FeedOptions = { siteUrl: SITE_URL, title: APP_NAME, description: DESCRIPTION };

// ResponseHeadersPlugin hands procedures a `resHeaders` Headers object (used for set-cookie)
const rpc = new RPCHandler(router, { plugins: [new ResponseHeadersPlugin()] });
const api = new OpenAPIHandler(router, { plugins: [new ResponseHeadersPlugin()] });

const contextFrom = (req: Request): Context => {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") || "");
  return { token: m?.[1]?.trim(), sessionId: readCookie(req, SESSION_COOKIE) };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

// ---------- html with Open Graph tags ----------

interface Meta {
  title: string;
  description: string;
  url: string;
  image?: string | null;
  type?: string;
}

const absolute = (src: string) => (src.startsWith("/") ? SITE_URL + src : src);

/** The built index.html, with the `<!-- og -->` placeholder swapped for page-specific tags. */
const html = async (meta: Meta): Promise<Response> => {
  const index = Bun.file(path.join(DIST, "index.html"));
  if (!(await index.exists())) return new Response("dist/ not built. Run `bun run build`.", { status: 503 });
  const image = meta.image ? absolute(meta.image) : `${SITE_URL}/icon-512.png`;
  const tags = [
    `<meta property="og:site_name" content="${APP_NAME}">`,
    `<meta property="og:type" content="${meta.type || "website"}">`,
    `<meta property="og:title" content="${escapeHtml(meta.title)}">`,
    `<meta property="og:description" content="${escapeHtml(meta.description)}">`,
    `<meta property="og:url" content="${escapeHtml(meta.url)}">`,
    `<meta property="og:image" content="${escapeHtml(image)}">`,
    `<meta name="twitter:card" content="${meta.image ? "summary_large_image" : "summary"}">`,
    `<meta name="description" content="${escapeHtml(meta.description)}">`,
    `<link rel="canonical" href="${escapeHtml(meta.url)}">`,
  ].join("\n    ");
  const body = (await index.text())
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(meta.title)}</title>`)
    .replace("<!-- og -->", tags);
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
};

const defaultMeta = (p: string): Meta => ({ title: APP_NAME, description: DESCRIPTION, url: SITE_URL + p });

const postMeta = async (id: string): Promise<Meta> => {
  const [post] = await loadPosts({ id, limit: 1 });
  if (!post) return defaultMeta(`/p/${id}`);
  const text = post.text.length > 200 ? post.text.slice(0, 197).trimEnd() + "…" : post.text;
  return {
    title: `${post.author.displayName} (@${post.author.username}) on ${APP_NAME}: ${itemTitle(post)}`,
    description: text || post.preview?.description || DESCRIPTION,
    url: `${SITE_URL}/p/${post.id}`,
    image: post.preview?.image,
    type: "article",
  };
};

const userMeta = async (username: string): Promise<Meta> => {
  const user = await userByUsername(username);
  if (!user) return defaultMeta(`/u/${username}`);
  return { title: `${user.displayName} (@${user.username}) on ${APP_NAME}`, description: DESCRIPTION, url: `${SITE_URL}/u/${user.username}`, type: "profile" };
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
      const posts = await loadPosts({ limit: 100 });
      const xml = p === "/feed.xml";
      return new Response(xml ? toRss(posts, feedOptions) : toJsonFeed(posts, feedOptions), {
        headers: {
          "content-type": xml ? "application/rss+xml; charset=utf-8" : "application/feed+json; charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      });
    }

    const shot = /^\/previews\/([0-9a-f]{12})\.jpg$/.exec(p);
    if (shot) {
      const img = await screenshotByHash(shot[1]);
      if (!img) return new Response("not found", { status: 404 });
      return new Response(img.bytes.buffer as ArrayBuffer, {
        headers: { "content-type": img.type, "cache-control": "public, max-age=86400" },
      });
    }

    if (req.method === "GET" || req.method === "HEAD") {
      if (p !== "/") {
        const f = await staticFile(p);
        if (f) return f;
      }
      // app routes: index.html with Open Graph tags for the page
      const post = /^\/p\/([a-z0-9]+)$/i.exec(p);
      if (post) return html(await postMeta(post[1]));
      const user = /^\/u\/([a-z0-9_]+)$/i.exec(p);
      if (user) return html(await userMeta(user[1]));
      return html(defaultMeta(p));
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
