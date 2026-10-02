# codexbar-tailnet-pwa

An installable phone dashboard for [CodexBar](https://github.com/steipete/CodexBar) usage, served
from your own machine and reachable only inside your [Tailscale](https://tailscale.com) tailnet.

CodexBar already ships a Linux CLI and a versioned `dashboard-v1` snapshot contract. This project
is the last hop: it puts that snapshot on your phone, over TLS, without exposing anything publicly
and without putting a credential on the device.

```
Android/iOS PWA ──https──▶ tailscale serve ──▶ node :8899 (loopback)
  <host>.<tailnet>.ts.net                        ├── /             static UI
                                                 ├── /api/snapshot ──▶ 127.0.0.1:8087
                                                 │                      + Host: 127.0.0.1
                                                 │                      + Authorization: Bearer …
                                                 │                                       codexbar serve
                                                 ├── /api/cost     ──▶ 127.0.0.1:8087/cost (trimmed)
                                                 └── /api/push/*   Web Push notifications
```

Four views, remembered across launches:

- **Cards** — provider tiles with per-window usage bars, plan badges, credits and cost.
- **Resets** — every window across every provider, soonest reset first, with large countdowns.
- **Dense** — one compact row per window.
- **Spend** — today's and 30-day spend, then per provider a 30-day daily chart and the cost split
  by model; tap a day to see that day's split. Comes from `codexbar serve`'s `/cost` (local log
  scans priced at API list rates, so for a subscription it is a usage measure, not a bill). The
  proxy drops Codex's per-project rows, which carry local paths, and is only asked for spend
  while this view is open.

Every view leads with the *reserve* — the headroom left rather than the amount burnt: `35% left`
per window (with `65% used` alongside it) and the remaining credit balance for providers that
report one. Opening the app paints the last snapshot from `localStorage` immediately and refreshes
behind a spinner, so a launch is never a blank screen.

The footer links back to the repo (taken from your `origin` remote, so forks link to themselves)
and shows the commit the server is running, linked to that commit on GitHub. It comes from
`/api/version`, which reads `.git` directly — a checkout with uncommitted edits still reports
whatever `HEAD` points at.

## Push notifications on window reset

The PWA supports Web Push notifications when rate limit windows renew (e.g. Claude session resets,
OpenCode Go windows, weekly resets).

- **Zero dependencies**: Full RFC 8291 (message encryption with `aes128gcm`) and RFC 8292 (VAPID
  authentication with ES256) implementation using Node stdlib `node:crypto`.
- **Proactive scheduling**: Even if the PWA is closed on your phone, the proxy computes the soonest
  upcoming reset time across all windows and schedules a proactive refresh timer when there is at
  least one active subscriber.
- **Only when it matters**: A renewal means one thing — a window that was in use dropped back to
  (near) empty. A push goes out when a window that was at least `CBT_PUSH_MIN_USED` percent used
  loses at least that many points and lands at no more than half its previous usage. Reset times
  are not evidence: providers slide them on every use for rolling windows and jitter them by a
  second between polls, and `codexbar serve` may still be serving the old cycle from its cache
  when the clock passes the boundary. The proxy re-polls once a minute for five minutes after a
  used window's reset time until the drop shows up. One notification per window per half hour at most.
- **One notification per provider**: Windows that renew together (Claude's weekly and its
  model-scoped weekly share one boundary) go out as a single notification.
- **Self-healing subscriptions**: The app re-registers its subscription on every launch and
  re-subscribes if the server's VAPID key changed; the server drops subscriptions the push
  service reports gone or repeatedly rejects. Every delivery is logged to the journal.
- **Known push services only**: Subscriptions are accepted only for https endpoints on FCM, Mozilla,
  Apple and WNS push hosts, so a tailnet client cannot make the proxy POST to arbitrary URLs.
- **Device UI**: Tap the bell icon in the topbar to enable/disable notifications or send a test push.
- **iOS Note**: On iOS 16.4+, Apple requires Web Push apps to be added to the Home Screen first before
  requesting notification permissions.

## Why a proxy instead of pointing the phone at `codexbar serve`

Three concrete blockers, all handled here:

1. **Host check.** On a loopback bind `codexbar serve` accepts only
   `Host: 127.0.0.1 | localhost | [::1]` (`CLILocalHTTPServer.swift`). A tailnet `Host` gets
   `403 {"error":"forbidden host"}`. The proxy rewrites it.
2. **No CORS.** `serve` emits no CORS headers, so the UI must be same-origin with the API.
   The proxy serves both from one origin.
3. **Token placement.** The bearer token stays in the proxy process. The phone stores no secret;
   your tailnet ACL is the boundary.

The alternative — binding `serve` to a non-loopback address — requires `--allow-plain-http` and
puts the token in cleartext on the wire on every request. Keeping `serve` on loopback behind
`tailscale serve` gets a real Let's Encrypt certificate instead, which also makes the app
installable: service workers require a secure context, so a plain-HTTP LAN address cannot be a PWA.

## Requirements

- CodexBar's CLI on PATH — [release tarballs](https://github.com/steipete/CodexBar/releases)
  (macOS/Linux, glibc + static musl), Homebrew, or the AUR.
- Node 18+ (no dependencies are installed; the server is stdlib-only).
- Tailscale, logged in, with HTTPS certificates enabled for the tailnet.
- systemd for the units. Anything that supervises two processes works otherwise.

## Install

```bash
git clone https://github.com/simonsteiner/codexbar-tailnet-pwa
cd codexbar-tailnet-pwa
./install.sh
```

The script generates a bearer token if one doesn't exist, writes and enables both user units,
turns on lingering so they survive a reboot, and runs `tailscale serve`. It prints the URL to open.
Re-run it after changing ports or pulling updates.

Pick ports if the defaults clash — `CBT_PORT` and `CBT_UPSTREAM_PORT` are local listeners,
`TS_PORT` is the tailnet-facing HTTPS port:

```bash
CBT_PORT=9100 CBT_UPSTREAM_PORT=9101 ./install.sh   # local ports
TS_PORT=8443 ./install.sh                           # if 443 is already in use on this node
```

`tailscale serve` replaces an existing mapping without asking, so if you already serve something
else on 443 it would go offline. The installer checks first and refuses rather than clobbering it.

Then open the URL printed by the installer — **including the port** — on your phone and
**Add to Home Screen**.

### Changing ports later

`https://host` and `https://host:8443` are *different browser origins*. After a port change:

- Re-add the home-screen icon from the new URL; the old one points at the old origin.
- Clear site data for the old origin (Chrome → Site settings → the host → Clear & reset).
  The service worker installed there stays registered and keeps intercepting requests for
  whatever now serves that origin.
- View preference and the cached snapshot live in `localStorage`, so they don't carry over.

## Configuration

Read from `~/.config/codexbar/dashboard.env` (mode 600):

| Var | Default | Meaning |
| --- | --- | --- |
| `CODEXBAR_DASHBOARD_TOKEN` | *(required)* | Bearer token; shared with `codexbar serve` |
| `CBT_PORT` | `8899` | Local listen port |
| `CBT_BIND` | `127.0.0.1` | Keep on loopback — `tailscale serve` fronts it |
| `CBT_UPSTREAM_PORT` | `8087` | Where `codexbar serve` listens |
| `CBT_CACHE_TTL` | `60` | Snapshot cache seconds |
| `CBT_COST_TTL` | `300` | Spend (`/api/cost`) cache seconds |
| `CBT_UPSTREAM_TIMEOUT` | `90` | Upstream deadline; keep above `serve --request-timeout` |
| `CBT_ACTIVE_WINDOW` | `600` | Keep the cache warm this long after the last client request |
| `CBT_POLL` | `45` | Background refresh cadence while inside the active window |
| `CBT_VAPID_PATH` | `~/.config/codexbar/vapid.json` | Path to generated/stored VAPID keys |
| `CBT_PUSH_SUBSCRIPTIONS_PATH` | `~/.config/codexbar/push-subscriptions.json` | Path to persistent push subscriptions |
| `CBT_PUSH_STATE_PATH` | `~/.config/codexbar/push-window-state.json` | Last-seen usage per window, so a restart does not lose a pending renewal (ignored when over an hour old) |
| `CBT_VAPID_SUBJECT` | `mailto:codexbar@local` | Subject URI in VAPID JWT claims |
| `CBT_PUSH_MIN_USED` | `10` | Skip the renewal push for windows whose usage stayed below this percent (1–100) |
| `CBT_PUSH_TTL` | `3600` | Seconds the push service may hold an undelivered renewal notice (integer ≥ 0) |

Snapshot serving is stale-while-revalidate: a request never waits on a live provider
fetch when any cached copy exists — it gets the cached body plus `X-Snapshot-Refreshing: true`,
and the app re-polls until the background refresh lands. `codexbar serve` itself is lazy
(its `--refresh-interval` is only a cache TTL), so the active-window poller is what keeps
"open the app, see fresh numbers" fast instead of a ~13 s cold fetch.

`TS_PORT` (default `443`) is read by `install.sh` only, not by the server.

Which providers appear is entirely CodexBar's config (`~/.config/codexbar/config.json`):

```bash
codexbar config providers
codexbar config enable --provider claude
```

## Operating

```bash
systemctl --user status codexbar-serve codexbar-tailnet
journalctl --user -u codexbar-tailnet -f
tailscale serve status
```

### Load path

A launch paints usable data without a single round trip. Three things get it there:

- **One document.** The server inlines `styles.css` and `app.js` into `/` and gzips the result
  (~26 KB → ~9 KB), so the shell costs one request instead of three. The standalone files stay
  served for debugging; nothing references them.
- **The snapshot ships inside the page.** `/` embeds the proxy's warm snapshot as
  `window.__BOOT__`, so the UI has real numbers before it can even ask for them. A launch skips
  its opening `/api/snapshot` fetch when that copy is under 10 s old and not mid-refresh.
  Embedding never blocks: a cold proxy just ships the page without one.
- **The service worker is cache-first**, not network-first. It answers from cache and revalidates
  behind the response, so a launch never waits out a round trip — which on a tailnet is ~200 ms
  each, and was most of the several seconds this used to take.

### Picking up updates

Cache-first means a launch can paint a build-old shell, so two mechanisms replace it. `/` carries
`X-Shell-Stamp`, the mtimes of `app.js` and `styles.css`; when the worker's revalidation sees that
header change it messages the page, which reloads into the copy it just stored — normally within a
few hundred milliseconds of the launch. `/api/version` reports the same stamp, which is how a
resumed PWA that never re-navigated notices it is running old JS.

`index.html` and `sw.js` are `no-store`; everything else is `no-cache` with an encoding-aware
`ETag`, so a direct (non-SW) client revalidates and gets a `304` when nothing changed. The
inlined document is rebuilt whenever those mtimes move, so editing `app.js` or `styles.css` needs
no restart; restart `codexbar-tailnet` only when `server.mjs` itself changes.

## Provider notes on Linux

CodexBar reuses existing provider sessions, and some of those paths are macOS-only. On Linux:

- **API-key and OAuth providers** work normally and report the same server-side numbers as any
  other machine, so it doesn't matter which box asks.
- **Claude** may need `"source": "cli"` in `config.json`. Under `auto` it can try a macOS-only web
  path first and time out. Local cost scans of `~/.claude` work regardless.
- **Providers whose only source is a browser session** (OpenCode's web source, Cursor cost, and
  automatic cookie import generally) are macOS-only; several accept a manual `Cookie:` header.
- **OpenCode** ships as two providers. `opencode` has only the web source, so on Linux it fails
  with *"selected source requires web support and is only supported on macOS"* — `--source cli`
  and `--source api` are not implemented for it. `opencodego` reads local state instead and works
  here, reporting 5-hour, weekly and monthly windows. Enable that one:
  `codexbar config enable --provider opencodego`.

Local cost figures reflect *that machine's* agent runs, so a box that doesn't run your agents
won't show their spend.
