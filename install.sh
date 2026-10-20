#!/usr/bin/env bash
# Installs Karen as a systemd service, the karen-update timer that deploys new GitHub commits for every
# project in projects.json, and a sudoers rule that lets both restart those projects' services.
# Run from the repo folder, and again after adding a project to projects.json:  bash install.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_USER="${SUDO_USER:-$USER}"
PORT="${KAREN_PORT:-8080}"
NODE_BIN="$(command -v node || true)"
SERVICE=/etc/systemd/system/karen.service
UPDATE_SERVICE=/etc/systemd/system/karen-update.service
UPDATE_TIMER=/etc/systemd/system/karen-update.timer
SUDOERS=/etc/sudoers.d/karen
SYSTEMCTL=/usr/bin/systemctl

if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js not found. Install it first." >&2
  exit 1
fi

if [[ ! -x "$SYSTEMCTL" ]]; then
  echo "$SYSTEMCTL not found; this needs a systemd machine." >&2
  exit 1
fi

# One "service<TAB>dir" line per project
PROJECTS="$(cd "$APP_DIR" && "$NODE_BIN" --input-type=module -e \
  "import { loadProjects } from './projects.js'; for (const p of await loadProjects()) console.log(p.service + '\t' + p.dir)")"

RULES=("$SYSTEMCTL --no-block start karen-update.service")
while IFS=$'\t' read -r svc dir; do
  [[ -d "$dir/.git" ]] || echo "Warning: $svc has no git checkout at $dir; fix its dir in projects.json" >&2
  [[ "$svc" == karen || -f "/etc/systemd/system/$svc.service" ]] || echo "Warning: no $svc service installed yet" >&2
  RULES+=("$SYSTEMCTL restart $svc")
done <<< "$PROJECTS"

# Only these exact commands, so the dashboard can't be used to run anything else as root
echo "Writing $SUDOERS"
TMP="$(mktemp)"
(IFS=,; echo "$RUN_USER ALL=(root) NOPASSWD: ${RULES[*]}") | sed 's/,/, /g' > "$TMP"
sudo visudo -cf "$TMP" > /dev/null
sudo install -m 0440 -o root -g root "$TMP" "$SUDOERS"
rm -f "$TMP"

echo "Writing $SERVICE (user: $RUN_USER, port: $PORT)"
sudo tee "$SERVICE" > /dev/null <<EOF
[Unit]
Description=Karen (web dashboard for this Pi)
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
Environment=KAREN_PORT=$PORT

[Install]
WantedBy=multi-user.target
EOF

echo "Writing $UPDATE_SERVICE and $UPDATE_TIMER"
sudo tee "$UPDATE_SERVICE" > /dev/null <<EOF
[Unit]
Description=Deploy new GitHub commits for the projects in Karen's projects.json
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=$RUN_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN $APP_DIR/update.js
Environment=PATH=$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin
EOF

sudo tee "$UPDATE_TIMER" > /dev/null <<EOF
[Unit]
Description=Check GitHub for project updates every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=10s

[Install]
WantedBy=timers.target
EOF

# Reading other services' logs needs the systemd-journal (or adm) group
if ! id -nG "$RUN_USER" | grep -qwE 'systemd-journal|adm'; then
  echo "Adding $RUN_USER to systemd-journal so the dashboard can read logs"
  sudo usermod -aG systemd-journal "$RUN_USER"
fi

sudo systemctl daemon-reload
sudo systemctl enable --now karen karen-update.timer
sudo systemctl restart karen
sleep 2
sudo systemctl --no-pager --lines=5 status karen || true

echo
echo "Done. Open http://$(hostname).local:$PORT from any device on your network."
echo "  journalctl -u karen -f # dashboard logs"
echo "  journalctl -u karen-update -f # deploy log"
echo "  sudo systemctl disable --now karen-update.timer # turn auto-update off"
