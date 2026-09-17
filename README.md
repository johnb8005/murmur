# Murmur

Links worth sharing, from people worth following. No algorithm.

A small Twitter-like app for sharing links. Bun server + Turso + R2, React 19 + Tailwind 4,
deployed as a container on Cloud Run.

- **Accounts are passkeys.** Pick a unique username, your device's Face ID / Touch ID / security key is
  the credential. No passwords, no email. Settings lets you change your username and display name
  (the profile link follows the username) and add or remove passkeys.
- **One public timeline.** Post up to 500 characters; the first link gets a preview card (title,
  description, image). Like, comment, delete your own posts.
- **Share.** The share button uses the Web Share API (falls back to copying the link). Post permalinks
  (`/p/<id>`) and profiles (`/u/<username>`) carry server-rendered Open Graph tags, so WhatsApp, Slack,
  iMessage and the rest show a card.
- **PWA.** Installable, offline shell, and a Web Share Target: once installed on Android (or desktop
  Chrome), Murmur appears in the system share sheet next to Twitter and Slack. Shared links land in the
  composer at `/share`.
- **Feeds.** `/feed.xml` (RSS 2.0) and `/feed.json` (JSON Feed 1.1) for the timeline.
- **API.** oRPC at `/rpc` (used by the app) and `/api` (plain HTTP). `GET /api/health` reports
  `{status, sha, version, date}` as injected by the deploy. `GET /api/posts`,
  `GET /api/posts/{id}`, `GET /api/users/{username}`, `POST /api/posts {"text"}` with the session cookie
  or `Authorization: Bearer $ADMIN_TOKEN` (acts as the owner).

## Running locally

```bash
bun install
bunx playwright install chromium          # once, for link screenshots
cp .env.example .env                      # SITE_URL=http://localhost:5173 (the WebAuthn origin), local SQLite by default
bun run dev                               # API on :8080 + Vite on :5173
```

`bun run build` builds the app into `dist/`; `bun run start` serves it with the API on `$PORT`.

## Deploying

`cloud-run.yml` builds the `Dockerfile` (Playwright image + Bun) with Cloud Build and deploys to
Cloud Run on every push to `master` (and on `v*` tags). Secrets: `GCP_SA_KEY`, `TURSO_DATABASE_URL`,
`TURSO_AUTH_TOKEN`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, optionally
`ADMIN_TOKEN`. Variables: `GCP_PROJECT_ID` (required), `SITE_URL` (the public address, it is the
WebAuthn origin), optionally `GCP_REGION`, `CLOUD_RUN_SERVICE`, `OWNER_USERNAME`, `R2_BUCKET`. Map the
domain to the service in the Cloud Run console. The owner account (`OWNER_USERNAME`, default `johan`)
may delete any post and inherits posts made before accounts existed.

## Layout

- `server/index.ts` static app, feeds, preview images, API, Open Graph tags; `server/router.ts` the
  oRPC procedures; `server/auth.ts` accounts, passkeys, sessions; `server/preview.ts` link previews
  (meta tags first, screenshot when there is no image); `server/r2.ts` image bytes; `server/db.ts` schema
- `shared/links.ts` post model, link extraction, feeds
- `src/` React 19 + Tailwind 4; `vite.config.ts` holds the PWA manifest and Workbox rules
