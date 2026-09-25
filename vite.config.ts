import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// Everything dynamic (posts, auth, feeds, preview images) comes from server/index.ts.
// In dev, run it on :8080 (`bun run dev:api`) and Vite proxies to it.
const api = process.env.API_URL || "http://localhost:8080";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Murmur",
        short_name: "Murmur",
        description: "Links worth sharing, from people worth following. No algorithm.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#050509",
        theme_color: "#050509",
        lang: "en",
        categories: ["social", "news"],
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
        // Android (and desktop Chrome) list the installed app in the share sheet; the share lands on /share.
        // Pictures need a POST, which public/share-target.js (in the service worker) turns into a GET
        share_target: {
          action: "/share",
          method: "POST",
          enctype: "multipart/form-data",
          params: { title: "title", text: "text", url: "url", files: [{ name: "image", accept: ["image/*"] }] },
        },
        shortcuts: [{ name: "New post", url: "/?compose=1", icons: [{ src: "/icon-192.png", sizes: "192x192" }] }],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        globIgnores: ["share-target.js"],
        importScripts: ["share-target.js"],
        // the server renders these itself (Open Graph tags, feeds, images, API): never the cached shell
        navigateFallbackDenylist: [/^\/api/, /^\/rpc/, /^\/feed\./, /^\/previews\//, /^\/images\//],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/previews/"),
            handler: "CacheFirst",
            options: { cacheName: "previews", expiration: { maxEntries: 300, maxAgeSeconds: 7 * 24 * 3600 } },
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/images/"),
            handler: "CacheFirst",
            options: { cacheName: "pictures", expiration: { maxEntries: 200, maxAgeSeconds: 30 * 24 * 3600 }, cacheableResponse: { statuses: [200] } },
          },
          {
            urlPattern: ({ url }) => url.origin === "https://fonts.gstatic.com" || url.origin === "https://fonts.googleapis.com",
            handler: "StaleWhileRevalidate",
            options: { cacheName: "fonts", expiration: { maxEntries: 20, maxAgeSeconds: 365 * 24 * 3600 } },
          },
        ],
      },
    }),
  ],
  server: {
    proxy: Object.fromEntries(["/rpc", "/api", "/feed.xml", "/feed.json", "/previews", "/images"].map((p) => [p, api])),
  },
});
