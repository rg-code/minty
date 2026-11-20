// JET's service worker (scope /jet/): installable, and its pages open offline. It caches only JET's
// own static files (and the vendored map library), network first so updates land at once. API
// responses (trips, bookings, transactions) and map tiles are never cached: they always go to the
// network (the API behind Cloudflare Access). A redirect (the Access sign-in) is never cached.
const CACHE = "jet-v3";               // v3: Gmail pull (gmail.js), Share to JET
const SHELL = ["/jet/", "/jet/jet.js", "/jet/jet.css", "/jet/map.js", "/jet/map-style.js", "/jet/jet-parse.js", "/jet/theme.js", "/jet/mode.js", "/jet/store.js", "/jet/gmail.js", "/jet/airports.json",
               "/jet/manifest.webmanifest", "/jet/icon.svg", "/jet/icon-192.png", "/jet/icon-512.png", "/jet/apple-touch-icon.png",
               "/vendor/maplibre/maplibre-gl-csp.js", "/vendor/maplibre/maplibre-gl-csp-worker.js", "/vendor/maplibre/maplibre-gl.css",
               "/lock.js", "/lock.css", "/pdf-read.js"];
const isShell = (url) => url.origin === self.location.origin && SHELL.includes(url.pathname);

self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("jet-") && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Share to JET (Android, the installed app): the manifest's share_target posts a shared PDF,
// screenshot, email file or text here. It's kept in IndexedDB (jet-share) on this device, never sent
// anywhere, and JET's add page opens to read it (#/add?shared=1).
function keepShare(form) {
  return new Promise((ok, fail) => {
    const req = indexedDB.open("jet-share", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("shared");
    req.onerror = () => fail(req.error);
    req.onsuccess = () => {
      const files = form.getAll("files").filter((f) => f && typeof f === "object" && f.size > 0 && f.size <= 20 * 1024 * 1024)
        .slice(0, 5).map((f) => ({ name: f.name, type: f.type, blob: f }));
      const t = req.result.transaction("shared", "readwrite");
      t.objectStore("shared").put({ at: Date.now(), title: form.get("title") || "", text: form.get("text") || "", url: form.get("url") || "", files }, "latest");
      t.oncomplete = () => ok();
      t.onerror = () => fail(t.error);
    };
  });
}
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === "POST" && url.origin === self.location.origin && url.pathname === "/jet/share") {
    e.respondWith(e.request.formData().then(keepShare).then(() => Response.redirect("/jet/#/add?shared=1", 303),
      () => Response.redirect("/jet/#/add?shared=0", 303)));
    return;
  }
  if (e.request.method !== "GET" || !isShell(url)) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok && res.type === "basic" && !res.redirected) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
    }
    return res;
  }).catch(() => caches.match(e.request).then((hit) => hit || Response.error())));
});
