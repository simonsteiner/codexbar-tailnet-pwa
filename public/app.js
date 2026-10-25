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
  healthBtn: document.getElementById("health"),
  healthDot: document.getElementById("health-dot"),
  updatePill: document.getElementById("update-pill"),
  healthDialog: document.getElementById("health-dialog"),
  healthClose: document.getElementById("health-close"),
  healthInfo: document.getElementById("health-info"),
  healthActions: document.getElementById("health-actions"),
};

let snapshot = null;
let view = localStorage.getItem(VIEW_KEY) ?? "cards";
let ticking = null;
let loading = false;
let recheck = null;
let updating = false;
// The build this page was served as. It must come from the page itself: adopting whatever the
// first /api/version says instead meant a page that booted from an old cached shell, and only
// asked after the server had moved on, took the new stamp as its own and never reloaded.
let shellStamp = boot?.version?.stamp ?? null;
let cost = null;
/** Whether the last snapshot response said serve is down; a change re-asks `/api/status`. */
let outageShown = boot?.upstream ? !boot.upstream.ok : false;
/** Per-window pace from the proxy's usage history (`/api/pace`), keyed `provider::kind`. */
let pace = boot?.pace ?? null;
let costLoading = false;
let costFetchedAt = 0;
let costError = null;
let costRecheck = null;
/** Spend view: provider id -> the column (its first YYYY-MM-DD day) picked in its chart. */
const spendSel = new Map();

// Spin for the whole refresh cycle, not just the fetch: a warm proxy answers in
// ~2 ms, so tying the spinner to the request alone makes it an invisible flash.
const syncSpinner = () => el.refresh?.classList.toggle("spinning", loading || updating || costLoading);

// The proxy answers stale hits instantly and refreshes in the background
// (X-Snapshot-Refreshing). Re-poll on a short fuse until the fresh data lands — but while
// serve is down, only when the proxy says its next attempt is due (X-Upstream-Retry-In).
function scheduleRecheck(delayMs = 4000) {
  if (recheck) return;
  recheck = setTimeout(() => {
    recheck = null;
    load();
  }, Math.min(Math.max(delayMs, 4000), 120_000));
}

const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** The banner for a proxy that has data but can't refresh it: says what, since when, and how old. */
function outageText({ downSince, error, ageSeconds, retryIn }) {
  const since = downSince ? ` since ${clock(downSince)}` : "";
  const why = error ? ` (${error})` : "";
  const age = ageSeconds > 0 ? ` Showing data from ${span(ageSeconds * 1000)} ago.` : "";
  const next = retryIn > 0 ? ` Retrying in ${retryIn < 60 ? `${retryIn}s` : span(retryIn * 1000)}.` : " Retrying…";
  return `CodexBar serve isn't answering${since}${why}.${age}${next}`;
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

/** A duration as "2d 4h", "3h 20m" or "5m". */
function span(ms) {
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${Math.max(1, m)}m`;
}

function countdown(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return ms <= 0 ? "now" : span(ms);
}

/* ---------------- staleness ---------------- */

// A row older than the snapshot's own staleness hint is old data, not slow data: a hung
// provider probe under `serve` can freeze every row behind perfectly plausible numbers.
function staleAge(iso) {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return null;
  const age = Date.now() - t;
  return age > (snapshot?.staleAfterSeconds ?? 180) * 1000 ? age : null;
}

function staleTag(p) {
  const age = staleAge(p.updatedAt);
  if (!age) return "";
  const at = new Date(p.updatedAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return `<span class="tag" title="Last updated ${esc(at)}">${esc(span(age))} old</span>`;
}

/** The same warning inline, for the rows of Resets; `compact` is a bare mark for Dense. */
function staleNote(p, compact = false) {
  const age = staleAge(p.updatedAt);
  if (!age) return "";
  const text = `${span(age)} old`;
  return compact
    ? ` <span class="t-warn" title="${esc(text)}" aria-label="${esc(text)}">\u26a0</span>`
    : ` \u00b7 <span class="t-warn">${esc(text)}</span>`;
}

/* ---------------- pace ---------------- */

const paceOf = (p, w) => pace?.windows?.[`${p.id}::${w.kind}`] ?? null;

/** Time until the projected run-out, measured from now rather than from the last sample. */
function etaLeft(pc) {
  const last = pc.samples?.[pc.samples.length - 1]?.[0] ?? Date.now();
  return pc.etaSeconds * 1000 - (Date.now() - last);
}

/** "Runs out in 1h 20m" when the recent burn empties the window before it resets, else null. */
function runOut(pc) {
  if (pc?.willLastToReset !== false) return null;
  const left = pc.etaSeconds > 0 ? etaLeft(pc) : 0;
  return left > 0 ? `Runs out in ${span(left)}` : "Used up";
}

/** Under a window's bar: how usage compares with even use, then where the recent burn leads. */
function paceLine(pc) {
  // An untouched window is trivially in reserve; saying so on every idle lane is noise.
  if (!(pc?.usedPercent > 0)) return "";
  const parts = [];
  if (pc.stage === "onPace") parts.push("On pace");
  else if (pc.stage) parts.push(`${Math.abs(pc.deltaPercent)}% in ${pc.stage}`);
  const out = runOut(pc);
  if (pc.willLastToReset === true && pc.usedPercent > 0) parts.push("lasts to reset");
  if (!parts.length && !out) return "";
  const why = [
    pc.expectedUsedPercent != null ? `Expected ${pc.expectedUsedPercent}% used by now` : null,
    pc.ratePerHour != null ? `burning ${pc.ratePerHour}%/h over the last ${span(pc.lookbackMinutes * 60_000)}` : null,
  ].filter(Boolean).join(" \u00b7 ");
  return `<div class="pace" title="${esc(why)}">${esc(parts.join(" \u00b7 "))}${
    out ? `${parts.length ? " \u00b7 " : ""}<span class="t-warn">\u26a0 ${esc(out)}</span>` : ""}</div>`;
}

/**
 * Burndown sparkline: recorded reserve over the cycle, against the even-use line from full at
 * the window's start to empty at its reset. Like upstream's chart, it stops at the last
 * reading rather than being drawn on to now. Omitted until usage has actually moved.
 */
function sparkline(pc, sev) {
  const pts = pc?.samples ?? [];
  if (pts.length < 2) return "";
  const used = pts.map((s) => s[1]);
  if (Math.max(...used) - Math.min(...used) < 1) return "";
  const x0 = pc.startAt ? Date.parse(pc.startAt) : pts[0][0];
  const x1 = Date.parse(pc.resetAt);
  if (!(x1 > x0)) return "";
  const x = (t) => Math.min(100, Math.max(0, ((t - x0) / (x1 - x0)) * 100)).toFixed(2);
  const line = pts.map(([t, u]) => `${x(t)},${(u * 0.24).toFixed(2)}`).join(" ");
  // The wash under the line is the reserve itself, so the chart drains like the bars do.
  const area = `${x(pts[0][0])},24 ${line} ${x(pts[pts.length - 1][0])},24`;
  return `
    <svg class="spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
      <polygon class="spark-area t-${sev}" points="${area}"/>
      ${pc.startAt ? `<line class="spark-guide" x1="0" y1="0" x2="100" y2="24" vector-effect="non-scaling-stroke"/>` : ""}
      <polyline class="spark-line stroke-${sev}" points="${line}" vector-effect="non-scaling-stroke"/>
    </svg>
  `;
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
          ${staleTag(p)}
          ${p.identity?.plan ? `<span class="badge">${esc(p.identity.plan)}</span>` : ""}
        </header>

        ${errText(p.error) ? `<div class="err">${esc(errText(p.error))}</div>` : ""}

        ${wins.map((w) => {
          const res = reserve(w);
          const sev = severity(w.usedPercent);
          const cd = countdown(w.resetAt);
          const pc = paceOf(p, w);
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
              ${sparkline(pc, sev)}
              ${paceLine(pc)}
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
    const out = acc ? null : runOut(paceOf(p, win));
    return `
      <section class="reset-row">
        <span class="reset-when mono">${esc(countdown(win.resetAt))}</span>
        <div class="reset-who">${pdot(p)} <span>${who}</span></div>
        <div class="reset-sub">${esc(win.label ?? win.kind)} \u00b7 <b class="t-${sev} mono">${res}%</b>${
          out ? ` \u00b7 <span class="t-warn">\u26a0 ${esc(out)}</span>` : ""}${staleNote(p)}</div>
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
            <span class="dname">${esc(name)}${staleNote(p, true)} <span class="dwin">\u00b7 ${esc(win.label ?? win.kind)}</span></span>
            <span class="dpct mono t-${sev}">${res}<span class="dsuf">%</span></span>
            <span class="dreset mono">${cd ? esc(cd) : "\u2014"}</span>
          </div>
        `;
      }).join("")}
    </section>
  `;
}

/* ---------------- view: spend ---------------- */

// `codexbar cost --days 90`, trimmed by the proxy: per provider, local-log spend by calendar
// day with its model split. Each range is sliced out of that one payload on the phone. Bars
// are days (weeks for 90 days, where daily columns would be under 2 px wide on a phone), so a
// provider is one series and its accent is identity.
const RANGE_KEY = "codexbar.spendRange";
const SPEND_RANGES = {
  today: { label: "Today", short: "today", days: 1, bucket: 1 },
  "7d": { label: "7 days", short: "7d", days: 7, bucket: 1 },
  "30d": { label: "30 days", short: "30d", days: 30, bucket: 1 },
  "90d": { label: "90 days", short: "90d", days: 90, bucket: 7 },
};
const MAX_MODELS = 5;

let spendRange = SPEND_RANGES[localStorage.getItem(RANGE_KEY)] ? localStorage.getItem(RANGE_KEY) : "30d";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function money(n) {
  if (n == null) return "—";
  if (n > 0 && n < 0.005) return "<$0.01";
  return (n >= 1000 ? usdWhole : usd).format(n);
}

const sum = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);

// The cost report buckets by the host's local calendar; the phone is assumed to share its zone.
const dayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function dayLabel(key, opts = { month: "short", day: "numeric" }) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, opts);
}

/** The last `n` local days, oldest first, keyed the way the cost report keys them. */
function lastDays(n) {
  const now = new Date();
  return Array.from({ length: n }, (_, i) =>
    dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (n - 1 - i))));
}

/** The range's columns, oldest first. Weekly buckets count back from today, so only the oldest can be short. */
function spendBuckets(range) {
  const days = lastDays(range.days);
  const groups = [];
  for (let end = days.length; end > 0; end -= range.bucket) groups.unshift(days.slice(Math.max(0, end - range.bucket), end));
  return groups.map((ds) => ({ key: ds[0], days: ds }));
}

function bucketLabel(b, opts) {
  return b.days.length === 1 ? dayLabel(b.key, opts) : `${dayLabel(b.days[0])} – ${dayLabel(b.days[b.days.length - 1])}`;
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

/** One provider's spend over the range: its columns, and the day entries behind them. */
function spendSeries(c, buckets) {
  const byDay = new Map((c.daily ?? []).map((d) => [d.date, d]));
  const series = buckets.map((b) => {
    const entries = b.days.map((k) => byDay.get(k)).filter(Boolean);
    return { ...b, entries, cost: sum(entries.map((d) => d.totalCost)) };
  });
  return { series, total: sum(series.map((s) => s.cost)) };
}

function spendCard(c, p, range, buckets) {
  const color = p?.display?.accentColor ?? "#8b8b96";
  const { series, total } = spendSeries(c, buckets);
  const peak = series.reduce((a, b) => (b.cost > a.cost ? b : a), series[0]);
  const sel = series.find((s) => s.key === spendSel.get(c.provider)) ?? null;
  const scope = sel ?? { entries: series.flatMap((s) => s.entries), cost: total };
  const models = modelSplit(scope.entries);
  const today = (c.daily ?? []).find((d) => d.date === dayKey(new Date()))?.totalCost ?? 0;
  const incomplete = sum(series.flatMap((s) => s.entries.map((d) => d.incompleteRequestCount)));
  const unit = range.bucket === 1 ? "Daily" : "Weekly";
  const showChart = range.days > 1 && peak.cost > 0;

  const cols = series.map((s) => {
    const h = peak.cost > 0 && s.cost > 0 ? Math.max(3, (s.cost / peak.cost) * 100) : 0;
    const label = `${bucketLabel(s)}: ${money(s.cost)}`;
    return `<button class="col${sel?.key === s.key ? " on" : ""}" data-spend="${esc(c.provider)}" data-day="${s.key}"
      aria-pressed="${sel?.key === s.key}" aria-label="${esc(label)}" title="${esc(label)}">${
        h ? `<i style="height:${h.toFixed(1)}%;background:${esc(color)}"></i>` : ""}</button>`;
  }).join("");

  return `
    <section class="card spend-card">
      <header class="card-head">
        ${pdot(p ?? {})}
        <span class="card-name">${esc(p?.name ?? c.provider)}</span>
        <span class="spend-total"><b>${esc(money(total))}</b> ${esc(range.short)}</span>
      </header>

      ${errText(c.error) ? `<div class="err">${esc(errText(c.error))}</div>` : ""}

      ${showChart ? `
        <div class="spend-chart">
          <div class="spend-peak">Peak ${range.bucket > 1 ? "week " : ""}<b>${esc(money(peak.cost))}</b> · ${esc(bucketLabel(peak))}</div>
          <div class="cols${sel ? " has-sel" : ""}" role="group" aria-label="${unit} spend, last ${esc(range.label)}">${cols}</div>
          <div class="spend-axis"><span>${esc(dayLabel(buckets[0].key))}</span><span>Today</span></div>
        </div>
      ` : ""}

      ${total > 0 ? `
        <div class="spend-detail">
          <div class="spend-detail-head">
            <span>${sel ? esc(bucketLabel(sel, { weekday: "short", month: "short", day: "numeric" }))
              : range.days === 1 ? "Today" : `Last ${esc(range.label)}`}</span>
            <b class="mono">${esc(money(scope.cost))}</b>
          </div>
          ${models.map((m) => {
            const share = scope.cost > 0 ? Math.round((m.cost / scope.cost) * 100) : 0;
            return `
              <div class="model">
                <span class="model-name">${esc(m.name)}</span>
                <span class="mono">${esc(money(m.cost))}</span>
                <span class="model-share mono">${share}%</span>
                <div class="bar model-bar"><i style="width:${Math.min(share, 100)}%;background:${esc(color)}"></i></div>
              </div>
            `;
          }).join("")}
          ${sel && models.length === 0 ? `<div class="spend-none">No spend recorded.</div>` : ""}
        </div>
      ` : ""}

      ${range.days > 1 || incomplete > 0 ? `
        <footer class="card-foot">
          ${range.days > 1 ? `<span>Today <b>${esc(money(today))}</b></span>` : ""}
          ${range.days > 1 ? `<span>Avg/day <b>${esc(money(total / range.days))}</b></span>` : ""}
          ${incomplete > 0 ? `<span class="tag" title="${incomplete} request(s) without final usage are excluded">Incomplete</span>` : ""}
        </footer>
      ` : ""}
    </section>
  `;
}

function rangePicker() {
  return `
    <nav class="seg" role="tablist" aria-label="Spend range">
      ${Object.entries(SPEND_RANGES).map(([id, r]) =>
        `<button class="seg-btn" role="tab" data-range="${id}" aria-selected="${id === spendRange}">${esc(r.label)}</button>`).join("")}
    </nav>
  `;
}

function renderSpend(snap, data) {
  if (!data) {
    return `${rangePicker()}<p class="empty">${costError ? `Can't load spend (${esc(costError)}).` : "Loading spend…"}</p>`;
  }
  const range = SPEND_RANGES[spendRange];
  const buckets = spendBuckets(range);
  const meta = new Map((snap?.providers ?? []).map((p) => [p.id, p]));
  const rows = (data.providers ?? [])
    .map((c) => ({ c, total: spendSeries(c, buckets).total }))
    .filter(({ c, total }) => errText(c.error) || total > 0)
    .sort((a, b) => (meta.get(a.c.provider)?.display?.sortKey ?? 999) - (meta.get(b.c.provider)?.display?.sortKey ?? 999));
  const stale = costError
    ? `<div class="status">Couldn't refresh spend (${esc(costError)}) — showing the last copy.</div>`
    : "";
  if (rows.length === 0) {
    const when = range.days === 1 ? "today" : `in the last ${range.label}`;
    return `${rangePicker()}${stale}<p class="empty">No local spend recorded ${esc(when)}.</p>`;
  }

  const total = sum(rows.map((r) => r.total));
  // Today has no average to speak of; yesterday is the comparison that means something.
  const yesterday = sum(rows.map(({ c }) => spendSeries(c, [{ key: "y", days: lastDays(2).slice(0, 1) }]).total));
  const estimate = rows.some(({ c }) => c.provenance === "listPriceEstimate");
  return `
    ${rangePicker()}
    ${stale}
    <section class="spend-hero">
      <div>
        <div class="hero-label">${range.days === 1 ? "Today" : `Last ${esc(range.label)}`}</div>
        <div class="hero-value">${esc(money(total))}</div>
      </div>
      <div class="hero-side">
        <div class="hero-label">${range.days === 1 ? "Yesterday" : "Avg/day"}</div>
        <div class="hero-sub">${esc(money(range.days === 1 ? yesterday : total / range.days))}</div>
      </div>
      ${estimate ? `<p class="hero-note">Estimated at API list prices from local logs — not what a subscription bills.</p>` : ""}
    </section>
    ${rows.map(({ c }) => spendCard(c, meta.get(c.provider), range, buckets)).join("")}
  `;
}

el.content.addEventListener("click", (e) => {
  const pick = e.target.closest?.("[data-range]");
  if (pick) {
    spendRange = pick.dataset.range;
    localStorage.setItem(RANGE_KEY, spendRange);
    spendSel.clear(); // a picked day or week belongs to the range it was picked in
    render();
    return;
  }
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
    const age = view === "spend" ? null : staleAge(stamp);
    el.meta.textContent = age ? `Updated ${when} \u00b7 ${span(age)} ago` : `Updated ${when}`;
    el.meta.classList.toggle("t-warn", !!age);
  }
}

async function load({ retry = false } = {}) {
  if (loading) return;
  loading = true;
  syncSpinner();
  el.content.setAttribute("aria-busy", "true");

  // Pace is derived from the same proxy-side snapshot, so ask for both at once and render once.
  const paceReq = fetch("/api/pace", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  try {
    const res = await fetch(retry ? "/api/snapshot?retry=1" : "/api/snapshot", { cache: "no-store" });
    const h = (name) => res.headers.get(name);
    const outage = h("X-Snapshot-Stale") === "true" ? {
      downSince: h("X-Upstream-Down-Since"),
      error: h("X-Snapshot-Error"),
      ageSeconds: Number(h("X-Snapshot-Age")) || 0,
      retryIn: Number(h("X-Upstream-Retry-In")) || 0,
    } : null;
    if (res.status === 502 && outage) {
      // The proxy is up but has never had a snapshot to fall back on.
      const err = new Error(outageText(outage));
      err.outage = outage;
      throw err;
    }
    if (!res.ok) throw new Error(`snapshot ${res.status}`);
    snapshot = await res.json();
    pace = (await paceReq) ?? pace;
    localStorage.setItem(LAST_KEY, JSON.stringify(snapshot));
    updating = h("X-Snapshot-Refreshing") === "true";
    if (updating) scheduleRecheck();
    else if (outage) scheduleRecheck(outage.retryIn * 1000 + 1000);
    if (outage) show(outageText(outage), true);
    else hide();
    noteOutage(!!outage);
    render();
  } catch (err) {
    // Offline or the box is down: fall back to whatever we last saw.
    updating = false;
    if (!snapshot) {
      snapshot = readCached();
      if (snapshot) render();
      else el.content.innerHTML = `<p class="empty">No snapshot yet.</p>`;
    }
    if (err.outage) {
      noteOutage(true);
      show(err.message, true);
      scheduleRecheck(err.outage.retryIn * 1000 + 1000);
    } else show(`Can't reach CodexBar (${err.message}). Is Tailscale connected?`, true);
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
        // Not out from under an open dialog (an update job's log, a half-made choice); the
        // next check reloads once it is closed.
        if (document.querySelector("dialog[open]")) return;
        location.reload();
        return;
      }
      shellStamp = v.stamp;
    }
    localStorage.setItem(VERSION_KEY, JSON.stringify(v));
    renderAbout(v);
  } catch { /* offline — whatever we cached stands */ }
}

/* ---------------- service status ---------------- */

/** `/api/status`: serve's unit, the proxy's view of it, and whether a newer CodexBar is out. */
let status = boot?.status ?? null;

const extLink = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`;

function healthRows(s) {
  if (!s) return `<dt>Health</dt><dd>Unknown — the proxy hasn't answered yet.</dd>`;
  const rows = [];
  const h = s.health;
  rows.push(["Health", h.level === "ok"
    ? (h.reason ? esc(h.reason) : `<span class="t-ok">All good</span>`)
    : `<span class="${h.level === "down" ? "t-crit" : "t-warn"}">${esc(h.reason)}</span>${h.since ? ` · since ${esc(clock(h.since))}` : ""}`]);

  const u = s.serve;
  if (u?.error) rows.push(["Serve", `<span class="t-warn">${esc(u.error)}</span>`]);
  else if (u) {
    const state = u.activeState === "active"
      ? `running${u.uptimeSeconds != null ? ` · up ${span(u.uptimeSeconds * 1000)}` : ""}`
      : `${u.activeState}${u.subState ? ` (${u.subState})` : ""}`;
    rows.push(["Serve", `${esc(state)} · ${u.restarts} restart${u.restarts === 1 ? "" : "s"}`]);
  }

  const snap = s.snapshot ? `fetched ${clock(s.snapshot.at)} (${span(s.snapshot.ageSeconds * 1000)} ago)` : "none yet";
  const lastTry = s.upstream?.expected
    ? `<br><span class="t-muted">waiting for serve to come back</span>`
    : s.upstream && !s.upstream.ok
      ? `<br><span class="t-warn">last try ${esc(clock(s.upstream.lastErrorAt))}: ${esc(s.upstream.lastError)}</span>`
      : "";
  rows.push(["Snapshot", esc(snap) + lastTry]);

  const c = s.codexbar;
  let cb = c.version ? esc(c.version) : `<span class="t-warn">${esc(c.error ?? "unknown")}</span>`;
  if (c.latest?.tag) {
    cb += c.updateAvailable
      ? ` · <span class="t-warn">${extLink(c.latest.url, `${c.latest.tag} available`)}</span>`
      : ` · up to date`;
  }
  if (c.latest?.error) cb += `<br><span class="t-warn">release check failed: ${esc(c.latest.error)}</span>`;
  rows.push(["CodexBar", cb]);
  rows.push(["Proxy", `up ${esc(span(s.proxy.uptimeSeconds * 1000))}`]);
  return rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
}

const JOB_STATE = {
  running: ["t-warn", "Working…"],
  succeeded: ["t-ok", "Done"],
  failed: ["t-crit", "Failed — nothing was changed"],
  "rolled-back": ["t-crit", "Rolled back — serve wasn't healthy on the new version"],
};

/** Update / switch-version controls, for whoever the proxy says may use them. */
function healthActions(s) {
  const admin = s?.admin;
  const latest = s?.codexbar?.latest;
  if (!admin?.allowed) {
    // Say why only when there is something to do; otherwise the dialog stays quiet.
    return s?.codexbar?.updateAvailable && admin?.reason ? `<p class="note">${esc(admin.reason)}.</p>` : "";
  }
  if (admin.reason) return `<p class="note">Can't update from here: ${esc(admin.reason)}.</p>`;
  const job = admin.job;
  const busy = job?.state === "running";
  const parts = [];
  if (job) {
    const [cls, label] = JOB_STATE[job.state] ?? ["", job.state];
    const what = job.action === "update" ? `Install ${job.target}` : `Switch to ${job.target}`;
    parts.push(`<div class="job-state"><span class="${cls}">${esc(label)}</span> · ${esc(what)}</div>`);
    const lines = job.log.map((l) => `${clock(l.at)}  ${l.msg}`).join("\n");
    parts.push(`<pre class="job-log">${esc(lines)}</pre>`);
  }
  if (!busy && s.codexbar.updateAvailable && latest?.tag) {
    parts.push(`<button class="btn btn-primary" data-action="update" data-tag="${esc(latest.tag)}">Update to ${esc(latest.tag)}</button>`);
  }
  const others = (admin.installs ?? []).filter((i) => !i.current);
  if (!busy && others.length) {
    // Preselect the newest glibc build: switching back is usually "the one before", and musl
    // builds are the ones known to crash serve (the smoke test would refuse them anyway).
    const pick = (others.find((i) => !i.musl) ?? others[0]).name;
    const opts = others.map((i) =>
      `<option value="${esc(i.name)}"${i.name === pick ? " selected" : ""}>${esc(i.name)}${i.musl ? " (musl)" : ""}</option>`).join("");
    parts.push(`<details><summary>Switch to an installed version</summary>
      <div class="switch"><select id="rollback-to" aria-label="Installed version">${opts}</select>
      <button class="btn btn-secondary" data-action="rollback">Switch</button></div></details>`);
  }
  return parts.join("");
}

let jobPoll = null;

function renderHealth() {
  const level = status?.health?.level ?? "ok";
  el.healthDot?.classList.toggle("warn", level === "warn");
  el.healthDot?.classList.toggle("down", level === "down");
  if (el.healthBtn) el.healthBtn.title = status?.health?.reason ?? "Service status";
  if (el.updatePill) el.updatePill.hidden = !status?.codexbar?.updateAvailable;
  if (el.healthDialog?.open) {
    el.healthInfo.innerHTML = healthRows(status);
    // Re-rendering the controls would close an open <details> and reset the <select> under the
    // user's finger every poll, so they are only replaced when they actually changed.
    const html = healthActions(status);
    if (el.healthActions.dataset.html !== html) {
      el.healthActions.innerHTML = html;
      el.healthActions.dataset.html = html;
      el.healthActions.querySelector(".job-log")?.scrollTo(0, 1e6);
    }
  }
  // Follow a running job closely while someone is watching it.
  const running = status?.admin?.job?.state === "running";
  if (running && el.healthDialog?.open && !jobPoll) {
    jobPoll = setTimeout(() => { jobPoll = null; loadStatus(); }, 2000);
  }
}

async function adminPost(route, body) {
  try {
    const res = await fetch(route, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CodexBar-Admin": "1" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  } catch (err) {
    alert(err.message);
  }
  await loadStatus();
}

el.healthActions?.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  if (btn.dataset.action === "update") {
    const tag = btn.dataset.tag;
    if (!confirm(`Install CodexBar ${tag} and restart serve?\n\nIt is smoke-tested first and rolled back automatically if serve doesn't come up healthy.`)) return;
    adminPost("/api/admin/update", { tag });
  } else {
    const to = el.healthActions.querySelector("#rollback-to")?.value;
    if (!to || !confirm(`Switch CodexBar to ${to} and restart serve?`)) return;
    adminPost("/api/admin/rollback", { to });
  }
});

async function loadStatus() {
  try {
    const res = await fetch("/api/status", { cache: "no-store" });
    if (!res.ok) return;
    status = await res.json();
    renderHealth();
  } catch { /* offline — the snapshot banner already says so */ }
}

/** The light should follow the banner without waiting out the status poll. */
function noteOutage(down) {
  if (down === outageShown) return;
  outageShown = down;
  loadStatus();
}

function openStatus() {
  if (!el.healthDialog?.open) el.healthDialog?.showModal();
  renderHealth();
  loadStatus();
}
el.healthBtn?.addEventListener("click", openStatus);
el.healthClose?.addEventListener("click", () => el.healthDialog?.close());
el.healthDialog?.addEventListener("click", (e) => {
  if (e.target === el.healthDialog) el.healthDialog.close();
});

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
  load({ retry: true });
  if (view === "spend") loadCost();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  load();
  maybeLoadCost();
  loadVersion();
  loadStatus();
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
// A page served mid-outage says so before its first fetch lands.
if (boot?.upstream && !boot.upstream.ok) {
  show(outageText({
    downSince: boot.upstream.downSince,
    error: boot.upstream.lastError,
    ageSeconds: snapshot ? Math.round((Date.now() - generatedMs(snapshot)) / 1000) : 0,
    retryIn: boot.upstream.retryInSeconds,
  }), true);
}

renderHealth();
// A "new release" push opens the app at /?status.
if (new URLSearchParams(location.search).has("status")) {
  history.replaceState(null, "", "/");
  openStatus();
}
setTimeout(loadVersion, 2000);
setTimeout(loadStatus, 2000);
// A hidden window still ticks about once a minute, and every tick keeps the proxy's poller
// fetching providers, which is how a minimised PWA got Claude's OAuth endpoint rate limited.
// Coming back into view reloads anyway (the visibilitychange handler).
setInterval(() => {
  if (document.hidden) return;
  load();
  maybeLoadCost();
  loadStatus();
  // A window that stays visible (a desktop PWA left open, a pinned tab) never fires
  // visibilitychange, so it has to look for a new build on the timer too.
  loadVersion();
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
    if (e.data?.type === "open" && e.data.what === "status") openStatus();
  });
  navigator.serviceWorker.register("/sw.js")
    .then((reg) => {
      reg.update();
      syncPushState();
    })
    .catch(() => {});
}
