# Murmur as a container: published to ghcr.io/<owner>/murmur by .github/workflows/publish.yml, run
# anywhere with the environment from .env.example.
#
# Three stages. Bun builds the web app into dist/. Rust builds the server as one static binary
# (Alpine's toolchain targets musl, so nothing is linked dynamically). The runtime stage is
# distroless/static: the binary, dist/ and CA certificates, no shell, no package manager, about
# 10 MB in all.

FROM oven/bun:1-slim AS web
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
# dependencies first, in their own layer: cached until the manifests change
RUN mkdir -p server && echo 'fn main() {}' > server/main.rs \
 && cargo build --release --locked \
 && rm -rf server target/release/murmur target/release/deps/murmur-*
COPY server ./server
RUN cargo build --release --locked

FROM gcr.io/distroless/static-debian12:nonroot AS runtime
WORKDIR /app
COPY --from=build --chown=nonroot:nonroot /app/target/release/murmur /app/murmur
COPY --from=web --chown=nonroot:nonroot /app/dist /app/dist

# what /api/health reports; the workflow passes them, a local `docker build` leaves them empty
ARG GIT_SHA
ARG GIT_VERSION
ARG BUILD_DATE
ENV GIT_SHA=$GIT_SHA GIT_VERSION=$GIT_VERSION BUILD_DATE=$BUILD_DATE

ENV PORT=8080
# without TURSO_DATABASE_URL the server keeps a SQLite file here (gone with the container)
ENV LOCAL_DB_PATH=/tmp/murmur.db
EXPOSE 8080

# /api/health answers 200 when the app is up and the database answers, 503 otherwise. `docker ps`
# then shows (healthy) / (unhealthy) and Compose's `condition: service_healthy` can wait for it.
# No shell or curl in the image: the binary probes itself. Every 2 s for the first 30 s, then every 30 s.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=1s --retries=3 \
  CMD ["/app/murmur", "health"]

ENTRYPOINT ["/app/murmur"]
