import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentSyncConfigError,
  loadAgentSyncConfig,
  toolsFor,
} from '../../../src/agent-sync/config.js';
import {
  defaultListOrcaAccounts,
  parseOrcaAccountList,
  resolveOrcaCommand,
} from '../../../src/agent-sync/orca.js';
import { discoverTargets } from '../../../src/agent-sync/targets.js';
import { makeFixture, type Fixture } from './fixture.js';

let f: Fixture;

beforeEach(() => {
  f = makeFixture();
});

afterEach(() => f.restore());

describe('사용자 설정 (AC16)', () => {
  it('파일이 없으면 빈 기본값이다', () => {
    const config = loadAgentSyncConfig();
    expect(config.accounts).toEqual({});
    expect(toolsFor(config, 'claude')).toEqual([]);
    expect(config.rules.claudeOnly).toEqual([]);
  });

  it('~/.gestalt/agent-sync.json에서 계정 이름과 도구 목록을 읽는다', () => {
    f.writeConfig({
      tools: { all: ['git'], claude: ['git', 'jq'], codex: ['rg'] },
      accounts: { 'acct-a': { label: 'cfg-a' } },
    });
    const config = loadAgentSyncConfig();
    expect(toolsFor(config, 'claude')).toEqual(['git', 'jq']);
    expect(toolsFor(config, 'codex')).toEqual(['git', 'rg']);
    expect(config.accounts['acct-a']?.label).toBe('cfg-a');
  });

  it('JSON이 깨졌거나 형식이 다르면 어느 칸인지 알려준다', () => {
    f.write('.gestalt/agent-sync.json', '{');
    expect(() => loadAgentSyncConfig()).toThrow(AgentSyncConfigError);
    f.writeConfig({ tools: { all: 'git' } });
    expect(() => loadAgentSyncConfig()).toThrow('tools.all');
  });
});

describe('오르카 계정 목록', () => {
  const raw = {
    ok: true,
    result: {
      claude: {
        accounts: [
          {
            id: 'c1',
            home: '/x/claude-profiles/c1/home',
            managedAuthRuntime: 'host',
            organizationName: 'org-a',
          },
          { id: 'c2', home: '/wsl/home', managedAuthRuntime: 'wsl' },
          { home: '/no-id' },
        ],
      },
      codex: { accounts: [{ id: 'x1', managedHomeRuntime: 'host', workspaceLabel: 'ws-b' }] },
    },
  };

  it('호스트 계정만 읽고 봉투가 없어도 읽는다', () => {
    const expected = [
      { kind: 'claude', id: 'c1', home: '/x/claude-profiles/c1/home', label: 'org-a' },
      { kind: 'codex', id: 'x1', home: undefined, label: 'ws-b' },
    ];
    expect(parseOrcaAccountList(JSON.stringify(raw))).toEqual(expected);
    expect(parseOrcaAccountList(JSON.stringify(raw.result))).toEqual(expected);
  });

  it('명령은 설정값, ORCA_CLI_COMMAND, orca 순서로 고른다', () => {
    const saved = process.env['ORCA_CLI_COMMAND'];
    try {
      process.env['ORCA_CLI_COMMAND'] = '/env/orca';
      expect(resolveOrcaCommand('/conf/orca')).toBe('/conf/orca');
      expect(resolveOrcaCommand()).toBe('/env/orca');
      delete process.env['ORCA_CLI_COMMAND'];
      expect(resolveOrcaCommand()).toBe('orca');
    } finally {
      if (saved === undefined) delete process.env['ORCA_CLI_COMMAND'];
      else process.env['ORCA_CLI_COMMAND'] = saved;
    }
  });

  it('명령을 못 부르면 계정 없이 경고만 돌려준다', () => {
    const listing = defaultListOrcaAccounts(join(f.root, 'missing-orca'))();
    expect(listing.accounts).toEqual([]);
    expect(listing.warning).toBeDefined();
  });

  it('가짜 orca 스크립트의 출력을 읽는다', () => {
    const script = join(f.root, 'fake-orca');
    writeFileSync(script, `#!/bin/sh\necho '${JSON.stringify(raw)}'\n`);
    chmodSync(script, 0o755);
    const listing = defaultListOrcaAccounts(script)();
    expect(listing.warning).toBeUndefined();
    expect(listing.accounts.map((a) => a.id)).toEqual(['c1', 'x1']);
  });
});

describe('대상 홈 찾기 (AC9)', () => {
  function seedHomes() {
    for (const p of [
      f.claudeA,
      f.claudeB,
      f.codexX,
      join(f.home, '.claude'),
      join(f.home, '.codex'),
    ])
      mkdirSync(p, { recursive: true });
  }

  it('시스템 홈과 오르카 계정 홈 전부를 넣고 Codex 계정 홈은 데이터 폴더에서 만든다', () => {
    seedHomes();
    const d = f.discover();
    expect(d.targets.map((t) => [t.label, t.home])).toEqual([
      ['Claude 시스템', join(f.home, '.claude')],
      ['Codex 시스템', join(f.home, '.codex')],
      ['Claude 계정 org-a', f.claudeA],
      ['Claude 계정 org-b', f.claudeB],
      ['Codex 계정 ws-x', f.codexX],
    ]);
    expect(d.skipped).toEqual([]);
  });

  it('설정의 이름이 오르카 이름을 이기고 skip한 계정과 없는 폴더는 이유와 함께 건너뛴다', () => {
    seedHomes();
    f.writeConfig({
      accounts: { 'acct-a': { label: 'cfg-a' }, 'acct-b': { skip: true } },
    });
    const d = f.discover();
    expect(d.targets.map((t) => t.label)).toContain('Claude 계정 cfg-a');
    expect(d.skipped).toEqual([
      { label: 'Claude 계정 org-b', home: f.claudeB, reason: '사용자 설정에서 제외했어요' },
    ]);
  });

  it('폴더가 없는 홈은 건너뛰고 같은 폴더를 가리키는 홈은 한 번만 넣는다', () => {
    mkdirSync(join(f.home, '.claude'), { recursive: true });
    const d = discoverTargets({
      home: f.home,
      config: loadAgentSyncConfig(),
      listOrcaAccounts: () => ({
        accounts: [
          { kind: 'claude', id: 'same', home: join(f.home, '.claude'), label: 'dup' },
          { kind: 'claude', id: 'nohome' },
        ],
        warning: 'orca 경고',
      }),
    });
    expect(d.targets.map((t) => t.label)).toEqual(['Claude 시스템']);
    expect(d.skipped.map((s) => s.reason)).toEqual([
      '폴더가 없어요',
      '오르카가 계정 홈을 알려주지 않았어요',
    ]);
    expect(d.warnings).toEqual(['orca 경고']);
  });
});
