// Usage history per rate window, recorded by the proxy from every snapshot it fetches, and
// the pace derived from it. dashboard-v1 carries neither: no window length, no history and
// (outside claude-swap accounts) no pace. The window lengths come from `serve /usage`,
// which has `windowMinutes` but is a full provider fetch, so it is asked rarely.

import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Samples kept per window. Flat runs collapse to their two ends, so a cycle needs far fewer. */
export const MAX_SAMPLES = 400;
/** How long a series of unknown length is kept, and how long a vanished window lingers. */
const FALLBACK_RETENTION_MS = 31 * DAY;
/** Points shipped to the phone per sparkline. */
export const SPARK_POINTS = 60;
/** Within this many points of the even-use line, a window is "on pace". */
export const ON_PACE_BAND = 5;

/** The /usage slot a dashboard-v1 window kind was built from (DashboardSnapshotBuilder). */
const SLOT_OF_KIND = { session: "primary", weekly: "secondary", tertiary: "tertiary" };

export const windowKey = (providerId, kind) => `${providerId}::${kind}`;

const usedOf = (w) => {
  const used = Number(w.usedPercent ?? (w.remainingPercent != null ? 100 - w.remainingPercent : NaN));
  return Number.isFinite(used) ? Math.min(100, Math.max(0, used)) : null;
};

/**
 * A new cycle: usage fell back hard (the same rule push.mjs uses for a renewal), or fell at
 * all while the reset moved on by more than half a window. Small drops alone are a rolling
 * window shedding old usage and stay in the series.
 */
export function isNewCycle(prevUsed, used, prevResetAt, resetAt, windowMinutes) {
  if (used >= prevUsed) return false;
  if (prevUsed - used >= 5 && used <= prevUsed / 2) return true;
  const moved = Date.parse(resetAt) - Date.parse(prevResetAt);
  const threshold = windowMinutes ? (windowMinutes * MINUTE) / 2 : HOUR;
  return Number.isFinite(moved) && moved > threshold;
}

/** `used` at time `t`, interpolated between samples; clamps to the ends. */
function usedAt(samples, t) {
  if (t <= samples[0][0]) return samples[0][1];
  for (let i = 1; i < samples.length; i++) {
    const [t1, u1] = samples[i];
    if (t <= t1) {
      const [t0, u0] = samples[i - 1];
      return t1 === t0 ? u1 : u0 + ((u1 - u0) * (t - t0)) / (t1 - t0);
    }
  }
  return samples[samples.length - 1][1];
}

/** At most `n` points, evenly spread in time, always keeping the first and last. */
export function downsample(samples, n = SPARK_POINTS) {
  if (samples.length <= n) return samples;
  const out = [samples[0]];
  const t0 = samples[0][0];
  const span = samples[samples.length - 1][0] - t0;
  let next = 1;
  for (let i = 1; i < samples.length - 1; i++) {
    if (samples[i][0] - t0 >= (span * next) / (n - 1)) {
      out.push(samples[i]);
      next++;
    }
  }
  out.push(samples[samples.length - 1]);
  return out;
}

/**
 * Pace for one window. The expected line is even use from the window start to its reset —
 * what upstream's own pace compares against. The projection uses the recent burn rate
 * instead of the cycle average, so a burst shows up while it still matters: the lookback is
 * a fifth of the window, kept between 30 minutes and a day.
 */
export function computePace({ samples, resetAt, windowMinutes, now = Date.now() }) {
  if (!samples?.length) return null;
  const [tNow, uNow] = samples[samples.length - 1];
  const resetMs = Date.parse(resetAt);
  const span = windowMinutes ? windowMinutes * MINUTE : null;
  const startMs = span && Number.isFinite(resetMs) ? resetMs - span : null;

  let expectedUsedPercent = null;
  let deltaPercent = null;
  if (startMs != null) {
    expectedUsedPercent = Math.round(Math.min(100, Math.max(0, ((now - startMs) / span) * 100)));
    deltaPercent = Math.round(uNow - expectedUsedPercent);
  }

  const lookback = Math.min(DAY, Math.max(30 * MINUTE, (span ?? 7 * DAY) / 5));
  const from = Math.max(samples[0][0], tNow - lookback);
  const observed = tNow - from;
  let ratePerHour = null;
  let etaSeconds = null;
  let willLastToReset = null;
  // Too short a stretch says nothing about a rate: one poll interval of a fresh series.
  if (observed >= Math.min(15 * MINUTE, lookback / 2)) {
    const rate = Math.max(0, (uNow - usedAt(samples, from)) / observed); // points per ms
    ratePerHour = Math.round(rate * HOUR * 10) / 10;
    if (uNow >= 100) {
      etaSeconds = 0;
      willLastToReset = false;
    } else if (rate > 0) {
      const eta = (100 - uNow) / rate;
      etaSeconds = Math.round(eta / 1000);
      willLastToReset = Number.isFinite(resetMs) ? tNow + eta >= resetMs : null;
    } else {
      willLastToReset = true;
    }
  }

  return {
    windowMinutes: windowMinutes ?? null,
    startAt: startMs != null ? new Date(startMs).toISOString() : null,
    resetAt: resetAt ?? null,
    usedPercent: uNow,
    expectedUsedPercent,
    deltaPercent,
    stage: deltaPercent == null ? null
      : Math.abs(deltaPercent) <= ON_PACE_BAND ? "onPace" : deltaPercent > 0 ? "deficit" : "reserve",
    lookbackMinutes: Math.round(observed / MINUTE),
    ratePerHour,
    etaSeconds,
    willLastToReset,
    samples: downsample(samples.filter(([t]) => startMs == null || t >= startMs)),
  };
}

export class UsageHistory {
  constructor(filePath) {
    this.filePath = filePath;
    /** @type {Map<string, {resetAt: string|null, samples: [number, number][]}>} */
    this.series = new Map();
    /** window key -> windowMinutes, or null when /usage reports none (Copilot's month) */
    this.durations = new Map();
    this.durationsAt = 0;
    this.dirty = false;
  }

  async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      for (const [k, v] of Object.entries(data.series ?? {})) {
        if (Array.isArray(v?.samples)) this.series.set(k, { resetAt: v.resetAt ?? null, samples: v.samples });
      }
      for (const [k, v] of Object.entries(data.durations ?? {})) this.durations.set(k, v);
      this.durationsAt = Number(data.durationsAt) || 0;
    } catch { /* first run or unreadable: start empty */ }
  }

  async save() {
    if (!this.dirty) return;
    this.dirty = false;
    const data = {
      version: 1,
      durationsAt: this.durationsAt,
      durations: Object.fromEntries(this.durations),
      series: Object.fromEntries(this.series),
    };
    // Unique per call: the 5-minute save and the shutdown save can overlap, and two writers on
    // one temp file can interleave into JSON that load() discards whole.
    const tmp = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(data));
      await fs.rename(tmp, this.filePath);
    } catch (err) {
      this.dirty = true; // still unsaved; the next save tries again
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }
  }

  /** Windows of `snapshot` this history tracks: top-level, non-idle provider windows. */
  static windowsOf(snapshot) {
    const out = [];
    for (const p of snapshot?.providers ?? []) {
      if (p.enabled === false || !p.id) continue;
      for (const w of p.windows ?? []) {
        if (w.idle || !w.kind) continue;
        const used = usedOf(w);
        if (used != null) out.push({ key: windowKey(p.id, w.kind), used, resetAt: w.resetAt ?? null });
      }
    }
    return out;
  }

  /** Append the snapshot's readings, taken at `now`. */
  record(snapshot, now = Date.now()) {
    for (const { key, used, resetAt } of UsageHistory.windowsOf(snapshot)) {
      let s = this.series.get(key);
      if (!s) this.series.set(key, (s = { resetAt, samples: [] }));
      const last = s.samples[s.samples.length - 1];
      if (last && now <= last[0]) continue; // a slow fetch landing after a newer one
      if (last && isNewCycle(last[1], used, s.resetAt, resetAt, this.durations.get(key))) s.samples = [];
      s.resetAt = resetAt;
      const n = s.samples.length;
      // A flat run only needs its ends: slide the trailing one forward instead of appending.
      if (n >= 2 && s.samples[n - 1][1] === used && s.samples[n - 2][1] === used) s.samples[n - 1][0] = now;
      else s.samples.push([now, used]);
      this.prune(key, s, now);
      this.dirty = true;
    }
    // Windows that disappeared (provider disabled, model lane gone) eventually go too.
    for (const [key, s] of this.series) {
      const last = s.samples[s.samples.length - 1];
      if (!last || now - last[0] > FALLBACK_RETENTION_MS) {
        this.series.delete(key);
        this.dirty = true;
      }
    }
  }

  prune(key, s, now) {
    const minutes = this.durations.get(key);
    const keep = minutes ? minutes * MINUTE + HOUR : FALLBACK_RETENTION_MS;
    const cutoff = now - keep;
    let drop = 0;
    while (drop < s.samples.length - 1 && s.samples[drop][0] < cutoff) drop++;
    drop = Math.max(drop, s.samples.length - MAX_SAMPLES);
    if (drop > 0) s.samples.splice(0, drop);
  }

  /** True when `snapshot` has a window whose length was never asked, or the answers are a day old. */
  needsDurations(snapshot, now = Date.now()) {
    if (now - this.durationsAt > DAY) return true;
    return UsageHistory.windowsOf(snapshot).some(({ key }) => !this.durations.has(key));
  }

  /**
   * Learn window lengths from a `serve /usage` payload. Windows of `snapshot` it has no slot
   * for are recorded as unknown, so they are not asked about again until the daily refresh.
   */
  learnDurations(usagePayload, snapshot = null, now = Date.now()) {
    for (const row of Array.isArray(usagePayload) ? usagePayload : [usagePayload]) {
      const id = row?.provider;
      const u = row?.usage;
      if (!id || !u) continue;
      for (const [kind, slot] of Object.entries(SLOT_OF_KIND)) {
        if (u[slot]) this.durations.set(windowKey(id, kind), u[slot].windowMinutes ?? null);
      }
      for (const extra of u.extraRateWindows ?? []) {
        if (extra?.id) this.durations.set(windowKey(id, extra.id), extra.window?.windowMinutes ?? null);
      }
    }
    for (const { key } of UsageHistory.windowsOf(snapshot)) {
      if (!this.durations.has(key)) this.durations.set(key, null);
    }
    this.durationsAt = now;
    this.dirty = true;
  }

  /** Pace for every window in `snapshot`, keyed like windowKey(). */
  report(snapshot, now = Date.now()) {
    const out = {};
    for (const { key, resetAt } of UsageHistory.windowsOf(snapshot)) {
      const s = this.series.get(key);
      const pace = s && computePace({ samples: s.samples, resetAt, windowMinutes: this.durations.get(key), now });
      if (pace) out[key] = pace;
    }
    return out;
  }
}
