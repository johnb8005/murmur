# Murmur

A small Twitter-like app for sharing links: passkey accounts with unique usernames, one public timeline, likes, comments, Web Share, PWA with a share target. Bun server + Turso + R2, container on Cloud Run (`.github/workflows/cloud-run.yml`, `Dockerfile`). Johan Boissard's identity page (the `personal-website` repo) links here.

## Commands

- `bun install` (Playwright's browser is not downloaded; `bunx playwright install chromium` once locally)
- `bun run typecheck` / `bun run build`
- `bun run dev` — API on :8080 (`bun --watch`) plus Vite on :5173 proxying `/rpc`, `/api`, feeds and previews. Needs a `.env` (see `.env.example`); `SITE_URL=http://localhost:5173` there, it is the WebAuthn origin
- `bun run start` — serve the built app with the API on `$PORT`

## Layout

- `server/index.ts` — `Bun.serve`: built app, `/feed.xml`, `/feed.json`, `/previews/<hash>.jpg`, `/api/health`, oRPC at `/rpc` (protocol) and `/api` (OpenAPI style). `/p/<id>` and `/u/<username>` get server-rendered Open Graph tags (the `<!-- og -->` placeholder in `index.html`)
- `server/router.ts` — the API: `auth.*`, `posts.*` (list/get/create/delete/like/comment/deleteComment), `users.get`, `previews.refresh`. `withUser` resolves the session cookie (or `ADMIN_TOKEN` as the owner); `authed` requires it
- `server/auth.ts` — accounts and passkeys via `@simplewebauthn/server`. Usernames `[a-z0-9_]{3,20}`, unique. Passkeys are discoverable. Challenges and sessions are Turso tables. `OWNER_USERNAME` may moderate and inherits single-admin-era posts
- `server/preview.ts` — link previews: meta tags first, Playwright screenshot only when there is no og:image; `server/r2.ts` image bytes; `server/db.ts` schema + additive migrations
- `shared/links.ts` — post model, link extraction, RSS/JSON Feed
- `src/` — React 19 + Tailwind 4: `auth.tsx` (session context, passkey flows), `ui/timeline`, `ui/post` (card, like, share), `ui/postpage` (comments), `ui/profile`, `ui/login`, `ui/settings`, `ui/share` (share-target landing). `vite.config.ts` holds the PWA manifest (`share_target` → `/share`) and Workbox rules

## Conventions

- TypeScript everywhere, run by Bun; no Node-specific tooling
- oRPC for every client/server call; add procedures to `server/router.ts`, `src/api.ts` picks up the types
- Keep `/api/*` paths stable, they're used from curl
- Additive schema changes only: new columns go in `LATER_COLUMNS` in `server/db.ts`
