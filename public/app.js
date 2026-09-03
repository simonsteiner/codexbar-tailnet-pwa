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

// Spin for the whole refresh cycle, not just the fetch: a warm proxy answers in
// ~2 ms, so tying the spinner to the request alone makes it an invisible flash.
const syncSpinner = () => el.refresh?.classList.toggle("spinning", loading || updating);

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
const credits = (p) => (typeof p.credits?.remainingUSD === "number" ? p.credits.remainingUSD : null);

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

function readCached() {
  try { return JSON.parse(localStorage.getItem(LAST_KEY)); } catch { return null; }
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

        ${p.error ? `<div class="err">${esc(p.error)}</div>` : ""}

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
            ${cred != null ? `<span>Credit <b>$${cred.toFixed(2)}</b></span>` : ""}
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

/* ---------------- core rendering ---------------- */

function render() {
  if (!snapshot) return;
  if (view === "cards") el.content.innerHTML = renderCards(snapshot);
  else if (view === "resets") el.content.innerHTML = renderResets(snapshot);
  else if (view === "dense") el.content.innerHTML = renderDense(snapshot);

  if (snapshot.generatedAt) {
    const when = new Date(snapshot.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
}

for (const b of document.querySelectorAll(".view-btn")) {
  b.addEventListener("click", () => setView(b.dataset.view));
}
el.refresh?.addEventListener("click", () => load());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  load();
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

async function getVapidPublicKey() {
  if (vapidPublicKey) return vapidPublicKey;
  try {
    const res = await fetch("/api/push/vapid-public-key", { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      vapidPublicKey = data.publicKey;
    }
  } catch {}
  return vapidPublicKey;
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
if (snapshot) localStorage.setItem(LAST_KEY, JSON.stringify(snapshot));
renderAbout(knownVersion());
setView(view);

const bootIsCurrent = snapshot === boot?.snapshot
  && !boot.refreshing
  && Date.now() - generatedMs(snapshot) < BOOT_FRESH_MS;
if (!bootIsCurrent) load();

setTimeout(loadVersion, 2000);
setInterval(load, REFRESH_MS);
ticking = setInterval(() => { if (snapshot) render(); }, 30_000);

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
