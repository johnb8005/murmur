// End-to-end check of the passkey flows with Chromium's virtual authenticator: create an account on
// device A, mint a device link from A's profile (after a passkey check on A), open it on device B (a
// separate browser context with its own authenticator), finish there, confirm B is signed in with a
// second passkey and that A noticed. Also: the timeline is members-only, the feed token lets a
// reader in, and a device link cannot be minted with the session cookie alone.
//
// Run against a built app: `bun run build`, then `bun test/e2e.ts` (it starts the server itself).

import { chromium, type Page } from "playwright";

const PORT = 8090;
const ORIGIN = `http://localhost:${PORT}`;

const server = Bun.spawn(["bun", "server/index.ts"], {
  env: { ...process.env, PORT: String(PORT), SITE_URL: ORIGIN, TURSO_DATABASE_URL: `file:${process.cwd()}/test/e2e.db` },
  stdout: "inherit",
  stderr: "inherit",
});
let current: import("playwright").Page | null = null;
const fail = async (msg: string) => {
  console.error(`FAIL: ${msg}`);
  if (current) console.error(`page ${current.url()} says:\n${(await current.innerText("body").catch(() => "")).slice(0, 1500)}`);
  server.kill();
  process.exit(1);
};
const expect = (cond: unknown, msg: string) => {
  if (!cond) fail(msg);
  console.log(`ok: ${msg}`);
};

for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${ORIGIN}/api/health`)).ok) break;
  } catch {}
  if (i > 50) fail("server did not start");
  await Bun.sleep(200);
}

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });

/**
 * A fresh browser context (own cookies) with one page that has a virtual platform authenticator
 * (Touch ID / Windows Hello stand-in). The authenticator lives on the CDP session of that page, so
 * the page is what the test drives.
 */
const device = async (): Promise<Page> => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`browser error: ${e.message}`));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return page;
};

try {
  // signed out: the timeline sends you to sign in; the API and feeds refuse
  const pa = await device();
  current = pa;
  await pa.goto(`${ORIGIN}/`);
  await pa.waitForURL(/\/login/);
  expect(pa.url().includes("/login"), "signed-out visitor is sent to /login");
  const healthBody = await (await fetch(`${ORIGIN}/api/health`)).json();
  expect(healthBody.status === "ok" && healthBody.db === "ok" && healthBody.storage === "database", "health reports the database round trip and where images live");
  expect((await fetch(`${ORIGIN}/api/posts`)).status === 401, "GET /api/posts is 401 without a session");
  expect((await fetch(`${ORIGIN}/feed.xml`)).status === 401, "feed.xml is 401 without a token");

  // create an account on device A
  const username = `e2e${Date.now().toString(36).slice(-6)}`;
  await pa.getByRole("button", { name: "Create account" }).click();
  await pa.getByPlaceholder("username").fill(username);
  await pa.getByText(`@${username} is free`).waitFor();
  await pa.getByRole("button", { name: "Create account with passkey" }).click();
  await pa.waitForURL(`${ORIGIN}/`);
  await pa.getByPlaceholder("Something worth sharing?").waitFor();
  expect(true, `account @${username} created on device A and signed in`);

  await pa.getByPlaceholder("Something worth sharing?").fill("hello from device A https://example.com/ #e2e");
  await pa.getByRole("button", { name: "Murmur", exact: true }).click();
  await pa.getByText("hello from device A").first().waitFor();
  await pa.locator("article").first().getByRole("link", { name: "#e2e" }).first().waitFor();
  expect(true, "device A posted, the #hashtag became a label");

  // a private murmur, tagged through the separate field: only its author sees it
  await pa.getByRole("button", { name: "Tags" }).click();
  await pa.getByLabel("Tags").fill("secret, E2E");
  await pa.getByRole("switch", { name: "Everyone" }).click();
  await pa.getByPlaceholder("Something worth sharing?").fill("a note to self");
  await pa.getByRole("button", { name: "Murmur to myself" }).click();
  const privateCard = pa.locator("article", { hasText: "a note to self" });
  await privateCard.getByText("Only you").waitFor();
  const privateId = (await privateCard.getAttribute("id"))!;
  expect(privateId && (await privateCard.getByRole("link", { name: "#secret" }).count()) === 1, "a private murmur shows 'Only you' and its labels");
  await pa.goto(`${ORIGIN}/t/secret`);
  await pa.getByText("a note to self").first().waitFor();
  expect(true, "the tag page lists the author's private murmur");

  // a murmur with a picture: drawn in the page, shrunk by the composer, uploaded with the post
  const png = await pa.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 2400;
    c.height = 1600;
    const g = c.getContext("2d")!;
    g.fillStyle = "#8b5cf6";
    g.fillRect(0, 0, 2400, 1600);
    g.fillStyle = "#10b981";
    g.beginPath();
    g.arc(1200, 800, 500, 0, Math.PI * 2);
    g.fill();
    return c.toDataURL("image/png").split(",")[1]!;
  });
  await pa.goto(`${ORIGIN}/`);
  await pa.getByPlaceholder("Something worth sharing?").waitFor();
  await pa.getByLabel("Picture file").setInputFiles({ name: "sunset.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await pa.getByRole("button", { name: "Remove picture" }).waitFor();
  await pa.getByPlaceholder("Something worth sharing?").fill("a picture, no link");
  await pa.getByRole("button", { name: "Murmur", exact: true }).click();
  const picCard = pa.locator("article", { hasText: "a picture, no link" }).first();
  await picCard.locator('img[src^="/images/"]').waitFor();
  const picSrc = (await picCard.locator('img[src^="/images/"]').getAttribute("src"))!;
  const picMeta = await pa.evaluate(async (src) => {
    const r = await fetch(src);
    return { status: r.status, type: r.headers.get("content-type"), bytes: (await r.arrayBuffer()).byteLength };
  }, picSrc);
  expect(picMeta.status === 200 && /^image\/(png|jpeg)$/.test(picMeta.type || "") && picMeta.bytes > 1000 && picMeta.bytes < 800_000, `the picture is served as ${picMeta.type}, shrunk to ${Math.round(picMeta.bytes / 1024)} KB`);
  const picW = await picCard.locator('img[src^="/images/"]').getAttribute("width");
  expect(picW === "2000", "the composer capped the long side at 2000 px");
  expect((await fetch(`${ORIGIN}${picSrc}`)).status === 401, "the picture is members only");

  // A shared post URL unfurls to nothing specific
  const postHtml = await (await fetch(`${ORIGIN}/p/whatever`)).text();
  expect(postHtml.includes('og:title" content="Murmur"') && !postHtml.includes("hello from device A"), "post pages carry only generic Open Graph tags");
  expect(postHtml.includes("A murmur was shared with you") && postHtml.includes(`og:image" content="${ORIGIN}/og.jpg"`), "a post URL unfurls to the 'shared with you' card");
  const og = await fetch(`${ORIGIN}/og.jpg`);
  const ogBytes = (await og.arrayBuffer()).byteLength;
  expect(og.status === 200 && og.headers.get("content-type")?.startsWith("image/jpeg") && ogBytes > 10_000 && ogBytes < 300_000, `the card image is served (${Math.round(ogBytes / 1024)} KB, under WhatsApp's 300 KB)`);

  // feed token: the feed answers with it, and the token is in the image URLs
  await pa.goto(`${ORIGIN}/settings`);
  await pa.getByText("Copy RSS URL").waitFor();
  const feedUrls = await pa.evaluate(async () => {
    const r = await fetch("/api/auth/feed");
    return (await r.json()) as { token: string; rss: string; json: string };
  });
  expect(feedUrls.rss.startsWith(`${ORIGIN}/feed.xml?token=`), "feed URL carries the token");
  const rss = await fetch(feedUrls.rss);
  const rssText = await rss.text();
  expect(rss.status === 200 && rssText.includes("hello from device A") && rssText.includes("<category>e2e</category>"), "RSS feed opens with the token, no cookie, and carries the labels");
  expect(rssText.includes(`<enclosure url="${ORIGIN}${picSrc}?token=`) && rssText.includes(`type="${picMeta.type}"`), "the picture is an enclosure in the feed, with the token");
  expect((await fetch(`${ORIGIN}${picSrc}?token=${encodeURIComponent(feedUrls.token)}`)).status === 200, "the feed token opens the picture too");
  expect((await fetch(`${ORIGIN}/feed.xml?token=wrong`)).status === 401, "a wrong feed token is refused");

  // a device link needs a fresh passkey assertion: the session cookie alone gets nothing
  const cookieOnly = await pa.evaluate(async () => {
    const r = await fetch("/api/auth/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challengeId: "nope", response: {} }) });
    return r.status;
  });
  expect(cookieOnly === 400, "POST /api/auth/link without a valid passkey assertion is refused");

  // device link: made on A from its own profile, after the (virtual) passkey answers the re-auth prompt ...
  await pa.goto(`${ORIGIN}/u/${username}`);
  await pa.getByRole("button", { name: "Add another device" }).click();
  await pa.locator("code").first().waitFor();
  const url = (await pa.locator("code").first().textContent())!.trim();
  expect(/\/link\/[A-Za-z0-9_-]{20,}$/.test(url), `device link minted: ${url.replace(/link\/.*/, "link/…")}`);
  expect((await pa.locator('img[alt="QR code of the device link"]').getAttribute("src"))!.startsWith("data:image/png"), "QR code rendered");

  // ... opened on B, which has no passkey at all
  const pb = await device();
  current = pb;
  await pb.goto(url);
  await pb.getByText(`@${username}`).waitFor();
  await pb.getByRole("button", { name: "Create a passkey on this device" }).click();
  await pb.waitForURL(`${ORIGIN}/`);
  await pb.getByText("hello from device A").first().waitFor();
  expect(true, "device B signed in through the link and sees the timeline");

  // the link is single use
  const pc = await device();
  await pc.goto(url);
  await pc.getByText(/expired or was already used/).waitFor();
  expect(true, "a used device link is refused");

  // ... and A noticed without a reload
  await pa.getByText("New device added").waitFor({ timeout: 15_000 });
  expect(true, "device A saw the new passkey arrive");

  // another member never sees the private murmur: not in the timeline, the profile, the tag page or by URL
  current = pc;
  await pc.goto(`${ORIGIN}/login`);
  await pc.getByRole("button", { name: "Create account" }).click();
  await pc.getByPlaceholder("username").fill(`${username}b`);
  await pc.getByText(`@${username}b is free`).waitFor();
  await pc.getByRole("button", { name: "Create account with passkey" }).click();
  await pc.waitForURL(`${ORIGIN}/`);
  await pc.getByText("hello from device A").first().waitFor();
  expect((await pc.getByText("a note to self").count()) === 0, "another member's timeline has the public murmur, not the private one");
  await pc.goto(`${ORIGIN}/u/${username}`);
  await pc.getByText("hello from device A").first().waitFor();
  expect((await pc.getByText("a note to self").count()) === 0, "nor does the author's profile as seen by them");
  await pc.goto(`${ORIGIN}/t/secret`);
  await pc.getByText("No murmur carries #secret.").waitFor();
  await pc.goto(`${ORIGIN}/p/${privateId}`);
  await pc.getByText("no such post").waitFor();
  const byApi = await pc.evaluate(async (id) => (await fetch(`/api/posts/${id}`)).status, privateId);
  expect(byApi === 404, "the private murmur's page and API answer 404 to them");
  current = pb;

  // B is a real second passkey: it can sign in on its own after signing out
  await pb.goto(`${ORIGIN}/settings`);
  await pb.locator("section", { hasText: "Passkeys" }).getByText("· added").nth(1).waitFor();
  expect((await pb.locator("section", { hasText: "Passkeys" }).getByText("· added").count()) === 2, "the account now has two passkeys");
  await pb.getByRole("button", { name: "Sign out" }).click();
  await pb.waitForURL(/\/login/);
  await pb.getByRole("button", { name: "Sign in with passkey" }).click();
  await pb.waitForURL(`${ORIGIN}/settings`); // back where sign-out happened
  await pb.getByRole("button", { name: "Sign out" }).waitFor();
  expect(true, "device B signs in again with its own passkey");

  console.log("all passkey flows pass");
} catch (e) {
  fail(e instanceof Error ? (e.stack ?? e.message) : String(e));
} finally {
  await browser.close();
  server.kill();
}
