// CodexBar tailnet PWA — renders a dashboard-v1 snapshot in three layouts.
// Payload contract: docs/dashboard-api.md in steipete/CodexBar.

const REFRESH_MS = 60_000;
const VIEW_KEY = "codexbar.view";

const el = {
  content: document.getElementById("content"),
  status: document.getElementById("status"),
  meta: document.getElementById("meta"),
  refresh: document.getElementById("refresh"),
};

let snapshot = null;
let view = localStorage.getItem(VIEW_KEY) ?? "cards";
let ticking = null;

/* ---------------- helpers ---------------- */

const severity = (pct) => (pct >= 90 ? "crit" : pct >= 75 ? "warn" : "ok");

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
            <span class="mono t-${sev}">${pct}%${cd ? ` · ${cd}` : ""}</span>
          </div>
          <div class="bar"><i class="fill-${sev}" style="width:${Math.min(pct, 100)}%"></i></div>
        </div>`;
    }).join("");

    const foot = [];
    if (p.credits?.remaining != null) {
      foot.push(`<span><b>${p.credits.remaining}</b> ${esc(p.credits.unit ?? "credits")}</span>`);
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

  return rows.map(({ provider, win }) => {
    const pct = Math.round(win.usedPercent);
    const sev = severity(pct);
    const accent = provider.display?.accentColor ?? "#6e5aff";
    const when = new Date(win.resetAt);
    const local = when.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
    return `
      <section class="reset-row">
        <div class="reset-who">
          <span class="pdot" style="background:${esc(accent)}"></span>
          ${esc(provider.name ?? provider.id)}
          <span class="reset-sub">· ${esc(win.label ?? win.kind ?? "")}</span>
        </div>
        <div class="reset-when mono t-${sev}">${countdown(win.resetAt) ?? "—"}</div>
        <div class="reset-sub mono">${pct}% used · resets ${esc(local)}</div>
        <div class="bar reset-bar"><i class="fill-${sev}" style="width:${Math.min(pct, 100)}%"></i></div>
      </section>`;
  }).join("");
}

function renderDense(snap) {
  const rows = allWindows(snap);
  const failed = (snap.providers ?? []).filter((p) => p.error && !(p.windows ?? []).length);
  if (!rows.length && !failed.length) return `<p class="empty">Nothing to show.</p>`;

  const body = rows.map(({ provider, win }) => {
    const pct = Math.round(win.usedPercent);
    const sev = severity(pct);
    const accent = provider.display?.accentColor ?? "#6e5aff";
    return `
      <div class="drow">
        <span class="pdot" style="background:${esc(accent)}"></span>
        <span class="dname">${esc(provider.name ?? provider.id)}
          <span class="dwin">${esc(win.label ?? win.kind ?? "")}</span></span>
        <span class="dpct mono t-${sev}">${pct}%</span>
        <span class="dreset mono">${countdown(win.resetAt) ?? "—"}</span>
      </div>`;
  }).join("");

  const errs = failed.map((p) => `
      <div class="drow">
        <span class="pdot" style="background:${esc(p.display?.accentColor ?? "#6e5aff")}"></span>
        <span class="dname">${esc(p.name ?? p.id)}</span>
        <span class="dpct t-crit" style="grid-column: 3 / -1; text-align:right; font-size:12px;">failed</span>
      </div>`).join("");

  return `<div class="dense">${body}${errs}</div>`;
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
      (snapshot.host?.codexBarVersion ? ` · CodexBar ${snapshot.host.codexBarVersion}` : "")
    : "";

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

async function load({ manual = false } = {}) {
  if (manual) el.refresh.classList.add("spinning");
  try {
    const res = await fetch("/api/snapshot", { cache: "no-store" });
    if (!res.ok) throw new Error(`snapshot ${res.status}`);
    snapshot = await res.json();
    localStorage.setItem("codexbar.last", JSON.stringify(snapshot));
    if (res.headers.get("X-Snapshot-Stale") === "true") {
      show("Showing last good data — the latest refresh failed.", false);
    } else hide();
    render();
  } catch (err) {
    // Offline or the box is down: fall back to whatever we last saw.
    const cached = localStorage.getItem("codexbar.last");
    if (cached && !snapshot) { snapshot = JSON.parse(cached); render(); }
    show(`Can't reach CodexBar (${err.message}). Is Tailscale connected?`, true);
  } finally {
    el.refresh.classList.remove("spinning");
  }
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
el.refresh.addEventListener("click", () => load({ manual: true }));
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });

setView(view);
load();
setInterval(load, REFRESH_MS);
// Countdowns are derived from resetAt, so re-render locally without refetching.
ticking = setInterval(() => { if (snapshot) render(); }, 30_000);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
