import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

function gitValue(args: string[], fallback: string): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim() || fallback;
  } catch {
    return fallback;
  }
}

const versionScript = fileURLToPath(new URL('./scripts/build-version.mjs', import.meta.url));
let buildVersion = '0.1.0';
try {
  buildVersion = execFileSync(process.execPath, [versionScript], { encoding: 'utf8' }).trim();
} catch {
  // A source tarball without git history still gets a usable version.
}
process.env.VITE_BUILD_VERSION ??= buildVersion;
process.env.VITE_COMMIT_SHA ??= gitValue(['rev-parse', '--short', 'HEAD'], 'LOCAL');

export default defineConfig({
  base: './',
  server: {
    // Native fs.watch fails on this filesystem (Z: mount, UNKNOWN error);
    // polling keeps the dev server alive.
    watch: {
      usePolling: true,
    },
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      // Two entry points: the visible app (`index.html`) and the headless CLI
      // page (`cli.html`) the desktop binary loads into a hidden window.
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        cli: fileURLToPath(new URL('./cli.html', import.meta.url)),
      },
    },
  },
  test: {
    environment: 'node',
    exclude: ['**/.reasonix/**', '**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      include: ['src/lib/unwrap/**/*.ts', 'cli/config.ts', 'cli/main.ts'],
      reporter: ['text', 'json-summary'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/.{nyc_output,c8,istanbul}/**',
        '**/*.d.ts',
        '**/test?(s)/**',
        '**/{test,tests,__tests__}/**',
        '**/{vitest,vite}.config.*',
        'src/lib/unwrap/unwrap.worker.ts',
        'src/lib/unwrap/types.ts',
      ],
      thresholds: {
        lines: 95,
        functions: 100,
        statements: 95,
        branches: 85,
      },
    },
  },
});
