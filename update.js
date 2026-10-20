// Deploys new GitHub commits for every project in projects.json: resets the checkout to origin/main,
// reinstalls npm packages if the project has a lockfile, and restarts its service.
// Run every minute by karen-update.timer (see install.sh), or with: node update.js
import path from 'node:path';
import { execFile } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { loadProjects } from './projects.js';

const exec = promisify(execFile);
// Must match the paths in the sudoers rule written by install.sh
const SYSTEMCTL = '/usr/bin/systemctl';

async function update(p) {
  const git = async (...args) => (await exec('git', args, { cwd: p.dir })).stdout.trim();
  await git('fetch', '--quiet', 'origin', 'main');
  const target = await git('rev-parse', 'origin/main');
  // Compare against the last commit that finished deploying, so a failed install is retried
  const marker = path.join(p.dir, '.git', 'karen-deployed');
  const deployed = (await readFile(marker, 'utf8').catch(() => '')).trim();
  if (deployed === target) return;
  // First run on a checkout that's already current: record it rather than restarting for nothing
  if (!deployed && (await git('rev-parse', 'HEAD')) === target) return writeFile(marker, target);

  // Mirror GitHub exactly: local edits to tracked files are discarded, untracked files like .env are kept
  await git('reset', '--hard', '--quiet', target);
  const hasLock = await access(path.join(p.dir, 'package-lock.json')).then(() => true, () => false);
  if (hasLock) await exec('npm', ['ci', '--omit=dev'], { cwd: p.dir, timeout: 600_000 });
  await exec('sudo', ['-n', SYSTEMCTL, 'restart', p.service]);
  await writeFile(marker, target);
  console.log(`Updated ${p.name} to ${target.slice(0, 7)}`);
}

let failed = false;
for (const p of await loadProjects()) {
  try {
    await update(p);
  } catch (e) {
    failed = true;
    console.error(`${p.name}: ${e.stderr?.trim() || e.message}`);
  }
}
process.exitCode = failed ? 1 : 0;
