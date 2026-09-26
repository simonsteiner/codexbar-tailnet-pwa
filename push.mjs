// Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) and reset window renewal detection
// Zero external dependencies — built on node:crypto, node:fs, node:path, and global fetch.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Load or generate persistent VAPID EC P-256 keys.
 * Stored as base64url-encoded uncompressed public key (65 bytes) and private key (32 bytes).
 */
export async function getVapidKeys(vapidPath) {
  try {
    const raw = await fs.readFile(vapidPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.publicKey && parsed.privateKey) {
      return parsed;
    }
  } catch {
    // File missing or corrupt; generate new pair
  }

  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const keys = {
    publicKey: ecdh.getPublicKey().toString("base64url"),
    privateKey: ecdh.getPrivateKey().toString("base64url"),
    generatedAt: new Date().toISOString(),
  };

  try {
    await fs.mkdir(path.dirname(vapidPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(vapidPath, JSON.stringify(keys, null, 2), { mode: 0o600, encoding: "utf8" });
  } catch (err) {
    console.warn(`Could not persist VAPID keys to ${vapidPath}:`, err.message);
  }

  return keys;
}

/**
 * Create a VAPID Authorization header (RFC 8292) using ES256 (P-256 with SHA-256).
 */
export function getVapidAuthHeader(audience, vapidKeys, subject = "mailto:codexbar@local") {
  const pubKeyBuf = Buffer.from(vapidKeys.publicKey, "base64url");
  const privKeyBuf = Buffer.from(vapidKeys.privateKey, "base64url");

  const x = pubKeyBuf.subarray(1, 33).toString("base64url");
  const y = pubKeyBuf.subarray(33, 65).toString("base64url");
  const d = privKeyBuf.toString("base64url");

  const jwk = { kty: "EC", crv: "P-256", x, y, d };
  const keyObj = crypto.createPrivateKey({ key: jwk, format: "jwk" });

  const header = { typ: "JWT", alg: "ES256" };
  const nowSec = Math.floor(Date.now() / 1000);
  const claims = {
    aud: audience,
    exp: nowSec + 12 * 3600,
    sub: subject,
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const claimsB64 = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const unsigned = `${headerB64}.${claimsB64}`;

  const sig = crypto.sign("SHA256", Buffer.from(unsigned, "utf8"), {
    key: keyObj,
    dsaEncoding: "ieee-p1363",
  });
  const jwt = `${unsigned}.${sig.toString("base64url")}`;
  return `vapid t=${jwt}, k=${vapidKeys.publicKey}`;
}

/**
 * Encrypt a Web Push payload using RFC 8291 (aes128gcm).
 */
export function encryptWebPush(payloadText, p256dhBase64Url, authBase64Url) {
  const clientPublicKey = Buffer.from(p256dhBase64Url, "base64url");
  const clientAuth = Buffer.from(authBase64Url, "base64url");

  const localECDH = crypto.createECDH("prime256v1");
  localECDH.generateKeys();
  const localPublicKey = localECDH.getPublicKey();
  const sharedSecret = localECDH.computeSecret(clientPublicKey);
  const salt = crypto.randomBytes(16);

  const authInfo = Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), clientPublicKey, localPublicKey]);
  const prk = crypto.hkdfSync("sha256", sharedSecret, clientAuth, authInfo, 32);

  const cekInfo = Buffer.from("Content-Encoding: aes128gcm\0", "utf8");
  const cek = crypto.hkdfSync("sha256", prk, salt, cekInfo, 16);

  const nonceInfo = Buffer.from("Content-Encoding: nonce\0", "utf8");
  const nonce = crypto.hkdfSync("sha256", prk, salt, nonceInfo, 12);

  const recordSize = 4096;
  const rsBuf = Buffer.alloc(4);
  rsBuf.writeUInt32BE(recordSize, 0);

  const payload = Buffer.from(payloadText, "utf8");
  const padded = Buffer.concat([payload, Buffer.from([2])]);

  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const enc = cipher.update(padded);
  const final = cipher.final();
  const tag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([enc, final, tag]);

  return Buffer.concat([
    salt,
    rsBuf,
    Buffer.from([localPublicKey.length]),
    localPublicKey,
    ciphertext,
  ]);
}

/**
 * Send an encrypted Web Push notification to a PushSubscription.
 */
export async function sendPushNotification(subscription, payload, vapidKeys, subject) {
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return { success: false, error: "Invalid subscription" };
  }

  try {
    const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);
    const encrypted = encryptWebPush(payloadStr, subscription.keys.p256dh, subscription.keys.auth);
    const endpointUrl = new URL(subscription.endpoint);
    const audience = endpointUrl.origin;
    const authHeader = getVapidAuthHeader(audience, vapidKeys, subject);

    const res = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "aes128gcm",
        TTL: "86400",
        Urgency: "high",
      },
      body: encrypted,
    });

    if (res.status === 404 || res.status === 410) {
      return { success: false, status: res.status, expired: true };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { success: false, status: res.status, error: text.slice(0, 200) };
    }

    return { success: true, status: res.status };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Manage push subscription persistence.
 */
export class SubscriptionStore {
  constructor(filePath) {
    this.filePath = filePath;
    /** @type {Map<string, {endpoint: string, keys: {p256dh: string, auth: string}, createdAt: number, lastSeenAt: number}>} */
    this.subscriptions = new Map();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        this.subscriptions.clear();
        for (const sub of list) {
          if (sub.endpoint && sub.keys?.p256dh && sub.keys?.auth) {
            this.subscriptions.set(sub.endpoint, sub);
          }
        }
      }
    } catch {
      // File missing or invalid JSON; start empty
    }
  }

  async save() {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const list = Array.from(this.subscriptions.values());
      await fs.writeFile(this.filePath, JSON.stringify(list, null, 2), { mode: 0o600, encoding: "utf8" });
    } catch (err) {
      console.warn(`Could not save subscriptions to ${this.filePath}:`, err.message);
    }
  }

  async add(sub) {
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return false;
    const now = Date.now();
    const existing = this.subscriptions.get(sub.endpoint);
    this.subscriptions.set(sub.endpoint, {
      endpoint: sub.endpoint,
      keys: {
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
      },
      createdAt: existing?.createdAt ?? now,
      lastSeenAt: now,
    });
    await this.save();
    return true;
  }

  async remove(endpoint) {
    if (!endpoint) return false;
    const removed = this.subscriptions.delete(endpoint);
    if (removed) {
      await this.save();
    }
    return removed;
  }

  all() {
    return Array.from(this.subscriptions.values());
  }

  count() {
    return this.subscriptions.size;
  }
}

/**
 * Extract rate limit windows from a snapshot.
 */
export function extractWindows(snapshot) {
  const windows = [];
  if (!snapshot?.providers) return windows;

  for (const provider of snapshot.providers) {
    if (provider.enabled === false) continue;
    const pName = provider.name || provider.id || "Provider";
    const pId = provider.id || provider.name || "provider";

    // Primary provider windows
    for (const win of provider.windows ?? []) {
      if (win.idle === true) continue;
      const key = `${pId}::${win.label || win.kind || "window"}`;
      windows.push({
        key,
        providerId: pId,
        providerName: pName,
        accountLabel: null,
        label: win.label || win.kind || "Window",
        kind: win.kind || null,
        usedPercent: win.usedPercent != null ? Number(win.usedPercent) : null,
        remainingPercent: win.remainingPercent != null ? Number(win.remainingPercent) : null,
        resetAt: win.resetAt || null,
      });
    }

    // Account-specific windows (e.g. claude-swap)
    for (const acc of provider.accounts ?? []) {
      if (acc.active === false) continue;
      for (const win of acc.windows ?? []) {
        if (win.idle === true) continue;
        const key = `${pId}:${acc.id || acc.label || "acc"}:${win.label || win.kind || "window"}`;
        windows.push({
          key,
          providerId: pId,
          providerName: pName,
          accountLabel: acc.label || acc.id || null,
          label: win.label || win.kind || "Window",
          kind: win.kind || null,
          usedPercent: win.usedPercent != null ? Number(win.usedPercent) : null,
          remainingPercent: win.remainingPercent != null ? Number(win.remainingPercent) : null,
          resetAt: win.resetAt || null,
        });
      }
    }
  }

  return windows;
}

// Renewals of windows whose usage never reached this much are not announced: a window
// nobody touched has nothing to say when it rolls over. The same figure is the minimum
// drop that counts as a renewal.
export const DEFAULT_MIN_USED_PERCENT = 10;
// One notification per window per this long, so a provider that reports usage in fits
// and starts (40 → 5 → 40 → 5) cannot announce the same reset twice.
export const DEFAULT_RENEWAL_COOLDOWN_MS = 30 * 60_000;

const toMs = (iso) => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
};

/**
 * Compare current windows against previous state to detect renewals.
 *
 * A renewal is one thing only: a window that was in use has its usage drop back to
 * (near) empty. Concretely, the last observation was at least `minUsedPercent` used, and
 * this one is at least that many points lower and no more than half of it.
 *
 * Reset times are deliberately not evidence. Providers move them for reasons that are
 * not a reset — a rolling window slides its boundary on every use, and several jitter
 * by a second between polls — and `codexbar serve` may still be serving the old cycle
 * from its cache when the clock passes the boundary. Any of those used to produce a
 * push that said "renewed" over an unchanged number.
 *
 * @param {Array} currentWindows
 * @param {Map} windowStates Map of window key -> state
 * @param {number} now Current timestamp in ms
 * @param {{minUsedPercent?: number, cooldownMs?: number}} [opts]
 * @returns {Array} List of renewed windows with { win, prev, reason }
 */
export function detectWindowRenewals(currentWindows, windowStates, now = Date.now(), opts = {}) {
  const minUsedPercent = opts.minUsedPercent ?? DEFAULT_MIN_USED_PERCENT;
  const cooldownMs = opts.cooldownMs ?? DEFAULT_RENEWAL_COOLDOWN_MS;
  const renewals = [];

  for (const win of currentWindows) {
    const prev = windowStates.get(win.key);

    if (!prev) {
      windowStates.set(win.key, {
        providerName: win.providerName,
        accountLabel: win.accountLabel,
        windowLabel: win.label,
        resetAt: win.resetAt,
        usedPercent: win.usedPercent,
        remainingPercent: win.remainingPercent,
        lastNotifiedAt: null,
      });
      continue;
    }

    const wasUsed = prev.usedPercent != null && prev.usedPercent >= minUsedPercent;
    const dropped = wasUsed && win.usedPercent != null &&
      prev.usedPercent - win.usedPercent >= minUsedPercent &&
      win.usedPercent <= prev.usedPercent / 2;
    const cooledDown = prev.lastNotifiedAt == null || now - prev.lastNotifiedAt >= cooldownMs;

    if (dropped && cooledDown) {
      renewals.push({ win, prev, reason: "usage_dropped" });
      prev.lastNotifiedAt = now;
    }

    prev.resetAt = win.resetAt;
    prev.usedPercent = win.usedPercent;
    prev.remainingPercent = win.remainingPercent;
    prev.providerName = win.providerName;
    prev.windowLabel = win.label;
    prev.accountLabel = win.accountLabel;
  }

  return renewals;
}

/**
 * How long until the proxy should next fetch a snapshot on the push feature's behalf,
 * or null when nothing is worth waiting for.
 *
 * Two triggers: the soonest future reset time (plus a small lead, so the fetch lands
 * after the provider has rolled over), and any used window whose reset time has passed
 * without the usage drop showing up yet. The latter is re-polled every `retryMs` for
 * `retryWindowMs`, because upstream may still be serving the pre-reset cycle from its
 * cache — but only while the window still reads as used, and not once this reset has
 * already been announced.
 *
 * @param {Array} windows
 * @param {Map} windowStates
 * @param {number} now
 * @param {{leadMs?: number, retryMs?: number, retryWindowMs?: number, minUsedPercent?: number}} [opts]
 * @returns {number|null} delay in ms, never below one second
 */
export function nextCheckDelayMs(windows, windowStates, now = Date.now(), opts = {}) {
  const leadMs = opts.leadMs ?? 3000;
  // `codexbar serve` caches for --refresh-interval (60 s here) and a cold fetch takes
  // ~13 s, so polling faster than once a minute only re-reads its cache.
  const retryMs = opts.retryMs ?? 60_000;
  const retryWindowMs = opts.retryWindowMs ?? 5 * 60_000;
  const minUsedPercent = opts.minUsedPercent ?? DEFAULT_MIN_USED_PERCENT;

  let delay = Infinity;
  for (const win of windows) {
    const t = toMs(win.resetAt);
    if (t == null) continue;
    if (t > now) {
      delay = Math.min(delay, t - now + leadMs);
      continue;
    }
    const state = windowStates.get(win.key);
    if (!state) continue;
    if (state.usedPercent == null || state.usedPercent < minUsedPercent) continue;
    if (state.lastNotifiedAt != null && state.lastNotifiedAt >= t) continue;
    if (now - t <= retryWindowMs) delay = Math.min(delay, retryMs);
  }
  return Number.isFinite(delay) ? Math.max(1000, delay) : null;
}
