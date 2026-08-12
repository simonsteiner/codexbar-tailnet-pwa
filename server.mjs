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
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, "public");

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

if (!TOKEN) {
  console.error("CODEXBAR_DASHBOARD_TOKEN is not set — the snapshot route would 401. Refusing to start.");
  process.exit(1);
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

async function getVersion() {
  if (version && Date.now() - version.at < VERSION_TTL_MS) return version.value;
  let commit = null;
  let repo = null;
  try { commit = await readCommit(); } catch { /* not a checkout */ }
  try { repo = await readRepo(); } catch { /* no remote */ }
  // Shell fingerprint: the same mtime stamps index.html embeds in asset URLs.
  // A resumed PWA compares this to the value it booted with and reloads itself
  // on change — a backgrounded phone otherwise runs old JS until a manual reload.
  let stamp = null;
  try {
    const parts = [];
    for (const name of STAMPED) {
      const { mtimeMs } = await fs.stat(path.join(PUBLIC_DIR, name));
      parts.push(Math.floor(mtimeMs).toString(36));
    }
    stamp = parts.join(".");
  } catch { /* asset missing — leave unstamped */ }
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

// index.html is never cached, but the assets it points at may already sit in a phone's
// HTTP cache under terms we can no longer change. Stamping each URL with the file's mtime
// makes a changed asset a changed URL, which no stale entry can answer.
const STAMPED = ["app.js", "styles.css"];

async function readIndex() {
  let html = await fs.readFile(path.join(PUBLIC_DIR, "index.html"), "utf8");
  for (const name of STAMPED) {
    const { mtimeMs } = await fs.stat(path.join(PUBLIC_DIR, name));
    html = html.replaceAll(`/${name}"`, `/${name}?v=${Math.floor(mtimeMs).toString(36)}"`);
  }
  return html;
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
      const html = Buffer.from(await readIndex(), "utf8");
      res.writeHead(200, {
        "Content-Type": type,
        "Cache-Control": "no-store",
        "Content-Length": html.length,
      });
      res.end(req.method === "HEAD" ? undefined : html);
      return;
    }
    // The service worker must never be pinned, or an update never lands.
    const noStore = rel === "sw.js";
    // Everything else is `no-cache`, not `max-age`: the phone may cache it, but has to
    // revalidate every time. Pinning assets for an hour meant an updated app.js kept
    // losing to a stale copy in the browser's HTTP cache, even through a network-first SW.
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const headers = {
      "Content-Type": type,
      "Cache-Control": noStore ? "no-store" : "no-cache",
      ...(noStore ? {} : { ETag: etag, "Last-Modified": stat.mtime.toUTCString() }),
    };
    if (!noStore && req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers).end();
      return;
    }
    res.writeHead(200, { ...headers, "Content-Length": stat.size });
    res.end(req.method === "HEAD" ? undefined : await fs.readFile(full));
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

  if (urlPath === "/api/snapshot") {
    lastClientAt = Date.now();
    try {
      const snap = await getSnapshot();
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Snapshot-Cached": String(snap.cached),
        "X-Snapshot-Refreshing": String(snap.refreshing),
        "X-Snapshot-Age": String(Math.round((Date.now() - snap.at) / 1000)),
      });
      res.end(snap.body);
    } catch (err) {
      // Fall back to the last good snapshot so a single slow provider doesn't blank the phone.
      if (lastGood) {
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Snapshot-Stale": "true",
          "X-Snapshot-Error": String(err.message).slice(0, 200),
        });
        res.end(lastGood.body);
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
