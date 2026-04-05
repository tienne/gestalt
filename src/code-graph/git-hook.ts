import { readFileSync, writeFileSync, existsSync, unlinkSync, chmodSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GESTALT_MARKER = '# GESTALT_CODE_GRAPH_HOOK';

// Absolute path to the fallback dist entry (resolved relative to this source file)
const __filename = fileURLToPath(import.meta.url);
const FALLBACK_PATH = resolve(dirname(__filename), '../../dist/code-graph/index.js');

const HOOK_SCRIPT = `#!/bin/sh
${GESTALT_MARKER} - managed by Gestalt, do not remove this comment
node --input-type=module << 'GESTALT_HOOK_EOF'
import { createRequire } from 'module';
const req = createRequire(import.meta.url);
try {
  const pkgMain = req.resolve('@tienne/gestalt');
  const { codeGraphEngine } = await import(pkgMain);
  await codeGraphEngine.build(process.cwd(), { mode: 'incremental' });
} catch {
  try {
    const { codeGraphEngine } = await import('${FALLBACK_PATH}');
    await codeGraphEngine.build(process.cwd(), { mode: 'incremental' });
  } catch {}
}
GESTALT_HOOK_EOF
`;

export class GitHookManager {
  private getHookPath(repoRoot: string): string {
    return join(repoRoot, '.git', 'hooks', 'post-commit');
  }

  /**
   * Install the Gestalt post-commit hook into the given repo root.
   * - Creates the hook file with mode 0o755 if it doesn't exist.
   * - Appends the Gestalt section to an existing file only when the marker is absent.
   * - No-ops if the marker is already present.
   */
  installHook(repoRoot: string): void {
    const hookPath = this.getHookPath(repoRoot);

    if (existsSync(hookPath)) {
      const existing = readFileSync(hookPath, 'utf-8');
      if (existing.includes(GESTALT_MARKER)) {
        // Already installed — skip
        return;
      }
      // Append to existing file preserving original content
      const appended = existing.endsWith('\n')
        ? existing + '\n' + HOOK_SCRIPT
        : existing + '\n\n' + HOOK_SCRIPT;
      writeFileSync(hookPath, appended, { encoding: 'utf-8' });
    } else {
      writeFileSync(hookPath, HOOK_SCRIPT, { encoding: 'utf-8' });
    }

    chmodSync(hookPath, 0o755);
  }

  /**
   * Remove only the Gestalt-managed section from the post-commit hook.
   * Preserves any pre-existing hook content.
   * Deletes the file entirely if it becomes empty after removal.
   */
  uninstallHook(repoRoot: string): void {
    const hookPath = this.getHookPath(repoRoot);

    if (!existsSync(hookPath)) {
      return;
    }

    const content = readFileSync(hookPath, 'utf-8');
    if (!content.includes(GESTALT_MARKER)) {
      return;
    }

    // Remove the Gestalt block: from the marker line to the end of the block.
    // Strategy: split on the marker and keep only content before it.
    // The marker line is always preceded by a newline (or is at the start).
    const markerIndex = content.indexOf(GESTALT_MARKER);
    // Walk backwards to find the beginning of the line containing the marker
    let lineStart = markerIndex;
    while (lineStart > 0 && content[lineStart - 1] !== '\n') {
      lineStart--;
    }

    const before = content.slice(0, lineStart).trimEnd();

    if (before.length === 0) {
      // Nothing remains — delete the file
      unlinkSync(hookPath);
    } else {
      writeFileSync(hookPath, before + '\n', { encoding: 'utf-8' });
    }
  }

  /**
   * Returns true if the Gestalt hook marker is present in the post-commit hook file.
   */
  isInstalled(repoRoot: string): boolean {
    const hookPath = this.getHookPath(repoRoot);
    if (!existsSync(hookPath)) {
      return false;
    }
    const content = readFileSync(hookPath, 'utf-8');
    return content.includes(GESTALT_MARKER);
  }
}

// Singleton for shared use across MCP tools
export const gitHookManager = new GitHookManager();
