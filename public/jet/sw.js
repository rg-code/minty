// JET's service worker (scope /jet/): installable, and its pages open offline. It caches only JET's
// own static files (and the vendored map library), network first so updates land at once. API
// responses (trips, bookings, transactions) and map tiles are never cached: they always go to the
// network (the API behind Cloudflare Access). A redirect (the Access sign-in) is never cached.
const CACHE = "jet-v2";               // v2: store.js, mode.js (JET on its own)
const SHELL = ["/jet/", "/jet/jet.js", "/jet/jet.css", "/jet/map.js", "/jet/map-style.js", "/jet/jet-parse.js", "/jet/theme.js", "/jet/mode.js", "/jet/store.js", "/jet/airports.json",
               "/jet/manifest.webmanifest", "/jet/icon.svg", "/jet/icon-192.png", "/jet/icon-512.png", "/jet/apple-touch-icon.png",
               "/vendor/maplibre/maplibre-gl-csp.js", "/vendor/maplibre/maplibre-gl-csp-worker.js", "/vendor/maplibre/maplibre-gl.css",
               "/lock.js", "/lock.css", "/pdf-read.js"];
const isShell = (url) => url.origin === self.location.origin && SHELL.includes(url.pathname);

self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("jet-") && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || !isShell(url)) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok && res.type === "basic" && !res.redirected) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
    }
    return res;
  }).catch(() => caches.match(e.request).then((hit) => hit || Response.error())));
});
