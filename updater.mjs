// Installs a CodexBar CLI release, or switches back to an older install, from the PWA.
//
// Same shape as the manual procedure in the workspace notes, plus what that procedure only
// learned the hard way: verify the checksum, refuse a binary with unresolved libraries
// (0.78.0's libxml2.so.2), run a *cold* cost scan before trusting it (0.78.0-musl segfaulted
// there and crash-looped serve for 11 hours), and put the previous binary back on its own
// when serve doesn't come up healthy. A successful update then prunes old installs down to the
// active one, the one it replaced, and the newest `keep` other glibc builds; musl builds count as
// nothing worth rolling back to. Failed or rolled-back jobs delete nothing but their own
// download and staging directories.

import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { parseVersion, compareVersions, parseSystemctlShow } from "./health.mjs";

export const TAG_RE = /^v\d+\.\d+\.\d+$/;
const MAX_DOWNLOAD_BYTES = 400 * 1024 * 1024;
// Release assets redirect from github.com to GitHub's object storage; nothing else may serve them.
const DOWNLOAD_HOSTS = /(^|\.)github\.com$|(^|\.)githubusercontent\.com$/;
const SMOKE_TIMEOUT_MS = 5 * 60_000;
// How long serve must stay up, without the unit restarting it, before an install counts.
const SETTLE_MS = 60_000;
const VERIFY_TIMEOUT_MS = 3 * 60_000;
const LOG_LINES = 60;

/**
 * Which installs a prune removes: everything except the active one, the one just replaced, and
 * the newest `keep` other glibc builds. `keep` 0 = prune nothing. Pure, for the tests.
 */
export function pruneCandidates(installs, { keep, previous }) {
  if (!(keep > 0)) return [];
  const spare = installs.filter((i) => !i.current && i.name !== previous && !i.musl);
  const kept = new Set(spare.slice(0, keep).map((i) => i.name)); // installs() is newest first
  return installs.filter((i) => !i.current && i.name !== previous && !kept.has(i.name)).map((i) => i.name);
}

export const linuxArch = (nodeArch = os.arch()) => ({ x64: "x86_64", arm64: "aarch64" })[nodeArch] ?? null;

/** The CLI tarball for a tag: glibc by default; `musl` is opt-in (see the workspace notes). */
export const assetName = (tag, arch, variant = "") =>
  `CodexBarCLI-${tag}-linux-${variant ? `${variant}-` : ""}${arch}.tar.gz`;

/** The hash out of a `.sha256` file: `<hex>  <name>`, or a bare hex digest. */
export function parseSha256File(text, name) {
  for (const line of String(text).split("\n")) {
    const m = line.trim().match(/^([0-9a-f]{64})(?:\s+\*?(.+))?$/i);
    if (m && (!m[2] || m[2].trim() === name)) return m[1].toLowerCase();
  }
  return null;
}

/**
 * Checks a `tar -tvzf` listing before anything is extracted: only plain files, directories and
 * relative symlinks, none of them escaping the extraction directory. Returns a reason, or null.
 */
export function unsafeTarEntry(listing) {
  for (const line of String(listing).split("\n")) {
    if (!line.trim()) continue;
    const type = line[0];
    const m = line.match(/^\S+\s+\S+\s+\d+\s+\S+\s+\S+\s+(.+)$/);
    if (!m) return `unreadable entry: ${line}`;
    let name = m[1];
    let target = null;
    if (type === "l") [name, target] = name.split(" -> ");
    else if (type !== "-" && type !== "d") return `unexpected entry type ${type}: ${name}`;
    const escapes = (p) => path.isAbsolute(p) || p.split("/").includes("..");
    if (escapes(name)) return `entry escapes the install dir: ${name}`;
    if (target != null && escapes(target)) return `symlink escapes the install dir: ${name} -> ${target}`;
  }
  return null;
}

/** Libraries `ldd` could not resolve: the 0.78.0 libxml2.so.2 failure, caught before install. */
export const missingLibraries = (lddOutput) =>
  String(lddOutput).split("\n").filter((l) => /not found/.test(l)).map((l) => l.trim().split(/\s+/)[0]);

function run(cmd, args, { timeout = 30_000, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, env: env ?? process.env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const why = err.killed ? `timed out after ${timeout / 1000}s` : err.signal ? `killed by ${err.signal}` : (stderr || err.message).trim();
        reject(Object.assign(new Error(`${path.basename(cmd)} ${args[0] ?? ""}: ${why}`.slice(0, 400)), { stdout, stderr, signal: err.signal }));
      } else resolve({ stdout, stderr });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");

export class Updater {
  /**
   * @param {object} o
   * @param {string} o.installRoot  e.g. ~/.local/opt/codexbar
   * @param {string} o.binLink      e.g. ~/.local/bin/CodexBarCLI, a symlink into installRoot
   * @param {string} o.serveUnit    systemd user unit running `codexbar serve`
   * @param {string} o.repo         owner/name
   * @param {string} [o.variant]    "" (glibc) or "musl"
   * @param {() => Promise<unknown>} o.verifyServe  one real snapshot fetch through serve
   * @param {(untilMs: number) => void} [o.quiet]   silence the down alert while serve restarts
   * @param {() => void} [o.onChange]               installed binary changed
   * @param {number} [o.keep]  older glibc installs to keep after an update, besides the replaced one; 0 = never prune
   * (`fetch`, `systemctl`, `settleMs`, `verifyTimeoutMs` and `pollMs` exist for the tests.)
   */
  constructor(o) {
    Object.assign(this, {
      variant: "", keep: 2, quiet: () => {}, onChange: () => {}, fetch: globalThis.fetch, systemctl: "systemctl",
      settleMs: SETTLE_MS, verifyTimeoutMs: VERIFY_TIMEOUT_MS, pollMs: 3000, ...o,
    });
    this.job = null;
    /** True while this updater is restarting serve and waiting for it: a dead port is expected then. */
    this.restarting = false;
  }

  /** Why this box can't be updated from here, or null when it can. */
  async unsupported() {
    if (!linuxArch()) return `unsupported architecture ${os.arch()}`;
    let target;
    try { target = await fs.readlink(this.binLink); } catch { return `${this.binLink} is not a symlink`; }
    const real = path.resolve(path.dirname(this.binLink), target);
    if (path.dirname(path.dirname(real)) !== path.resolve(this.installRoot)) {
      return `${this.binLink} points outside ${this.installRoot}`;
    }
    return null;
  }

  /** The install dir the symlink points at now. */
  async current() {
    const target = await fs.readlink(this.binLink);
    return path.dirname(path.resolve(path.dirname(this.binLink), target));
  }

  /** Every install under the root that has a CLI in it, newest version first. */
  async installs() {
    let cur = null;
    try { cur = await this.current(); } catch { /* not set up */ }
    let names = [];
    try { names = await fs.readdir(this.installRoot); } catch { return []; }
    const out = [];
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const dir = path.join(this.installRoot, name);
      try {
        const st = await fs.lstat(dir);
        if (!st.isDirectory()) continue; // e.g. an old `current` symlink
        await fs.access(path.join(dir, "CodexBarCLI"));
      } catch { continue; }
      const version = parseVersion(name)?.join(".") ?? null;
      out.push({ name, version, current: dir === cur, musl: /musl/.test(name) });
    }
    return out.sort((a, b) => compareVersions(b.version, a.version) || a.musl - b.musl || b.name.localeCompare(a.name));
  }

  status() {
    return this.job && { ...this.job, log: this.job.log.slice(-LOG_LINES) };
  }

  get busy() {
    return this.job?.state === "running";
  }

  /** Starts installing `tag`; resolves once the job is accepted, not when it finishes. */
  async startUpdate(tag) {
    if (!TAG_RE.test(tag ?? "")) throw new Error(`not a release tag: ${tag}`);
    return this.#start({ action: "update", target: tag }, (job) => this.#update(job, tag));
  }

  /** Starts switching the symlink to an existing install by its directory name. */
  async startRollback(name) {
    const install = (await this.installs()).find((i) => i.name === name);
    if (!install) throw new Error(`no such install: ${name}`);
    if (install.current) throw new Error(`${name} is already the active install`);
    return this.#start({ action: "rollback", target: name }, (job) =>
      this.#activate(job, path.join(this.installRoot, name), install.version));
  }

  async #start(fields, body) {
    if (this.busy) throw new Error(`a ${this.job.action} to ${this.job.target} is already running`);
    const why = await this.unsupported();
    if (why) throw new Error(why);
    const job = { ...fields, state: "running", from: path.basename(await this.current()), startedAt: new Date().toISOString(), finishedAt: null, error: null, log: [] };
    this.job = job;
    body(job)
      .then(() => { if (job.state === "running") job.state = "succeeded"; })
      .catch((err) => {
        job.error = err.message;
        if (job.state === "running") job.state = "failed";
        this.#log(job, `✗ ${err.message}`);
      })
      .finally(() => { job.finishedAt = new Date().toISOString(); });
    return this.status();
  }

  #log(job, msg) {
    job.log.push({ at: new Date().toISOString(), msg });
    console.log(`update: ${msg}`);
  }

  async #update(job, tag) {
    const version = parseVersion(tag).join(".");
    const asset = assetName(tag, linuxArch(), this.variant);
    const base = `https://github.com/${this.repo}/releases/download/${tag}`;
    const work = await fs.mkdtemp(path.join(this.installRoot, `.download-${tag}-`));
    let staging = null;
    try {
      this.#log(job, `downloading ${asset}`);
      const shaText = await this.#download(`${base}/${asset}.sha256`, null, 64 * 1024, job);
      const want = parseSha256File(shaText, asset);
      if (!want) throw new Error(`no digest for ${asset} in its .sha256`);
      const tarball = path.join(work, asset);
      const got = await this.#download(`${base}/${asset}`, tarball, MAX_DOWNLOAD_BYTES, job);
      if (got !== want) throw new Error(`sha256 mismatch: expected ${want}, got ${got}`);
      this.#log(job, `sha256 ok (${want.slice(0, 12)}…)`);

      const { stdout: listing } = await run("tar", ["-tvzf", tarball]);
      const bad = unsafeTarEntry(listing);
      if (bad) throw new Error(`refusing the tarball: ${bad}`);
      staging = await fs.mkdtemp(path.join(this.installRoot, `.staging-${version}-`));
      await run("tar", ["-xzf", tarball, "-C", staging, "--no-same-owner"], { timeout: 120_000 });
      await fs.access(path.join(staging, "CodexBarCLI"));

      await this.#smoke(job, staging, version);

      let dest = path.join(this.installRoot, this.variant ? `${version}-${this.variant}` : version);
      if (await fs.lstat(dest).then(() => true, () => false)) dest = `${dest}-${stamp()}`;
      await fs.rename(staging, dest);
      staging = null;
      this.#log(job, `installed to ${dest}`);
      await this.#activate(job, dest, version, { smoked: true });
      if (job.state === "running") await this.#prune(job);
    } finally {
      await fs.rm(work, { recursive: true, force: true });
      if (staging) await fs.rm(staging, { recursive: true, force: true });
    }
  }

  /** Streams a URL to `file` (returning its sha256) or, without one, returns the body as text. */
  async #download(url, file, maxBytes, job) {
    const res = await this.fetch(url, { headers: { "User-Agent": "codexbar-tailnet" }, redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
    const host = new URL(res.url || url).hostname;
    if (!DOWNLOAD_HOSTS.test(host)) throw new Error(`download redirected to unexpected host ${host}`);
    if (!res.ok) throw new Error(`GET ${path.basename(url)}: HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length"));
    if (declared > maxBytes) throw new Error(`${path.basename(url)} is ${declared} bytes, over the ${maxBytes} limit`);
    if (!file) {
      const text = await res.text();
      if (text.length > maxBytes) throw new Error(`${path.basename(url)} is too large`);
      return text;
    }
    const hash = createHash("sha256");
    let seen = 0;
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        seen += chunk.length;
        if (seen > maxBytes) return cb(new Error(`${path.basename(url)} exceeds ${maxBytes} bytes`));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), meter, createWriteStream(file, { mode: 0o600 }));
    this.#log(job, `downloaded ${(seen / 1024 / 1024).toFixed(1)} MiB`);
    return hash.digest("hex");
  }

  /** Would this binary work as serve? Libraries, version, and a cold cost scan of every provider. */
  async #smoke(job, dir, version) {
    const bin = path.join(dir, "CodexBarCLI");
    const ldd = await run("ldd", [bin]).catch((err) => err); // "not a dynamic executable" exits 1
    const missing = missingLibraries(`${ldd.stdout ?? ""}${ldd.stderr ?? ""}`);
    if (missing.length) throw new Error(`missing shared libraries: ${missing.join(", ")}`);
    this.#log(job, "libraries ok");

    const { stdout } = await run(bin, ["--version"], { timeout: 20_000 });
    if (version && parseVersion(stdout)?.join(".") !== version) {
      throw new Error(`binary reports "${stdout.trim()}", expected ${version}`);
    }

    // Cold on purpose: an empty cache forces the full log scan, which is the path that crashed.
    const cache = await fs.mkdtemp(path.join(os.tmpdir(), "codexbar-smoke-"));
    try {
      this.#log(job, "smoke test: cold cost scan (takes ~30\u00a0s)…");
      const t0 = Date.now();
      const { stdout: out } = await run(bin, ["cost", "--days", "90", "--format", "json"], {
        timeout: SMOKE_TIMEOUT_MS,
        env: { ...process.env, XDG_CACHE_HOME: cache },
      });
      try { JSON.parse(out); } catch { throw new Error(`smoke test: cost scan printed something other than JSON: ${out.slice(0, 80)}`); }
      this.#log(job, `smoke test ok (${Math.round((Date.now() - t0) / 1000)} s)`);
    } finally {
      await fs.rm(cache, { recursive: true, force: true });
    }
  }

  /** Points the symlink at `dir`, restarts serve, and undoes both if serve doesn't settle. */
  async #activate(job, dir, version, { smoked = false } = {}) {
    if (!smoked) await this.#smoke(job, dir, version);
    const previous = await this.current();
    await this.#point(dir);
    this.onChange();
    this.#log(job, `switched ${path.basename(previous)} → ${path.basename(dir)}; restarting serve`);
    try {
      await this.#restartAndVerify(job);
      this.#log(job, `✓ serve healthy on ${path.basename(dir)}`);
    } catch (err) {
      this.#log(job, `serve not healthy (${err.message}); rolling back to ${path.basename(previous)}`);
      await this.#point(previous);
      this.onChange();
      try {
        await this.#restartAndVerify(job, { settleMs: Math.min(this.settleMs, 15_000) });
        this.#log(job, `rolled back to ${path.basename(previous)}`);
      } catch (again) {
        this.#log(job, `serve is still unhealthy after rolling back: ${again.message}`);
      }
      job.state = "rolled-back";
      job.error = err.message;
    }
  }

  /** Only after a good update, and only dirs `installs()` vouched for (real dirs with a CLI in them). */
  async #prune(job) {
    const removed = [];
    for (const name of pruneCandidates(await this.installs(), { keep: this.keep, previous: job.from })) {
      const dir = path.join(this.installRoot, name);
      if (path.dirname(dir) !== path.resolve(this.installRoot)) continue;
      try {
        await fs.rm(dir, { recursive: true, force: true });
        removed.push(name);
      } catch (err) {
        this.#log(job, `couldn't remove ${name}: ${err.message}`);
      }
    }
    if (removed.length) this.#log(job, `removed old installs: ${removed.join(", ")}`);
  }

  /** Atomic: a new link renamed over the old one, so the CLI is never missing. */
  async #point(dir) {
    const tmp = `${this.binLink}.tmp-${process.pid}-${Date.now()}`;
    await fs.symlink(path.join(dir, "CodexBarCLI"), tmp);
    await fs.rename(tmp, this.binLink);
  }

  async #unit() {
    const { stdout } = await run(this.systemctl, [
      "--user", "show", this.serveUnit, "--timestamp=unix",
      "-p", "LoadState,ActiveState,SubState,Result,NRestarts,MainPID,ActiveEnterTimestamp",
    ], { timeout: 5000 });
    return parseSystemctlShow(stdout);
  }

  async #restartAndVerify(job, opts) {
    this.restarting = true;
    try {
      await this.#restartAndSettle(job, opts);
    } finally {
      this.restarting = false;
    }
  }

  async #restartAndSettle(job, { settleMs = this.settleMs } = {}) {
    this.quiet(Date.now() + this.verifyTimeoutMs + settleMs);
    await run(this.systemctl, ["--user", "restart", this.serveUnit], { timeout: 60_000 });
    const start = Date.now();
    const baseline = (await this.#unit()).restarts;
    let fetched = false;
    let lastError = null;
    while (Date.now() - start < this.verifyTimeoutMs) {
      // Only the unit's verdict is fatal. A fetch can fail just because serve isn't listening
      // yet; a crash shows up here as the restart counter moving.
      const unit = await this.#unit();
      if (unit.restarts !== baseline) throw new Error(`serve crashed and was restarted by systemd (${unit.result})`);
      if (unit.activeState === "failed" || unit.activeState === "inactive") throw new Error(`serve unit is ${unit.activeState} (${unit.result})`);
      if (unit.activeState === "active" && !fetched) {
        try {
          await this.verifyServe();
          fetched = true;
          this.#log(job, "serve answered a snapshot");
        } catch (err) {
          lastError = err.message;
        }
      }
      if (fetched && Date.now() - start >= settleMs) return;
      await sleep(this.pollMs);
    }
    throw new Error(`serve didn't settle within ${this.verifyTimeoutMs / 1000}s${lastError ? ` (${lastError})` : ""}`);
  }
}
