#!/usr/bin/env node
// codexbar-tailnet — serves the PWA and proxies the CodexBar dashboard-v1 snapshot.
//
// Exists to solve three things that stop a phone talking to `codexbar serve` directly:
//   1. `serve` on a loopback bind only accepts Host: 127.0.0.1 / localhost / [::1]
//      (CLILocalHTTPServer.swift), so a tailnet Host header gets 403 "forbidden host".
//      We rewrite Host on the way through.
//   2. `serve` sends no CORS headers, so the UI must be same-origin with the API.
//      We serve both.
//   3. The bearer token stays here, in this process, instead of shipping to the phone.

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  getVapidKeys,
  sendPushNotification,
  SubscriptionStore,
  extractWindows,
  detectWindowRenewals,
  nextCheckDelayMs,
  DEFAULT_MIN_USED_PERCENT,
  DEFAULT_PUSH_TTL_SECONDS,
} from "./push.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, "public");

// The two assets whose mtimes make up the shell fingerprint, and which index.html
// inlines. Keeping the list here means adding an asset updates both at once.
const STAMPED = ["app.js", "styles.css"];

const PORT = Number(process.env.CBT_PORT ?? 8899);
const BIND = process.env.CBT_BIND ?? "127.0.0.1";
const UPSTREAM_HOST = process.env.CBT_UPSTREAM_HOST ?? "127.0.0.1";
const UPSTREAM_PORT = Number(process.env.CBT_UPSTREAM_PORT ?? 8087);
const TOKEN = process.env.CODEXBAR_DASHBOARD_TOKEN ?? "";
const CACHE_TTL_MS = Number(process.env.CBT_CACHE_TTL ?? 60) * 1000;
// `serve` can take a while when a provider is slow; keep this above its --request-timeout.
const UPSTREAM_TIMEOUT_MS = Number(process.env.CBT_UPSTREAM_TIMEOUT ?? 90) * 1000;
// How long after the last client request the background poller keeps the cache warm.
// Upstream `serve` is lazy (its --refresh-interval is only a cache TTL), so without
// this, the first request after a quiet spell pays the full live provider fetch (~13s).
const ACTIVE_WINDOW_MS = Number(process.env.CBT_ACTIVE_WINDOW ?? 600) * 1000;
const POLL_MS = Number(process.env.CBT_POLL ?? 45) * 1000;

const CONFIG_DIR = process.env.CBT_CONFIG_DIR ??
  (process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, "codexbar")
    : path.join(os.homedir(), ".config", "codexbar"));
const VAPID_PATH = process.env.CBT_VAPID_PATH ?? path.join(CONFIG_DIR, "vapid.json");
const SUBSCRIPTIONS_PATH = process.env.CBT_PUSH_SUBSCRIPTIONS_PATH ?? path.join(CONFIG_DIR, "push-subscriptions.json");
const VAPID_SUBJECT = process.env.CBT_VAPID_SUBJECT ?? "mailto:codexbar@local";
// A numeric env knob, or its default when unset, blank or out of range. `Number()` alone
// turns "abc" into NaN and "" into 0, and either silently breaks renewal detection.
function envNumber(name, fallback, { min, max = Infinity, integer = false }) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    console.warn(`${name}=${JSON.stringify(raw)} is not valid; using ${fallback}`);
    return fallback;
  }
  return n;
}
// A window whose usage never reached this much renews without a notification. Zero would
// announce every untouched window, so the floor is just above it.
const PUSH_MIN_USED_PERCENT = envNumber("CBT_PUSH_MIN_USED", DEFAULT_MIN_USED_PERCENT, { min: 1, max: 100 });
// How long the push service may hold a "renewed" notice before dropping it as stale.
const PUSH_TTL_SECONDS = envNumber("CBT_PUSH_TTL", DEFAULT_PUSH_TTL_SECONDS, { min: 0, integer: true });
// Consecutive VAPID rejections before a subscription is treated as dead.
const PUSH_AUTH_FAILURE_LIMIT = 3;

if (!TOKEN) {
  console.error("CODEXBAR_DASHBOARD_TOKEN is not set — the snapshot route would 401. Refusing to start.");
  process.exit(1);
}

// Push subscription store & VAPID keys
let vapidKeys = null;
const subscriptionStore = new SubscriptionStore(SUBSCRIPTIONS_PATH);
await subscriptionStore.load();
try {
  vapidKeys = await getVapidKeys(VAPID_PATH);
} catch (err) {
  console.warn("Could not load/generate VAPID keys:", err.message);
}

// Window renewal detection state
const windowStates = new Map();
let resetTimer = null;
let resetRetryAttempt = 0;

const endpointHost = (endpoint) => {
  try { return new URL(endpoint).host; } catch { return "?"; }
};

function scheduleNextResetCheck(windows) {
  if (resetTimer) {
    clearTimeout(resetTimer);
    resetTimer = null;
  }
  if (subscriptionStore.count() === 0) return;
  const delay = nextCheckDelayMs(windows, windowStates, Date.now(), { minUsedPercent: PUSH_MIN_USED_PERCENT });
  if (delay != null) armResetTimer(delay);
}

// A successful refresh re-arms this through handleSnapshotRenewals. A failed one would
// otherwise leave the push feature silent until someone opened the app, so retry here
// with backoff instead.
function armResetTimer(delay) {
  // A subscribe can re-arm while a timer-driven refresh is still in flight; keep one chain.
  if (resetTimer) clearTimeout(resetTimer);
  resetTimer = setTimeout(() => {
    resetTimer = null;
    if (subscriptionStore.count() === 0) return;
    refresh()
      .then(() => { resetRetryAttempt = 0; })
      .catch((err) => {
        resetRetryAttempt += 1;
        const backoff = Math.min(300_000, 15_000 * 2 ** (resetRetryAttempt - 1));
        console.warn(`push: reset check could not refresh (${err.message}); retrying in ${backoff / 1000}s`);
        armResetTimer(backoff);
      });
  }, Math.min(delay, 2147483647));
  resetTimer.unref?.();
}

async function deliverToAll(payload) {
  const label = payload.title;
  const subs = subscriptionStore.all();
  console.log(`push: "${label}" → ${subs.length} subscription(s)`);
  await Promise.all(subs.map(async (sub) => {
    const host = endpointHost(sub.endpoint);
    let res;
    try {
      res = await sendPushNotification(sub, payload, vapidKeys, VAPID_SUBJECT, { ttlSeconds: PUSH_TTL_SECONDS });
    } catch (err) {
      res = { success: false, error: err.message };
    }
    if (res.success) {
      await subscriptionStore.markDelivered(sub.endpoint);
      console.log(`push: delivered to ${host} (${res.status})`);
    } else if (res.expired) {
      await subscriptionStore.remove(sub.endpoint);
      console.warn(`push: ${host} returned ${res.status}; subscription removed`);
    } else if (res.unauthorized) {
      const removed = await subscriptionStore.recordAuthFailure(sub.endpoint, PUSH_AUTH_FAILURE_LIMIT);
      console.warn(`push: ${host} rejected our VAPID signature (${res.status})${removed ? "; subscription removed" : ""}`);
    } else {
      console.warn(`push: delivery to ${host} failed (${res.status ?? "no response"}) ${res.error ?? ""}`.trim());
    }
  }));
}

const pct = (n) => (n != null ? `${Math.round(n)}% left` : null);

async function handleSnapshotRenewals(snap) {
  const windows = extractWindows(snap);
  const renewals = detectWindowRenewals(windows, windowStates, Date.now(), { minUsedPercent: PUSH_MIN_USED_PERCENT });

  if (renewals.length > 0 && subscriptionStore.count() > 0 && vapidKeys) {
    // Windows that renew together (Claude's weekly and its model-scoped weekly share one
    // boundary) go out as one notification per provider/account, not one each.
    const groups = new Map();
    for (const { win } of renewals) {
      const groupKey = `${win.providerId}:${win.accountLabel ?? ""}`;
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push(win);
    }

    for (const [groupKey, wins] of groups) {
      const first = wins[0];
      const accountPrefix = first.accountLabel ? `${first.accountLabel}: ` : "";
      const title = `${first.providerName} · ${wins.map((w) => w.label).join(", ")} renewed`;
      const parts = wins.map((w) => (pct(w.remainingPercent) ? `${w.label} (${pct(w.remainingPercent)})` : w.label));
      const body = wins.length === 1
        ? `${accountPrefix}${parts[0]} window has been renewed.`
        : `${accountPrefix}${parts.join(", ")} windows have been renewed.`;

      const payload = {
        title,
        body,
        tag: `renewal-${groupKey}`,
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        data: {
          url: "/",
          providerId: first.providerId,
          windowKeys: wins.map((w) => w.key),
          renewedAt: new Date().toISOString(),
        },
      };
      deliverToAll(payload).catch((err) => console.warn("push: delivery batch failed:", err.message));
    }
  }

  scheduleNextResetCheck(windows);
}

// Shown in the UI footer. Read straight out of .git rather than shelling out to git,
// so this stays stdlib-only and works when the unit's PATH has no git on it.
const GIT_DIR = path.join(HERE, ".git");
const REPO_FALLBACK = "https://github.com/simonsteiner/codexbar-tailnet-pwa";
const VERSION_TTL_MS = 30_000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// A phone on a tailnet pays ~200 ms per round trip, so bytes on the wire are worth
// more than the microseconds gzip costs. Sync compression is fine: every response
// here is a few KB, and the alternative (a stream) would buy nothing measurable.
const GZIP_MIN_BYTES = 512;
const GZIPPABLE = /^(?:text\/|application\/(?:json|manifest\+json|javascript))/;

const acceptsGzip = (req) => /\bgzip\b/.test(req.headers["accept-encoding"] ?? "");

/** True when this response is both worth compressing and welcome to be. */
const shouldGzip = (req, type, size) =>
  acceptsGzip(req) && size >= GZIP_MIN_BYTES && GZIPPABLE.test(type);

/** Write a body, gzipping it when `gzip` says so. Honours HEAD. */
function sendBody(req, res, status, headers, body, gzip) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  const out = gzip ? zlib.gzipSync(buf) : buf;
  res.writeHead(status, {
    ...headers,
    ...(gzip ? { "Content-Encoding": "gzip" } : {}),
    Vary: "Accept-Encoding",
    "Content-Length": out.length,
  });
  res.end(req.method === "HEAD" ? undefined : out);
}

/** @type {{value: {commit: string|null, short: string|null, repo: string}, at: number} | null} */
let version = null;

/** The commit HEAD points at, or null outside a checkout. */
async function readCommit() {
  const head = (await fs.readFile(path.join(GIT_DIR, "HEAD"), "utf8")).trim();
  if (!head.startsWith("ref:")) return /^[0-9a-f]{40}$/.test(head) ? head : null; // detached
  const ref = head.slice(4).trim();
  try {
    return (await fs.readFile(path.join(GIT_DIR, ref), "utf8")).trim();
  } catch {
    // `git gc` moves refs into packed-refs and deletes the loose file.
    const packed = await fs.readFile(path.join(GIT_DIR, "packed-refs"), "utf8");
    const line = packed.split("\n").find((l) => l.endsWith(` ${ref}`));
    return line ? line.split(" ")[0] : null;
  }
}

/** origin's URL as a browsable https link, so forks link to themselves. */
async function readRepo() {
  const cfg = await fs.readFile(path.join(GIT_DIR, "config"), "utf8");
  const match = cfg.match(/\[remote "origin"\]([^[]*)/);
  const url = match?.[1].match(/^\s*url\s*=\s*(.+)$/m)?.[1].trim();
  if (!url) return null;
  const https = url
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/\.git$/, "");
  return https.startsWith("https://") ? https : null;
}

// Shell fingerprint: the mtimes of the assets index.html inlines. A resumed PWA
// compares this to the value it booted with and reloads itself on change, and the
// service worker compares it across a revalidation — a backgrounded phone otherwise
// runs old JS until a manual reload. Null when an asset is missing.
async function shellStamp() {
  try {
    const parts = [];
    for (const name of STAMPED) {
      const { mtimeMs } = await fs.stat(path.join(PUBLIC_DIR, name));
      parts.push(Math.floor(mtimeMs).toString(36));
    }
    return parts.join(".");
  } catch {
    return null;
  }
}

async function getVersion() {
  if (version && Date.now() - version.at < VERSION_TTL_MS) return version.value;
  let commit = null;
  let repo = null;
  try { commit = await readCommit(); } catch { /* not a checkout */ }
  try { repo = await readRepo(); } catch { /* no remote */ }
  const stamp = await shellStamp();
  const value = { commit, short: commit?.slice(0, 7) ?? null, repo: repo ?? REPO_FALLBACK, stamp };
  version = { value, at: Date.now() };
  return value;
}

/** @type {{body: string, at: number} | null} */
let cache = null;
/** @type {{body: string, at: number} | null} */
let lastGood = null;
/** @type {Promise<{body: string, at: number}> | null} */
let inFlight = null;

function fetchSnapshot() {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        path: "/dashboard/v1/snapshot",
        method: "GET",
        headers: {
          // The whole reason this proxy exists. node:http lets us set Host directly;
          // the fetch() API treats it as a forbidden header and would send the wrong one.
          Host: "127.0.0.1",
          Authorization: `Bearer ${TOKEN}`,
          Accept: "application/json",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) {
            reject(new Error(`upstream ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          resolve({ body, at: Date.now() });
        });
      },
    );
    req.setTimeout(UPSTREAM_TIMEOUT_MS, () => req.destroy(new Error("upstream timeout")));
    req.on("error", reject);
    req.end();
  });
}

// Coalesce concurrent refreshes into one upstream call, mirroring what `serve` does internally.
function refresh() {
  if (!inFlight) {
    inFlight = fetchSnapshot()
      .then((fresh) => {
        cache = fresh;
        lastGood = fresh;
        try {
          const parsed = JSON.parse(fresh.body);
          handleSnapshotRenewals(parsed).catch(() => {});
        } catch { /* json parse error */ }
        return fresh;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

// Stale-while-revalidate: never make a phone wait out a live provider fetch when we
// have anything at all to show. A stale hit answers immediately, marks itself
// `refreshing`, and the client re-polls until the background refresh lands.
async function getSnapshot() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return { ...cache, cached: true, refreshing: false };
  const pending = refresh();
  if (cache) {
    pending.catch(() => {}); // background failure falls back to lastGood on a later miss
    return { ...cache, cached: true, refreshing: true };
  }
  // Cold boot with nothing cached: waiting is all we can do.
  return { ...(await pending), cached: false, refreshing: false };
}

// Same policy as getSnapshot(), minus the waiting: index.html must never block on a
// live provider fetch, because a page that renders late is worse than one that renders
// slightly stale data and corrects itself a moment later. Returns null on a truly cold
// boot, having kicked off the refresh the first client request will pick up.
function peekSnapshot() {
  const hit = cache ?? lastGood;
  if (!hit || Date.now() - hit.at >= CACHE_TTL_MS) refresh().catch(() => {});
  return hit ? { body: hit.body, at: hit.at, refreshing: !!inFlight } : null;
}

let lastClientAt = 0;

// While someone is actually looking (a request within ACTIVE_WINDOW_MS), keep the
// cache warm so their next poll is answered from memory. Idle otherwise, so a closed
// app doesn't make the box churn provider fetches around the clock.
setInterval(() => {
  if (Date.now() - lastClientAt > ACTIVE_WINDOW_MS) return;
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return;
  refresh().catch(() => {});
}, POLL_MS).unref?.();

// Prewarm at boot so even the first-ever request finds a cache.
refresh().catch(() => {});

// Nothing in an inlined document can close the tag that carries it. CSS and JS never
// legitimately contain these sequences outside a string, where the escape is a no-op.
const deTag = (s) => s.replace(/<\/(script|style)/gi, "<\\/$1");

/** @type {{stamp: string|null, html: string} | null} */
let shell = null;

// One document, no sub-resources. The old three-request shell cost the phone two extra
// round trips before it could paint (~200 ms each on this tailnet) and bought nothing:
// every asset was served `no-cache`, so a launch revalidated all of them anyway.
async function buildShell() {
  const stamp = await shellStamp();
  if (shell && shell.stamp === stamp) return shell;
  const [html, css, js] = await Promise.all([
    fs.readFile(path.join(PUBLIC_DIR, "index.html"), "utf8"),
    fs.readFile(path.join(PUBLIC_DIR, "styles.css"), "utf8"),
    fs.readFile(path.join(PUBLIC_DIR, "app.js"), "utf8"),
  ]);
  // Function replacers, not strings: `$$`, `$&` and friends are substitution syntax in a
  // replacement string, and app.js is full of `` `$${n}` `` — which silently ate the
  // dollar sign off every cost figure until this was a function.
  shell = {
    stamp,
    html: html
      .replace(/<link rel="stylesheet"[^>]*>/, () => `<style>${deTag(css)}</style>`)
      .replace(/<script src="\/app\.js"[^>]*><\/script>/, () => `<script type="module">${deTag(js)}</script>`),
  };
  return shell;
}

// The snapshot the proxy already holds, shipped inside the page. Without this the phone
// cannot even ask for data until the document has arrived and its JS has run — one more
// round trip on the critical path, for a payload the server had ready all along.
function bootScript(snap, ver, vapidPub) {
  const fields = [
    `"version":${JSON.stringify(ver)}`,
    `"vapidPublicKey":${JSON.stringify(vapidPub ?? null)}`,
  ];
  if (snap) {
    fields.push(
      `"snapshot":${snap.body}`,          // already JSON; re-encoding would double-escape it
      `"refreshing":${snap.refreshing}`,
    );
  }
  // `<` only ever occurs inside a JSON string here, where < means the same thing.
  const json = `{${fields.join(",")}}`.replace(/</g, "\\u003c");
  return `<script>window.__BOOT__=${json}</script>`;
}

async function readIndex() {
  const built = await buildShell();
  // Classic inline scripts run before deferred module scripts, so __BOOT__ is always
  // defined by the time app.js looks for it.
  const script = bootScript(peekSnapshot(), await getVersion(), vapidKeys?.publicKey ?? null);
  return built.html.replace("</head>", () => `${script}</head>`);
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 65536) {
        req.destroy(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const str = Buffer.concat(chunks).toString("utf8");
        resolve(str ? JSON.parse(str) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).replace(/^\/+/, "");
  const full = path.join(PUBLIC_DIR, rel);
  // Contain traversal: the resolved path must stay inside PUBLIC_DIR.
  if (!full.startsWith(PUBLIC_DIR + path.sep) && full !== path.join(PUBLIC_DIR, "index.html")) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const stat = await fs.stat(full);
    const type = MIME[path.extname(full).toLowerCase()] ?? "application/octet-stream";
    if (rel === "index.html") {
      lastClientAt = Date.now(); // opening the app counts as activity, same as polling it
      const html = Buffer.from(await readIndex(), "utf8");
      sendBody(req, res, 200, {
        "Content-Type": type,
        "Cache-Control": "no-store",
        // The service worker serves this document from cache and revalidates behind it;
        // this header is how it tells a shell update from a new embedded snapshot.
        ...(shell?.stamp ? { "X-Shell-Stamp": shell.stamp } : {}),
      }, html, shouldGzip(req, type, html.length));
      return;
    }
    // The service worker must never be pinned, or an update never lands.
    const noStore = rel === "sw.js";
    // Everything else is `no-cache`, not `max-age`: the phone may cache it, but has to
    // revalidate every time. Pinning assets for an hour meant an updated app.js kept
    // losing to a stale copy in the browser's HTTP cache, even through a network-first SW.
    const gzip = shouldGzip(req, type, stat.size);
    // The encoding is part of what the entity tag identifies, or a shared cache could
    // hand a gzipped body to a client that never asked for one.
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}${gzip ? "-gz" : ""}"`;
    const headers = {
      "Content-Type": type,
      "Cache-Control": noStore ? "no-store" : "no-cache",
      ...(noStore ? {} : { ETag: etag, "Last-Modified": stat.mtime.toUTCString() }),
    };
    if (!noStore && req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ...headers, Vary: "Accept-Encoding" }).end();
      return;
    }
    sendBody(req, res, 200, headers, await fs.readFile(full), gzip);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
  }
}

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url ?? "/").split("?")[0];

  if (urlPath === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ status: "ok", upstream: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` }));
    return;
  }

  if (urlPath === "/api/version") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(await getVersion()));
    return;
  }

  if (urlPath === "/api/push/vapid-public-key" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ publicKey: vapidKeys?.publicKey ?? null }));
    return;
  }

  if (urlPath === "/api/push/subscribe" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const added = await subscriptionStore.add(body);
      if (!added) {
        res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: "invalid_subscription" }));
        return;
      }
      const snap = cache ?? lastGood;
      if (snap) {
        try {
          scheduleNextResetCheck(extractWindows(JSON.parse(snap.body)));
        } catch {}
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ status: "subscribed", count: subscriptionStore.count() }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (urlPath === "/api/push/unsubscribe" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      await subscriptionStore.remove(body.endpoint);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ status: "unsubscribed" }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (urlPath === "/api/push/test" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      // Only subscriptions this server already holds: the endpoint is a URL we POST to,
      // and a test push must not turn the proxy into a relay for arbitrary ones.
      const sub = subscriptionStore.get(body?.endpoint);
      if (!sub) {
        res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: "unknown_subscription" }));
        return;
      }
      const testPayload = {
        title: "CodexBar",
        body: "Push notifications are working! You will be notified when a reset window is renewed.",
        tag: "test-notification",
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        data: { url: "/", test: true },
      };
      const result = await sendPushNotification(sub, testPayload, vapidKeys, VAPID_SUBJECT, { ttlSeconds: PUSH_TTL_SECONDS });
      console.log(`push: test to ${endpointHost(sub.endpoint)} ${result.success ? "delivered" : "failed"} (${result.status ?? result.error})`);
      res.writeHead(result.success ? 200 : 502, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (urlPath === "/api/snapshot") {
    lastClientAt = Date.now();
    const json = "application/json; charset=utf-8";
    try {
      const snap = await getSnapshot();
      sendBody(req, res, 200, {
        "Content-Type": json,
        "Cache-Control": "no-store",
        "X-Snapshot-Cached": String(snap.cached),
        "X-Snapshot-Refreshing": String(snap.refreshing),
        "X-Snapshot-Age": String(Math.round((Date.now() - snap.at) / 1000)),
      }, snap.body, shouldGzip(req, json, Buffer.byteLength(snap.body)));
    } catch (err) {
      // Fall back to the last good snapshot so a single slow provider doesn't blank the phone.
      if (lastGood) {
        sendBody(req, res, 200, {
          "Content-Type": json,
          "Cache-Control": "no-store",
          "X-Snapshot-Stale": "true",
          "X-Snapshot-Error": String(err.message).slice(0, 200),
        }, lastGood.body, shouldGzip(req, json, Buffer.byteLength(lastGood.body)));
        return;
      }
      res.writeHead(502, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: "upstream_unavailable", detail: String(err.message) }));
    }
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end("method not allowed");
    return;
  }
  await serveStatic(req, res, urlPath);
});

server.listen(PORT, BIND, () => {
  console.log(`codexbar-tailnet on http://${BIND}:${PORT} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT} (cache ${CACHE_TTL_MS / 1000}s)`);
});
