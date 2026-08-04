# codexbar-tailnet

A phone-sized PWA for [CodexBar](https://github.com/steipete/CodexBar) usage, served from the WSL
box and reachable only inside your tailnet.

```
Android PWA ──https──▶ tailscale serve ──▶ node :8899 (loopback)
  <host>.<tailnet>.ts.net                    ├─ /            static UI
                                             └─ /api/snapshot ──▶ 127.0.0.1:8087
                                                  + Host: 127.0.0.1
                                                  + Authorization: Bearer …
                                                                   codexbar serve
```

## Why the proxy exists

`codexbar serve` can't be exposed to the tailnet directly, for three reasons:

1. **Host check.** On a loopback bind it only accepts `Host: 127.0.0.1 | localhost | [::1]`
   (`CLILocalHTTPServer.swift`). A tailnet `Host` gets `403 {"error":"forbidden host"}`.
   The proxy rewrites it.
2. **No CORS.** `serve` sends no CORS headers, so the UI has to be same-origin with the API.
   The proxy serves both.
3. **Token placement.** The bearer token stays in this process. The phone never holds a secret;
   your tailnet ACL is the auth boundary.

Binding `serve` to a non-loopback host would instead require `--allow-plain-http`, putting the
token in cleartext on the wire. Keeping it on loopback behind `tailscale serve` gets a real
Let's Encrypt cert — which is also what makes the PWA installable, since service workers
require a secure context.

## Layout

- `server.mjs` — static host + caching snapshot proxy. Zero dependencies, Node 18+.
- `public/` — the PWA (three views: Cards, Resets, Dense; the choice persists in localStorage).

## Config

Environment, read from `~/.config/codexbar/dashboard.env` (mode 600):

| Var | Default | Meaning |
| --- | --- | --- |
| `CODEXBAR_DASHBOARD_TOKEN` | *(required)* | Bearer token; must match what `codexbar serve` uses |
| `CBT_PORT` | `8899` | Local listen port |
| `CBT_BIND` | `127.0.0.1` | Keep on loopback — `tailscale serve` fronts it |
| `CBT_UPSTREAM_PORT` | `8087` | Where `codexbar serve` listens |
| `CBT_CACHE_TTL` | `60` | Snapshot cache seconds |

Port 8087 rather than CodexBar's default 8080, because `llama-server` already owns 8080 here.

## Operating

```bash
systemctl --user status codexbar-serve codexbar-tailnet
systemctl --user restart codexbar-tailnet
journalctl --user -u codexbar-tailnet -f
tailscale serve status
```

Both units are enabled with lingering on, so they come back after a reboot without a login.

## Provider notes on Linux

- **Codex** — works via OAuth.
- **Claude** — pinned to `"source": "cli"` in `config.json`. Under `auto` it tries the macOS-only
  web path first and times out. Local cost scans of `~/.claude` work either way.
- **OpenCode** — disabled; its web source is macOS-only.

Local cost figures reflect *this machine's* agent runs. API-key providers report the same numbers
everywhere, so they don't care which box asks.

## Known limits

- If Windows sleeps or WSL idles out its VM, the snapshot goes stale. The UI shows a
  "snapshot is Nm old" banner and falls back to the last good data rather than blanking.
- Renders were verified structurally (DOM/asset/payload level), not with a device screenshot.
