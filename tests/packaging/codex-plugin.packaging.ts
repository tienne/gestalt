import { describe, expect, it } from 'vitest';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeNpmStub } from '../helpers/npm-stub.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

// This suite intentionally requires an existing build. It runs separately from
// ordinary source tests via test:plugin-install after build in CI and gate.
// npm acquisition is stubbed; the copied wrapper executes the real compiled CLI.
describe('built Codex plugin installation', () => {
  it('runs setup and a required scan through a copied plugin without a global CLI', () => {
    const root = mkdtempSync(join(tmpdir(), 'gestalt-plugin-cli-'));
    try {
      // CI builds before tests. Fail with an actionable message when run alone.
      const bin = join(ROOT, 'dist/bin/gestalt.js');
      expect(existsSync(bin), 'Run pnpm build before the installation integration test').toBe(true);
      const installed = join(root, 'plugin');
      cpSync(join(ROOT, 'dist/plugin'), installed, { recursive: true });
      const project = join(root, 'project');
      mkdirSync(project);
      const shim = join(root, 'npm-bin');
      mkdirSync(shim);
      const packageBin = join(root, 'package-bin');
      mkdirSync(packageBin);
      symlinkSync(bin, join(packageBin, 'gestalt'));
      // Fake only npm acquisition; the real resolver locates the local built package.
      writeNpmStub(shim, { packageBin });
      const env = {
        ...process.env,
        PATH: shim,
        GESTALT_HOME: join(root, 'home'),
        GESTALT_NO_UPDATE_CHECK: '1',
      };
      const run = (args: string[]) =>
        spawnSync(process.execPath, [join(installed, 'scripts/gestalt-cli.mjs'), ...args], {
          cwd: project,
          env,
          encoding: 'utf8',
          timeout: 20000,
        });
      const setup = run(['setup', '--client', 'codex']);
      expect(setup.status, setup.stderr).toBe(0);
      expect(JSON.parse(readFileSync(join(project, 'gestalt.json'), 'utf8')).client).toBe('codex');
      expect(run(['--version']).stdout.trim()).toBe(version);
      const file = join(project, 'scan input.md');
      writeFileSync(file, '문서를 저장했습니다.\n');
      const scan = run(['humanize-scan', '--file', file, '--register', 'report']);
      expect([0, 10], scan.stderr).toContain(scan.status);
      expect(scan.stderr).not.toContain('could not resolve');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it('runs the in-place compiled package launcher without npm on PATH', () => {
    const root = mkdtempSync(join(tmpdir(), 'gestalt-installed-package-'));
    try {
      const result = spawnSync(
        process.execPath,
        [join(ROOT, 'dist/plugin/scripts/gestalt-cli.mjs'), '--version'],
        {
          cwd: root,
          env: { ...process.env, PATH: '' },
          encoding: 'utf8',
          timeout: 20000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(version);
      expect(result.stderr).not.toContain('resolving @tienne/gestalt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});
