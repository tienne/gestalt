import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2EFailure, runE2E } from './lib/codex-e2e.js';

try {
  console.log(JSON.stringify(await runE2E(resolve(dirname(fileURLToPath(import.meta.url)), '..'))));
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'failed',
      reason: error instanceof E2EFailure ? error.reason : 'prerequisite',
      checkpoint: error instanceof E2EFailure ? error.checkpoint : undefined,
    }),
  );
  process.exitCode = 1;
}
