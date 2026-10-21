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
