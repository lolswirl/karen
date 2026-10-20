// Projects on this Pi that the dashboard shows and update.js keeps in sync with GitHub
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// dir may start with ~ (home folder) or be relative to this repo, so "." is Karen itself.
// Each project is named after its folder.
export async function loadProjects() {
  const list = JSON.parse(await readFile(path.join(HERE, 'projects.json'), 'utf8'));
  return list.map((p) => {
    const dir = path.resolve(HERE, p.dir.replace(/^~(?=$|\/)/, os.homedir()));
    return { ...p, dir, name: path.basename(dir) };
  });
}
