/**
 * Webview CLI host. File IO and stdout/stderr go through the Rust `cli_*`
 * commands; path resolution uses the process cwd Rust reports.
 */
import { invoke } from '@tauri-apps/api/core';
import type { CliHost } from '../../cli/host';
import { isAbsolute, join, normalizeSeparators } from '../../cli/path';

function toUint8(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  throw new Error('cli_read_file returned an unexpected payload.');
}

export function createWebviewHost(cwd: string): CliHost {
  let outBuffer = '';
  let errBuffer = '';

  return {
    async readFileBytes(path: string): Promise<Uint8Array> {
      return toUint8(await invoke('cli_read_file', { path }));
    },

    async readFileText(path: string): Promise<string> {
      const bytes = await this.readFileBytes(path);
      return new TextDecoder().decode(bytes);
    },

    async writeFileBytes(path: string, bytes: Uint8Array): Promise<void> {
      await invoke('cli_write_file', { path, data: Array.from(bytes) });
    },

    resolvePath(path: string): string {
      const normalized = normalizeSeparators(path);
      return isAbsolute(normalized) ? normalized : join(cwd, normalized);
    },

    log(text: string): void {
      outBuffer += text;
    },

    error(text: string): void {
      errBuffer += text;
    },

    async flush(): Promise<void> {
      if (outBuffer) {
        const pending = outBuffer;
        outBuffer = '';
        await invoke('cli_log', { text: pending });
      }
      if (errBuffer) {
        const pending = errBuffer;
        errBuffer = '';
        await invoke('cli_error', { text: pending });
      }
    },
  };
}
