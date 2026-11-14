// Writes the Tauri installer version to src-tauri/tauri.version.json.
//
// The version comes from scripts/build-version.mjs (the same git commit count
// the frontend badge uses), so the installer and the in-app version never
// disagree. `tauri build` merges this file into the bundle config via
// `--config`, locally and in CI.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const version = execFileSync('node', ['scripts/build-version.mjs'], {
  encoding: 'utf8',
}).trim();
writeFileSync('src-tauri/tauri.version.json', `${JSON.stringify({ version }, null, 2)}\n`);
console.log(`Wrote src-tauri/tauri.version.json (version ${version})`);
