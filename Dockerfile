# Murmur on Cloud Run.
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

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["bun", "server/index.ts"]
