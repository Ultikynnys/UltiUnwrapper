import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setCliHost } from './host';
import { nodeCliHost } from './hostNode';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.env.VITE_BUILD_VERSION = execFileSync(
    'node',
    [resolve(root, 'scripts/build-version.mjs')],
    { cwd: root, encoding: 'utf8' },
  ).trim();
  process.env.VITE_COMMIT_SHA = execFileSync(
    'git',
    ['rev-parse', '--short', 'HEAD'],
    { cwd: root, encoding: 'utf8' },
  ).trim();
} catch {
  // Keep the dev fallback when git or the version script is unavailable.
}

setCliHost(nodeCliHost);
const { runCli } = await import('./main');

runCli(process.argv.slice(2))
  .then(async (code) => {
    await nodeCliHost.flush();
    process.exitCode = code;
  })
  .catch(async (error: unknown) => {
    nodeCliHost.error(`error: ${(error as Error)?.stack ?? String(error)}\n`);
    await nodeCliHost.flush();
    process.exitCode = 1;
  });
