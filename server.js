// Small web dashboard for the Pi: system stats, running services, and each project's deploy state and logs.
// Run with: node server.js  (or bash install.sh to install as a service)
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { readFile, statfs } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadProjects } from './projects.js';

const PORT = Number(process.env.KAREN_PORT || 8080);
const HERE = path.dirname(fileURLToPath(import.meta.url));
// Must match the paths in the sudoers rule written by install.sh
const SYSTEMCTL = '/usr/bin/systemctl';
const UPDATER = 'karen-update';

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

// systemctl show for several units at once, keyed by unit name
async function unitProps(units) {
  const { out } = await run(SYSTEMCTL, [
    'show', ...units,
    '-p', 'Id,LoadState,ActiveState,SubState,Result,NRestarts,ActiveEnterTimestampMonotonic,ExecMainExitTimestampMonotonic',
  ]);
  return Object.fromEntries(
    out.split('\n\n').map((block) => {
      const p = Object.fromEntries(block.split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
      return [p.Id, p];
    })
  );
}

async function commitInfo(dir, ref) {
  const { out } = await run('git', ['log', '-1', '--format=%H%x09%s%x09%cI', ref], dir);
  const [hash, subject, date] = out.split('\t');
  return hash ? { hash, subject, date } : null;
}

async function projects(list) {
  const props = await unitProps([...list.map((p) => `${p.service}.service`), `${UPDATER}.service`, `${UPDATER}.timer`]);
  const upd = props[`${UPDATER}.service`] || {};
  const timer = props[`${UPDATER}.timer`] || {};
  return {
    projects: await Promise.all(
      list.map(async (p) => {
        const u = props[`${p.service}.service`] || {};
        const [commit, github, deployed] = await Promise.all([
          commitInfo(p.dir, 'HEAD'),
          commitInfo(p.dir, 'origin/main'),
          readFile(path.join(p.dir, '.git/karen-deployed'), 'utf8').then((s) => s.trim(), () => null),
        ]);
        return {
          name: p.name,
          service: p.service,
          installed: u.LoadState === 'loaded',
          active: u.ActiveState,
          sub: u.SubState,
          since: fromMono(u.ActiveEnterTimestampMonotonic),
          restarts: Number(u.NRestarts || 0),
          commit,
          github,
          // update.js writes this after a successful deploy; if it lags HEAD the last update didn't finish
          deployed,
        };
      })
    ),
    updater: {
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
    const list = await loadProjects();
    const serviceNames = list.map((p) => p.service);
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const [sys, svc, pr] = await Promise.all([system(), services(), projects(list)]);
      return send(res, 200, { system: sys, services: svc, ...pr, at: Date.now() });
    }
    if (req.method === 'GET' && url.pathname === '/api/logs') {
      const unit = url.searchParams.get('unit');
      if (![...serviceNames, UPDATER].includes(unit)) return send(res, 400, { error: 'unknown unit' });
      const lines = Math.min(500, Math.max(10, Number(url.searchParams.get('lines')) || 100));
      return send(res, 200, await logs(unit, lines));
    }
    if (req.method === 'POST' && (url.pathname === '/api/restart' || url.pathname === '/api/update')) {
      // A custom header can't be sent cross-site without a CORS preflight, which this server never answers,
      // so other websites open in your browser can't press these buttons
      if (req.headers['x-dashboard'] !== '1') return send(res, 403, { error: 'missing X-Dashboard header' });
      let args;
      if (url.pathname === '/api/update') {
        args = ['--no-block', 'start', `${UPDATER}.service`];
      } else {
        const service = url.searchParams.get('service');
        if (!serviceNames.includes(service)) return send(res, 400, { error: 'unknown service' });
        args = ['restart', service];
      }
      const r = await run('sudo', ['-n', SYSTEMCTL, ...args]);
      console.log(`${new Date().toISOString()} ${args.join(' ')}: ${r.ok ? 'ok' : r.err}`);
      return send(res, r.ok ? 200 : 500, { ok: r.ok, error: r.ok ? null : r.err });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('Request failed:', e);
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`Dashboard on http://${os.hostname()}.local:${PORT}`));
