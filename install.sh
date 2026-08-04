#!/usr/bin/env bash
# Installs codexbar-tailnet as two systemd user services and exposes it on the tailnet.
# Idempotent: safe to re-run after changing ports or pulling updates.
set -euo pipefail

PORT="${CBT_PORT:-8899}"
UPSTREAM_PORT="${CBT_UPSTREAM_PORT:-8087}"
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
  echo "==> exposing port $PORT on the tailnet"
  tailscale serve --bg "$PORT" || echo "note: 'tailscale serve --bg $PORT' failed; run it manually"
  tailscale serve status || true
else
  echo "note: tailscale not found — start it, then run: tailscale serve --bg $PORT"
fi

echo
echo "Done. Check with:  systemctl --user status codexbar-serve codexbar-tailnet"
echo "Open the printed https://<host>.<tailnet>.ts.net URL on your phone and Add to Home Screen."
