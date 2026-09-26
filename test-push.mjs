import {
  getVapidKeys,
  getVapidAuthHeader,
  encryptWebPush,
  SubscriptionStore,
  extractWindows,
  detectWindowRenewals,
  nextCheckDelayMs,
  isValidSubscription,
  loadWindowStates,
  saveWindowStates,
  sendPushNotification,
} from "./push.mjs";
import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert";

async function runTests() {
  console.log("Running push.mjs comprehensive unit & integration tests...");

  // Test 1: VAPID keys generation and persistence
  const tmpVapidPath = path.join(os.tmpdir(), `test-vapid-${Date.now()}.json`);
  const keys1 = await getVapidKeys(tmpVapidPath);
  assert(keys1.publicKey, "Should generate public key");
  assert(keys1.privateKey, "Should generate private key");

  const keys2 = await getVapidKeys(tmpVapidPath);
  assert.strictEqual(keys1.publicKey, keys2.publicKey, "Should reload saved public key");
  assert.strictEqual(keys1.privateKey, keys2.privateKey, "Should reload saved private key");
  await fs.unlink(tmpVapidPath).catch(() => {});
  console.log("✓ Test 1 passed: VAPID key generation and loading");

  // Test 2: VAPID auth header format
  const authHeader = getVapidAuthHeader("https://fcm.googleapis.com", keys1, "mailto:test@example.com");
  assert(authHeader.startsWith("vapid t="), "Auth header should start with vapid t=");
  assert(authHeader.includes(", k="), "Auth header should contain public key param");
  console.log("✓ Test 2 passed: VAPID authorization header generation");

  // Test 3: Web Push encryption & decryption round-trip (RFC 8291)
  const clientECDH = crypto.createECDH("prime256v1");
  clientECDH.generateKeys();
  const clientPubB64 = clientECDH.getPublicKey().toString("base64url");
  const clientAuth = crypto.randomBytes(16);
  const clientAuthB64 = clientAuth.toString("base64url");

  const message = JSON.stringify({ title: "CodexBar", body: "Claude renewed!" });
  const encrypted = encryptWebPush(message, clientPubB64, clientAuthB64);
  assert(Buffer.isBuffer(encrypted), "Should return buffer");
  assert(encrypted.length > 86, "Encrypted payload should contain salt, rs, id, key, ciphertext");

  // Decrypt using client keys to verify RFC 8291 compliance
  const salt = encrypted.subarray(0, 16);
  const idlen = encrypted[20];
  const localPublicKey = encrypted.subarray(21, 21 + idlen);
  const ciphertextWithTag = encrypted.subarray(21 + idlen);
  const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - 16);
  const tag = ciphertextWithTag.subarray(ciphertextWithTag.length - 16);

  const sharedSecret = clientECDH.computeSecret(localPublicKey);
  const authInfo = Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), clientECDH.getPublicKey(), localPublicKey]);
  const prk = crypto.hkdfSync("sha256", sharedSecret, clientAuth, authInfo, 32);

  const cek = crypto.hkdfSync("sha256", prk, salt, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16);
  const nonce = crypto.hkdfSync("sha256", prk, salt, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12);

  const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  let end = dec.length - 1;
  while (end >= 0 && dec[end] === 0) end--;
  assert(end >= 0 && dec[end] === 2, "Padding delimiter must be 0x02");
  const decrypted = dec.subarray(0, end).toString("utf8");
  assert.strictEqual(decrypted, message, "Decrypted text must match original message");
  console.log("✓ Test 3 passed: RFC 8291 Web Push encryption round-trip");

  // Test 4: Subscription Store
  const tmpSubPath = path.join(os.tmpdir(), `test-subs-${Date.now()}.json`);
  const store = new SubscriptionStore(tmpSubPath);
  await store.load();
  assert.strictEqual(store.count(), 0);

  const sampleSub = {
    endpoint: "https://fcm.googleapis.com/fcm/send/123",
    keys: { p256dh: clientPubB64, auth: clientAuthB64 },
  };
  await store.add(sampleSub);
  assert.strictEqual(store.count(), 1);

  const store2 = new SubscriptionStore(tmpSubPath);
  await store2.load();
  assert.strictEqual(store2.count(), 1);
  assert.strictEqual(store2.all()[0].endpoint, sampleSub.endpoint);

  await store2.remove(sampleSub.endpoint);
  assert.strictEqual(store2.count(), 0);
  await fs.unlink(tmpSubPath).catch(() => {});
  console.log("✓ Test 4 passed: SubscriptionStore load, add, save, remove");

  // Test 5: Window extraction
  const sampleSnapshot = {
    providers: [
      {
        id: "claude",
        name: "Claude",
        enabled: true,
        windows: [
          { kind: "session", label: "Session", usedPercent: 80, remainingPercent: 20, resetAt: "2026-09-03T18:00:00Z" },
          { kind: "session", label: "Idle Window", usedPercent: 0, idle: true },
        ],
        accounts: [
          {
            id: "claude-swap:2",
            label: "Work",
            active: true,
            windows: [
              { kind: "session", label: "Work Session", usedPercent: 50, remainingPercent: 50, resetAt: "2026-09-03T19:00:00Z" },
            ],
          },
        ],
      },
      {
        id: "disabled_prov",
        enabled: false,
        windows: [{ kind: "session", label: "Disabled" }],
      },
    ],
  };

  const extracted = extractWindows(sampleSnapshot);
  assert.strictEqual(extracted.length, 2, "Should extract 2 active windows (excluding idle and disabled)");
  assert.strictEqual(extracted[0].key, "claude::Session");
  assert.strictEqual(extracted[1].key, "claude:claude-swap:2:Work Session");
  console.log("✓ Test 5 passed: extractWindows filtering");

  // Test 6: Renewal detection - baseline initialization
  const states = new Map();
  const now = new Date("2026-09-03T17:00:00Z").getTime();
  const initRenewals = detectWindowRenewals(extracted, states, now);
  assert.strictEqual(initRenewals.length, 0, "No renewals on first baseline observation");
  assert.strictEqual(states.size, 2);
  console.log("✓ Test 6 passed: Renewal detection baseline");

  // Test 7: a used window whose usage drops back to empty renews, once
  const advancedSnapshot = JSON.parse(JSON.stringify(sampleSnapshot));
  advancedSnapshot.providers[0].windows[0].resetAt = "2026-09-03T22:00:00Z";
  advancedSnapshot.providers[0].windows[0].usedPercent = 0;
  advancedSnapshot.providers[0].windows[0].remainingPercent = 100;

  const advancedWindows = extractWindows(advancedSnapshot);
  const detected = detectWindowRenewals(advancedWindows, states, now + 1000);
  assert.strictEqual(detected.length, 1, "Should detect 1 renewed window");
  assert.strictEqual(detected[0].win.key, "claude::Session");
  assert.strictEqual(detected[0].reason, "usage_dropped");

  const recheck = detectWindowRenewals(advancedWindows, states, now + 2000);
  assert.strictEqual(recheck.length, 0, "Subsequent check should not re-trigger renewal");
  console.log("✓ Test 7 passed: usage drop renews once");

  // Test 8: a moved reset time is not a renewal; a drop under a stale reset time is
  {
    const st = new Map();
    const t0 = new Date("2026-09-04T08:00:00Z").getTime();
    const weekly = (over) => extractWindows({
      providers: [{ id: "opencodego", name: "OpenCode Go", enabled: true, windows: [
        { kind: "weekly", label: "Weekly", usedPercent: 13.5, remainingPercent: 86.5, resetAt: "2026-09-06T23:59:59Z", ...over },
      ] }],
    });
    detectWindowRenewals(weekly(), st, t0);
    // The provider slides the boundary and shaves half a point: what produced the false push.
    const slid = detectWindowRenewals(weekly({ usedPercent: 13, remainingPercent: 87, resetAt: "2026-09-08T23:59:59Z" }), st, t0 + 60_000);
    assert.strictEqual(slid.length, 0, "a moved reset time with unchanged usage is not a renewal");
    // Jitter by a second, same usage: nothing.
    const jitter = detectWindowRenewals(weekly({ usedPercent: 13, remainingPercent: 87, resetAt: "2026-09-09T00:00:00Z" }), st, t0 + 120_000);
    assert.strictEqual(jitter.length, 0, "reset-time jitter is not a renewal");
    // Usage collapses while the provider still reports the old boundary: that is one.
    const dropped = detectWindowRenewals(weekly({ usedPercent: 0, remainingPercent: 100, resetAt: "2026-09-09T00:00:00Z" }), st, t0 + 180_000);
    assert.strictEqual(dropped.length, 1, "usage dropping to empty renews even with a stale boundary");
    assert.strictEqual(dropped[0].reason, "usage_dropped");
  }
  console.log("✓ Test 8 passed: reset-time movement alone never renews");

  // Test 9: Expired subscription handling (410 Gone)
  const mockServer = http.createServer((req, res) => {
    res.writeHead(410, { "Content-Type": "text/plain" }).end("Gone");
  });
  await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  const mockPort = mockServer.address().port;
  const expiredSub = {
    endpoint: `http://127.0.0.1:${mockPort}/sub/expired`,
    keys: { p256dh: clientPubB64, auth: clientAuthB64 },
  };

  const sendRes = await sendPushNotification(expiredSub, { title: "Test" }, keys1, "mailto:test@example.com");
  assert.strictEqual(sendRes.success, false);
  assert.strictEqual(sendRes.expired, true, "Should report expired on 410");
  mockServer.close();
  console.log("✓ Test 9 passed: Expired subscription detection on HTTP 410");

  // Test 10: a window that sat at 0% renews silently — on the clock, and when its boundary moves
  {
    const st = new Map();
    const t0 = new Date("2026-09-04T09:00:00Z").getTime();
    const idleWin = (over) => extractWindows({
      providers: [{ id: "opencodego", name: "OpenCode Go", enabled: true, windows: [
        { kind: "session", label: "5-hour", usedPercent: 0, remainingPercent: 100, resetAt: "2026-09-04T09:58:14Z", ...over },
      ] }],
    });
    detectWindowRenewals(idleWin(), st, t0);
    assert.strictEqual(detectWindowRenewals(idleWin(), st, t0 + 60 * 60_000).length, 0,
      "0% window passing its reset time must not renew");
    assert.strictEqual(detectWindowRenewals(idleWin({ resetAt: "2026-09-04T14:58:14Z" }), st, t0 + 61 * 60_000).length, 0,
      "0% window whose boundary advances must not renew");
    // Below-threshold usage that clears is still not worth a push.
    detectWindowRenewals(idleWin({ resetAt: "2026-09-04T14:58:14Z", usedPercent: 6, remainingPercent: 94 }), st, t0 + 62 * 60_000);
    assert.strictEqual(detectWindowRenewals(idleWin({ resetAt: "2026-09-04T19:58:14Z" }), st, t0 + 6 * 60 * 60_000).length, 0,
      "a barely-used window clearing must not renew");
    // Real usage that clears does.
    detectWindowRenewals(idleWin({ resetAt: "2026-09-04T19:58:14Z", usedPercent: 40, remainingPercent: 60 }), st, t0 + 7 * 60 * 60_000);
    const renewed = detectWindowRenewals(idleWin({ resetAt: "2026-09-05T00:58:14Z" }), st, t0 + 11 * 60 * 60_000);
    assert.strictEqual(renewed.length, 1, "a used window renews when its usage clears");
  }
  console.log("✓ Test 10 passed: untouched and barely-used windows renew silently");

  // Test 11: the clock alone is never evidence — stale upstream numbers past the reset time
  {
    const st = new Map();
    const t0 = new Date("2026-09-04T09:00:00Z").getTime();
    const win = (over) => extractWindows({
      providers: [{ id: "claude", name: "Claude", enabled: true, windows: [
        { kind: "session", label: "Session", usedPercent: 82, remainingPercent: 18, resetAt: "2026-09-04T09:49:59Z", ...over },
      ] }],
    });
    detectWindowRenewals(win(), st, t0);
    const stale = detectWindowRenewals(win(), st, new Date("2026-09-04T09:50:02Z").getTime());
    assert.strictEqual(stale.length, 0, "unchanged numbers past the reset time must not renew");
    const later = detectWindowRenewals(win(), st, new Date("2026-09-04T09:51:00Z").getTime());
    assert.strictEqual(later.length, 0, "still no renewal a minute later on identical numbers");
    // The real cycle arrives, with a little use already on it: exactly one renewal.
    const fresh = detectWindowRenewals(win({ usedPercent: 3, remainingPercent: 97, resetAt: "2026-09-04T14:49:59Z" }),
      st, new Date("2026-09-04T09:51:30Z").getTime());
    assert.strictEqual(fresh.length, 1);
    assert.strictEqual(fresh[0].win.remainingPercent, 97);
    assert.strictEqual(detectWindowRenewals(fresh.map((r) => r.win), st, new Date("2026-09-04T09:52:00Z").getTime()).length, 0);
  }
  console.log("✓ Test 11 passed: no renewal on time alone; one renewal once usage really drops");

  // Test 12: partial drops and flapping usage
  {
    const st = new Map();
    const t0 = new Date("2026-09-04T09:00:00Z").getTime();
    const win = (used, resetAt = "2026-09-06T23:59:59Z") => extractWindows({
      providers: [{ id: "p", name: "P", enabled: true, windows: [
        { kind: "weekly", label: "Weekly", usedPercent: used, remainingPercent: 100 - used, resetAt },
      ] }],
    });
    detectWindowRenewals(win(60), st, t0);
    assert.strictEqual(detectWindowRenewals(win(45), st, t0 + 60_000).length, 0, "a 15-point slide of a rolling window is not a renewal");
    assert.strictEqual(detectWindowRenewals(win(5), st, t0 + 120_000).length, 1, "a collapse is");
    // Flapping provider: back up to 40, then down to 5 again within the cooldown.
    detectWindowRenewals(win(40), st, t0 + 180_000);
    assert.strictEqual(detectWindowRenewals(win(5), st, t0 + 240_000).length, 0, "second drop inside the cooldown is swallowed");
    detectWindowRenewals(win(40), st, t0 + 31 * 60_000);
    assert.strictEqual(detectWindowRenewals(win(5), st, t0 + 32 * 60_000).length, 1, "a drop after the cooldown counts again");
    // Below-threshold drops never count regardless of ratio.
    detectWindowRenewals(win(9), st, t0 + 40 * 60_000);
    assert.strictEqual(detectWindowRenewals(win(0), st, t0 + 70 * 60_000).length, 0, "9% clearing is below the threshold");
  }
  console.log("✓ Test 12 passed: partial slides and flapping usage do not renew");

  // Test 13: nextCheckDelayMs — lead before a reset, bounded retries after one
  {
    const st = new Map();
    const now = new Date("2026-09-04T09:00:00Z").getTime();
    const mk = (label, usedPercent, resetAt) => ({ key: `p::${label}`, resetAt, usedPercent, remainingPercent: 100 - usedPercent,
      providerId: "p", providerName: "P", label, kind: null, accountLabel: null });
    const future = mk("future", 50, "2026-09-04T09:10:00Z");
    const pastUsed = mk("pastUsed", 50, "2026-09-04T08:59:00Z");
    const pastIdle = mk("pastIdle", 0, "2026-09-04T08:59:00Z");
    const pastOld = mk("pastOld", 50, "2026-09-04T08:00:00Z");
    const pastSix = mk("pastSix", 50, "2026-09-04T08:54:00Z");
    detectWindowRenewals([future, pastUsed, pastIdle, pastOld, pastSix], st, now - 3600_000 - 1);

    assert.strictEqual(nextCheckDelayMs([future], st, now), 10 * 60_000 + 3000, "future reset: wait until just after it");
    assert.strictEqual(nextCheckDelayMs([pastUsed], st, now), 60_000, "used window past its reset: retry once a minute");
    assert.strictEqual(nextCheckDelayMs([pastIdle], st, now), null, "idle window past its reset: nothing to chase");
    assert.strictEqual(nextCheckDelayMs([pastOld], st, now), null, "retry window exhausted: give up");
    assert.strictEqual(nextCheckDelayMs([future, pastUsed], st, now), 60_000, "soonest trigger wins");
    assert.strictEqual(nextCheckDelayMs([pastSix], st, now), null, "gives up after five minutes");
    assert.strictEqual(nextCheckDelayMs([pastSix], st, now - 2 * 60_000), 60_000, "still chasing four minutes in");
    st.get(pastUsed.key).lastNotifiedAt = now - 10_000;
    assert.strictEqual(nextCheckDelayMs([pastUsed], st, now), null, "announced reset is not chased");
    assert.strictEqual(nextCheckDelayMs([], st, now), null);
  }
  console.log("✓ Test 13 passed: nextCheckDelayMs scheduling");

  // Test 14: VAPID rejection is flagged and prunes the subscription after repeated failures
  {
    const server403 = http.createServer((req, res) => res.writeHead(403).end("VAPID mismatch"));
    await new Promise((resolve) => server403.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${server403.address().port}/sub/x`;
    const r = await sendPushNotification({ endpoint, keys: { p256dh: clientPubB64, auth: clientAuthB64 } }, { t: 1 }, keys1);
    assert.strictEqual(r.unauthorized, true, "403 must be reported as unauthorized");
    assert.strictEqual(r.expired, undefined);
    server403.close();

    const subPath = path.join(os.tmpdir(), `test-subs-auth-${Date.now()}.json`);
    const st = new SubscriptionStore(subPath);
    const ep = "https://fcm.googleapis.com/fcm/send/auth";
    await st.add({ endpoint: ep, keys: { p256dh: clientPubB64, auth: clientAuthB64 } });
    assert.strictEqual(await st.recordAuthFailure(ep, 3), false);
    assert.strictEqual(await st.recordAuthFailure(ep, 3), false);
    // The client re-registering the same subscription on launch must not wipe the count.
    await st.add({ endpoint: ep, keys: { p256dh: clientPubB64, auth: clientAuthB64 } });
    assert.strictEqual(st.get(ep).authFailures, 2, "re-registering keeps the failure count");
    await st.markDelivered(ep);
    assert.strictEqual(st.get(ep).authFailures, 0, "a delivery resets the failure count");
    for (let i = 0; i < 2; i++) await st.recordAuthFailure(ep, 3);
    assert.strictEqual(st.count(), 1);
    assert.strictEqual(await st.recordAuthFailure(ep, 3), true, "third consecutive failure removes it");
    assert.strictEqual(st.count(), 0);
    await fs.unlink(subPath).catch(() => {});
  }
  console.log("✓ Test 14 passed: unauthorized responses and auth-failure pruning");

  // Test 15: delivery timeout — a push service that never answers does not hang the caller
  {
    const blackhole = http.createServer(() => { /* never respond */ });
    await new Promise((resolve) => blackhole.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${blackhole.address().port}/sub/hang`;
    const started = Date.now();
    const r = await sendPushNotification({ endpoint, keys: { p256dh: clientPubB64, auth: clientAuthB64 } }, { t: 1 }, keys1,
      undefined, { timeoutMs: 300 });
    assert.strictEqual(r.success, false);
    assert(Date.now() - started < 5000, "must give up on a silent push service");
    blackhole.closeAllConnections?.();
    blackhole.close();
  }
  console.log("✓ Test 15 passed: delivery timeout");

  // Test 16: subscription validation — only https endpoints with both keys
  {
    const keys = { p256dh: clientPubB64, auth: clientAuthB64 };
    for (const ok of [
      "https://fcm.googleapis.com/fcm/send/a",
      "https://updates.push.services.mozilla.com/wpush/v2/a",
      "https://web.push.apple.com/a",
      "https://wns2-ln2p.notify.windows.com/w/?token=a",
    ]) assert.strictEqual(isValidSubscription({ endpoint: ok, keys }), true, ok);
    assert.strictEqual(isValidSubscription({ endpoint: "http://fcm.googleapis.com/fcm/send/a", keys }), false, "plain http rejected");
    assert.strictEqual(isValidSubscription({ endpoint: "https://push.example.com/a", keys }), false, "unknown host rejected");
    assert.strictEqual(isValidSubscription({ endpoint: "https://100.64.0.1/a", keys }), false, "tailnet address rejected");
    assert.strictEqual(isValidSubscription({ endpoint: "https://evilfcm.googleapis.com.attacker.net/a", keys }), false, "suffix lookalike rejected");
    assert.strictEqual(isValidSubscription({ endpoint: "https://notfcm.googleapis.com/a", keys }), false, "prefix lookalike rejected");
    assert.strictEqual(isValidSubscription({ endpoint: "not a url", keys }), false);
    assert.strictEqual(isValidSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/a", keys: { p256dh: clientPubB64 } }), false);
    assert.strictEqual(isValidSubscription(null), false);
    const st = new SubscriptionStore(path.join(os.tmpdir(), `test-subs-valid-${Date.now()}.json`));
    assert.strictEqual(await st.add({ endpoint: "http://127.0.0.1/evil", keys }), false);
    assert.strictEqual(st.count(), 0);
  }
  console.log("✓ Test 16 passed: subscription validation");

  // Test 17: detection state survives a restart, but not a long outage
  {
    const statePath = path.join(os.tmpdir(), `test-window-state-${Date.now()}.json`);
    const t0 = new Date("2026-09-04T09:00:00Z").getTime();
    const win = (used) => extractWindows({
      providers: [{ id: "claude", name: "Claude", enabled: true, windows: [
        { kind: "session", label: "Session", usedPercent: used, remainingPercent: 100 - used, resetAt: "2026-09-04T09:49:59Z" },
      ] }],
    });
    const before = new Map();
    detectWindowRenewals(win(82), before, t0);
    await saveWindowStates(statePath, before, t0);

    // Restarted across the reset: the first post-restart poll still sees the drop.
    const after = await loadWindowStates(statePath, t0 + 5 * 60_000);
    assert.strictEqual(after.get("claude::Session").usedPercent, 82);
    assert.strictEqual(detectWindowRenewals(win(2), after, t0 + 6 * 60_000).length, 1, "renewal survives a restart");

    // Down for longer than the max age: start fresh rather than announce an old reset.
    assert.strictEqual((await loadWindowStates(statePath, t0 + 2 * 3600_000)).size, 0, "stale state is discarded");

    await fs.writeFile(statePath, "{not json");
    assert.strictEqual((await loadWindowStates(statePath, t0)).size, 0, "corrupt file starts empty");
    assert.strictEqual((await loadWindowStates(`${statePath}.missing`, t0)).size, 0, "missing file starts empty");
    const leftovers = (await fs.readdir(os.tmpdir())).filter((f) => f.startsWith(path.basename(statePath)) && f.endsWith(".tmp"));
    assert.strictEqual(leftovers.length, 0, "no temp files left behind");
    await fs.unlink(statePath).catch(() => {});
  }
  console.log("✓ Test 17 passed: window state persistence");

  // Test 18: a window that reports only remainingPercent is still tracked
  {
    const [w] = extractWindows({ providers: [{ id: "p", name: "P", windows: [
      { kind: "weekly", label: "Weekly", remainingPercent: 30, resetAt: null },
    ] }] });
    assert.strictEqual(w.usedPercent, 70);
    const st = new Map();
    detectWindowRenewals([w], st, 0);
    const [fresh] = extractWindows({ providers: [{ id: "p", name: "P", windows: [
      { kind: "weekly", label: "Weekly", remainingPercent: 100, resetAt: null },
    ] }] });
    assert.strictEqual(detectWindowRenewals([fresh], st, 60_000).length, 1, "remaining-only window renews");
  }
  console.log("✓ Test 18 passed: usedPercent derived from remainingPercent");

  console.log("All 18 push.mjs tests passed successfully!");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
