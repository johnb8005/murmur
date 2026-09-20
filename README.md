# Murmur

Links worth sharing, from people worth following. No algorithm.

A small, private Twitter-like app for sharing links. Bun server + Turso + R2, React 19 + Tailwind 4,
deployed as a container on Cloud Run.

- **Members only.** The timeline, posts, profiles, feeds and preview images all need an account;
  visitors only see the sign-in page. A post URL pasted into a chat unfurls to the generic Murmur card,
  never to the post. Sign-up is open to anyone who reaches the page.
- **Accounts are passkeys.** Pick a unique username, your device's Face ID / Touch ID / security key is
  the credential. No passwords, no email. Settings lets you change your username and display name
  (the profile link follows the username) and add or remove passkeys.
- **One account, many devices.** "Add another device" on your profile (or in Settings) asks for your
  passkey on the device you hold, then shows a link and a QR code. Opened on a new phone or laptop
  (`/link/<token>`), it creates a passkey there for the same account and signs it in: no passkey needed
  on the new device beforehand. The inviting device notices when the new one is in. A session cookie
  alone cannot mint a link, only a fresh passkey check can. Links are single use and expire after ten
  minutes. Passkeys synced by iCloud Keychain / Google Password Manager need no extra step.
- **Pictures.** A murmur can carry one picture: the Photo button (camera or library on a phone), a
  paste into the composer, or the Android share sheet (the installed app accepts images; the service
  worker script `public/share-target.js` hands them to the composer). The browser shrinks it to
  2000 px on the long side before upload; bytes live in R2 (or the `images` table without R2) and are
  served at `/images/<id>` to members who may see the murmur. Feeds carry it as an enclosure.
- **One timeline.** A post is a *murmur*: up to 500 characters; the first link gets a preview card
  (title, description, image). Like, comment, delete your own murmurs.
- **Labels.** `#hashtags` in the text, and/or tags typed in the composer's tag field, become labels
  on the murmur. Each links to `/t/<tag>`, which lists everything with that label and the other labels
  in use. Feeds carry them as RSS categories / JSON Feed tags.
- **Only me.** Flip the composer's "Everyone" switch to "Only me" and the murmur is private: it shows
  up in your own timeline, profile, tag pages and feed with an "Only you" mark, and nobody else can
  list it, open it, like it or comment on it.
- **Share.** The share button uses the Web Share API (falls back to copying the link) and shares
  only the murmur's address. Chat apps unfurl it into the generic Murmur card (`public/og.jpg`, made
  by `bun scripts/og-card.ts`): a post URL says a murmur was shared and that signing in shows it,
  never the murmur itself.
- **PWA.** Installable, offline shell, and a Web Share Target: once installed on Android (or desktop
  Chrome), Murmur appears in the system share sheet next to Twitter and Slack. Shared links land in the
  composer at `/share`.
- **Feeds.** `/feed.xml` (RSS 2.0) and `/feed.json` (JSON Feed 1.1), with `?token=<feed token>`: every
  member has a secret feed token (Settings → Feeds, or `GET /api/auth/feed`). Preview images in the
  feed carry the same token so readers can load them.
- **API.** oRPC at `/rpc` (used by the app) and `/api` (plain HTTP). `GET /api/health` reports
  `{status, sha, version, date}` as injected by the deploy. Everything else needs the session cookie
  or `Authorization: Bearer $ADMIN_TOKEN` (acts as the owner): `GET /api/posts`,
  `GET /api/posts/{id}`, `GET /api/posts?tag=`, `GET /api/tags`, `GET /api/users/{username}`,
  `POST /api/posts {"text", "tags"?: [...], "private"?: bool}`.

## Running locally

```bash
bun install
bunx playwright install chromium          # once, for link screenshots
cp .env.example .env                      # SITE_URL=http://localhost:5173 (the WebAuthn origin), local SQLite by default
bun run dev                               # API on :8080 + Vite on :5173
```

`bun run build` builds the app into `dist/`; `bun run start` serves it with the API on `$PORT`.
`bun test/e2e.ts` (after a build) drives the passkey flows in Chromium with a virtual authenticator:
sign-up, the device link, feed tokens.

## Deploying

`cloud-run.yml` builds the `Dockerfile` (Playwright image + Bun) with Cloud Build and deploys to
Cloud Run on every push to `main` (and on `v*` tags). Secrets: `GCP_SA_KEY`, `TURSO_DATABASE_URL`,
`TURSO_AUTH_TOKEN`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, optionally
`ADMIN_TOKEN`. Variables: `GCP_PROJECT_ID` (required), `SITE_URL` (the public address, it is the
WebAuthn origin), optionally `GCP_REGION`, `CLOUD_RUN_SERVICE`, `OWNER_USERNAME`, `R2_BUCKET`. Map the
domain to the service in the Cloud Run console. The owner account (`OWNER_USERNAME`, default `johan`)
may delete any post and inherits posts made before accounts existed.

## Layout

- `server/index.ts` static app, feeds, preview images, API; `server/router.ts` the oRPC procedures;
  `server/auth.ts` accounts, passkeys, device links, feed tokens, sessions; `server/preview.ts` link
  previews (meta tags first, screenshot when there is no image); `server/r2.ts` image bytes;
  `server/db.ts` schema
- `shared/links.ts` post model, link extraction, feeds
- `src/` React 19 + Tailwind 4; `vite.config.ts` holds the PWA manifest and Workbox rules
