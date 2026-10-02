// CodexBar tailnet PWA — renders a dashboard-v1 snapshot in three layouts.
// Payload contract: docs/dashboard-api.md in steipete/CodexBar.

const REFRESH_MS = 60_000;
const VIEW_KEY = "codexbar.view";
const LAST_KEY = "codexbar.last";
const VERSION_KEY = "codexbar.version";
const COST_KEY = "codexbar.cost";
// Spend comes from a local log scan that moves slowly; the proxy caches it for 5 minutes.
const COST_REFRESH_MS = 5 * 60_000;
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
  notifyBtn: document.getElementById("notify"),
  notifyDot: document.getElementById("notify-dot"),
  notifyDialog: document.getElementById("notify-dialog"),
  notifyClose: document.getElementById("notify-close"),
  notifyToggle: document.getElementById("notify-toggle"),
  notifyTest: document.getElementById("notify-test"),
  notifyInfo: document.getElementById("notify-info"),
};

let snapshot = null;
let view = localStorage.getItem(VIEW_KEY) ?? "cards";
let ticking = null;
let loading = false;
let recheck = null;
let updating = false;
let shellStamp = null;
let cost = null;
let costLoading = false;
let costFetchedAt = 0;
let costError = null;
let costRecheck = null;
/** Spend view: provider id -> the YYYY-MM-DD day picked in its chart. */
const spendSel = new Map();

// Spin for the whole refresh cycle, not just the fetch: a warm proxy answers in
// ~2 ms, so tying the spinner to the request alone makes it an invisible flash.
const syncSpinner = () => el.refresh?.classList.toggle("spinning", loading || updating || costLoading);

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

/** Remaining credit balance as dashboard-v1 reports it (`{remaining, unit}`), or null. */
const credits = (p) => (typeof p.credits?.remaining === "number" ? p.credits : null);

const fmtNum = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

// Upstream reports provider errors as {code, message, kind}; older payloads used a bare string.
const errText = (e) => (e == null ? null : typeof e === "string" ? e : (e.message ?? null));

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pdot(p) {
  const c = p.display?.accentColor ?? "#8b8b96";
  return `<span class="pdot" style="background:${esc(c)}"></span>`;
}

function show(msg, isError) {
  el.status.textContent = msg;
  el.status.className = isError ? "status error" : "status";
  el.status.hidden = false;
}
function hide() { el.status.hidden = true; }

function readCached(key = LAST_KEY) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

/* ---------------- windows & countdowns ---------------- */

// Drop windows the user configured the upstream menu bar to hide.
const shown = (p) => (p.windows ?? []).filter((w) => !w.idle);

function countdown(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "now";
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${Math.max(1, m)}m`;
}

/** Flatten all shown windows across enabled providers for the Resets view. */
function allWindows(snap) {
  const rows = [];
  for (const p of snap?.providers ?? []) {
    if (!p.enabled) continue;
    for (const win of shown(p)) rows.push({ p, acc: null, win });
    for (const acc of p.accounts ?? []) {
      if (acc.active === false) continue;
      for (const win of shown(acc)) rows.push({ p, acc, win });
    }
  }
  return rows;
}

/* ---------------- view: cards ---------------- */

function renderCards(snap) {
  const providers = (snap?.providers ?? []).filter((p) => p.enabled);
  if (providers.length === 0) {
    return `<p class="empty">No providers enabled in CodexBar.</p>`;
  }
  return providers.map((p) => {
    const cred = credits(p);
    const wins = shown(p);
    return `
      <section class="card">
        <header class="card-head">
          ${pdot(p)}
          <span class="card-name">${esc(p.name)}</span>
          ${p.identity?.plan ? `<span class="badge">${esc(p.identity.plan)}</span>` : ""}
        </header>

        ${errText(p.error) ? `<div class="err">${esc(errText(p.error))}</div>` : ""}

        ${wins.map((w) => {
          const res = reserve(w);
          const sev = severity(w.usedPercent);
          const cd = countdown(w.resetAt);
          return `
            <div class="win">
              <div class="win-top">
                <span class="win-label">${esc(w.label ?? w.kind)}</span>
                <span class="mono">
                  <b class="t-${sev}">${res}%</b>
                  ${cd ? `<span class="win-sub">in ${esc(cd)}</span>` : ""}
                </span>
              </div>
              <div class="bar">
                <i class="fill-${sev}" style="width:${barWidth(w)}%"></i>
              </div>
            </div>
          `;
        }).join("")}

        ${(p.cost?.todayUSD != null || p.cost?.last30DaysUSD != null || cred != null) ? `
          <footer class="card-foot">
            ${p.cost?.todayUSD != null ? `<span>Today <b>$${p.cost.todayUSD.toFixed(2)}</b></span>` : ""}
            ${p.cost?.last30DaysUSD != null ? `<span>30d <b>$${p.cost.last30DaysUSD.toFixed(2)}</b></span>` : ""}
            ${cred ? `<span><b>${fmtNum(cred.remaining)}</b> ${esc(cred.unit ?? "credits")} left</span>` : ""}
          </footer>
        ` : ""}
      </section>
    `;
  }).join("");
}

/* ---------------- view: resets ---------------- */

function renderResets(snap) {
  const rows = allWindows(snap)
    .filter((r) => r.win.resetAt)
    .sort((a, b) => new Date(a.win.resetAt) - new Date(b.win.resetAt));

  if (rows.length === 0) {
    return `<p class="empty">No upcoming reset windows.</p>`;
  }

  return rows.map(({ p, acc, win }) => {
    const res = reserve(win);
    const sev = severity(win.usedPercent);
    const who = acc ? `${esc(p.name)} <span class="reset-sub">(${esc(acc.label ?? acc.id)})</span>` : esc(p.name);
    return `
      <section class="reset-row">
        <span class="reset-when mono">${esc(countdown(win.resetAt))}</span>
        <div class="reset-who">${pdot(p)} <span>${who}</span></div>
        <div class="reset-sub">${esc(win.label ?? win.kind)} \u00b7 <b class="t-${sev} mono">${res}%</b></div>
        <div class="bar reset-bar">
          <i class="fill-${sev}" style="width:${barWidth(win)}%"></i>
        </div>
      </section>
    `;
  }).join("");
}

/* ---------------- view: dense ---------------- */

function renderDense(snap) {
  const rows = allWindows(snap);
  if (rows.length === 0) return `<p class="empty">No active windows.</p>`;

  return `
    <section class="dense">
      ${rows.map(({ p, acc, win }) => {
        const res = reserve(win);
        const sev = severity(win.usedPercent);
        const cd = countdown(win.resetAt);
        const name = acc ? `${p.name} (${acc.label ?? acc.id})` : p.name;
        return `
          <div class="drow">
            ${pdot(p)}
            <span class="dname">${esc(name)} <span class="dwin">\u00b7 ${esc(win.label ?? win.kind)}</span></span>
            <span class="dpct mono t-${sev}">${res}<span class="dsuf">%</span></span>
            <span class="dreset mono">${cd ? esc(cd) : "\u2014"}</span>
          </div>
        `;
      }).join("")}
    </section>
  `;
}

/* ---------------- view: spend ---------------- */

// `serve /cost`, trimmed by the proxy: per provider, local-log spend by calendar day with
// its model split. Bars are days, so a provider is one series and its accent is identity.
const SPEND_DAYS = 30;
const MAX_MODELS = 5;

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function money(n) {
  if (n == null) return "\u2014";
  if (n > 0 && n < 0.005) return "<$0.01";
  return (n >= 1000 ? usdWhole : usd).format(n);
}

const sum = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);

// `/cost` buckets by the host's local calendar; the phone is assumed to share its zone.
const dayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function dayLabel(key, opts = { month: "short", day: "numeric" }) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, opts);
}

/** The last SPEND_DAYS local days, oldest first, keyed the way `/cost` keys them. */
function spendDays() {
  const now = new Date();
  return Array.from({ length: SPEND_DAYS }, (_, i) =>
    dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (SPEND_DAYS - 1 - i))));
}

/** Cost per model across `days`, biggest first, with the tail folded into "Other". */
function modelSplit(days) {
  const by = new Map();
  for (const d of days) {
    for (const m of d.modelBreakdowns ?? []) by.set(m.modelName, (by.get(m.modelName) ?? 0) + (m.cost ?? 0));
  }
  const rows = [...by].map(([name, c]) => ({ name, cost: c })).filter((r) => r.cost > 0).sort((a, b) => b.cost - a.cost);
  if (rows.length > MAX_MODELS) {
    const rest = rows.splice(MAX_MODELS - 1);
    rows.push({ name: "Other", cost: sum(rest.map((r) => r.cost)) });
  }
  return rows;
}

function spendCard(c, p, keys) {
  const color = p?.display?.accentColor ?? "#8b8b96";
  const byDay = new Map((c.daily ?? []).map((d) => [d.date, d]));
  const series = keys.map((key) => ({ key, day: byDay.get(key) ?? null, cost: byDay.get(key)?.totalCost ?? 0 }));
  const peak = series.reduce((a, b) => (b.cost > a.cost ? b : a), series[0]);
  const sel = series.find((s) => s.key === spendSel.get(c.provider)) ?? null;
  const total30 = c.last30DaysCostUSD ?? sum(series.map((s) => s.cost));
  const today = c.sessionCostUSD ?? series[series.length - 1].cost;
  const scopeDays = sel ? (sel.day ? [sel.day] : []) : series.map((s) => s.day).filter(Boolean);
  const scopeTotal = sel ? sel.cost : total30;
  const models = modelSplit(scopeDays);
  const incomplete = c.incompleteRequestCount ?? c.totals?.incompleteRequestCount;
  const periodTotal = c.totals?.totalCost;
  const otherPeriod = c.reportingPeriod && c.reportingPeriod !== "rolling:30" && periodTotal != null;

  const cols = series.map((s) => {
    const h = peak.cost > 0 && s.cost > 0 ? Math.max(3, (s.cost / peak.cost) * 100) : 0;
    const label = `${dayLabel(s.key)}: ${money(s.cost)}`;
    return `<button class="col${sel?.key === s.key ? " on" : ""}" data-spend="${esc(c.provider)}" data-day="${s.key}"
      aria-pressed="${sel?.key === s.key}" aria-label="${esc(label)}" title="${esc(label)}">${
        h ? `<i style="height:${h.toFixed(1)}%;background:${esc(color)}"></i>` : ""}</button>`;
  }).join("");

  return `
    <section class="card spend-card">
      <header class="card-head">
        ${pdot(p ?? {})}
        <span class="card-name">${esc(p?.name ?? c.provider)}</span>
        <span class="spend-total"><b>${esc(money(total30))}</b> 30d</span>
      </header>

      ${errText(c.error) ? `<div class="err">${esc(errText(c.error))}</div>` : ""}

      ${peak.cost > 0 ? `
        <div class="spend-chart">
          <div class="spend-peak">Peak <b>${esc(money(peak.cost))}</b> \u00b7 ${esc(dayLabel(peak.key))}</div>
          <div class="cols${sel ? " has-sel" : ""}" role="group" aria-label="Daily spend, last ${SPEND_DAYS} days">${cols}</div>
          <div class="spend-axis"><span>${esc(dayLabel(keys[0]))}</span><span>Today</span></div>
        </div>

        <div class="spend-detail">
          <div class="spend-detail-head">
            <span>${sel ? esc(dayLabel(sel.key, { weekday: "short", month: "short", day: "numeric" })) : `Last ${SPEND_DAYS} days`}</span>
            <b class="mono">${esc(money(scopeTotal))}</b>
          </div>
          ${models.map((m) => {
            const share = scopeTotal > 0 ? Math.round((m.cost / scopeTotal) * 100) : 0;
            return `
              <div class="model">
                <span class="model-name">${esc(m.name)}</span>
                <span class="mono">${esc(money(m.cost))}</span>
                <span class="model-share mono">${share}%</span>
                <div class="bar model-bar"><i style="width:${Math.min(share, 100)}%;background:${esc(color)}"></i></div>
              </div>
            `;
          }).join("")}
          ${sel && models.length === 0 ? `<div class="win-label">No spend recorded.</div>` : ""}
        </div>
      ` : ""}

      <footer class="card-foot">
        <span>Today <b>${esc(money(today))}</b></span>
        <span>Avg/day <b>${esc(money(total30 / SPEND_DAYS))}</b></span>
        ${otherPeriod ? `<span>${esc(c.historyLabel ?? c.reportingPeriod)} <b>${esc(money(periodTotal))}</b></span>` : ""}
        ${incomplete > 0 ? `<span class="tag" title="${incomplete} request(s) without final usage are excluded">Incomplete</span>` : ""}
      </footer>
    </section>
  `;
}

function renderSpend(snap, data) {
  if (!data) {
    return `<p class="empty">${costError ? `Can't load spend (${esc(costError)}).` : "Loading spend\u2026"}</p>`;
  }
  const meta = new Map((snap?.providers ?? []).map((p) => [p.id, p]));
  const rows = (data.providers ?? [])
    .filter((c) => errText(c.error) || (c.daily ?? []).some((d) => d.totalCost > 0))
    .sort((a, b) => (meta.get(a.provider)?.display?.sortKey ?? 999) - (meta.get(b.provider)?.display?.sortKey ?? 999));
  if (rows.length === 0) return `<p class="empty">No local spend recorded in the last ${SPEND_DAYS} days.</p>`;

  const keys = spendDays();
  const estimate = rows.some((c) => c.provenance === "listPriceEstimate");
  const stale = costError
    ? `<div class="status">Couldn't refresh spend (${esc(costError)}) \u2014 showing the last copy.</div>`
    : "";
  return `
    ${stale}
    <section class="spend-hero">
      <div>
        <div class="hero-label">Today</div>
        <div class="hero-value">${esc(money(sum(rows.map((c) => c.sessionCostUSD))))}</div>
      </div>
      <div class="hero-side">
        <div class="hero-label">Last ${SPEND_DAYS} days</div>
        <div class="hero-sub">${esc(money(sum(rows.map((c) => c.last30DaysCostUSD))))}</div>
      </div>
      ${estimate ? `<p class="hero-note">Estimated at API list prices from local logs \u2014 not what a subscription bills.</p>` : ""}
    </section>
    ${rows.map((c) => spendCard(c, meta.get(c.provider), keys)).join("")}
  `;
}

el.content.addEventListener("click", (e) => {
  const col = e.target.closest?.("[data-day]");
  if (!col) return;
  const { spend: id, day } = col.dataset;
  if (spendSel.get(id) === day) spendSel.delete(id);
  else spendSel.set(id, day);
  render();
  // Keyboard activation (detail 0): keep focus on the bar the markup was rebuilt under.
  if (e.detail === 0) el.content.querySelector(`[data-spend="${CSS.escape(id)}"][data-day="${CSS.escape(day)}"]`)?.focus();
});

/* ---------------- core rendering ---------------- */

function render() {
  if (view === "spend") el.content.innerHTML = renderSpend(snapshot, cost);
  else if (!snapshot) return;
  else if (view === "cards") el.content.innerHTML = renderCards(snapshot);
  else if (view === "resets") el.content.innerHTML = renderResets(snapshot);
  else if (view === "dense") el.content.innerHTML = renderDense(snapshot);

  const stamp = view === "spend" ? cost?.generatedAt : snapshot?.generatedAt;
  if (stamp) {
    const when = new Date(stamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    el.meta.textContent = `Updated ${when}`;
  }
}

async function load() {
  if (loading) return;
  loading = true;
  syncSpinner();
  el.content.setAttribute("aria-busy", "true");

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

async function loadCost() {
  if (costLoading) return;
  costLoading = true;
  syncSpinner();
  try {
    const res = await fetch("/api/cost", { cache: "no-store" });
    if (!res.ok) throw new Error(`cost ${res.status}`);
    cost = await res.json();
    costFetchedAt = Date.now();
    costError = null;
    localStorage.setItem(COST_KEY, JSON.stringify(cost));
    if (res.headers.get("X-Snapshot-Refreshing") === "true" && !costRecheck) {
      costRecheck = setTimeout(() => {
        costRecheck = null;
        loadCost();
      }, 4000);
    }
  } catch (err) {
    costError = err.message;
    cost ??= readCached(COST_KEY);
  } finally {
    costLoading = false;
    syncSpinner();
    if (view === "spend") render();
  }
}

/** Spend is only fetched while someone is looking at it, and at most every few minutes. */
function maybeLoadCost() {
  if (view === "spend" && Date.now() - costFetchedAt > COST_REFRESH_MS) loadCost();
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
  maybeLoadCost();
}

for (const b of document.querySelectorAll(".view-btn")) {
  b.addEventListener("click", () => setView(b.dataset.view));
}
el.refresh?.addEventListener("click", () => {
  load();
  if (view === "spend") loadCost();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  load();
  maybeLoadCost();
  loadVersion();
});

/* ---------------- push notifications ---------------- */

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

let pushSub = null;
let vapidPublicKey = boot?.vapidPublicKey ?? null;

// Asks the server every time: the key baked into __BOOT__ rides in the cached page shell,
// which the service worker only refreshes when app.js/styles.css change — not when the
// server regenerates its VAPID key. The boot copy is the offline fallback.
async function getVapidPublicKey() {
  try {
    const res = await fetch("/api/push/vapid-public-key", { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      if (data.publicKey) vapidPublicKey = data.publicKey;
    }
  } catch {}
  return vapidPublicKey;
}

// The browser can hold a subscription the server no longer knows about — pruned after
// the push service said it was gone, or the subscriptions file was lost — or one minted
// against a VAPID key the server has since regenerated. Either way the bell would show
// "active" while nothing ever arrives. Re-registering is idempotent and heals the first;
// a key mismatch needs a fresh subscription, which is silent once permission is granted.
let reconciledEndpoint = null;

async function reconcileSubscription(reg, sub) {
  if (reconciledEndpoint === sub.endpoint) return sub;
  const key = await getVapidPublicKey();
  if (!key) return sub;
  try {
    if (!subscribedWithKey(sub, key)) {
      if (Notification.permission !== "granted") return sub;
      await sub.unsubscribe().catch(() => {});
      sub = null; // if resubscribing fails, report no subscription rather than the dead one
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
    }
    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub),
    });
    if (res.ok) reconciledEndpoint = sub.endpoint;
  } catch {
    // Offline or the server is down; try again next launch.
  }
  return sub;
}

function subscribedWithKey(sub, serverKeyB64) {
  const held = sub.options?.applicationServerKey;
  if (!held) return true; // browser does not expose it; nothing to compare against
  const a = new Uint8Array(held);
  const b = urlBase64ToUint8Array(serverKeyB64);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function syncPushState() {
  if (!("serviceWorker" in navigator) || !("Notification" in window) || !("PushManager" in window)) {
    el.notifyBtn?.classList.add("disabled");
    if (el.notifyInfo) {
      el.notifyInfo.textContent = "Push notifications are not supported in this browser. (On iOS, add CodexBar to your Home Screen first).";
    }
    if (el.notifyToggle) {
      el.notifyToggle.disabled = true;
      el.notifyToggle.textContent = "Not Supported";
    }
    return;
  }

  try {
    const reg = await navigator.serviceWorker.ready;
    pushSub = await reg.pushManager.getSubscription();
    if (pushSub) pushSub = await reconcileSubscription(reg, pushSub);
  } catch {
    pushSub = null;
  }

  const isSubscribed = !!pushSub;
  if (el.notifyDot) el.notifyDot.hidden = !isSubscribed;
  el.notifyBtn?.classList.toggle("active", isSubscribed);

  if (!el.notifyInfo || !el.notifyToggle) return;

  if (Notification.permission === "denied") {
    el.notifyInfo.textContent = "Notifications are blocked. Please enable notifications in your browser or device settings.";
    el.notifyToggle.disabled = true;
    el.notifyToggle.textContent = "Notifications Blocked";
    el.notifyToggle.className = "btn btn-secondary";
    if (el.notifyTest) el.notifyTest.hidden = true;
  } else if (isSubscribed) {
    el.notifyInfo.innerHTML = "Push notifications are <b>active</b> on this device. You will be alerted whenever a rate limit window renews.";
    el.notifyToggle.disabled = false;
    el.notifyToggle.textContent = "Disable Notifications";
    el.notifyToggle.className = "btn btn-danger";
    if (el.notifyTest) el.notifyTest.hidden = false;
  } else {
    el.notifyInfo.textContent = "Push notifications are disabled on this device.";
    el.notifyToggle.disabled = false;
    el.notifyToggle.textContent = "Enable Notifications";
    el.notifyToggle.className = "btn btn-primary";
    if (el.notifyTest) el.notifyTest.hidden = true;
  }
}

async function togglePush() {
  if (pushSub) {
    el.notifyToggle.disabled = true;
    el.notifyToggle.textContent = "Disabling…";
    try {
      await fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: pushSub.endpoint }),
      });
      await pushSub.unsubscribe();
      pushSub = null;
    } catch (err) {
      alert(`Failed to unsubscribe: ${err.message}`);
    } finally {
      await syncPushState();
    }
  } else {
    el.notifyToggle.disabled = true;
    el.notifyToggle.textContent = "Enabling…";
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        await syncPushState();
        return;
      }
      const key = await getVapidPublicKey();
      if (!key) throw new Error("Could not retrieve VAPID public key from server");
      const reg = await navigator.serviceWorker.ready;
      pushSub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pushSub),
      });
    } catch (err) {
      alert(`Could not enable notifications: ${err.message}`);
    } finally {
      await syncPushState();
    }
  }
}

async function sendTestNotification() {
  if (!pushSub || !el.notifyTest) return;
  el.notifyTest.disabled = true;
  el.notifyTest.textContent = "Sending test…";
  try {
    const res = await fetch("/api/push/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: pushSub.endpoint, keys: pushSub.toJSON().keys }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    el.notifyTest.textContent = "Test sent!";
    setTimeout(() => {
      if (el.notifyTest) {
        el.notifyTest.textContent = "Send Test Notification";
        el.notifyTest.disabled = false;
      }
    }, 2500);
  } catch (err) {
    alert(`Test push failed: ${err.message}`);
    el.notifyTest.textContent = "Send Test Notification";
    el.notifyTest.disabled = false;
  }
}

el.notifyBtn?.addEventListener("click", () => {
  syncPushState();
  el.notifyDialog?.showModal();
});
el.notifyClose?.addEventListener("click", () => el.notifyDialog?.close());
el.notifyDialog?.addEventListener("click", (e) => {
  if (e.target === el.notifyDialog) el.notifyDialog.close();
});
el.notifyToggle?.addEventListener("click", togglePush);
el.notifyTest?.addEventListener("click", sendTestNotification);

/* ---------------- startup ---------------- */

/** Whichever of two snapshots was generated later; nulls lose. */
const newerOf = (a, b) => (generatedMs(a) >= generatedMs(b) ? a : b);
function generatedMs(s) {
  const t = s?.generatedAt ? new Date(s.generatedAt).getTime() : NaN;
  return Number.isNaN(t) ? -Infinity : t;
}

snapshot = newerOf(boot?.snapshot ?? null, readCached());
cost = readCached(COST_KEY);
if (snapshot) localStorage.setItem(LAST_KEY, JSON.stringify(snapshot));
renderAbout(knownVersion());
setView(view);

const bootIsCurrent = snapshot === boot?.snapshot
  && !boot.refreshing
  && Date.now() - generatedMs(snapshot) < BOOT_FRESH_MS;
if (!bootIsCurrent) load();

setTimeout(loadVersion, 2000);
setInterval(() => {
  load();
  maybeLoadCost();
}, REFRESH_MS);
ticking = setInterval(render, 30_000);

if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  const reloadOnce = () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  };
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) return;
    reloadOnce();
  });
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "shell-updated") reloadOnce();
  });
  navigator.serviceWorker.register("/sw.js")
    .then((reg) => {
      reg.update();
      syncPushState();
    })
    .catch(() => {});
}
