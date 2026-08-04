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

if (!TOKEN) {
  console.error("CODEXBAR_DASHBOARD_TOKEN is not set — the snapshot route would 401. Refusing to start.");
  process.exit(1);
}

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

// Coalesce concurrent misses into one upstream call, mirroring what `serve` does internally.
async function getSnapshot() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return { ...cache, cached: true };
  if (inFlight) return { ...(await inFlight), cached: true };

  inFlight = fetchSnapshot();
  try {
    const fresh = await inFlight;
    cache = fresh;
    lastGood = fresh;
    return { ...fresh, cached: false };
  } finally {
    inFlight = null;
  }
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
    const data = await fs.readFile(full);
    const type = MIME[path.extname(full).toLowerCase()] ?? "application/octet-stream";
    // The service worker and shell must never be pinned, or updates never land.
    const noStore = rel === "sw.js" || rel === "index.html";
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": noStore ? "no-store" : "public, max-age=3600",
    });
    res.end(data);
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

  if (urlPath === "/api/snapshot") {
    try {
      const snap = await getSnapshot();
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Snapshot-Cached": String(snap.cached),
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
