/**
 * Node CLI host. Used by `npm run cli`, the test suite, and CI. The shipped
 * desktop binary uses the webview host instead; the pipeline is identical.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { CliHost } from './host';

export const nodeCliHost: CliHost = {
  async readFileBytes(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(path));
  },

  async readFileText(path: string): Promise<string> {
    return readFile(path, 'utf8');
  },

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: 'w' });
  },

  resolvePath(path: string): string {
    return resolve(path);
  },

  log(text: string): void {
    process.stdout.write(text);
  },

  error(text: string): void {
    process.stderr.write(text);
  },

  async flush(): Promise<void> {
    // Direct writes need no flush.
  },
};
