import { setCliHost } from './host';
import { nodeCliHost } from './hostNode';
import { runCli } from './main';

setCliHost(nodeCliHost);

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
