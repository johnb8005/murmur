// Renders public/og.jpg, the 1200x630 link-preview card every page advertises (see `html` in
// server/index.ts). Run after `bun install` with a Chromium for Playwright:
//   bun scripts/og-card.ts            (PLAYWRIGHT_CHROMIUM_PATH=... to point at an installed one)
// Fonts come from Google Fonts at render time (Outfit + JetBrains Mono, as in index.html); with no
// network the DejaVu fallbacks are used. Keep it under 300 KB: WhatsApp drops larger thumbnails.
import { chromium } from "playwright";
const html = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
<style>
    html,body{margin:0;width:1200px;height:630px;background:#050509;overflow:hidden;font-family:Outfit,'DejaVu Sans',sans-serif;color:#f3f4f6}
  .aurora{position:absolute;inset:0;background:
    radial-gradient(40% 40% at 22% 30%, rgba(59,130,246,.30), transparent 70%),
    radial-gradient(45% 45% at 82% 62%, rgba(139,92,246,.24), transparent 70%),
    radial-gradient(30% 30% at 48% 90%, rgba(16,185,129,.18), transparent 70%)}
  .card{position:absolute;left:80px;top:80px;right:80px;bottom:80px;border-radius:48px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.045);display:flex;align-items:center;padding:0 88px;gap:64px;box-sizing:border-box}
  .logo{width:200px;height:200px;border-radius:44px;flex:none;position:relative;background:linear-gradient(135deg,#0b1020,#050509);box-shadow:0 20px 60px rgba(0,0,0,.5)}
  .logo i{position:absolute;border-radius:50%;opacity:.95}
  h1{margin:0;font-weight:300;font-size:112px;letter-spacing:-.03em;line-height:1}
  p{margin:22px 0 0;font-weight:300;font-size:36px;color:#9ca3af;letter-spacing:-.01em}
  small{display:block;margin-top:34px;font-family:'JetBrains Mono','DejaVu Sans Mono',monospace;font-size:22px;color:#4b5563}
</style></head><body>
<div class="aurora"></div>
<div class="card">
  <div class="logo">
    <i style="left:40px;top:85px;width:58px;height:58px;background:#3b82f6"></i>
    <i style="left:70px;top:41px;width:72px;height:72px;background:#8b5cf6"></i>
    <i style="left:113px;top:98px;width:48px;height:48px;background:#10b981"></i>
    <i style="left:93px;top:64px;width:26px;height:26px;background:#050509;opacity:.55"></i>
  </div>
  <div>
    <h1>Murmur</h1>
    <p>Links worth sharing, from people worth following.</p>
    <small>members only · sign in to read</small>
  </div>
</div>
</body></html>`;
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: "networkidle" }).catch(() => {});
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: "public/og.jpg", type: "jpeg", quality: 86 });
await browser.close();
