// Cache the app shell so the PWA opens instantly and still renders (from the
// localStorage snapshot) when the tailnet or the WSL box is unreachable.
// The snapshot itself is deliberately never cached here — app.js handles staleness.

// Bump on shell changes: activate deletes every other cache, which is the only way to
// evict entries an older SW stored back when assets were served with a long max-age.
const CACHE = "codexbar-shell-v2";
const SHELL = [
  "/",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // always hit the network

  // Network-first so shell updates land, cache as the offline floor.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
        return res;
      })
      // ignoreSearch: the page asks for /app.js?v=<mtime>, the shell was cached as /app.js.
      .catch(() => caches.match(event.request, { ignoreSearch: true })
        .then((hit) => hit ?? caches.match("/"))),
  );
});
