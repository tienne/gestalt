import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkOf, makeFixture, seedFirstSetup, snapshot, type Fixture } from './fixture.js';

const tsx = resolve('node_modules/.bin/tsx');
const bin = resolve('bin/gestalt.ts');

let f: Fixture;

beforeEach(() => {
  f = makeFixture();
  seedFirstSetup(f);
  // orca account list --json 꼴을 흉내 낸다. 실제 오르카는 부르지 않는다
  const script = join(f.root, 'fake-orca');
  const listing = {
    ok: true,
    result: {
      claude: {
        accounts: [
          { id: 'acct-a', home: f.claudeA, managedAuthRuntime: 'host', organizationName: 'org-a' },
          { id: 'acct-b', home: f.claudeB, managedAuthRuntime: 'host', organizationName: 'org-b' },
        ],
      },
      codex: { accounts: [{ id: 'cx-1', managedHomeRuntime: 'host', workspaceLabel: 'ws-x' }] },
    },
  };
  writeFileSync(script, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(listing)}\nJSON\n`);
  chmodSync(script, 0o755);
  f.writeConfig({
    orcaCommand: script,
    tools: { all: ['gestalt-test-missing-tool'] },
    rules: { claudeOnly: ['[claude-only]'] },
  });
});

afterEach(() => f.restore());

function gestalt(...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: f.home, GESTALT_HOME: f.home };
  delete env['ORCA_CLI_COMMAND'];
  const r = spawnSync(tsx, [bin, ...args], { env, encoding: 'utf-8', cwd: f.root });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('gestalt sync / doctor CLI (AC15)', () => {
  it('미리보기, 실행, 점검, 되돌리기가 터미널 명령으로 돈다', { timeout: 60_000 }, () => {
    const before = snapshot(f.home);

    const preview = gestalt('sync', '--dry-run', '--json');
    expect(preview.status).toBe(0);
    const plan = JSON.parse(preview.stdout) as {
      command: string;
      dryRun: boolean;
      targets: { label: string }[];
      changes: string[];
    };
    expect(plan.command).toBe('sync');
    expect(plan.dryRun).toBe(true);
    expect(plan.targets.map((t) => t.label)).toEqual([
      'Claude 시스템',
      'Codex 시스템',
      'Claude 계정 org-a',
      'Claude 계정 org-b',
      'Codex 계정 ws-x',
    ]);
    expect(plan.changes.length).toBeGreaterThan(0);
    expect(snapshot(f.home)).toEqual(before);

    const applied = gestalt('sync');
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain('바꾼 것');
    expect(applied.stdout).toContain('백업 폴더  ~/.gestalt/backups/');
    expect(linkOf(join(f.home, '.claude/skills'))).toBe(join(f.home, '.agents/skills'));

    const checked = gestalt('doctor');
    expect(checked.status).toBe(0);
    expect(checked.stdout).toContain('어긋난 연결이 없어요');
    expect(checked.stdout).toContain(
      'Codex 계정 ws-x: gestalt-test-missing-tool를 PATH에서 찾지 못했어요',
    );

    const reverted = gestalt('sync', '--revert');
    expect(reverted.status).toBe(0);
    expect(reverted.stdout).toContain('되돌리기:');
    expect(snapshot(f.home)).toEqual(before);

    const broken = gestalt('doctor', '--json');
    expect(broken.status).toBe(1);
    const report = JSON.parse(broken.stdout) as { ok: boolean; remaining: unknown[] };
    expect(report.ok).toBe(true);
    expect(report.remaining.length).toBeGreaterThan(0);
  });

  it('설정이 깨졌으면 이유를 stderr에 내고 1로 끝난다', { timeout: 30_000 }, () => {
    f.write('.gestalt/agent-sync.json', '{');
    const r = gestalt('doctor');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('agent-sync.json');
  });

  it('--json이면 설정 에러도 stdout에 JSON으로 내고 1로 끝난다 (Q7)', { timeout: 30_000 }, () => {
    f.write('.gestalt/agent-sync.json', '{');
    for (const args of [
      ['doctor', '--json'],
      ['sync', '--json'],
    ]) {
      const r = gestalt(...args);
      expect(r.status).toBe(1);
      const out = JSON.parse(r.stdout) as { ok: boolean; error: string };
      expect(out.ok).toBe(false);
      expect(out.error).toContain('agent-sync.json');
    }
  });

  it('--help에 옵션이 나온다', { timeout: 30_000 }, () => {
    const sync = gestalt('sync', '--help');
    expect(sync.stdout).toContain('--dry-run');
    expect(sync.stdout).toContain('--revert');
    expect(gestalt('doctor', '--help').stdout).toContain('--fix');
    expect(readFileSync(join(f.home, '.claude/CLAUDE.md'), 'utf-8')).toContain('[Tone]');
  });
});
