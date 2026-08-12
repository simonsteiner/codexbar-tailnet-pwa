# codexbar-tailnet-pwa

An installable phone dashboard for [CodexBar](https://github.com/steipete/CodexBar) usage, served
from your own machine and reachable only inside your [Tailscale](https://tailscale.com) tailnet.

CodexBar already ships a Linux CLI and a versioned `dashboard-v1` snapshot contract. This project
is the last hop: it puts that snapshot on your phone, over TLS, without exposing anything publicly
and without putting a credential on the device.

```
Android/iOS PWA ──https──▶ tailscale serve ──▶ node :8899 (loopback)
  <host>.<tailnet>.ts.net                        ├─ /             static UI
                                                 └─ /api/snapshot ──▶ 127.0.0.1:8087
                                                      + Host: 127.0.0.1
                                                      + Authorization: Bearer …
                                                                       codexbar serve
```

Three views, remembered across launches:

- **Cards** — provider tiles with per-window usage bars, plan badges, credits and cost.
- **Resets** — every window across every provider, soonest reset first, with large countdowns.
- **Dense** — one compact row per window.

Every view leads with the *reserve* — the headroom left rather than the amount burnt: `35% left`
per window (with `65% used` alongside it) and the remaining credit balance for providers that
report one. Opening the app paints the last snapshot from `localStorage` immediately and refreshes
behind a spinner, so a launch is never a blank screen.

The footer links back to the repo (taken from your `origin` remote, so forks link to themselves)
and shows the commit the server is running, linked to that commit on GitHub. It comes from
`/api/version`, which reads `.git` directly — a checkout with uncommitted edits still reports
whatever `HEAD` points at.

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
| `CBT_UPSTREAM_TIMEOUT` | `90` | Upstream deadline; keep above `serve --request-timeout` |
| `CBT_ACTIVE_WINDOW` | `600` | Keep the cache warm this long after the last client request |
| `CBT_POLL` | `45` | Background refresh cadence while inside the active window |

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

### Picking up updates

`index.html` and `sw.js` are `no-store`; `app.js` and `styles.css` are `no-cache` with an `ETag`,
so a phone revalidates them on every launch and gets a `304` when nothing changed. `index.html`
also stamps those two URLs with the file's mtime (`/app.js?v=msf6fpmj`), which means an edited
asset arrives under a URL no cache has ever seen. Pulling updates needs no restart for the UI;
restart `codexbar-tailnet` only when `server.mjs` itself changes.

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

## Behaviour when things are down

- Upstream refresh fails → the proxy serves the last good snapshot with `X-Snapshot-Stale: true`,
  and the UI says so rather than blanking.
- Phone offline or host asleep → the service worker serves the cached shell and the UI renders the
  last snapshot from `localStorage`, with a "snapshot is N minutes old" banner.
- Host sleeps (a laptop, or a WSL VM that idles out) → data goes stale. Nothing here can fix that;
  the banner is there so stale numbers are never mistaken for current ones.

## Security notes

- The token never reaches the phone and never appears in `ps` (it's passed via `EnvironmentFile`).
- `codexbar serve` stays bound to loopback and is not reachable from the tailnet; only the proxy is.
- `tailscale serve` (not `funnel`) means tailnet-only. Don't swap in `funnel` unless you intend to
  publish your usage data to the internet.
- Static file serving is contained to `public/`; the snapshot route is never cached by the SW.

## License

MIT — see [LICENSE](LICENSE). Builds on [CodexBar](https://github.com/steipete/CodexBar)
by Peter Steinberger, also MIT.
