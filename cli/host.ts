/**
 * Host abstraction for the shared CLI core.
 *
 * The CLI orchestration runs unchanged in two hosts:
 *  - Node (`cli/hostNode.ts`): `node:fs`, used by tests, the `npm run cli`
 *    development entry, and CI.
 *  - Tauri webview (`src/cli/hostWebview.ts`): Rust-backed file IO and
 *    stdout/stderr through the `cli_*` commands, used by the desktop binary.
 *
 * Unwrapping needs no image codecs, so this interface is deliberately smaller
 * than UltiPixelizer's: bytes, text, paths, and output only.
 */

export interface CliHost {
  readFileBytes(path: string): Promise<Uint8Array>;
  readFileText(path: string): Promise<string>;
  writeFileBytes(path: string, bytes: Uint8Array): Promise<void>;
  resolvePath(path: string): string;
  log(text: string): void;
  error(text: string): void;
  flush(): Promise<void>;
}

let current: CliHost | null = null;

export function setCliHost(host: CliHost): void {
  current = host;
}

export function cliHost(): CliHost {
  if (!current) throw new Error('CLI host has not been installed.');
  return current;
}
