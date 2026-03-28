/**
 * Postinstall script: auto-setup agg for GIF recording support.
 * Runs after: npm install @tienne/gestalt
 *
 * - Silently skips in CI or if GESTALT_SKIP_DEPS=1
 * - Always exits 0 (never fails the install)
 */
import { AggInstaller } from '../recording/agg-installer.js';

async function main(): Promise<void> {
  if (process.env['CI'] || process.env['GESTALT_SKIP_DEPS'] === '1') {
    return;
  }

  const installer = new AggInstaller();
  if (installer.isInstalled()) return;

  process.stdout.write('\n[gestalt] agg not found — setting up GIF recording support...\n');

  try {
    await installer.ensureInstalled();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`[gestalt] Skipping agg setup: ${msg}\n`);
    process.stdout.write('[gestalt] Install manually later: https://github.com/asciinema/agg\n\n');
  }
}

main().then(() => process.exit(0)).catch(() => process.exit(0));
