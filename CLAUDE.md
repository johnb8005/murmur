# Murmur

A small, members-only Twitter-like app for sharing links: passkey accounts with unique usernames, one timeline, likes, comments, Web Share, PWA with a share target. A post is called a *murmur* in the UI (`POST_NOUN`); the API and code keep `posts`. Murmurs carry tags (labels: `#hashtags` in the text plus the composer's tag field, `post_tags` table, `/t/:tag` page) and may be private (`posts.private`: only the author sees them; every query goes through `loadPosts` / `visiblePostOwnerId` with a viewer). Everything but sign-in, sign-up and device links needs an account. Bun server + Turso + R2, container on Cloud Run (`.github/workflows/cloud-run.yml`, `Dockerfile`). Johan Boissard's identity page (the `personal-website` repo) links here.

## Commands

- `bun install` (Playwright's browser is not downloaded; `bunx playwright install chromium` once locally)
- `bun run typecheck` / `bun run build`
- `bun run dev` — API on :8080 (`bun --watch`) plus Vite on :5173 proxying `/rpc`, `/api`, feeds and previews. Needs a `.env` (see `.env.example`); `SITE_URL=http://localhost:5173` there, it is the WebAuthn origin
- `bun run start` — serve the built app with the API on `$PORT`
- `bun test/e2e.ts` — after a build: sign-up, device link and feed token flows in Chromium with a virtual authenticator (also run by `test.yml`)

## Layout

- `server/index.ts` — `Bun.serve`: built app, `/feed.xml`, `/feed.json`, `/previews/<hash>.jpg` (session cookie or `?token=<feed token>`, else 401), `/api/health`, oRPC at `/rpc` (protocol) and `/api` (OpenAPI style). Every page gets the same generic Open Graph card (the `<!-- og -->` placeholder in `index.html`, image `public/og.jpg` from `scripts/og-card.ts`; a `/p/:id` URL only says a murmur was shared): post content must not unfurl, and `sharePost` shares the address alone
- `server/router.ts` — the API: `auth.*`, `posts.*` (list/get/create/delete/like/comment/deleteComment/tags; `list` takes `tag`, `create` takes `tags` and `private`), `users.get`, `previews.refresh`. `withUser` resolves the session cookie (or `ADMIN_TOKEN` as the owner); `authed` requires it and is the default for everything but health, sign-in/up and `auth.link*`
- `server/auth.ts` — accounts and passkeys via `@simplewebauthn/server`. Usernames `[a-z0-9_]{3,20}`, unique. Passkeys are discoverable. Challenges, device links (`kind = 'device-link'`, single use, 10 min) and sessions are Turso tables; feed tokens live on `users`. Minting a device link needs a fresh assertion with one of the account's passkeys (`kind = 'reauth'`: `auth.linkChallenge` then `auth.linkCreate`), a session cookie alone is not enough. `OWNER_USERNAME` may moderate and inherits single-admin-era posts
- `server/preview.ts` — link previews: meta tags first, Playwright screenshot only when there is no og:image; `server/r2.ts` image bytes; `server/db.ts` schema + additive migrations
- `shared/links.ts` — post model, link extraction, tag normalization (`normalizeTag`, `extractTags`, `postTags`), RSS/JSON Feed
- `src/` — React 19 + Tailwind 4: `app.tsx` (`RequireAuth` wraps every route but `/login` and `/link/:token`), `auth.tsx` (session context, passkey flows), `ui/timeline`, `ui/compose` (text, tag field, Only me switch), `ui/post` (card, labels, like, share), `ui/tags` (`/t/:tag`), `ui/postpage` (comments), `ui/profile` (own profile also has "Add another device"), `ui/login`, `ui/settings` (profile, passkeys, add another device, feed URLs), `ui/link` (`useDeviceLink` + `DeviceLinkCard`: passkey check, QR code, polls until the new device is in; and the `/link/:token` page), `ui/share` (share-target landing). `vite.config.ts` holds the PWA manifest (`share_target` → `/share`) and Workbox rules

## Conventions

- TypeScript everywhere, run by Bun; no Node-specific tooling
- oRPC for every client/server call; add procedures to `server/router.ts`, `src/api.ts` picks up the types
- Keep `/api/*` paths stable, they're used from curl
- Additive schema changes only: new columns go in `LATER_COLUMNS` in `server/db.ts`
