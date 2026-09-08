// Link previews. Most pages declare an og:image, which is a far better card than a screenshot of
// them — so the first pass is a plain fetch that parses the meta tags, no browser. Only pages that
// declare no image fall back to headless Chromium for a 1200x630 screenshot. Stored in Turso.

import crypto from "node:crypto";
import { chromium, type Browser } from "playwright";
import { db, str, blob } from "./db";
import { putImage, getImage } from "./r2";
import { host, type Preview } from "../shared/links";

const NAV_TIMEOUT_MS = 20_000;
const META_TIMEOUT_MS = 12_000;
const IMAGE_TIMEOUT_MS = 15_000;
const IMAGE_MAX_BYTES = 5_000_000;
const VIEWPORT = { width: 1200, height: 630 };
const EXCERPT_CHARS = 300;
const RETRY_FAILED_AFTER_MS = 24 * 3600_000;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 links-feed/1.0";

export const previewHash = (url: string) => crypto.createHash("sha1").update(url).digest("hex").slice(0, 12);

let browserPromise: Promise<Browser> | null = null;
const getBrowser = () => {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined })
      .then((b) => {
        b.on("disconnected", () => (browserPromise = null));
        return b;
      })
      .catch((e) => {
        browserPromise = null;
        throw e;
      });
  }
  return browserPromise;
};

const clip = (s: string | null | undefined, n: number) =>
  s ? (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s) : null;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  hellip: "\u2026", mdash: "\u2014", ndash: "\u2013", rsquo: "\u2019", lsquo: "\u2018",
  ldquo: "\u201c", rdquo: "\u201d",
};

/**
 * HTMLRewriter hands back raw attribute values, where the DOM used to decode for
 * us — without this, titles read "Fermat&#x27;s Last Theorem".
 */
const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });

interface MetaTags {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
}

/**
 * First pass: fetch the html and read its meta tags. No browser, so it costs a
 * single request instead of a Chromium launch. Returns null when the page can't
 * be read as html, which sends the caller to the screenshot path.
 */
const fetchMetaTags = async (url: string): Promise<{ tags: MetaTags; finalUrl: string } | null> => {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
    signal: AbortSignal.timeout(META_TIMEOUT_MS),
  });
  if (!res.ok || !(res.headers.get("content-type") || "").includes("text/html")) return null;

  const found = new Map<string, string>();
  let title: string | null = null;
  let inTitle = false;
  await new HTMLRewriter()
    .on("meta", {
      element(el) {
        const key = el.getAttribute("property") || el.getAttribute("name");
        const content = el.getAttribute("content");
        if (key && content && !found.has(key.toLowerCase())) found.set(key.toLowerCase(), decodeEntities(content.trim()));
      },
    })
    .on("title", {
      element() {
        inTitle = true;
      },
      text(t) {
        if (inTitle && title === null) title = decodeEntities(t.text.trim()) || null;
      },
    })
    .transform(new Response(res.body))
    .arrayBuffer();

  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = found.get(k);
      if (v) return v;
    }
    return null;
  };
  return {
    finalUrl: res.url || url,
    tags: {
      title: pick("og:title", "twitter:title") || title,
      description: pick("og:description", "twitter:description", "description"),
      image: pick("og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"),
      siteName: pick("og:site_name"),
    },
  };
};

/**
 * Pull down the og:image and put it in R2. Hot-linking the source would leave
 * dead cards behind whenever the origin deletes or moves the file. Failure here
 * is not preview failure — the remote url is still stored as a fallback.
 */
const storeRemoteImage = async (url: string, imageUrl: string): Promise<{ key: string; type: string } | null> => {
  try {
    const res = await fetch(imageUrl, {
      headers: { "user-agent": UA, referer: url },
      redirect: "follow",
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") || "").split(";")[0].trim();
    if (!type.startsWith("image/")) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length || bytes.length > IMAGE_MAX_BYTES) return null;
    const key = await putImage(`previews/${previewHash(url)}`, bytes, type);
    return key ? { key, type } : null;
  } catch {
    return null;
  }
};

/** As above, for bytes we already have in hand (the screenshot). */
const storeRemoteImageBytes = async (
  url: string,
  bytes: Uint8Array,
  type: string
): Promise<{ key: string; type: string } | null> => {
  const key = await putImage(`previews/${previewHash(url)}`, bytes, type);
  return key ? { key, type } : null;
};

/** Runs inside the page. */
const extractInPage = () => {
  const meta = (sel: string) => document.querySelector<HTMLMetaElement>(sel)?.content?.trim() || null;
  const og = (p: string) => meta(`meta[property="og:${p}"]`) || meta(`meta[name="og:${p}"]`);
  const tw = (p: string) => meta(`meta[name="twitter:${p}"]`) || meta(`meta[property="twitter:${p}"]`);

  const main = document.querySelector("main, article, [role=main]") || document.body;
  const noise = "script, style, noscript, nav, header, footer, aside, svg, [aria-hidden=true]";
  const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  let total = 0;
  for (let n = walker.nextNode(); n && total < 2000; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || el.closest(noise) || !el.getClientRects().length) continue;
    const s = (n.textContent || "").replace(/\s+/g, " ").trim();
    if (s) parts.push(s), (total += s.length);
  }

  return {
    title: og("title") || tw("title") || document.title?.trim() || null,
    description: og("description") || tw("description") || meta('meta[name="description"]'),
    image: og("image") || og("image:url") || tw("image") || tw("image:src"),
    siteName: og("site_name"),
    text: parts.join(" "),
  };
};

interface Captured {
  title: string | null;
  description: string | null;
  excerpt: string | null;
  image: string | null;
  siteName: string | null;
  screenshot: Uint8Array | null;
  /** r2 key of the image we stored, so the card survives the source deleting it */
  imageKey: string | null;
  imageType: string | null;
  error: string | null;
}

const captureWithBrowser = async (url: string): Promise<Captured> => {
  const empty: Captured = { title: null, description: null, excerpt: null, image: null, siteName: null, screenshot: null, imageKey: null, imageType: null, error: null };
  let context;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({ viewport: VIEWPORT, userAgent: UA, locale: "en-US", reducedMotion: "reduce" });
    const page = await context.newPage();
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    if (res && !res.ok()) return { ...empty, error: `HTTP ${res.status()}` };
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(500);

    const info = await page.evaluate(extractInPage);
    const image = info.image ? new URL(info.image, page.url()).href : null;
    const shot = await page.screenshot({ type: "jpeg", quality: 70 });
    // The page declared no image (that is why we are here), so the screenshot is
    // the card. Store it in R2; fall back to the Turso blob if R2 is off.
    const stored =
      (image && (await storeRemoteImage(url, image))) ||
      (await storeRemoteImageBytes(url, new Uint8Array(shot), "image/jpeg"));
    return {
      title: clip(info.title, 200),
      description: clip(info.description, 300),
      excerpt: clip(info.text, EXCERPT_CHARS),
      image,
      siteName: info.siteName || host(url),
      screenshot: stored ? null : new Uint8Array(shot),
      imageKey: stored?.key ?? null,
      imageType: stored?.type ?? null,
      error: null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    return { ...empty, error: /Timeout/i.test(msg) ? "timeout" : msg };
  } finally {
    await context?.close().catch(() => {});
  }
};

/**
 * og:image first, browser second. A page that declares its own image gets no
 * Chromium launch at all, which is both faster and a better card — the
 * screenshot of X or LinkedIn is a login wall.
 */
const capture = async (url: string): Promise<Captured> => {
  try {
    const meta = await fetchMetaTags(url);
    if (meta?.tags.image) {
      const imageUrl = new URL(meta.tags.image, meta.finalUrl).href;
      const stored = await storeRemoteImage(url, imageUrl);
      return {
        title: clip(meta.tags.title, 200),
        description: clip(meta.tags.description, 300),
        excerpt: null,
        image: imageUrl,
        siteName: meta.tags.siteName || host(url),
        screenshot: null,
        imageKey: stored?.key ?? null,
        imageType: stored?.type ?? null,
        error: null,
      };
    }
  } catch {
    // unreachable host, bad tls, non-html body: let the browser have a go
  }
  return captureWithBrowser(url);
};

/** Fetch (or re-fetch) the preview for one url and store it. Returns the error, if any. */
export const refreshPreview = async (url: string): Promise<string | null> => {
  const c = await capture(url);
  await db.execute({
    sql: `INSERT INTO previews (url, hash, title, description, excerpt, image, site_name, screenshot, image_key, image_type, error, fetched_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(url) DO UPDATE SET
            title = excluded.title, description = excluded.description, excerpt = excluded.excerpt,
            image = excluded.image, site_name = excluded.site_name,
            screenshot = COALESCE(excluded.screenshot, previews.screenshot),
            image_key = COALESCE(excluded.image_key, previews.image_key),
            image_type = COALESCE(excluded.image_type, previews.image_type),
            error = excluded.error, fetched_at = excluded.fetched_at`,
    args: [url, previewHash(url), c.title, c.description, c.excerpt, c.image, c.siteName, c.screenshot, c.imageKey, c.imageType, c.error, new Date().toISOString()],
  });
  return c.error;
};

/** Fetch previews for urls that have none yet (or whose last attempt failed more than a day ago). */
export const ensurePreviews = async (urls: string[]): Promise<Record<string, string | null>> => {
  const unique = [...new Set(urls)];
  const result: Record<string, string | null> = {};
  if (!unique.length) return result;

  const existing = await db.execute({
    sql: `SELECT url, error, fetched_at FROM previews WHERE url IN (${unique.map(() => "?").join(",")})`,
    args: unique,
  });
  const known = new Map(existing.rows.map((r) => [str(r, "url")!, { error: str(r, "error"), fetchedAt: str(r, "fetched_at")! }]));

  for (const url of unique) {
    const k = known.get(url);
    if (k && (!k.error || Date.now() - Date.parse(k.fetchedAt) < RETRY_FAILED_AFTER_MS)) {
      result[url] = k.error;
      continue;
    }
    result[url] = await refreshPreview(url);
  }
  return result;
};

/** Previews for many urls, keyed by url, shaped for the client and the feeds. */
export const previewsFor = async (urls: string[]): Promise<Map<string, Preview>> => {
  const unique = [...new Set(urls)];
  const out = new Map<string, Preview>();
  if (!unique.length) return out;
  const res = await db.execute({
    sql: `SELECT url, hash, title, description, excerpt, image, site_name, image_key,
                 (screenshot IS NOT NULL) AS has_shot, error
          FROM previews WHERE url IN (${unique.map(() => "?").join(",")})`,
    args: unique,
  });
  for (const r of res.rows) {
    if (str(r, "error")) continue;
    out.set(str(r, "url")!, {
      title: str(r, "title"),
      description: str(r, "description") || str(r, "excerpt"),
      // Our own R2 copy first, so the card outlives the source. Then the site's
      // og:image. The Turso blob is last: it only exists on rows captured before
      // the og:image change, where it holds a screenshot of a login wall as
      // often as anything useful.
      image:
        str(r, "image_key")
          ? `/previews/${str(r, "hash")}.jpg`
          : str(r, "image") || (Number(r["has_shot"]) ? `/previews/${str(r, "hash")}.jpg` : null),
      siteName: str(r, "site_name"),
    });
  }
  return out;
};

export const screenshotByHash = async (hash: string): Promise<{ bytes: Uint8Array; type: string } | null> => {
  const res = await db.execute({
    sql: "SELECT screenshot, image_key, image_type FROM previews WHERE hash = ?",
    args: [hash],
  });
  const row = res.rows[0];
  if (!row) return null;
  const key = str(row, "image_key");
  if (key) {
    const stored = await getImage(key);
    if (stored) return { bytes: stored.bytes, type: str(row, "image_type") || stored.type };
  }
  const legacy = blob(row, "screenshot");
  return legacy ? { bytes: legacy, type: "image/jpeg" } : null;
};

/** Drop previews no post references any more. */
export const prunePreviews = () =>
  db.execute(`DELETE FROM previews WHERE url NOT IN (SELECT link FROM posts WHERE link IS NOT NULL)
                                   AND url NOT IN (SELECT ref FROM posts WHERE ref IS NOT NULL)`);

export const closeBrowser = async () => {
  const b = await browserPromise?.catch(() => null);
  await b?.close().catch(() => {});
  browserPromise = null;
};
