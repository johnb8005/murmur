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
- **One account, many devices.** Settings → "Add another device" shows a link and a QR code. Opened on
  a new phone or laptop (`/link/<token>`), it creates a passkey there for the same account and signs it
  in: no passkey needed on the new device beforehand. Links are single use and expire after ten
  minutes. Passkeys synced by iCloud Keychain / Google Password Manager need no extra step.
- **One timeline.** Post up to 500 characters; the first link gets a preview card (title,
  description, image). Like, comment, delete your own posts.
- **Share.** The share button uses the Web Share API (falls back to copying the link).
- **PWA.** Installable, offline shell, and a Web Share Target: once installed on Android (or desktop
  Chrome), Murmur appears in the system share sheet next to Twitter and Slack. Shared links land in the
  composer at `/share`.
- **Feeds.** `/feed.xml` (RSS 2.0) and `/feed.json` (JSON Feed 1.1), with `?token=<feed token>`: every
  member has a secret feed token (Settings → Feeds, or `GET /api/auth/feed`). Preview images in the
  feed carry the same token so readers can load them.
- **API.** oRPC at `/rpc` (used by the app) and `/api` (plain HTTP). `GET /api/health` reports
  `{status, sha, version, date}` as injected by the deploy. Everything else needs the session cookie
  or `Authorization: Bearer $ADMIN_TOKEN` (acts as the owner): `GET /api/posts`,
  `GET /api/posts/{id}`, `GET /api/users/{username}`, `POST /api/posts {"text"}`.

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
