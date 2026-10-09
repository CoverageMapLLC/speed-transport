import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

/** Builds dist/ once: the multi-process tests fork workers that load the compiled library. */
export default function setup(): void {
  const require = createRequire(import.meta.url);
  const tsc = require.resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { stdio: 'inherit' });
}
