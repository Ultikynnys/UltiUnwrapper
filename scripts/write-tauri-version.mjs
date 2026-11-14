// Writes the Tauri installer version to src-tauri/tauri.version.json.
//
// The version comes from scripts/build-version.mjs (the same git commit count
// the frontend badge uses), so the installer and the in-app version never
// disagree. `tauri build` merges this file into the bundle config via
// `--config`, locally and in CI.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = execFileSync('node', [resolve(root, 'scripts/build-version.mjs')], {
  cwd: root,
  encoding: 'utf8',
}).trim();
writeFileSync(resolve(root, 'src-tauri/tauri.version.json'), `${JSON.stringify({ version }, null, 2)}\n`);
console.log(`Wrote src-tauri/tauri.version.json (version ${version})`);
