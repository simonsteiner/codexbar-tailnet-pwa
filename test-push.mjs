import {
  getVapidKeys,
  getVapidAuthHeader,
  encryptWebPush,
  SubscriptionStore,
  extractWindows,
  detectWindowRenewals,
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
    endpoint: "https://push.example.com/sub/123",
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

  // Test 7: Renewal detection - boundary advancement
  const advancedSnapshot = JSON.parse(JSON.stringify(sampleSnapshot));
  advancedSnapshot.providers[0].windows[0].resetAt = "2026-09-03T22:00:00Z";
  advancedSnapshot.providers[0].windows[0].usedPercent = 0;
  advancedSnapshot.providers[0].windows[0].remainingPercent = 100;

  const advancedWindows = extractWindows(advancedSnapshot);
  const detected = detectWindowRenewals(advancedWindows, states, now + 1000);
  assert.strictEqual(detected.length, 1, "Should detect 1 renewed window");
  assert.strictEqual(detected[0].win.key, "claude::Session");
  assert.strictEqual(detected[0].reason, "boundary_advanced");

  // Subsequent check should NOT re-trigger
  const recheck = detectWindowRenewals(advancedWindows, states, now + 2000);
  assert.strictEqual(recheck.length, 0, "Subsequent check should not re-trigger renewal");
  console.log("✓ Test 7 passed: Renewal boundary advancement and deduplication");

  // Test 8: Renewal detection - scheduled reset time elapsed with usage drop
  const snap3 = JSON.parse(JSON.stringify(sampleSnapshot));
  const states3 = new Map();
  const t0 = new Date("2026-09-03T17:50:00Z").getTime();
  detectWindowRenewals(extractWindows(snap3), states3, t0);

  // Time travels past resetAt (18:00:00Z) to 18:00:05Z, usage drops from 80% to 0%
  const t1 = new Date("2026-09-03T18:00:05Z").getTime();
  snap3.providers[0].windows[0].usedPercent = 0;
  snap3.providers[0].windows[0].remainingPercent = 100;

  const detectedElapsed = detectWindowRenewals(extractWindows(snap3), states3, t1);
  assert.strictEqual(detectedElapsed.length, 1, "Should detect renewal when reset time elapses and usage drops");
  assert.strictEqual(detectedElapsed[0].win.key, "claude::Session");
  console.log("✓ Test 8 passed: Renewal detection on time elapsed with usage restoration");

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

  console.log("All 9 push.mjs tests passed successfully!");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
