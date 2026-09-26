# Murmur as a container: published to ghcr.io/<owner>/murmur by .github/workflows/publish.yml, run
# anywhere with the environment from .env.example.
#
# Two stages keep it small. The build stage has every dependency and produces dist/. The runtime
# stage installs production dependencies only, plus the one browser the server needs for link
# screenshots: Playwright's chromium-headless-shell and its system libraries, not the full
# Playwright image (which carries Chromium, Firefox, WebKit and Node, several gigabytes).

FROM oven/bun:1-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# a fixed, root-owned place for the browser, so it does not depend on the user running the app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# production dependencies only (playwright among them: the server drives the browser with it)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# the headless shell of the Chromium that matches the installed playwright, with its shared
# libraries and fonts; no Firefox, WebKit or the full Chromium
RUN bunx playwright install-deps chromium \
 && bunx playwright install chromium-headless-shell \
 && rm -rf /var/lib/apt/lists/* /root/.cache

COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
COPY tsconfig.json ./

# what /api/health reports; the workflow passes them, a local `docker build` leaves them empty
ARG GIT_SHA
ARG GIT_VERSION
ARG BUILD_DATE
ENV GIT_SHA=$GIT_SHA GIT_VERSION=$GIT_VERSION BUILD_DATE=$BUILD_DATE

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# /api/health answers 200 when the app is up and the database answers, 503 otherwise. `docker ps`
# then shows (healthy) / (unhealthy) and Compose's `condition: service_healthy` can wait for it.
# No curl in the slim image, so Bun does the request. Probes every 2 s for the first 30 s, then every 30 s.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
  CMD ["bun", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 8080}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["bun", "server/index.ts"]
