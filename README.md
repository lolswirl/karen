# Karen

A web page for your Raspberry Pi, served from the Pi itself on your home network, plus an auto-updater that deploys new GitHub commits for your projects.

The page shows:

- **Projects**: one card per entry in `projects.json`, with whether its service is running and for how long, which commit is deployed and whether GitHub has a newer one, and a restart button.
- **System**: auto-update status, uptime, load, memory, disk and CPU temperature. **Update all now** checks GitHub immediately instead of waiting for the next minute.
- **Services**: every systemd service that is running or has failed.
- **Logs**: recent lines from each project's service and from the auto-updater.

It refreshes every 10 seconds. No npm dependencies.

## Install

Needs Node 18.17 or newer.

```bash
git clone https://github.com/lolswirl/karen.git ~/karen
cd ~/karen
bash install.sh
```

Then open `http://<pi hostname>.local:8080` (for example `http://chumbucket.local:8080`) from any device on your network. Set `KAREN_PORT=9000 bash install.sh` to use a different port.

The install script:

- creates the `karen` service, which starts on boot,
- creates the `karen-update` timer, which runs `update.js` every minute,
- writes a sudoers rule at `/etc/sudoers.d/karen` that allows exactly `systemctl restart <service>` for each project and `systemctl --no-block start karen-update.service`, and nothing else,
- adds your user to the `systemd-journal` group if needed, so it can read logs.

## Projects

`projects.json` lists what the dashboard shows and the updater deploys:

```json
[
  { "name": "Hearthbeat", "dir": "~/hearthbeat", "service": "hearthbeat" },
  { "name": "Karen", "dir": ".", "service": "karen" }
]
```

- `name`: shown on the card.
- `dir`: the git checkout on the Pi. `~` is your home folder, and relative paths are relative to this repo, so `"."` is the dashboard itself.
- `service`: the systemd service that runs it.

Every minute the updater fetches `main` for each project. When there's a new commit it resets the checkout to match GitHub, runs `npm ci --omit=dev` if the project has a `package-lock.json`, and restarts the service. Local edits to tracked files are discarded; untracked files like `.env` are kept.

### Adding a project

1. Clone it on the Pi and set it up as a systemd service.
2. Add it to `projects.json` and push. The updater picks up the new list within a minute.
3. On the Pi, run `bash install.sh` in this folder once, so the sudoers rule includes the new service.

## Security

There is no login. Anyone on your network can see the page and press the buttons, so don't port-forward it to the internet. The buttons need a custom request header, so other websites open in your browser can't trigger them.

To remove everything: `sudo systemctl disable --now karen karen-update.timer && sudo rm /etc/systemd/system/karen.service /etc/systemd/system/karen-update.service /etc/systemd/system/karen-update.timer /etc/sudoers.d/karen`.
