// Small web dashboard for the Pi: system stats, running services, hearthbeat deploy state and logs.
// Run with: node server.js  (or bash install.sh to install as a service)
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { readFile, statfs } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.DASHBOARD_PORT || 8080);
const HERE = path.dirname(fileURLToPath(import.meta.url));
// The hearthbeat checkout, for its deployed commit
const APP_DIR = path.resolve(process.env.HEARTHBEAT_DIR || path.join(os.homedir(), 'hearthbeat'));
// Must match the paths in the sudoers rule written by install.sh
const SYSTEMCTL = '/usr/bin/systemctl';
const LOG_UNITS = ['hearthbeat', 'hearthbeat-update'];

// Commands run through execFile with fixed arguments, never a shell
function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: stdout.trim(), err: (stderr || err?.message || '').trim() })
    );
  });
}

// systemd reports times as microseconds on the monotonic clock; turn them into epoch ms
const fromMono = (us) => (Number(us) > 0 ? Math.round(Date.now() - os.uptime() * 1000 + Number(us) / 1000) : null);

async function system() {
  const meminfo = Object.fromEntries(
    (await readFile('/proc/meminfo', 'utf8'))
      .split('\n')
      .map((l) => l.match(/^(\w+):\s+(\d+)/))
      .filter(Boolean)
      .map((m) => [m[1], Number(m[2]) * 1024])
  );
  const disk = await statfs('/');
  const temp = await readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8').catch(() => null);
  return {
    hostname: os.hostname(),
    uptime: os.uptime(),
    load: os.loadavg(),
    cpus: os.cpus().length,
    mem: { total: meminfo.MemTotal, available: meminfo.MemAvailable },
    disk: { total: disk.blocks * disk.bsize, available: disk.bavail * disk.bsize },
    tempC: temp ? Number(temp) / 1000 : null,
  };
}

async function services() {
  const { out } = await run(SYSTEMCTL, [
    'list-units', '--type=service', '--state=running,failed', '--no-legend', '--plain', '--no-pager',
  ]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [unit, load, active, sub, ...desc] = line.trim().split(/\s+/);
      return { unit: unit.replace(/\.service$/, ''), active, sub, description: desc.join(' ') };
    });
}

async function hearthbeat() {
  const units = ['hearthbeat.service', 'hearthbeat-update.service', 'hearthbeat-update.timer'];
  const { out } = await run(SYSTEMCTL, [
    'show', ...units,
    '-p', 'Id,LoadState,ActiveState,SubState,Result,NRestarts,ActiveEnterTimestampMonotonic,ExecMainExitTimestampMonotonic',
  ]);
  const props = Object.fromEntries(
    out.split('\n\n').map((block) => {
      const p = Object.fromEntries(block.split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
      return [p.Id, p];
    })
  );
  const bot = props['hearthbeat.service'] || {};
  const upd = props['hearthbeat-update.service'] || {};
  const timer = props['hearthbeat-update.timer'] || {};

  const head = await run('git', ['log', '-1', '--format=%H%x09%s%x09%cI'], APP_DIR);
  const [hash, subject, date] = head.out.split('\t');
  const remote = await run('git', ['log', '-1', '--format=%H%x09%s%x09%cI', 'origin/main'], APP_DIR);
  const [rHash, rSubject, rDate] = remote.out.split('\t');
  const deployed = (await readFile(path.join(APP_DIR, '.git/hearthbeat-deployed'), 'utf8').catch(() => '')).trim();

  return {
    bot: {
      installed: bot.LoadState === 'loaded',
      active: bot.ActiveState,
      sub: bot.SubState,
      since: fromMono(bot.ActiveEnterTimestampMonotonic),
      restarts: Number(bot.NRestarts || 0),
    },
    commit: hash ? { hash, subject, date } : null,
    github: rHash ? { hash: rHash, subject: rSubject, date: rDate } : null,
    // The updater writes this after a successful deploy; if it lags HEAD the last update didn't finish
    deployed: deployed || null,
    autoUpdate: {
      installed: timer.LoadState === 'loaded',
      active: timer.ActiveState,
      running: upd.ActiveState === 'activating',
      lastResult: upd.Result,
      lastRun: fromMono(upd.ExecMainExitTimestampMonotonic),
    },
  };
}

async function logs(unit, lines) {
  const { ok, out, err } = await run('journalctl', ['-u', unit, '-n', String(lines), '--no-pager', '-o', 'short-iso']);
  return { ok, lines: (ok ? out : err).split('\n') };
}

const actions = {
  restart: () => run('sudo', ['-n', SYSTEMCTL, 'restart', 'hearthbeat']),
  update: () => run('sudo', ['-n', SYSTEMCTL, '--no-block', 'start', 'hearthbeat-update.service']),
};

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, await readFile(path.join(HERE, 'index.html')), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/icon.png') {
      return send(res, 200, await readFile(path.join(HERE, 'icon.png')), 'image/png');
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const [sys, svc, su] = await Promise.all([system(), services(), hearthbeat()]);
      return send(res, 200, { system: sys, services: svc, hearthbeat: su, at: Date.now() });
    }
    if (req.method === 'GET' && url.pathname === '/api/logs') {
      const unit = url.searchParams.get('unit');
      if (!LOG_UNITS.includes(unit)) return send(res, 400, { error: 'unknown unit' });
      const lines = Math.min(500, Math.max(10, Number(url.searchParams.get('lines')) || 100));
      return send(res, 200, await logs(unit, lines));
    }
    const action = req.method === 'POST' && url.pathname.match(/^\/api\/(\w+)$/)?.[1];
    if (action && actions[action]) {
      // A custom header can't be sent cross-site without a CORS preflight, which this server never answers,
      // so other websites open in your browser can't press these buttons
      if (req.headers['x-dashboard'] !== '1') return send(res, 403, { error: 'missing X-Dashboard header' });
      const r = await actions[action]();
      console.log(`${new Date().toISOString()} ${action}: ${r.ok ? 'ok' : r.err}`);
      return send(res, r.ok ? 200 : 500, { ok: r.ok, error: r.ok ? null : r.err });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('Request failed:', e);
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`Dashboard on http://${os.hostname()}.local:${PORT}`));
