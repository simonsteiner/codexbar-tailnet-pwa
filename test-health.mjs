import { UpstreamHealth, retryDelay, RETRY_BASE_MS, RETRY_MAX_MS } from "./health.mjs";
import assert from "node:assert";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T0 = Date.parse("2026-10-21T00:21:00Z");

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(port, urlPath) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`);
  return { status: res.status, headers: res.headers, body: await res.text() };
}

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(50);
  }
}

async function runTests() {
  console.log("Running health.mjs tests...");

  // 1: backoff doubles from the base and stops at the cap
  {
    assert.strictEqual(retryDelay(0), 0);
    assert.strictEqual(retryDelay(1), RETRY_BASE_MS);
    assert.strictEqual(retryDelay(2), RETRY_BASE_MS * 2);
    assert.strictEqual(retryDelay(50), RETRY_MAX_MS);
    console.log("✓ Test 1 passed: retry backoff");
  }

  // 2: an outage starts on the first failure, keeps its start, and ends on success
  {
    const h = new UpstreamHealth();
    assert.strictEqual(h.down, false);
    assert.strictEqual(h.retryIn(T0), 0);
    assert.strictEqual(h.fail(new Error("socket hang up"), T0), true);
    assert.strictEqual(h.fail(new Error("socket hang up"), T0 + 20_000), false);
    assert.strictEqual(h.downSince, T0);
    assert.strictEqual(h.failures, 2);
    assert.strictEqual(h.retryIn(T0 + 20_000), RETRY_BASE_MS * 2);
    assert.strictEqual(h.retryIn(T0 + 60_000), 0);
    assert.strictEqual(h.ok(T0 + 60_000), 60_000);
    assert.strictEqual(h.down, false);
    assert.strictEqual(h.downSince, null);
    assert.strictEqual(h.ok(T0 + 70_000), null, "no outage to end");
    console.log("✓ Test 2 passed: outage bookkeeping");
  }

  // 3: end to end — a serve that dies is reported as down, not "refreshing", and is not hammered
  {
    let mode = "ok";
    let hits = 0;
    const snapshot = JSON.stringify({ generatedAt: new Date().toISOString(), providers: [] });
    const fake = http.createServer((req, res) => {
      hits += 1;
      if (mode === "ok") res.writeHead(200, { "Content-Type": "application/json" }).end(snapshot);
      else req.socket.destroy(); // what a segfaulting serve looks like from here: "socket hang up"
    });
    const upstreamPort = await listen(fake);
    const probe = http.createServer();
    const port = await listen(probe);
    await new Promise((r) => probe.close(r));

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cbt-health-"));
    const child = spawn(process.execPath, [path.join(HERE, "server.mjs")], {
      env: {
        ...process.env,
        CODEXBAR_DASHBOARD_TOKEN: "test",
        CBT_PORT: String(port),
        CBT_UPSTREAM_PORT: String(upstreamPort),
        CBT_CONFIG_DIR: dir,
        CBT_CACHE_TTL: "0",
        CBT_HISTORY_POLL: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (d) => { log += d; });
    child.stderr.on("data", (d) => { log += d; });
    try {
      // Boot prewarm lands a good snapshot.
      await waitFor(async () => (await get(port, "/api/snapshot")).headers.get("x-snapshot-stale") == null && hits > 0);

      mode = "dead";
      const first = await get(port, "/api/snapshot");            // stale hit, kicks off a refresh
      assert.strictEqual(first.status, 200);
      const failed = await waitFor(async () => {
        const r = await get(port, "/api/snapshot");
        return r.headers.get("x-snapshot-stale") === "true" ? r : null;
      });
      assert.strictEqual(failed.status, 200, "still serves the last good body");
      assert.strictEqual(failed.headers.get("x-snapshot-refreshing"), "false");
      assert.match(failed.headers.get("x-snapshot-error"), /socket hang up/);
      assert.ok(failed.headers.get("x-upstream-down-since"));
      assert.ok(Number(failed.headers.get("x-upstream-retry-in")) > 0);

      // A burst of client polls inside the backoff must not reach serve.
      const before = hits;
      for (let i = 0; i < 10; i++) await get(port, "/api/snapshot");
      assert.strictEqual(hits, before, "polls inside the backoff were sent upstream");

      // The user tapping refresh may jump the queue; once serve is back, the outage clears.
      mode = "ok";
      await get(port, "/api/snapshot?retry=1");
      const healed = await waitFor(async () => {
        const r = await get(port, "/api/snapshot");
        return r.headers.get("x-snapshot-stale") == null ? r : null;
      });
      assert.strictEqual(healed.status, 200);
      assert.match(log, /upstream: down \(socket hang up\)/);
      assert.match(log, /upstream: back after \d+s down/);

      // The page itself carries the outage, so a launch can say so before its first fetch.
      mode = "dead";
      await get(port, "/api/snapshot?retry=1");
      await waitFor(async () => (await get(port, "/api/snapshot")).headers.get("x-snapshot-stale") === "true");
      const page = await get(port, "/");
      assert.match(page.body, /"upstream":\{"ok":false/);
      console.log("✓ Test 3 passed: dead upstream reported, backed off, recovered");
    } finally {
      // It saves its state on SIGTERM; let that finish before the directory goes.
      await new Promise((r) => { child.once("exit", r); child.kill(); });
      fake.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  console.log("\nAll health.mjs tests passed!");
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
