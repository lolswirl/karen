# pi-dashboard

A web page for your Raspberry Pi, served from the Pi itself on your home network. It shows:

- **servers-up**: whether the bot is running and for how long, which commit is deployed and whether GitHub has a newer one, and the auto-update timer's last run. It has buttons to restart the bot and to update now.
- **System**: uptime, load, memory, disk and CPU temperature.
- **Services**: every systemd service that is running or has failed.
- **Logs**: recent lines from the bot and from the auto-updater.

It refreshes every 10 seconds. No npm dependencies.

## Install

Needs Node 18.17 or newer and the [servers-up](https://github.com/lolswirl/serversup) service already installed on the Pi.

```bash
git clone <this repo> ~/pi-dashboard
cd ~/pi-dashboard
bash install.sh ~/serversup # path to your servers-up checkout
```

Then open `http://<pi hostname>.local:8080` (for example `http://chumbucket.local:8080`) from any device on your network. Set `DASHBOARD_PORT=9000 bash install.sh ...` to use a different port.

The install script:

- creates a `pi-dashboard` systemd service that starts on boot,
- adds a sudoers rule at `/etc/sudoers.d/pi-dashboard` that lets it run exactly two commands as root, `systemctl restart servers-up` and `systemctl --no-block start servers-up-update.service`, and nothing else,
- adds your user to the `systemd-journal` group if needed, so it can read logs.

## Security

There is no login. Anyone on your network can see the page and press the two buttons, so don't port-forward it to the internet. The buttons need a custom request header, so other websites open in your browser can't trigger them.

## Updating

```bash
cd ~/pi-dashboard && git pull && sudo systemctl restart pi-dashboard
```

To remove it: `sudo systemctl disable --now pi-dashboard && sudo rm /etc/systemd/system/pi-dashboard.service /etc/sudoers.d/pi-dashboard`.
