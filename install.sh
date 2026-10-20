#!/usr/bin/env bash
# Installs pi-dashboard as a systemd service, plus a sudoers rule that lets it restart and update hearthbeat.
# Run from the repo folder:  bash install.sh [path to hearthbeat checkout]
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_USER="${SUDO_USER:-$USER}"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
HEARTHBEAT_DIR="${1:-$RUN_HOME/hearthbeat}"
PORT="${DASHBOARD_PORT:-8080}"
NODE_BIN="$(command -v node || true)"
SERVICE=/etc/systemd/system/pi-dashboard.service
SUDOERS=/etc/sudoers.d/pi-dashboard
SYSTEMCTL=/usr/bin/systemctl

if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js not found. Install it first." >&2
  exit 1
fi

if [[ ! -x "$SYSTEMCTL" ]]; then
  echo "$SYSTEMCTL not found; this needs a systemd machine." >&2
  exit 1
fi

if [[ ! -d "$HEARTHBEAT_DIR/.git" ]]; then
  echo "No hearthbeat checkout at $HEARTHBEAT_DIR. Pass its path: bash install.sh /path/to/hearthbeat" >&2
  exit 1
fi
HEARTHBEAT_DIR="$(cd "$HEARTHBEAT_DIR" && pwd)"

# Only these two exact commands, so the dashboard can't be used to run anything else as root
echo "Writing $SUDOERS"
TMP="$(mktemp)"
cat > "$TMP" <<EOF
$RUN_USER ALL=(root) NOPASSWD: $SYSTEMCTL restart hearthbeat, $SYSTEMCTL --no-block start hearthbeat-update.service
EOF
sudo visudo -cf "$TMP" > /dev/null
sudo install -m 0440 -o root -g root "$TMP" "$SUDOERS"
rm -f "$TMP"

echo "Writing $SERVICE (user: $RUN_USER, port: $PORT, hearthbeat: $HEARTHBEAT_DIR)"
sudo tee "$SERVICE" > /dev/null <<EOF
[Unit]
Description=pi-dashboard (web dashboard for this Pi)
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN $APP_DIR/server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=DASHBOARD_PORT=$PORT
Environment=HEARTHBEAT_DIR=$HEARTHBEAT_DIR

[Install]
WantedBy=multi-user.target
EOF

# Reading other services' logs needs the systemd-journal (or adm) group
if ! id -nG "$RUN_USER" | grep -qwE 'systemd-journal|adm'; then
  echo "Adding $RUN_USER to systemd-journal so the dashboard can read logs"
  sudo usermod -aG systemd-journal "$RUN_USER"
fi

sudo systemctl daemon-reload
sudo systemctl enable --now pi-dashboard
sudo systemctl restart pi-dashboard
sleep 2
sudo systemctl --no-pager --lines=5 status pi-dashboard || true

echo
echo "Done. Open http://$(hostname).local:$PORT from any device on your network."
echo "  journalctl -u pi-dashboard -f          # dashboard logs"
echo "  sudo systemctl restart pi-dashboard    # after git pull"
