// Cache the app shell so the PWA opens instantly and still renders (from the page's
// embedded snapshot or localStorage) when the tailnet or the WSL box is unreachable.
// The snapshot route itself is deliberately never cached here — app.js handles staleness.

// Bump on shell changes: activate deletes every other cache, which is the only way to
// evict entries an older SW stored back when assets were served with a long max-age.
const CACHE = "codexbar-shell-v4";

// `/` is now a self-contained document — styles.css and app.js are inlined into it by
// the server — so the shell is one entry plus the icons the launcher needs.
const SHELL = [
  "/",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
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

async function notifyShellUpdated() {
  for (const client of await self.clients.matchAll({ type: "window" })) {
    client.postMessage({ type: "shell-updated" });
  }
}

// Refresh the cached copy behind the response we already returned. The document's body
// differs on every request (it carries a fresh snapshot), so a byte comparison would
// cry wolf every launch — X-Shell-Stamp changes only when app.js or styles.css do.
async function revalidate(request, cached) {
  try {
    const res = await fetch(request, { cache: "no-store" });
    if (!res.ok) return;
    const before = cached?.headers.get("X-Shell-Stamp");
    const after = res.headers.get("X-Shell-Stamp");
    await (await caches.open(CACHE)).put(request, res.clone());
    if (before && after && before !== after) await notifyShellUpdated();
  } catch { /* offline — the cached copy stands */ }
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // always hit the network

  // Cache-first, not network-first: this tailnet costs ~200 ms per round trip, and a
  // launch that waits one out before painting is the whole complaint. The revalidation
  // behind it is what keeps a stale shell from sticking.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // ignoreSearch: a launch may arrive as `/?utm=…` or with a start_url query.
    const cached = await cache.match(event.request, { ignoreSearch: true });
    if (cached) {
      try { event.waitUntil(revalidate(event.request, cached)); } catch { /* event closed */ }
      return cached;
    }
    try {
      const res = await fetch(event.request);
      if (res.ok) cache.put(event.request, res.clone()).catch(() => {});
      return res;
    } catch {
      // Nothing cached under this URL: the shell is the only useful thing left to show.
      return (await cache.match("/")) ?? Response.error();
    }
  })());
});

// Push notification handler for window reset renewals
self.addEventListener("push", (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data = { body: event.data.text() };
    }
  }

  const title = data.title || "CodexBar";
  const options = {
    body: data.body || "A rate limit window has renewed.",
    icon: data.icon || "/icons/icon-192.png",
    badge: data.badge || "/icons/icon-192.png",
    tag: data.tag || "codexbar-renewal",
    data: data.data || { url: "/" },
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Clicking a renewal notification focuses or opens the PWA
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";

  event.waitUntil(
    (async () => {
      const windowClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windowClients) {
        if (client.url && "focus" in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })()
  );
});
