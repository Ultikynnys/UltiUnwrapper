// UltiUnwrapper build version.
//
// The version is derived from the git commit count so every build and every
// installer can be matched back to a commit without a hardcoded number:
//
//   commit 1  -> 0.1.1
//   commit 42 -> 0.1.42
//
// The major/minor base is explicit because this repository starts its own
// history. Edit BASE_MINOR when the project leaves the 0.1 series.
//
// Usage:
//   node scripts/build-version.mjs            print the full version
//   node scripts/build-version.mjs --count    print the raw commit count
//   node scripts/build-version.mjs --count 42 print a count for tests/previews
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BASE_MAJOR = 0;
export const BASE_MINOR = 1;

export function versionFromCount(count) {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`Build count must be a non-negative integer, received ${count}.`);
  }
  return `${BASE_MAJOR}.${BASE_MINOR}.${count}`;
}

export function buildCount() {
  try {
    const counted = execFileSync('git', ['rev-list', '--count', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const count = Number(counted);
    return Number.isInteger(count) && count >= 0 ? count : 0;
  } catch {
    // No repository or no commits yet: the first build is 0.1.0.
    return 0;
  }
}

function isMainModule() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMainModule()) {
  const args = process.argv.slice(2);
  const countOnly = args.includes('--count');
  const explicit = args.find((arg) => /^\d+$/.test(arg));
  const count = explicit === undefined ? buildCount() : Number(explicit);
  process.stdout.write(countOnly ? String(count) : versionFromCount(count));
}
