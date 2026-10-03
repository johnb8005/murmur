# orpc-rs spike

Can [orpc-rs](https://github.com/ahonn/orpc-rs) (v1.1.0, April 2026) serve murmur's API to the
`@orpc/client` the app already uses? This is the smallest server that exercises everything
`server/router.ts` relies on, plus a client script that drives it with the repo's own `@orpc/client`.

```sh
cd spike/orpc-rs
cargo run --release            # writes bindings.ts, listens on :8081
bun client.ts                  # 21 checks through RPCLink, incl. a File upload
bunx tsc -p tsconfig.json      # the generated types against the client script
curl -s localhost:8081/api/health
```

## What was checked, and the result

| murmur needs | orpc-rs | notes |
|---|---|---|
| Context from the request (cookie, bearer) | yes | `ctx_fn(&http::request::Parts)` |
| Set-cookie from a procedure (login, logout, register, link finish) | **not built in** | 30 lines: `ResHeaders` in request extensions + an axum `from_fn` layer that copies them onto the response (`src/main.rs`). Works on `/rpc` and `/api` |
| `authed` middleware that swaps the context type | yes | `use_middleware(middleware_fn(...))`, `Ctx -> Authed` |
| Optional input (`loginOptions()`, `posts.list()`) | yes at runtime | client sends `undefined`, server gets `Option::None`. Generated type says `ListIn \| null`, so call sites must pass `null` or `{}` rather than nothing (`src/auth.tsx:42` is the one that passes `undefined`) |
| Optional fields (`tags?`, `private?`, `image?`) | yes | `#[serde(default)]` on the field makes specta emit `field?: T \| null` |
| `z.any()` passthrough (WebAuthn options) | yes | a `serde_json::Value` newtype with a hand-written `specta::Type` returning `DataType::Any` |
| File upload inside the input (`posts.create` with a picture) | yes | `Option<Upload>` where `Upload(ORPCFile)`; bytes, name, content type and sibling fields all arrive. Same `Any` trick for the TS type |
| `ORPCError` with status + `data` (health's degraded body) | yes | `ORPCError::new(ServiceUnavailable, msg).with_data(json)`; the client sees `instanceof ORPCError`, `.status`, `.code`, `.data` |
| 401/400/404 shapes the client reads | yes | identical envelope to the TS server |
| OpenAPI at `/api` with the same procedures | yes | `into_openapi_router`, `Route::get("/auth/username/{username}")`, path params and query strings merged into the input |
| Query strings typed as numbers (`?limit=5`) | needs a helper | query values are strings; `lenient_u32` deserializer accepts both. TS used `z.coerce.number()` |
| `curl -F image=@pic.jpg /api/posts` | **no** | the OpenAPI handler wants oRPC's own multipart envelope (`data` + `0` + `maps`), not plain form fields as `@orpc/openapi` does. Picture upload from curl needs a small plain axum route if anyone cares |
| TypeScript types for the client | yes | `orpc_specta::export_ts` writes `Procedures`; `const api: Procedures = createORPCClient(link)` replaces `RouterClient<AppRouter>` |
| `u64` / `usize` in exported types | **refused** | specta refuses BigInt-ish ints by default; use `u32`/`i32` or configure the exporter |
| One router instance for both transports | no | `Procedure` is not `Clone`; build the router twice (cheap) |

Runtime: all 21 client checks pass (health, 503 with data, optional input both ways, 401 from
middleware, login sets the cookie and later calls carry it, list with and without input, create
with a `File`, create without, empty post rejected with the message, logout clears the cookie).
OpenAPI: health, boom, path param, bearer auth, 401, query coercion, bad query 400, set-cookie,
JSON create, empty-body optional input, envelope multipart all behave; plain `curl -F` multipart
does not.

Release binary with LTO and `opt-level = "z"`: 1.3 MB (no TLS, no database yet).

## Takeaways for the port

- orpc-rs is enough. The two gaps (response headers, plain multipart on `/api`) are small and
  sit outside the library, in axum.
- The frontend changes are mechanical: import `Procedures` from the generated file instead of
  `AppRouter` from `server/router.ts`, and pass `null`/`{}` where it passes `undefined` today.
- The library is young and quiet (one maintainer, last commit April 2026). Pin the version; the
  wire protocol it implements is stable, and the surface we use is small enough to fork if needed.
