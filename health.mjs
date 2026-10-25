// Upstream health: whether `codexbar serve` is answering, and how hard to retry it when not.
//
// Before this, a failed background refresh was swallowed: the proxy kept answering with its
// old cache marked `refreshing`, every 4 s client re-poll started another doomed fetch, and
// the phone spun for 11 hours over a serve that segfaulted on each request (2026-10-21).

// First retry after this long, doubling per consecutive failure, up to the cap. Every
// attempt against a crash-looping serve is a cold start of every provider (Claude's OAuth
// endpoint rate-limits after a few dozen), so the cap is generous.
export const RETRY_BASE_MS = 10_000;
export const RETRY_MAX_MS = 5 * 60_000;

export const retryDelay = (failures) =>
  failures <= 0 ? 0 : Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (failures - 1));

export class UpstreamHealth {
  constructor() {
    this.lastOkAt = null;
    this.lastErrorAt = null;
    this.lastError = null;
    this.failures = 0;
    /** When the current outage began: the first failure after the last success. */
    this.downSince = null;
  }

  /** Records a success; returns how long the outage it ends lasted, or null if none. */
  ok(at = Date.now()) {
    const outage = this.downSince != null ? at - this.downSince : null;
    this.lastOkAt = at;
    this.failures = 0;
    this.downSince = null;
    return outage;
  }

  /** Records a failure; returns true when it starts a new outage. */
  fail(err, at = Date.now()) {
    this.lastErrorAt = at;
    this.lastError = String(err?.message ?? err).slice(0, 200);
    this.failures += 1;
    if (this.downSince != null) return false;
    this.downSince = at;
    return true;
  }

  get down() {
    return this.failures > 0;
  }

  /** Milliseconds until the next attempt is due; 0 when it may go now. */
  retryIn(now = Date.now()) {
    if (!this.down) return 0;
    return Math.max(0, this.lastErrorAt + retryDelay(this.failures) - now);
  }

  toJSON() {
    const iso = (t) => (t == null ? null : new Date(t).toISOString());
    return {
      ok: !this.down,
      lastOkAt: iso(this.lastOkAt),
      lastErrorAt: iso(this.lastErrorAt),
      lastError: this.lastError,
      failures: this.failures,
      downSince: iso(this.downSince),
      retryInSeconds: Math.ceil(this.retryIn() / 1000),
    };
  }
}

/* ---------------- serve unit & releases ---------------- */

/** `v0.79.0`, `0.79.0-musl`, `CodexBar 0.79.0` → [0, 79, 0]; null when there is no version. */
export function parseVersion(s) {
  const m = String(s ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1, 4).map(Number) : null;
}

/** Negative, zero or positive as `a` is older than, the same as, or newer than `b`. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** `systemctl show -p … --timestamp=unix` output as an object; timestamps become epoch ms. */
export function parseSystemctlShow(text) {
  const props = {};
  for (const line of String(text).split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) props[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  const ts = (v) => (/^@\d+$/.test(v ?? "") ? Number(v.slice(1)) * 1000 : null);
  return {
    loadState: props.LoadState ?? null,
    activeState: props.ActiveState ?? null,
    subState: props.SubState ?? null,
    result: props.Result ?? null,
    restarts: props.NRestarts != null ? Number(props.NRestarts) : null,
    mainPid: Number(props.MainPID) || null,
    activeSince: ts(props.ActiveEnterTimestamp),
  };
}

// A crash loop shows as the unit's restart counter climbing while it still reads "active"
// most of the time, so the counter is the signal; the state alone misses it.
export const LOOP_WINDOW_MS = 10 * 60_000;
export const LOOP_RESTARTS = 3;

/**
 * Turns periodic samples of serve's unit and of the proxy's own fetches into a health level
 * and the two edges worth a push: down (degraded for `alertAfterMs`) and recovered.
 */
export class ServeMonitor {
  constructor({ alertAfterMs = 10 * 60_000, notify = true } = {}) {
    this.alertAfterMs = alertAfterMs;
    this.notify = notify;
    /** [at, restarts] pairs within the loop window. */
    this.restartSamples = [];
    this.degradedSince = null;
    this.alerted = false;
    this.level = "ok";
    this.reason = null;
    /** Until when the monitor treats restarts as deliberate (an update is restarting serve). */
    this.quietUntil = 0;
  }

  /** Restarts and outages before `until` are expected; don't alert on them. */
  quiet(until) {
    this.quietUntil = Math.max(this.quietUntil, until);
  }

  /**
   * @param {{at: number, unit: ReturnType<typeof parseSystemctlShow> | null, upstream: UpstreamHealth}} s
   * @returns {{level: "ok"|"warn"|"down", reason: string|null, event: "down"|"recovered"|null}}
   */
  sample({ at, unit, upstream }) {
    if (unit?.restarts != null) {
      this.restartSamples.push([at, unit.restarts]);
      this.restartSamples = this.restartSamples.filter(([t]) => at - t <= LOOP_WINDOW_MS);
    }
    const { reason } = this.#reason(at, unit, upstream);
    let event = null;
    if (reason) {
      this.degradedSince ??= upstream.downSince ?? at;
      const long = at - this.degradedSince >= this.alertAfterMs;
      this.level = long ? "down" : "warn";
      if (long && !this.alerted && at >= this.quietUntil) {
        this.alerted = true;
        if (this.notify) event = "down";
      }
    } else {
      if (this.alerted && this.notify) event = "recovered";
      this.alerted = false;
      this.degradedSince = null;
      this.level = "ok";
    }
    this.reason = reason;
    return { level: this.level, reason, event };
  }

  /**
   * Health as of now, for display, without touching the alert state. The last `sample()` can
   * be a minute old: one taken mid-restart would otherwise still say "isn't answering" after
   * serve is back.
   * @returns {{level: "ok"|"warn"|"down", reason: string|null, since: number|null}}
   */
  view({ at, unit, upstream }) {
    const { reason, port } = this.#reason(at, unit, upstream);
    if (!reason) return { level: "ok", reason: null, since: null };
    // A dead port has its own start; `degradedSince` may belong to an outage that has ended
    // since the last sample.
    const since = (port ? upstream.downSince : this.degradedSince) ?? at;
    return { level: at - since >= this.alertAfterMs ? "down" : "warn", reason, since };
  }

  /** What's wrong, if anything; `port` when it's only that serve doesn't answer. */
  #reason(at, unit, upstream) {
    const oldest = this.restartSamples.find(([t]) => at - t <= LOOP_WINDOW_MS);
    const recentRestarts = oldest && unit?.restarts != null ? unit.restarts - oldest[1] : 0;
    // Restarts first: between crashes the unit reads "activating (auto-restart)", which on its
    // own is just a unit starting up.
    if (recentRestarts >= LOOP_RESTARTS) {
      return { reason: `serve is crash-looping: ${recentRestarts} restarts in ${Math.round(LOOP_WINDOW_MS / 60_000)} min` };
    }
    if (unit?.activeState === "inactive" || unit?.activeState === "failed") {
      return { reason: `serve unit is ${unit.activeState}${unit.result && unit.result !== "success" ? ` (${unit.result})` : ""}` };
    }
    if (upstream.down) return { reason: `serve isn't answering (${upstream.lastError})`, port: true };
    return { reason: null };
  }
}

/**
 * Whether a release is worth one push: newer than what runs here, not announced before, and
 * installable — GitHub publishes the release before its binaries finish uploading, and an
 * "update" that 404s is worse than one an hour later.
 */
export function shouldAnnounceRelease({ latest, installed, announced, asset }) {
  if (!latest?.tag || !installed) return false;
  if (compareVersions(latest.tag, installed) <= 0) return false;
  if (announced && compareVersions(latest.tag, announced) <= 0) return false;
  return isInstallable(latest, asset);
}

/** Whether `latest` has this box's CLI tarball attached yet; true when there is none to look for. */
export const isInstallable = (latest, asset) => !asset || (latest?.assets ?? []).includes(asset);
