import { BUILD_VERSION } from '../src/lib/buildInfo';
import { cliHost } from './host';

const HELP = `UltiUnwrapper CLI

Usage:
  ultiunwrapper --input <model> [--output <model>] [options]

The unwrap pipeline is implemented in the next build step of this repository.
`;

export async function runCli(argv: string[]): Promise<number> {
  const host = cliHost();
  if (argv.includes('--version')) {
    host.log(`UltiUnwrapper ${BUILD_VERSION}\n`);
    await host.flush();
    return 0;
  }
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
    host.log(HELP);
    await host.flush();
    return argv.length === 0 ? 2 : 0;
  }
  host.error('error: the unwrap CLI is not wired yet. Run npm run dev for the app shell.\n');
  await host.flush();
  return 2;
}
