/**
 * Headless CLI entry, loaded by the hidden `cli` webview window in CLI mode.
 */
import { invoke } from '@tauri-apps/api/core';
import { setCliHost } from '../../cli/host';
import { runCli } from '../../cli/main';
import { createBrowserRefineRunner } from '../lib/unwrap/browserRefinePool';
import { createWebviewHost } from './hostWebview';

async function run(): Promise<void> {
  const args = await invoke<string[]>('cli_args');
  const cwd = await invoke<string>('cli_cwd');
  const host = createWebviewHost(cwd);
  setCliHost(host);

  let code = 1;
  try {
    code = await runCli(args, {
      createRefineRunner: (config) => createBrowserRefineRunner(config.refineThreads),
    });
  } catch (error) {
    host.error(`error: ${(error as Error)?.stack ?? String(error)}\n`);
  }
  await host.flush();
  await invoke('cli_exit', { code });
}

run().catch(async (error: unknown) => {
  try {
    await invoke('cli_error', { text: `fatal: ${String(error)}\n` });
  } catch {
    // stderr unavailable; nothing more we can do.
  }
  await invoke('cli_exit', { code: 1 });
});
