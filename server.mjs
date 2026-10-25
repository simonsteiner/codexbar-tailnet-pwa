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
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  getVapidKeys,
  sendPushNotification,
  SubscriptionStore,
  extractWindows,
  detectWindowRenewals,
  nextCheckDelayMs,
  loadWindowStates,
  saveWindowStates,
  DEFAULT_MIN_USED_PERCENT,
  DEFAULT_PUSH_TTL_SECONDS,
} from "./push.mjs";
import { UsageHistory } from "./history.mjs";
import { Updater, assetName, linuxArch } from "./updater.mjs";
import { UpstreamHealth, ServeMonitor, parseSystemctlShow, parseVersion, compareVersions, shouldAnnounceRelease } from "./health.mjs";

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
// Each refresh is a live provider fetch (serve's own cache is shorter), and Claude's OAuth
// usage endpoint started answering 429 at the old 60 s TTL (~40 calls/h). Window percentages barely move
// in 3 minutes. Keep it under serve's staleAfterSeconds (3x its --refresh-interval).
const CACHE_TTL_MS = Number(process.env.CBT_CACHE_TTL ?? 180) * 1000;
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
const WINDOW_STATE_PATH = process.env.CBT_PUSH_STATE_PATH ?? path.join(CONFIG_DIR, "push-window-state.json");
const HISTORY_PATH = process.env.CBT_HISTORY_PATH ?? path.join(CONFIG_DIR, "usage-history.json");
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
// Pace needs readings while nobody is looking too, or a quiet morning is one straight line
// between two app launches. 0 turns this off and records only what clients cause.
const HISTORY_POLL_MS = envNumber("CBT_HISTORY_POLL", 900, { min: 0 }) * 1000;

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
const windowStates = await loadWindowStates(WINDOW_STATE_PATH);
if (windowStates.size > 0) console.log(`push: restored usage state for ${windowStates.size} window(s)`);
// Last state written, so a poll that changed nothing does not rewrite the file.
let savedWindowStates = JSON.stringify(Object.fromEntries(windowStates));

// Usage samples per window, for pace and the burndown sparklines.
const history = new UsageHistory(HISTORY_PATH);
await history.load();
if (history.series.size > 0) console.log(`history: restored ${history.series.size} window series`);

// Re-stamp the state on the way down: the file is only rewritten when usage changes, so
// without this its age after a restart would be how long usage sat still, and a quiet
// afternoon would get it discarded as stale.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    Promise.allSettled([saveWindowStates(WINDOW_STATE_PATH, windowStates), history.save()])
      .finally(() => process.exit(0));
  });
}
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
  const stateJson = JSON.stringify(Object.fromEntries(windowStates));
  if (stateJson !== savedWindowStates) {
    savedWindowStates = stateJson;
    await saveWindowStates(WINDOW_STATE_PATH, windowStates);
  }

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

const iso = (t) => (t == null ? null : new Date(t).toISOString());

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
/** The newest snapshot, parsed: what pace is reported against. */
let latestSnapshot = null;
const upstream = new UpstreamHealth();

function fetchUpstream(upstreamPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        path: upstreamPath,
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

const fetchSnapshot = () => fetchUpstream("/dashboard/v1/snapshot");

// Coalesce concurrent refreshes into one upstream call, mirroring what `serve` does internally.
// While serve is failing, calls inside the backoff are refused without touching it — every
// caller (clients, poller, push timer, history poll) goes through here. `force` is the user
// tapping refresh, which is allowed to jump the queue.
function refresh({ force = false } = {}) {
  if (!inFlight) {
    const wait = upstream.retryIn();
    if (wait > 0 && !force) {
      return Promise.reject(new Error(`upstream down (${upstream.lastError}); next try in ${Math.ceil(wait / 1000)}s`));
    }
    inFlight = fetchSnapshot()
      .then((fresh) => {
        const outage = upstream.ok(fresh.at);
        if (outage != null) console.log(`upstream: back after ${Math.round(outage / 1000)}s down`);
        cache = fresh;
        lastGood = fresh;
        try {
          const parsed = JSON.parse(fresh.body);
          latestSnapshot = parsed;
          handleSnapshotRenewals(parsed).catch(() => {});
          history.record(parsed, fresh.at);
          learnDurations(parsed);
        } catch { /* json parse error */ }
        return fresh;
      }, (err) => {
        if (upstream.fail(err)) console.warn(`upstream: down (${err.message})`);
        throw err;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

// Stale-while-revalidate: never make a phone wait out a live provider fetch when we
// have anything at all to show. A stale hit answers immediately, marks itself
// `refreshing`, and the client re-polls until the background refresh lands. `refreshing`
// means a fetch really is in flight: a refresh refused by the backoff is not one, and saying
// otherwise is what kept the phone spinning all night.
async function getSnapshot({ force = false } = {}) {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return { ...cache, cached: true, refreshing: false };
  const pending = refresh({ force });
  if (cache) {
    pending.catch(() => {}); // the failure is in `upstream`, reported with the stale body
    return { ...cache, cached: true, refreshing: !!inFlight };
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

/* ---------------- usage history & pace ---------------- */

// Window lengths are only in `serve /usage`, which is a full provider fetch of its own, so it
// is asked when a window shows up that was never asked about, and otherwise once a day.
let durationsInFlight = false;
let durationsTriedAt = 0;
function learnDurations(snap) {
  if (durationsInFlight || Date.now() - durationsTriedAt < 10 * 60_000) return;
  if (!history.needsDurations(snap)) return;
  durationsInFlight = true;
  durationsTriedAt = Date.now();
  fetchUpstream("/usage")
    .then((res) => {
      history.learnDurations(JSON.parse(res.body), snap);
      console.log(`history: learned ${history.durations.size} window length(s) from /usage`);
    })
    .catch((err) => console.warn(`history: /usage failed: ${err.message}`))
    .finally(() => { durationsInFlight = false; });
}

if (HISTORY_POLL_MS > 0) {
  setInterval(() => {
    if (cache && Date.now() - cache.at < HISTORY_POLL_MS) return; // clients kept it fresh
    refresh().catch(() => {});
  }, HISTORY_POLL_MS).unref?.();
}
setInterval(() => history.save().catch((err) => console.warn(`history: save failed: ${err.message}`)), 5 * 60_000).unref?.();

/** Pace per window of the newest snapshot, as JSON. */
function paceBody() {
  const snap = latestSnapshot ?? (lastGood ? JSON.parse(lastGood.body) : null);
  return JSON.stringify({ generatedAt: new Date().toISOString(), windows: snap ? history.report(snap) : {} });
}

/* ---------------- spend history (`codexbar cost`) ---------------- */

// Only the Spend view asks for this, so it is fetched on demand and never polled. Spend
// moves slowly and the cost scan reads local logs, so it gets its own, longer TTL.
const COST_TTL_MS = envNumber("CBT_COST_TTL", 300, { min: 0 }) * 1000;
// The phone offers ranges up to 90 days. `serve /cost` only takes `provider` and follows the
// app's saved period (30 days by default), so the proxy runs the CLI with an explicit window
// instead and the phone slices the shorter ranges out of it.
const COST_DAYS = 90;
const LOCAL_CODEXBAR = path.join(os.homedir(), ".local", "bin", "codexbar");
const CODEXBAR_BIN = process.env.CBT_CODEXBAR_BIN ?? (existsSync(LOCAL_CODEXBAR) ? LOCAL_CODEXBAR : "codexbar");

/** @type {{body: string, at: number} | null} */
let costCache = null;
/** @type {Promise<{body: string, at: number}> | null} */
let costInFlight = null;

// What the phone needs from the cost report: per-day totals with their model split. Codex's
// `projects[]` repeats every day once per project and carries local filesystem paths,
// so it is dropped rather than shipped over the tailnet to be ignored.
function trimCost(body) {
  const rows = JSON.parse(body);
  const providers = (Array.isArray(rows) ? rows : [rows]).map(({ projects, daily, totals, ...rest }) => ({
    ...rest,
    totals: totals
      ? { totalCost: totals.totalCost, totalTokens: totals.totalTokens, incompleteRequestCount: totals.incompleteRequestCount }
      : null,
    daily: (daily ?? []).map((d) => ({
      date: d.date,
      totalCost: d.totalCost,
      totalTokens: d.totalTokens,
      incompleteRequestCount: d.incompleteRequestCount,
      modelBreakdowns: (d.modelBreakdowns ?? []).map((m) => ({ modelName: m.modelName, cost: m.cost })),
    })),
  }));
  return JSON.stringify({ generatedAt: new Date().toISOString(), providers });
}

/** `codexbar cost --days 90 --format json`: the same payload as `serve /cost`, wider. */
function fetchCost() {
  return new Promise((resolve, reject) => {
    execFile(
      CODEXBAR_BIN,
      ["cost", "--days", String(COST_DAYS), "--format", "json"],
      { timeout: UPSTREAM_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // stderr also carries notes such as "Skipping providers without local cost usage".
        if (err) reject(new Error(`codexbar cost: ${(stderr || err.message).trim().slice(0, 200)}`));
        else resolve({ body: stdout, at: Date.now() });
      },
    );
  });
}

function refreshCost() {
  if (!costInFlight) {
    costInFlight = fetchCost()
      .then((fresh) => {
        costCache = { body: trimCost(fresh.body), at: fresh.at };
        return costCache;
      })
      .finally(() => {
        costInFlight = null;
      });
  }
  return costInFlight;
}

// Same stale-while-revalidate policy as getSnapshot().
async function getCost() {
  if (costCache && Date.now() - costCache.at < COST_TTL_MS) return { ...costCache, refreshing: false };
  const pending = refreshCost();
  if (costCache) {
    pending.catch(() => {});
    return { ...costCache, refreshing: true };
  }
  return { ...(await pending), refreshing: false };
}

/* ---------------- serve status & upstream releases ---------------- */

// The proxy runs as the same user as serve's unit, so `systemctl --user` can see it. That is
// what catches a crash loop: between crashes the port answers and the unit reads "activating",
// but NRestarts keeps climbing.
const SERVE_UNIT = process.env.CBT_SERVE_UNIT ?? "codexbar-serve.service";
const STATUS_PROBE_MS = 60_000;
// Push "serve is down" after this many seconds degraded, and "back" when it recovers. 0 = no pushes.
const DOWN_ALERT_S = envNumber("CBT_DOWN_ALERT", 600, { min: 0 });
// Where "update available" comes from. Unauthenticated GitHub API, so keep it to a few calls a day.
const RELEASE_REPO = process.env.CBT_RELEASE_REPO ?? "steipete/CodexBar";
const RELEASE_CHECK_MS = envNumber("CBT_RELEASE_CHECK", 6, { min: 0 }) * 3_600_000;
// The newest tag already pushed as "is out", so a restart doesn't announce it again.
const RELEASE_STATE_PATH = path.join(CONFIG_DIR, "release-announced.json");
const UPDATE_VARIANT = process.env.CBT_UPDATE_VARIANT ?? "";
const STARTED_AT = Date.now();

const monitor = new ServeMonitor({ alertAfterMs: (DOWN_ALERT_S || 600) * 1000, notify: DOWN_ALERT_S > 0 });
/** @type {(ReturnType<typeof parseSystemctlShow> & {probedAt: number}) | null} */
let serveUnit = null;
let unitError = null;
/** What `codexbar --version` says for the binary the symlink chain currently ends at. */
let installed = { version: null, path: null, error: null };
/** @type {{tag: string, name: string, url: string, publishedAt: string, assets: string[], checkedAt: string} | {error: string, checkedAt: string} | null} */
let latestRelease = null;

function run(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(cmd)}: ${(stderr || err.message).trim().slice(0, 300)}`));
      else resolve(stdout);
    });
  });
}

async function probeUnit() {
  try {
    const out = await run("systemctl", [
      "--user", "show", SERVE_UNIT, "--timestamp=unix",
      "-p", "LoadState,ActiveState,SubState,Result,NRestarts,MainPID,ActiveEnterTimestamp",
    ], 5000);
    const unit = parseSystemctlShow(out);
    // `show` on a unit that doesn't exist still answers, with ActiveState=inactive. That is
    // "serve runs some other way", not "serve is down".
    if (unit.loadState === "not-found") throw new Error(`${SERVE_UNIT} not found`);
    serveUnit = { ...unit, probedAt: Date.now() };
    unitError = null;
  } catch (err) {
    serveUnit = null;
    unitError = err.message;
  }
}

/** Re-asks `--version` only when the symlink now points somewhere else. */
async function probeInstalled({ force = false } = {}) {
  let real = CODEXBAR_BIN;
  try { real = await fs.realpath(CODEXBAR_BIN); } catch { /* bare name on PATH */ }
  if (!force && installed.path === real && installed.version) return;
  try {
    const out = await run(CODEXBAR_BIN, ["--version"], 10_000);
    installed = { version: parseVersion(out)?.join(".") ?? out.trim(), path: real, error: null };
  } catch (err) {
    installed = { version: null, path: real, error: err.message };
  }
}

async function checkRelease() {
  const checkedAt = new Date().toISOString();
  try {
    const res = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "codexbar-tailnet" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const r = await res.json();
    latestRelease = {
      tag: r.tag_name,
      name: r.name ?? r.tag_name,
      url: r.html_url,
      publishedAt: r.published_at,
      assets: (r.assets ?? []).map((a) => a.name),
      checkedAt,
    };
  } catch (err) {
    // Keep the last good answer; a flaky API shouldn't make "update available" flicker.
    latestRelease = latestRelease?.tag ? { ...latestRelease, error: err.message } : { error: err.message, checkedAt };
  }
}

let releaseAnnounced = null;
try { releaseAnnounced = JSON.parse(await fs.readFile(RELEASE_STATE_PATH, "utf8")).tag ?? null; } catch { /* never announced */ }

/** The CLI tarball this box would install for a tag, or null on an unsupported arch. */
const installAsset = (tag) => (linuxArch() ? assetName(tag, linuxArch(), UPDATE_VARIANT) : null);

/** One push per new release, once its Linux CLI is actually attached. */
async function announceRelease() {
  const latest = latestRelease?.tag ? latestRelease : null;
  if (!latest || !shouldAnnounceRelease({ latest, installed: installed.version, announced: releaseAnnounced, asset: installAsset(latest.tag) })) return;
  // Nobody to tell yet: leave it unannounced, so whoever subscribes next still hears about it.
  if (!vapidKeys || subscriptionStore.count() === 0) return;
  releaseAnnounced = latest.tag;
  await fs.writeFile(RELEASE_STATE_PATH, JSON.stringify({ tag: latest.tag, at: new Date().toISOString() }));
  console.log(`release: announcing ${latest.tag}`);
  await deliverToAll({
    title: `CodexBar ${latest.tag} is out`,
    body: `You're on ${installed.version}.${ADMIN_LOGINS.length ? " Tap to review and update." : ""}`,
    tag: "codexbar-release",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: "/?status", open: "status", release: latest.tag },
  });
}

function pushHealth(event, reason, since) {
  console.log(`health: ${event}${reason ? ` (${reason})` : ""}`);
  if (!vapidKeys || subscriptionStore.count() === 0) return;
  const down = event === "down";
  const lasted = since != null ? Math.round((Date.now() - since) / 60_000) : null;
  deliverToAll({
    title: down ? "CodexBar serve is down" : "CodexBar serve is back",
    body: down
      ? `${reason}. The dashboard is showing old data.`
      : `Answering again${lasted != null ? ` after ${lasted >= 60 ? `${Math.floor(lasted / 60)}h ${lasted % 60}m` : `${lasted}m`}` : ""}.`,
    tag: "serve-health", // "back" replaces "down" instead of stacking under it
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: "/", health: event },
  }).catch((err) => console.warn("push: health delivery failed:", err.message));
}

async function sampleHealth() {
  await probeUnit();
  const since = monitor.degradedSince;
  const { event, reason } = monitor.sample({ at: Date.now(), unit: serveUnit, upstream });
  if (event) pushHealth(event, reason, since);
}

/** Everything the status pill and dialog show. Synchronous: it reads what the probes cached. */
function statusBody() {
  const now = Date.now();
  const latest = latestRelease?.tag ? latestRelease : null;
  // An update restarting serve: the port is closed and the first snapshot is a cold one
  // (~25 s), which is no outage. The updater judges the restart itself and rolls back.
  const view = monitor.view({ at: now, unit: serveUnit, upstream });
  const health = updater.restarting
    ? { level: "ok", reason: "serve is restarting for the update", since: null }
    : { ...view, since: iso(view.since) };
  return {
    generatedAt: iso(now),
    health,
    upstream: upstream.toJSON(),
    snapshot: lastGood ? { at: iso(lastGood.at), ageSeconds: Math.round((now - lastGood.at) / 1000) } : null,
    serve: serveUnit
      ? {
        unit: SERVE_UNIT,
        activeState: serveUnit.activeState,
        subState: serveUnit.subState,
        result: serveUnit.result,
        restarts: serveUnit.restarts,
        mainPid: serveUnit.mainPid,
        activeSince: iso(serveUnit.activeSince),
        uptimeSeconds: serveUnit.activeState === "active" && serveUnit.activeSince ? Math.round((now - serveUnit.activeSince) / 1000) : null,
      }
      : { unit: SERVE_UNIT, error: unitError },
    codexbar: {
      version: installed.version,
      path: installed.path,
      error: installed.error,
      latest: latestRelease && (({ assets, ...rest }) => rest)(latestRelease), // assets are the updater's business
      // Installable, not merely published: the binaries land some minutes after the release does.
      updateAvailable: !!(latest && installed.version && compareVersions(latest.tag, installed.version) > 0
        && (!installAsset(latest.tag) || latest.assets.includes(installAsset(latest.tag)))),
    },
    proxy: { startedAt: iso(STARTED_AT), uptimeSeconds: Math.round((now - STARTED_AT) / 1000) },
  };
}

/* ---------------- updating codexbar from the PWA ---------------- */

// Who may install or switch CodexBar versions: tailnet logins, as `tailscale serve` reports them
// in Tailscale-User-Login. serve overwrites that header (a client-sent one never gets through),
// so it is trustworthy on requests that came through it — which is why the proxy must stay on
// loopback for this. Empty = updating from the PWA is off.
const ADMIN_LOGINS = (process.env.CBT_ADMIN_LOGINS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const LOOPBACK = /^(?:127\.|::1$|::ffff:127\.|localhost$)/;

const updater = new Updater({
  installRoot: process.env.CBT_INSTALL_ROOT ?? path.join(os.homedir(), ".local", "opt", "codexbar"),
  binLink: process.env.CBT_BIN_LINK ?? path.join(os.homedir(), ".local", "bin", "CodexBarCLI"),
  serveUnit: SERVE_UNIT,
  repo: RELEASE_REPO,
  variant: UPDATE_VARIANT,
  keep: envNumber("CBT_KEEP_INSTALLS", 2, { min: 0, integer: true }),
  verifyServe: () => refresh({ force: true }),
  quiet: (until) => monitor.quiet(until),
  onChange: () => {
    costCache = null; // spend came from the old binary
    probeInstalled({ force: true }).catch(() => {});
  },
});

/** Why this request may not run admin actions, or null when it may. */
function adminDenied(req) {
  if (ADMIN_LOGINS.length === 0) return "updating from here is off (set CBT_ADMIN_LOGINS)";
  if (!LOOPBACK.test(BIND)) return "updating from here needs CBT_BIND on loopback";
  if (!LOOPBACK.test(req.socket.remoteAddress ?? "")) return "request didn't come through tailscale serve";
  const login = String(req.headers["tailscale-user-login"] ?? "").toLowerCase();
  if (!login) return "no tailnet identity on this request";
  if (!ADMIN_LOGINS.includes(login)) return `${login} may not update CodexBar`;
  return null;
}

/** What only an admin's status dialog needs: the job, the installs to switch between. */
async function adminStatus(req) {
  const reason = adminDenied(req);
  if (reason) return { allowed: false, reason };
  return {
    allowed: true,
    reason: await updater.unsupported(),
    job: updater.status(),
    installs: await updater.installs(),
  };
}

await Promise.all([sampleHealth(), probeInstalled()]);
setInterval(() => { sampleHealth().catch(() => {}); }, STATUS_PROBE_MS).unref?.();
if (RELEASE_CHECK_MS > 0) {
  const check = () => checkRelease()
    .then(announceRelease)
    .catch((err) => console.warn(`release: ${err.message}`));
  check();
  setInterval(check, RELEASE_CHECK_MS).unref?.();
}

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
    `"pace":${paceBody()}`,
    `"upstream":${JSON.stringify(upstream.toJSON())}`,
    `"status":${JSON.stringify(statusBody())}`,
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
  // The stamp of the shell actually being sent, not getVersion()'s (cached for 30 s): the page
  // compares it to /api/version to notice it is running old JS.
  const ver = { ...(await getVersion()), stamp: built.stamp };
  const script = bootScript(peekSnapshot(), ver, vapidKeys?.publicKey ?? null);
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

// What the phone needs to say "serve has been down since 00:21" instead of spinning: set
// whenever the last refresh failed, even if a retry is already in flight. Not while an update
// is restarting serve, as long as there is data to show: that outage is expected and short.
function upstreamHeaders(err, { body = true } = {}) {
  if (!upstream.down && !err) return {};
  if (updater.restarting && body) return {};
  return {
    "X-Snapshot-Stale": "true",
    "X-Snapshot-Error": String(upstream.lastError ?? err?.message ?? "").replace(/[^\x20-\x7e]/g, "?").slice(0, 200),
    ...(upstream.downSince ? { "X-Upstream-Down-Since": new Date(upstream.downSince).toISOString() } : {}),
    "X-Upstream-Retry-In": String(Math.ceil(upstream.retryIn() / 1000)),
  };
}

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url ?? "/").split("?")[0];

  if (urlPath === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ status: "ok", upstream: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` }));
    return;
  }

  if (urlPath === "/api/status") {
    // The dialog is open and someone wants current numbers; the timer's copy can be a minute old.
    if (!serveUnit || Date.now() - serveUnit.probedAt > 15_000) await probeUnit();
    await probeInstalled();
    const json = "application/json; charset=utf-8";
    const body = JSON.stringify({ ...statusBody(), admin: await adminStatus(req) });
    sendBody(req, res, 200, { "Content-Type": json, "Cache-Control": "no-store" }, body,
      shouldGzip(req, json, Buffer.byteLength(body)));
    return;
  }

  if (urlPath === "/api/admin/update" || urlPath === "/api/admin/rollback") {
    const reply = (status, obj) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(obj));
    };
    if (req.method !== "POST") return reply(405, { error: "method not allowed" });
    // A page on another origin can't set a custom header without a CORS preflight, which this
    // server never answers — so together with Sec-Fetch-Site this keeps the routes same-origin.
    const crossSite = req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin";
    if (req.headers["x-codexbar-admin"] !== "1" || crossSite) return reply(403, { error: "same-origin requests only" });
    const denied = adminDenied(req);
    if (denied) return reply(403, { error: denied });
    try {
      const body = await readJsonBody(req);
      const login = req.headers["tailscale-user-login"];
      if (urlPath === "/api/admin/update") {
        const tag = body.tag ?? latestRelease?.tag;
        console.log(`update: ${login} asked for ${tag}`);
        return reply(202, await updater.startUpdate(tag));
      }
      console.log(`update: ${login} asked to switch to ${body.to}`);
      return reply(202, await updater.startRollback(body.to));
    } catch (err) {
      return reply(409, { error: err.message });
    }
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
    const force = new URLSearchParams((req.url ?? "").split("?")[1] ?? "").has("retry");
    try {
      const snap = await getSnapshot({ force });
      sendBody(req, res, 200, {
        "Content-Type": json,
        "Cache-Control": "no-store",
        "X-Snapshot-Cached": String(snap.cached),
        "X-Snapshot-Refreshing": String(snap.refreshing),
        "X-Snapshot-Age": String(Math.round((Date.now() - snap.at) / 1000)),
        ...upstreamHeaders(),
      }, snap.body, shouldGzip(req, json, Buffer.byteLength(snap.body)));
    } catch (err) {
      // Fall back to the last good snapshot so a single slow provider doesn't blank the phone.
      if (lastGood) {
        sendBody(req, res, 200, {
          "Content-Type": json,
          "Cache-Control": "no-store",
          "X-Snapshot-Refreshing": "false",
          "X-Snapshot-Age": String(Math.round((Date.now() - lastGood.at) / 1000)),
          ...upstreamHeaders(err),
        }, lastGood.body, shouldGzip(req, json, Buffer.byteLength(lastGood.body)));
        return;
      }
      res.writeHead(502, { "Content-Type": "application/json", "Cache-Control": "no-store", ...upstreamHeaders(err, { body: false }) });
      res.end(JSON.stringify({ error: "upstream_unavailable", detail: String(err.message), upstream: upstream.toJSON() }));
    }
    return;
  }

  if (urlPath === "/api/pace") {
    const json = "application/json; charset=utf-8";
    const body = paceBody();
    sendBody(req, res, 200, { "Content-Type": json, "Cache-Control": "no-store" }, body,
      shouldGzip(req, json, Buffer.byteLength(body)));
    return;
  }

  if (urlPath === "/api/cost") {
    const json = "application/json; charset=utf-8";
    try {
      const cost = await getCost();
      sendBody(req, res, 200, {
        "Content-Type": json,
        "Cache-Control": "no-store",
        "X-Snapshot-Refreshing": String(cost.refreshing),
        "X-Snapshot-Age": String(Math.round((Date.now() - cost.at) / 1000)),
      }, cost.body, shouldGzip(req, json, Buffer.byteLength(cost.body)));
    } catch (err) {
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
