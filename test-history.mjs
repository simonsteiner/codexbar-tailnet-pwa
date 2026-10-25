import { UsageHistory, computePace, downsample, isNewCycle, windowKey, MAX_SAMPLES } from "./history.mjs";
import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-10-02T10:00:00Z");

const snap = (windows, id = "claude") => ({
  providers: [{ id, enabled: true, windows }],
});
const win = (kind, used, resetAt, extra = {}) => ({ kind, label: kind, usedPercent: used, remainingPercent: 100 - used, resetAt, ...extra });

async function runTests() {
  console.log("Running history.mjs tests...");

  // 1: flat runs collapse to their two ends
  {
    const h = new UsageHistory("/dev/null");
    const reset = new Date(T0 + 5 * HOUR).toISOString();
    for (let i = 0; i < 10; i++) h.record(snap([win("session", 20, reset)]), T0 + i * MIN);
    const s = h.series.get(windowKey("claude", "session")).samples;
    assert.deepStrictEqual(s, [[T0, 20], [T0 + 9 * MIN, 20]]);
    h.record(snap([win("session", 25, reset)]), T0 + 10 * MIN);
    assert.strictEqual(h.series.get(windowKey("claude", "session")).samples.length, 3);
    console.log("✓ Test 1 passed: flat runs collapse");
  }

  // 2: a renewal starts a new series; a small rolling drop does not
  {
    assert.strictEqual(isNewCycle(80, 0, "2026-10-02T15:00:00Z", "2026-10-02T20:00:00Z", 300), true);
    assert.strictEqual(isNewCycle(40, 38, "2026-10-02T15:00:00Z", "2026-10-02T15:00:01Z", 300), false);
    // Small usage, reset moved a whole window on: still a new cycle
    assert.strictEqual(isNewCycle(3, 1, "2026-10-02T15:00:00Z", "2026-10-02T20:00:00Z", 300), true);
    assert.strictEqual(isNewCycle(50, 60, "2026-10-02T15:00:00Z", "2026-10-02T20:00:00Z", 300), false);

    const h = new UsageHistory("/dev/null");
    h.record(snap([win("session", 70, "2026-10-02T15:00:00Z")]), T0);
    h.record(snap([win("session", 90, "2026-10-02T15:00:00Z")]), T0 + HOUR);
    h.record(snap([win("session", 2, "2026-10-02T20:00:00Z")]), T0 + 5 * HOUR + MIN);
    assert.deepStrictEqual(h.series.get(windowKey("claude", "session")).samples, [[T0 + 5 * HOUR + MIN, 2]]);
    console.log("✓ Test 2 passed: cycle detection");
  }

  // 3: out-of-order and idle windows are ignored
  {
    const h = new UsageHistory("/dev/null");
    const reset = "2026-10-02T15:00:00Z";
    h.record(snap([win("session", 30, reset), win("x", 0, reset, { idle: true })]), T0 + HOUR);
    h.record(snap([win("session", 10, reset)]), T0);
    assert.deepStrictEqual(h.series.get(windowKey("claude", "session")).samples, [[T0 + HOUR, 30]]);
    assert.strictEqual(h.series.has(windowKey("claude", "x")), false);
    console.log("✓ Test 3 passed: stale fetches and idle windows skipped");
  }

  // 4: pace — even use, deficit and a run-out projection
  {
    // 5h window, 2h in, 60% used: expected 40, 20 in deficit, burning 30/h -> 100 in 1h20m, reset in 3h
    const start = T0;
    const reset = new Date(start + 5 * HOUR).toISOString();
    const samples = [[start, 0], [start + HOUR, 30], [start + 2 * HOUR, 60]];
    const p = computePace({ samples, resetAt: reset, windowMinutes: 300, now: start + 2 * HOUR });
    assert.strictEqual(p.expectedUsedPercent, 40);
    assert.strictEqual(p.deltaPercent, 20);
    assert.strictEqual(p.stage, "deficit");
    assert.strictEqual(p.ratePerHour, 30);
    assert.strictEqual(p.etaSeconds, 80 * 60);
    assert.strictEqual(p.willLastToReset, false);
    assert.strictEqual(p.startAt, new Date(start).toISOString());
    assert.strictEqual(p.lookbackMinutes, 60); // a fifth of 5h
    console.log("✓ Test 4 passed: deficit and run-out projection");
  }

  // 5: pace — reserve, no recent burn lasts to reset
  {
    const reset = new Date(T0 + 5 * HOUR).toISOString();
    const samples = [[T0, 10], [T0 + 4 * HOUR, 10]];
    const p = computePace({ samples, resetAt: reset, windowMinutes: 300, now: T0 + 4 * HOUR });
    assert.strictEqual(p.stage, "reserve");
    assert.strictEqual(p.deltaPercent, -70);
    assert.strictEqual(p.ratePerHour, 0);
    assert.strictEqual(p.etaSeconds, null);
    assert.strictEqual(p.willLastToReset, true);
    console.log("✓ Test 5 passed: reserve and idle burn");
  }

  // 6: pace — a too-short series projects nothing; an unknown window length still projects
  {
    const reset = new Date(T0 + 30 * 24 * HOUR).toISOString();
    const short = computePace({ samples: [[T0, 10], [T0 + 2 * MIN, 11]], resetAt: reset, windowMinutes: null, now: T0 + 2 * MIN });
    assert.strictEqual(short.ratePerHour, null);
    assert.strictEqual(short.willLastToReset, null);
    assert.strictEqual(short.expectedUsedPercent, null);
    assert.strictEqual(short.stage, null);

    const long = computePace({ samples: [[T0, 10], [T0 + 24 * HOUR, 20]], resetAt: reset, windowMinutes: null, now: T0 + 24 * HOUR });
    assert.strictEqual(long.ratePerHour, 0.4);
    assert.strictEqual(long.etaSeconds, 192 * 3600); // 80 points left at 10 per day
    assert.strictEqual(long.willLastToReset, false); // 192h to empty, 696h to reset
    console.log("✓ Test 6 passed: short series and unknown window length");
  }

  // 7: a full window has run out
  {
    const p = computePace({ samples: [[T0, 50], [T0 + HOUR, 100]], resetAt: new Date(T0 + 3 * HOUR).toISOString(), windowMinutes: 300, now: T0 + HOUR });
    assert.strictEqual(p.etaSeconds, 0);
    assert.strictEqual(p.willLastToReset, false);
    console.log("✓ Test 7 passed: exhausted window");
  }

  // 8: durations from /usage, keyed like dashboard-v1 kinds
  {
    const h = new UsageHistory("/dev/null");
    h.learnDurations([
      { provider: "claude", usage: { primary: { windowMinutes: 300 }, secondary: { windowMinutes: 10080 }, extraRateWindows: [{ id: "claude-weekly-scoped-fable", window: { windowMinutes: 10080 } }] } },
      { provider: "copilot", usage: { primary: { usedPercent: 1 } } },
    ], snap([win("session", 1, null), win("offline-lane", 0, null)]), T0);
    assert.strictEqual(h.durations.get("claude::session"), 300);
    // A window /usage has no slot for is settled as unknown, not asked about every time
    assert.strictEqual(h.durations.has("claude::offline-lane"), true);
    assert.strictEqual(h.durations.get("claude::offline-lane"), null);
    assert.strictEqual(h.needsDurations(snap([win("offline-lane", 0, null)]), T0 + HOUR), false);
    assert.strictEqual(h.durations.get("claude::weekly"), 10080);
    assert.strictEqual(h.durations.get("claude::claude-weekly-scoped-fable"), 10080);
    assert.strictEqual(h.durations.get("copilot::session"), null);
    assert.strictEqual(h.needsDurations(snap([win("session", 1, null)], "copilot"), T0 + HOUR), false);
    assert.strictEqual(h.needsDurations(snap([win("tertiary", 1, null)], "copilot"), T0 + HOUR), true);
    assert.strictEqual(h.needsDurations(snap([win("session", 1, null)], "copilot"), T0 + 25 * HOUR), true);
    console.log("✓ Test 8 passed: window durations");
  }

  // 9: retention — samples older than a window are pruned, the count is capped
  {
    const h = new UsageHistory("/dev/null");
    h.durations.set("claude::session", 300);
    const reset = new Date(T0 + 100 * HOUR).toISOString();
    for (let i = 0; i <= 600; i++) h.record(snap([win("session", i % 2 ? 40 : 41, reset)]), T0 + i * MIN);
    const s = h.series.get("claude::session").samples;
    assert(s.length <= MAX_SAMPLES);
    assert(s[0][0] >= T0 + 600 * MIN - 6 * HOUR);
    console.log("✓ Test 9 passed: retention");
  }

  // 10: downsample keeps the ends and the budget
  {
    const many = Array.from({ length: 500 }, (_, i) => [i, i % 7]);
    const d = downsample(many, 60);
    assert(d.length <= 60);
    assert.deepStrictEqual(d[0], many[0]);
    assert.deepStrictEqual(d[d.length - 1], many[499]);
    assert.strictEqual(downsample(many.slice(0, 5), 60).length, 5);
    console.log("✓ Test 10 passed: downsample");
  }

  // 11: report and persistence round-trip
  {
    const file = path.join(os.tmpdir(), `test-history-${Date.now()}.json`);
    const h = new UsageHistory(file);
    h.learnDurations([{ provider: "claude", usage: { primary: { windowMinutes: 300 } } }], null, T0);
    const reset = new Date(T0 + 5 * HOUR).toISOString();
    h.record(snap([win("session", 10, reset)]), T0 + HOUR);
    h.record(snap([win("session", 30, reset)]), T0 + 2 * HOUR);
    await h.save();
    const again = new UsageHistory(file);
    await again.load();
    const r = again.report(snap([win("session", 30, reset)]), T0 + 2 * HOUR);
    assert.strictEqual(r["claude::session"].expectedUsedPercent, 40);
    assert.strictEqual(r["claude::session"].samples.length, 2);
    await fs.unlink(file).catch(() => {});

    // A failed write keeps the readings pending instead of dropping them until the next one.
    const lost = new UsageHistory(path.join(os.tmpdir(), `no-such-dir-${Date.now()}`, "h.json"));
    lost.record(snap([win("session", 30, reset)]), T0 + HOUR);
    await assert.rejects(lost.save());
    assert.strictEqual(lost.dirty, true);
    console.log("✓ Test 11 passed: report and persistence");
  }

  console.log("All history.mjs tests passed successfully!");
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
