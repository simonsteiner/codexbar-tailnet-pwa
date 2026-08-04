#!/usr/bin/env bash
# Installs codexbar-tailnet as two systemd user services and exposes it on the tailnet.
# Idempotent: safe to re-run after changing ports or pulling updates.
set -euo pipefail

PORT="${CBT_PORT:-8899}"
UPSTREAM_PORT="${CBT_UPSTREAM_PORT:-8087}"
# Tailnet-facing HTTPS port. Use 8443 (or another) when something else already
# serves 443 on this node — `tailscale serve` would otherwise replace it.
TS_PORT="${TS_PORT:-443}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$HOME/.config/codexbar/dashboard.env"
UNIT_DIR="$HOME/.config/systemd/user"

die() { echo "error: $*" >&2; exit 1; }

command -v codexbar >/dev/null 2>&1 || die "codexbar not on PATH — see https://github.com/steipete/CodexBar#cli-tarballs-macoslinux"
NODE="$(command -v node)" || die "node not on PATH (18+ required)"
CODEXBAR="$(command -v codexbar)"

# systemd user services need an absolute interpreter path; nvm's lives under a versioned dir.
case "$NODE" in /*) ;; *) die "could not resolve an absolute node path" ;; esac

# --- bearer token -----------------------------------------------------------
install -d -m 700 "$(dirname "$ENV_FILE")"
if [ -f "$ENV_FILE" ] && grep -q '^CODEXBAR_DASHBOARD_TOKEN=.' "$ENV_FILE"; then
  echo "==> reusing existing token in $ENV_FILE"
else
  command -v openssl >/dev/null 2>&1 || die "openssl needed to generate a token"
  ( umask 077; printf 'CODEXBAR_DASHBOARD_TOKEN=%s\n' "$(openssl rand -hex 32)" > "$ENV_FILE" )
  chmod 600 "$ENV_FILE"
  echo "==> generated a new token in $ENV_FILE"
fi

# --- units ------------------------------------------------------------------
mkdir -p "$UNIT_DIR"
for unit in codexbar-serve codexbar-tailnet; do
  sed -e "s|__NODE__|$NODE|g" \
      -e "s|__CODEXBAR__|$CODEXBAR|g" \
      -e "s|__APP_DIR__|$APP_DIR|g" \
      -e "s|__PORT__|$PORT|g" \
      -e "s|__UPSTREAM_PORT__|$UPSTREAM_PORT|g" \
      "$APP_DIR/deploy/$unit.service" > "$UNIT_DIR/$unit.service"
done

systemctl --user daemon-reload
systemctl --user enable --now codexbar-serve.service codexbar-tailnet.service
# Without lingering the services stop when the last login session ends.
loginctl enable-linger "$USER" >/dev/null 2>&1 || \
  echo "note: could not enable lingering; run 'sudo loginctl enable-linger $USER' for start-on-boot"

# --- tailnet ----------------------------------------------------------------
if command -v tailscale >/dev/null 2>&1; then
  # `tailscale serve` replaces an existing mapping without asking, which would take
  # another service off the air and silently move this app's origin. Look first.
  occupant=""
  if command -v python3 >/dev/null 2>&1; then
    occupant="$(tailscale serve status --json 2>/dev/null | TS_PORT="$TS_PORT" python3 -c '
import json, os, sys
try:
    web = json.load(sys.stdin).get("Web") or {}
except Exception:
    sys.exit(0)
suffix = ":" + os.environ["TS_PORT"]
for host, cfg in web.items():
    if host.endswith(suffix):
        target = ((cfg.get("Handlers") or {}).get("/") or {}).get("Proxy", "")
        if target:
            print(target)
        break
' || true)"
  fi

  if [ -n "$occupant" ] && [ "$occupant" != "http://127.0.0.1:$PORT" ]; then
    echo "note: tailnet port $TS_PORT already proxies to $occupant — leaving it alone."
    echo "      Re-run with a free port, e.g.:  TS_PORT=8443 ./install.sh"
  else
    echo "==> exposing port $PORT on tailnet port $TS_PORT"
    tailscale serve --bg --https="$TS_PORT" "$PORT" ||
      echo "note: 'tailscale serve --bg --https=$TS_PORT $PORT' failed; run it manually"
  fi
  tailscale serve status || true
else
  echo "note: tailscale not found — start it, then run: tailscale serve --bg --https=$TS_PORT $PORT"
fi

echo
echo "Done. Check with:  systemctl --user status codexbar-serve codexbar-tailnet"
echo "Open the https://<host>.<tailnet>.ts.net URL printed above (note the port) and Add to Home Screen."
if [ "$TS_PORT" != 443 ]; then
  echo
  echo "Heads up: :$TS_PORT is a different browser origin than :443. If you previously"
  echo "installed this app on another port, remove that home-screen icon and clear that"
  echo "origin's site data — its old service worker still intercepts requests there."
fi
