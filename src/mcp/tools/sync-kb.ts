import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { log } from '../../core/log.js';

export interface SyncKbInput {
  sourcePath?: string;
  targetPath: string;
}

export async function handleSyncKb(input: SyncKbInput, cwd: string): Promise<string> {
  const sourcePath = input.sourcePath ?? path.join(cwd, '.gestalt-kb');
  const { targetPath } = input;

  log(`sync-kb: sourcePath=${sourcePath}, targetPath=${targetPath}`);

  try {
    await fs.cp(sourcePath, targetPath, { recursive: true, force: true });
    log(`sync-kb: done`);

    return JSON.stringify(
      {
        sourcePath,
        targetPath,
        success: true,
      },
      null,
      2,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log(`sync-kb error: ${message}`);
    return JSON.stringify({ error: message, sourcePath, targetPath }, null, 2);
  }
}
