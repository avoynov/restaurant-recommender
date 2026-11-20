// Service worker: makes the app installable and opens instantly offline.
// App shell is cache-first and refreshed in the background; saved data and media
// (data/) always go to the network first so new posts show up, with the cache as fallback.
const VERSION = "v2";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(`shell-${VERSION}`).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // GitHub API, fonts: straight to network
  if (url.pathname.includes("/data/")) {
    if (e.request.headers.has("range")) return; // video seeking: let the browser handle ranges
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          if (r.ok && !url.pathname.endsWith(".mp4")) { const copy = r.clone(); caches.open(`data-${VERSION}`).then((c) => c.put(e.request, copy)); }
          return r;
        })
        .catch(() => caches.match(e.request, { ignoreSearch: true })),
    );
    return;
  }
  // Shell: answer from cache (share-target URLs carry ?text=..., so ignore the query), refresh in background.
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      const net = fetch(e.request).then((r) => {
        if (r.ok && !url.search) { const copy = r.clone(); caches.open(`shell-${VERSION}`).then((c) => c.put(e.request, copy)); }
        return r;
      }).catch(() => hit);
      return hit || net;
    }),
  );
});
