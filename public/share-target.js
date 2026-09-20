// Runs inside the service worker (vite.config.ts pulls it in with importScripts). Android's share
// sheet POSTs a shared picture to /share as multipart form data; the page cannot read that body,
// so the worker parks the file in the Cache API and redirects to /share?files=1, where the share
// page picks it up (src/ui/share.tsx). Text-only shares keep using the GET form.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "POST" || url.pathname !== "/share") return;
  event.respondWith(
    (async () => {
      const q = new URLSearchParams();
      try {
        const form = await event.request.formData();
        for (const k of ["title", "text", "url"]) {
          const v = form.get(k);
          if (typeof v === "string" && v) q.set(k, v);
        }
        const file = form.get("image");
        if (file && typeof file !== "string" && file.size > 0) {
          const cache = await caches.open("share-target");
          await cache.put("/share/incoming", new Response(file, { headers: { "content-type": file.type || "application/octet-stream", "x-file-name": encodeURIComponent(file.name || "image") } }));
          q.set("files", "1");
        }
      } catch (e) {
        q.set("error", "could not read the shared file");
      }
      return Response.redirect("/share?" + q.toString(), 303);
    })()
  );
});
