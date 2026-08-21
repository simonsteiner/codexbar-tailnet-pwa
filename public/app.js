// CodexBar tailnet PWA — renders a dashboard-v1 snapshot in three layouts.
// Payload contract: docs/dashboard-api.md in steipete/CodexBar.

const REFRESH_MS = 60_000;
const VIEW_KEY = "codexbar.view";
const LAST_KEY = "codexbar.last";
const VERSION_KEY = "codexbar.version";
// How fresh the snapshot the server embedded in the page must be for the launch to skip
// its opening fetch. Below this the proxy has demonstrably just checked upstream.
const BOOT_FRESH_MS = 10_000;

// The server inlines its warm snapshot and version into the document, so a launch has
// real data before it has made a single request. Absent when the page came from the
// service worker's cache under an older build, hence the guards everywhere below.
const boot = globalThis.__BOOT__ ?? null;

const el = {
  content: document.getElementById("content"),
  status: document.getElementById("status"),
  meta: document.getElementById("meta"),
  about: document.getElementById("about"),
  refresh: document.getElementById("refresh"),
};

let snapshot = null;
let view = localStorage.getItem(VIEW_KEY) ?? "cards";
let ticking = null;
let loading = false;
let recheck = null;
let updating = false;
let shellStamp = null;

// Spin for the whole refresh cycle, not just the fetch: a warm proxy answers in
// ~2 ms, so tying the spinner to the request alone makes it an invisible flash.
const syncSpinner = () => el.refresh.classList.toggle("spinning", loading || updating);

// The proxy answers stale hits instantly and refreshes in the background
// (X-Snapshot-Refreshing). Re-poll on a short fuse until the fresh data lands.
function scheduleRecheck() {
  if (recheck) return;
  recheck = setTimeout(() => {
    recheck = null;
    load();
  }, 4000);
}

/* ---------------- helpers ---------------- */

const severity = (pct) => (pct >= 90 ? "crit" : pct >= 75 ? "warn" : "ok");

// The reserve: headroom left in a window, which is the number you plan around. dashboard-v1
// reports it directly; deriving it from usedPercent is only the fallback, since a provider
// that meters remaining separately needn't have the two add up to 100.
const reserve = (w) => Math.max(0, Math.round(w.remainingPercent ?? 100 - w.usedPercent));

// Bars drain rather than fill: the filled part is the reserve, so a full bar means a full tank.
// Matches the Android client's gauge; the severity color still keys off how much is *used*.
const barWidth = (w) => Math.min(reserve(w), 100);

/** Remaining credit balance for a provider, or null if it doesn't report one. */
function creditsLeft(p) {
  if (p.credits?.remaining == null) return null;
  const n = Number(p.credits.remaining);
  return {
    value: Number.isFinite(n) ? n.toLocaleString() : String(p.credits.remaining),
    unit: p.credits.unit ?? "credits",
  };
}

function countdown(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  if (ms <= 0) return "now";
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${mm}m`;
  return `${mm}m`;
}

function money(v) {
  if (v == null) return null;
  return v >= 100 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`;
}

// dashboard-v1 redacts the local part but keeps the domain; show only the domain.
function plan(p) {
  const bits = [];
  if (p.identity?.plan) bits.push(p.identity.plan);
  if (p.identity?.accountEmail) {
    const at = p.identity.accountEmail.split("@")[1];
    if (at) bits.push(at);
  }
  return bits.join(" · ");
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Every window across every provider, flattened, newest-resetting first. */
function allWindows(snap) {
  const out = [];
  for (const p of snap.providers ?? []) {
    for (const w of p.windows ?? []) {
      if (w.usedPercent == null) continue;
      out.push({ provider: p, win: w });
    }
  }
  return out.sort((a, b) => {
    const ta = a.win.resetAt ? new Date(a.win.resetAt).getTime() : Infinity;
    const tb = b.win.resetAt ? new Date(b.win.resetAt).getTime() : Infinity;
    return ta - tb;
  });
}

/* ---------------- views ---------------- */

function renderCards(snap) {
  const providers = snap.providers ?? [];
  if (!providers.length) return `<p class="empty">No providers enabled.</p>`;

  return providers.map((p) => {
    const accent = p.display?.accentColor ?? "#6e5aff";
    const wins = (p.windows ?? []).filter((w) => w.usedPercent != null);

    const winHtml = wins.map((w) => {
      const pct = Math.round(w.usedPercent);
      const sev = severity(pct);
      const cd = countdown(w.resetAt);
      return `
        <div class="win">
          <div class="win-top">
            <span class="win-label">${esc(w.label ?? w.kind ?? "Window")}</span>
            <span class="mono">
              <b class="t-${sev}">${reserve(w)}% left</b>
              <span class="win-sub">${pct}% used${cd ? ` · ${cd}` : ""}</span>
            </span>
          </div>
          <div class="bar"><i class="fill-${sev}" style="width:${barWidth(w)}%"></i></div>
        </div>`;
    }).join("");

    const foot = [];
    const credits = creditsLeft(p);
    if (credits) {
      foot.push(`<span><b>${esc(credits.value)}</b> ${esc(credits.unit)} left</span>`);
    }
    if (p.cost?.todayUSD != null) foot.push(`<span>today <b>${money(p.cost.todayUSD)}</b></span>`);
    if (p.cost?.last30DaysUSD != null) foot.push(`<span>30d <b>${money(p.cost.last30DaysUSD)}</b></span>`);

    const badge = plan(p);
    return `
      <section class="card">
        <div class="card-head">
          <span class="pdot" style="background:${esc(accent)}"></span>
          <span class="card-name">${esc(p.name ?? p.id)}</span>
          ${badge ? `<span class="badge">${esc(badge)}</span>` : ""}
        </div>
        ${winHtml || (p.error ? "" : `<div class="win-label">No usage window reported.</div>`)}
        ${p.error ? `<div class="err">${esc(p.error.message ?? "failed")}</div>` : ""}
        ${foot.length ? `<div class="card-foot">${foot.join("")}</div>` : ""}
      </section>`;
  }).join("");
}

function renderResets(snap) {
  const rows = allWindows(snap).filter((r) => r.win.resetAt);
  if (!rows.length) return `<p class="empty">No reset windows reported.</p>`;

  // Credits are per provider, not per window; show them once, on its soonest-resetting row.
  const creditsShown = new Set();

  return rows.map(({ provider, win }) => {
    const pct = Math.round(win.usedPercent);
    const sev = severity(pct);
    const accent = provider.display?.accentColor ?? "#6e5aff";
    const when = new Date(win.resetAt);
    const local = when.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });

    const key = provider.id ?? provider.name;
    let credits = null;
    if (!creditsShown.has(key)) {
      credits = creditsLeft(provider);
      if (credits) creditsShown.add(key);
    }

    return `
      <section class="reset-row">
        <div class="reset-who">
          <span class="pdot" style="background:${esc(accent)}"></span>
          ${esc(provider.name ?? provider.id)}
          <span class="reset-sub">· ${esc(win.label ?? win.kind ?? "")}</span>
        </div>
        <div class="reset-when mono t-${sev}">${countdown(win.resetAt) ?? "—"}</div>
        <div class="reset-sub mono"><b class="t-${sev}">${reserve(win)}% left</b> · ${pct}% used</div>
        <div class="reset-sub reset-foot mono">resets ${esc(local)}${
          credits ? ` · ${esc(credits.value)} ${esc(credits.unit)} left` : ""}</div>
        <div class="bar reset-bar"><i class="fill-${sev}" style="width:${barWidth(win)}%"></i></div>
      </section>`;
  }).join("");
}

function renderDense(snap) {
  const rows = allWindows(snap);
  const failed = (snap.providers ?? []).filter((p) => p.error && !(p.windows ?? []).length);
  const credited = (snap.providers ?? [])
    .map((p) => ({ p, credits: creditsLeft(p) }))
    .filter((x) => x.credits);
  if (!rows.length && !failed.length && !credited.length) return `<p class="empty">Nothing to show.</p>`;

  const body = rows.map(({ provider, win }) => {
    const pct = Math.round(win.usedPercent);
    const sev = severity(pct);
    const accent = provider.display?.accentColor ?? "#6e5aff";
    return `
      <div class="drow">
        <span class="pdot" style="background:${esc(accent)}"></span>
        <span class="dname">${esc(provider.name ?? provider.id)}
          <span class="dwin">${esc(win.label ?? win.kind ?? "")} · ${pct}% used</span></span>
        <span class="dpct mono t-${sev}">${reserve(win)}%<span class="dsuf">left</span></span>
        <span class="dreset mono">${countdown(win.resetAt) ?? "—"}</span>
      </div>`;
  }).join("");

  // Credit balances don't belong to any one window, so they get their own rows.
  const creds = credited.map(({ p, credits }) => `
      <div class="drow">
        <span class="pdot" style="background:${esc(p.display?.accentColor ?? "#6e5aff")}"></span>
        <span class="dname">${esc(p.name ?? p.id)}
          <span class="dwin">${esc(credits.unit)}</span></span>
        <span class="dpct mono">${esc(credits.value)}<span class="dsuf">left</span></span>
        <span class="dreset mono"></span>
      </div>`).join("");

  const errs = failed.map((p) => `
      <div class="drow">
        <span class="pdot" style="background:${esc(p.display?.accentColor ?? "#6e5aff")}"></span>
        <span class="dname">${esc(p.name ?? p.id)}</span>
        <span class="dpct t-crit" style="grid-column: 3 / -1; text-align:right; font-size:12px;">failed</span>
      </div>`).join("");

  return `<div class="dense">${body}${creds}${errs}</div>`;
}

/* ---------------- shell ---------------- */

function render() {
  if (!snapshot) return;
  const fn = view === "resets" ? renderResets : view === "dense" ? renderDense : renderCards;
  el.content.innerHTML = fn(snapshot);

  const gen = snapshot.generatedAt ? new Date(snapshot.generatedAt) : null;
  const staleAfter = (snapshot.staleAfterSeconds ?? 180) * 1000;
  const age = gen ? Date.now() - gen.getTime() : 0;
  el.meta.textContent = gen
    ? `updated ${gen.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` +
      (snapshot.host?.codexBarVersion ? ` · CodexBar ${snapshot.host.codexBarVersion}` : "") +
      (updating ? " · updating…" : "")
    : updating ? "updating…" : "";

  if (gen && age > staleAfter) {
    show(`Snapshot is ${Math.round(age / 60000)}m old — is the WSL box awake?`, false);
  }
}

function show(msg, isError) {
  el.status.hidden = false;
  el.status.textContent = msg;
  el.status.classList.toggle("error", !!isError);
}
const hide = () => { el.status.hidden = true; };

/** Last snapshot we rendered, or null if there isn't one or it didn't survive. */
function readCached() {
  const raw = localStorage.getItem(LAST_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    localStorage.removeItem(LAST_KEY);
    return null;
  }
}

async function load() {
  if (loading) return;
  loading = true;
  syncSpinner();
  el.content.setAttribute("aria-busy", "true");
  // Cold start with nothing cached: say so rather than showing an empty page.
  if (!snapshot) el.content.innerHTML = `<p class="empty">Loading…</p>`;
  try {
    const res = await fetch("/api/snapshot", { cache: "no-store" });
    if (!res.ok) throw new Error(`snapshot ${res.status}`);
    snapshot = await res.json();
    localStorage.setItem(LAST_KEY, JSON.stringify(snapshot));
    updating = res.headers.get("X-Snapshot-Refreshing") === "true";
    if (updating) scheduleRecheck();
    if (res.headers.get("X-Snapshot-Stale") === "true") {
      show("Showing last good data — the latest refresh failed.", false);
    } else hide();
    render();
  } catch (err) {
    // Offline or the box is down: fall back to whatever we last saw.
    updating = false;
    if (!snapshot) {
      snapshot = readCached();
      if (snapshot) render();
      else el.content.innerHTML = `<p class="empty">No snapshot yet.</p>`;
    }
    show(`Can't reach CodexBar (${err.message}). Is Tailscale connected?`, true);
  } finally {
    loading = false;
    syncSpinner();
    el.content.setAttribute("aria-busy", "false");
  }
}

/** Footer credit: repo link plus the commit this build was served from. */
function renderAbout(v) {
  if (!v?.repo) return;
  const name = v.repo.split("/").pop();
  const repoLink = `<a href="${esc(v.repo)}" target="_blank" rel="noopener noreferrer">${esc(name)}</a>`;
  const commitUrl = `${esc(v.repo)}/commit/${esc(v.commit)}`;
  const hashLink = v.short
    ? ` · <a class="mono" href="${commitUrl}" target="_blank" rel="noopener noreferrer">${esc(v.short)}</a>`
    : "";
  el.about.innerHTML = repoLink + hashLink;
}

/** The build label for the footer: this page's own, or the last one we stored. */
function knownVersion() {
  if (boot?.version?.repo) return boot.version;
  try { return JSON.parse(localStorage.getItem(VERSION_KEY)); } catch { return null; }
}

async function loadVersion() {
  try {
    const res = await fetch("/api/version", { cache: "no-store" });
    if (!res.ok) return;
    const v = await res.json();
    // The server fingerprints the shell assets. A change while we're running means
    // this page is executing old JS — reload once to pick the new build up. Only
    // live-fetched stamps count; comparing against localStorage could loop.
    if (v.stamp) {
      if (shellStamp && v.stamp !== shellStamp) {
        location.reload();
        return;
      }
      shellStamp = v.stamp;
    }
    localStorage.setItem(VERSION_KEY, JSON.stringify(v));
    renderAbout(v);
  } catch { /* offline — whatever we cached stands */ }
}

function setView(next) {
  view = next;
  localStorage.setItem(VIEW_KEY, next);
  for (const b of document.querySelectorAll(".view-btn")) {
    b.setAttribute("aria-selected", String(b.dataset.view === next));
  }
  render();
}

for (const b of document.querySelectorAll(".view-btn")) {
  b.addEventListener("click", () => setView(b.dataset.view));
}
el.refresh.addEventListener("click", () => load());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  load();
  loadVersion(); // a resumed PWA may be running a stale shell — check and self-reload
});

/** Whichever of two snapshots was generated later; nulls lose. */
const newerOf = (a, b) => (generatedMs(a) >= generatedMs(b) ? a : b);
function generatedMs(s) {
  const t = s?.generatedAt ? new Date(s.generatedAt).getTime() : NaN;
  return Number.isNaN(t) ? -Infinity : t;
}

// Paint before the network is even asked, so a launch is never blank. Two candidates:
// what the server embedded in this page, and what we last stored. The page usually wins,
// but a service worker can serve a cached document older than our own last refresh.
snapshot = newerOf(boot?.snapshot ?? null, readCached());
if (snapshot) localStorage.setItem(LAST_KEY, JSON.stringify(snapshot));
renderAbout(knownVersion());
setView(view);

// Skip the opening fetch when the embedded snapshot is fresh and settled — the proxy
// checked upstream moments ago, and the interval below takes it from here.
const bootIsCurrent = snapshot === boot?.snapshot
  && !boot.refreshing
  && Date.now() - generatedMs(snapshot) < BOOT_FRESH_MS;
if (!bootIsCurrent) load();

// Deferred: the shell fingerprint only matters once the page has settled, and at boot
// this would compete with the snapshot fetch for a narrow link.
setTimeout(loadVersion, 2000);
setInterval(load, REFRESH_MS);
// Countdowns are derived from resetAt, so re-render locally without refetching.
ticking = setInterval(() => { if (snapshot) render(); }, 30_000);

if ("serviceWorker" in navigator) {
  // A phone keeps the installed shell until a new SW claims it. Check for one on every
  // launch, and reload once when it takes over so the page isn't left on the old assets.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  const reloadOnce = () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  };
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) return; // first-ever claim: nothing to replace
    reloadOnce();
  });
  // The shell is served from cache and revalidated behind us, so this page can be a
  // build behind the moment it paints. The worker says so once the new one is stored;
  // reloading then is guaranteed to pick it up rather than re-serving what we have.
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "shell-updated") reloadOnce();
  });
  navigator.serviceWorker.register("/sw.js").then((reg) => reg.update()).catch(() => {});
}
