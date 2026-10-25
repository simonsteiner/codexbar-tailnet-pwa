import {
  UpstreamHealth, retryDelay, RETRY_BASE_MS, RETRY_MAX_MS,
  ServeMonitor, parseSystemctlShow, parseVersion, compareVersions, shouldAnnounceRelease,
} from "./health.mjs";
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

  // 3: versions — tags, CLI output and install dir names all compare
  {
    assert.deepStrictEqual(parseVersion("CodexBar 0.79.0\n"), [0, 79, 0]);
    assert.deepStrictEqual(parseVersion("0.78.0-musl"), [0, 78, 0]);
    assert.strictEqual(parseVersion("nightly"), null);
    assert.ok(compareVersions("v0.80.0", "0.79.0") > 0);
    assert.ok(compareVersions("v0.79.0", "0.79.0") === 0);
    assert.ok(compareVersions("v0.9.0", "0.10.0") < 0, "numeric, not lexical");
    console.log("✓ Test 3 passed: version compare");
  }

  // 4: systemctl show, as the proxy asks for it
  {
    const u = parseSystemctlShow("LoadState=loaded\nActiveState=active\nSubState=running\nResult=success\nNRestarts=141\nMainPID=2574974\nActiveEnterTimestamp=@1792574652\n");
    assert.deepStrictEqual(u, {
      loadState: "loaded", activeState: "active", subState: "running", result: "success",
      restarts: 141, mainPid: 2574974, activeSince: 1792574652000,
    });
    assert.strictEqual(parseSystemctlShow("ActiveEnterTimestamp=\nMainPID=0").activeSince, null);
    assert.strictEqual(parseSystemctlShow("MainPID=0").mainPid, null);
    console.log("✓ Test 4 passed: systemctl show parsing");
  }

  // 5: monitor — a crash loop alerts once after the grace period, then recovers once
  {
    const MIN = 60_000;
    const m = new ServeMonitor({ alertAfterMs: 10 * MIN });
    const up = new UpstreamHealth();
    const unit = (restarts, activeState = "active") => ({ activeState, restarts, result: "success" });
    assert.strictEqual(m.sample({ at: T0, unit: unit(0), upstream: up }).level, "ok");
    // 2026-10-21: serve restarting every ~10 s, reading "activating" between crashes
    const loop = m.sample({ at: T0 + MIN, unit: unit(6, "activating"), upstream: up });
    assert.strictEqual(loop.level, "warn");
    assert.match(loop.reason, /crash-looping: 6 restarts/);
    assert.strictEqual(loop.event, null, "not before the grace period");
    const down = m.sample({ at: T0 + 11 * MIN, unit: unit(60), upstream: up });
    assert.strictEqual(down.level, "down");
    assert.strictEqual(down.event, "down");
    assert.strictEqual(m.sample({ at: T0 + 12 * MIN, unit: unit(66), upstream: up }).event, null, "alerts once");
    // Restarts stop; the loop window still remembers them until they age out.
    assert.strictEqual(m.sample({ at: T0 + 20 * MIN, unit: unit(66), upstream: up }).level, "down");
    const back = m.sample({ at: T0 + 23 * MIN, unit: unit(66), upstream: up });
    assert.strictEqual(back.level, "ok");
    assert.strictEqual(back.event, "recovered");
    console.log("✓ Test 5 passed: crash loop alert and recovery");
  }

  // 6: monitor — a stopped unit and a dead port count; one restart and a quiet window don't
  {
    const MIN = 60_000;
    const m = new ServeMonitor({ alertAfterMs: 5 * MIN });
    const up = new UpstreamHealth();
    assert.strictEqual(m.sample({ at: T0, unit: { activeState: "active", restarts: 0 }, upstream: up }).level, "ok");
    assert.strictEqual(m.sample({ at: T0 + MIN, unit: { activeState: "active", restarts: 1 }, upstream: up }).level, "ok");
    const stopped = m.sample({ at: T0 + 2 * MIN, unit: { activeState: "failed", result: "signal", restarts: 1 }, upstream: up });
    assert.match(stopped.reason, /serve unit is failed \(signal\)/);

    const m2 = new ServeMonitor({ alertAfterMs: 5 * MIN });
    const up2 = new UpstreamHealth();
    up2.fail(new Error("upstream timeout"), T0);
    m2.quiet(T0 + 30 * MIN);
    const r = m2.sample({ at: T0 + 6 * MIN, unit: null, upstream: up2 });
    assert.strictEqual(r.level, "down", "measured from the outage start, not the first sample");
    assert.match(r.reason, /isn't answering \(upstream timeout\)/);
    assert.strictEqual(r.event, null, "quiet: an update is restarting serve");

    const silent = new ServeMonitor({ alertAfterMs: 5 * MIN, notify: false });
    const up3 = new UpstreamHealth();
    up3.fail(new Error("x"), T0);
    assert.strictEqual(silent.sample({ at: T0 + 6 * MIN, unit: null, upstream: up3 }).event, null);
    assert.strictEqual(silent.level, "down");
    console.log("✓ Test 6 passed: unit state, quiet window, notify off");
  }

  // 6a: monitor view — reads now, not the last sample, and never moves the alert state
  {
    const MIN = 60_000;
    const m = new ServeMonitor({ alertAfterMs: 5 * MIN });
    const up = new UpstreamHealth();
    const unit = { activeState: "active", restarts: 0 };
    up.fail(new Error("connect ECONNREFUSED"), T0);
    assert.strictEqual(m.sample({ at: T0 + 10_000, unit, upstream: up }).level, "warn", "sampled mid-restart");
    up.ok(T0 + 30_000);
    assert.deepStrictEqual(m.view({ at: T0 + 31_000, unit, upstream: up }), { level: "ok", reason: null, since: null },
      "serve answered since the sample: the view is clean");
    assert.strictEqual(m.level, "warn", "the alert state waits for the next sample");
    up.fail(new Error("upstream timeout"), T0 + MIN);
    const v = m.view({ at: T0 + 7 * MIN, unit, upstream: up });
    assert.strictEqual(v.since, T0 + MIN, "dated from this outage, not the sampled one");
    assert.strictEqual(v.level, "down");
    assert.match(v.reason, /upstream timeout/);
    assert.strictEqual(m.view({ at: T0 + 7 * MIN, unit: { activeState: "failed", result: "signal", restarts: 0 }, upstream: new UpstreamHealth() }).reason,
      "serve unit is failed (signal)");
    console.log("✓ Test 6a passed: view is live and side-effect free");
  }

  // 6b: release pushes — once per newer tag, and only once the Linux CLI is attached
  {
    const asset = "CodexBarCLI-v0.80.0-linux-x86_64.tar.gz";
    const latest = { tag: "v0.80.0", assets: [asset, `${asset}.sha256`] };
    assert.strictEqual(shouldAnnounceRelease({ latest, installed: "0.79.0", announced: null, asset }), true);
    assert.strictEqual(shouldAnnounceRelease({ latest, installed: "0.79.0", announced: "v0.80.0", asset }), false, "already announced");
    assert.strictEqual(shouldAnnounceRelease({ latest, installed: "0.80.0", announced: null, asset }), false, "already installed");
    assert.strictEqual(shouldAnnounceRelease({ latest: { tag: "v0.80.0", assets: ["CodexBar-macos-universal-0.80.0.zip"] }, installed: "0.79.0", announced: null, asset }), false, "binaries still uploading");
    assert.strictEqual(shouldAnnounceRelease({ latest: { tag: "v0.81.0", assets: ["CodexBarCLI-v0.81.0-linux-x86_64.tar.gz"] }, installed: "0.79.0", announced: "v0.80.0", asset: "CodexBarCLI-v0.81.0-linux-x86_64.tar.gz" }), true, "a newer one than last announced");
    assert.strictEqual(shouldAnnounceRelease({ latest, installed: null, announced: null, asset }), false, "unknown install");
    console.log("✓ Test 6b passed: release announcement rules");
  }

  // 7: end to end — a serve that dies is reported as down, not "refreshing", and is not hammered
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
        CBT_RELEASE_CHECK: "0",
        CBT_SERVE_UNIT: "cbt-test-does-not-exist.service",
        CBT_CODEXBAR_BIN: "/bin/false",
        CBT_ADMIN_LOGINS: "Me@Example.com",
        CBT_BIN_LINK: path.join(dir, "no-such-link"),
        CBT_INSTALL_ROOT: path.join(dir, "opt"),
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

      const st = JSON.parse((await get(port, "/api/status")).body);
      assert.strictEqual(st.health.level, "warn");
      assert.match(st.health.reason, /isn't answering/);
      assert.match(st.serve.error, /not found/, "a missing unit is unknown, not down");
      assert.strictEqual(st.codexbar.version, null);
      assert.strictEqual(st.codexbar.updateAvailable, false);
      assert.ok(st.snapshot.at);
      assert.strictEqual(st.admin.allowed, false, "no tailnet identity on a direct request");

      // A malformed %-escape is the client's mistake, not a reason for the process to exit.
      assert.strictEqual((await get(port, "/%E0%A4%A")).status, 400);
      assert.strictEqual((await get(port, "/api/health")).status, 200, "proxy survived a malformed path");

      // Admin routes: POST only, same-origin only, and only for a listed tailnet login.
      const post = (headers) => fetch(`http://127.0.0.1:${port}/api/admin/update`, {
        method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ tag: "v0.79.0" }),
      }).then(async (r) => ({ status: r.status, error: (await r.json()).error }));
      const admin = { "X-CodexBar-Admin": "1" };
      assert.strictEqual((await get(port, "/api/admin/update")).status, 405);
      assert.match((await post({})).error, /same-origin/);
      assert.match((await post({ ...admin, "Sec-Fetch-Site": "cross-site", "Tailscale-User-Login": "me@example.com" })).error, /same-origin/);
      assert.match((await post(admin)).error, /no tailnet identity/);
      assert.match((await post({ ...admin, "Tailscale-User-Login": "eve@example.com" })).error, /may not update/);
      const allowed = await post({ ...admin, "Tailscale-User-Login": "me@example.com" });
      assert.strictEqual(allowed.status, 409, "past the gate; refused only because this box has no install");
      assert.match(allowed.error, /not a symlink/);
      const st2 = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { "Tailscale-User-Login": "ME@example.com" } }).then((r) => r.json());
      assert.strictEqual(st2.admin.allowed, true);
      assert.match(st2.admin.reason, /not a symlink/);
      console.log("✓ Test 7 passed: dead upstream reported, backed off, recovered; /api/status; admin gate");
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
