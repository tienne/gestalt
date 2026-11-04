import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(assetPath: string, content: string) {
  const dir = mkdtempSync(join(tmpdir(), 'gestalt-plugin-check-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  mkdirSync(join(dir, 'scripts'));
  const script = join(dir, 'scripts/verify-plugin-assets.ts');
  cpSync(join(ROOT, 'scripts/verify-plugin-assets.ts'), script);
  // Build the installation contract, rather than allowing a later missing-dist
  // error to make a launcher rejection appear to pass.
  const assetDirs = [
    'agents',
    'role-agents',
    'review-agents',
    'personas',
    'research-sources',
    'skills',
    'scripts',
    '.codex-plugin',
  ];
  for (const prefix of ['plugin', 'dist/plugin']) {
    for (const assetDir of assetDirs) mkdirSync(join(dir, prefix, assetDir), { recursive: true });
    const file = join(dir, prefix, assetPath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return spawnSync(
    process.execPath,
    ['--import', join(ROOT, 'node_modules/tsx/dist/loader.mjs'), script],
    {
      cwd: dir,
      env: { ...process.env, TSX_TSCONFIG_PATH: join(ROOT, 'tsconfig.json') },
      encoding: 'utf8',
      timeout: 10000,
    },
  );
}

const fenced = (command: string) => ['# Fixture', '```bash', command, '```', ''].join('\n');

describe('plugin asset launcher guard', { timeout: 15000 }, () => {
  it('rejects a source-only CLI command in a copied skill with its exact location', () => {
    const result = fixture(
      'skills/example/SKILL.md',
      fenced('pnpm tsx bin/gestalt.ts humanize-scan'),
    );
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('skills/example/SKILL.md:3');
    expect(result.stderr).toContain('런처를 거치지 않는 직접 CLI 호출');
  });

  it.each(['role-agents', 'review-agents', 'agents'])(
    'rejects a global CLI command in a copied %s agent with its exact location',
    (agentDir) => {
      const path = `${agentDir}/example/AGENT.md`;
      const result = fixture(path, fenced('gestalt humanize-scan --file report.md'));
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(`${path}:3`);
      expect(result.stderr).toContain('런처를 거치지 않는 직접 CLI 호출');
    },
  );

  it('allows a skill CLI example that shared launcher instructions translate', () => {
    const result = fixture(
      'skills/example/SKILL.md',
      fenced('gestalt humanize-scan --file report.md'),
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Verified 1 plugin assets');
    expect(result.stderr).toBe('');
  });

  it('allows version probes and ellipsis placeholders in agent examples', () => {
    const result = fixture(
      'role-agents/example/AGENT.md',
      fenced(
        [
          'pnpm tsx bin/gestalt.ts --version',
          'pnpm tsx bin/gestalt.ts ...',
          'gestalt --version',
          'gestalt ...',
        ].join('\n'),
      ),
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Verified 1 plugin assets');
    expect(result.stderr).toBe('');
  });
});
