# Murmur as a container: published to ghcr.io/<owner>/murmur by .github/workflows/publish.yml, run
# anywhere with the environment from .env.example.
# Playwright's image ships Chromium + all system deps; the tag must match the playwright version in package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

# Bun, copied from the official image (no curl | bash)
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# what /api/health reports; the workflow passes them, a local `docker build` leaves them empty
ARG GIT_SHA
ARG GIT_VERSION
ARG BUILD_DATE
ENV GIT_SHA=$GIT_SHA GIT_VERSION=$GIT_VERSION BUILD_DATE=$BUILD_DATE

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["bun", "server/index.ts"]
