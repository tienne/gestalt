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
import type { DoctorResult } from '../../../src/agent-sync/doctor.js';
import { formatDoctor } from '../../../src/agent-sync/format.js';
import { discoverTargets } from '../../../src/agent-sync/targets.js';
import { makeFixture, type Fixture } from './fixture.js';

let f: Fixture;

const emptyDoctor: DoctorResult = {
  issues: [],
  toolWarnings: [],
  recordWarnings: [],
  fixed: [],
  hints: [],
  remaining: [],
  pruned: [],
};

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
    const rejected = [{ kind: 'claude', id: '', reason: '계정 id가 없어요' }];
    expect(parseOrcaAccountList(JSON.stringify(raw))).toEqual({ accounts: expected, rejected });
    expect(parseOrcaAccountList(JSON.stringify(raw.result))).toEqual({
      accounts: expected,
      rejected,
    });
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

  it('id에 경로 문자가 있거나 홈이 절대 경로가 아니거나 `..`이 든 계정은 이유와 함께 뺀다 (SEC-3)', () => {
    const claude = (id: string, home?: string) => ({ id, home, managedAuthRuntime: 'host' });
    const listed = parseOrcaAccountList(
      JSON.stringify({
        claude: {
          accounts: [
            claude('ok-1', '/x/home'),
            claude('../up', '/x/home'),
            claude('a/b', '/x/home'),
            claude('..', '/x/home'),
            claude('rel', 'x/home'),
            claude('dots', '/x/../etc'),
            claude('slash', '/x/home/'),
          ],
        },
      }),
    );
    expect(listed.accounts.map((a) => a.id)).toEqual(['ok-1']);
    expect(listed.rejected.map((r) => r.id)).toEqual([
      '../up',
      'a/b',
      '..',
      'rel',
      'dots',
      'slash',
    ]);
    expect(listed.rejected.every((r) => r.reason.length > 0)).toBe(true);
  });

  it('거절된 계정은 건너뛴 홈에 이유와 함께 나오고 id는 따옴표로 감싸 출력한다 (q-r2-2)', () => {
    for (const p of ['.claude', '.codex']) mkdirSync(join(f.home, p), { recursive: true });
    const script = join(f.root, 'fake-orca-bad');
    const bad = {
      claude: {
        accounts: [
          { id: 'c-ok', home: '../x', managedAuthRuntime: 'host' },
          { id: '../x', home: f.claudeA, managedAuthRuntime: 'host' },
        ],
      },
    };
    writeFileSync(script, `#!/bin/sh\necho '${JSON.stringify(bad)}'\n`);
    chmodSync(script, 0o755);
    const d = discoverTargets({
      home: f.home,
      config: loadAgentSyncConfig(),
      listOrcaAccounts: defaultListOrcaAccounts(script),
    });
    expect(d.skipped).toEqual([
      {
        label: 'Claude 계정',
        home: '',
        reason: '계정 홈이 절대 경로가 아니거나 `.`, `..`, 끝의 `/`, 겹친 `/`가 들어 있어요',
        rejectedId: 'c-ok',
      },
      {
        label: 'Claude 계정',
        home: '',
        reason: '계정 id에 쓸 수 없는 글자가 있어요',
        rejectedId: '../x',
      },
    ]);
    const out = formatDoctor(f.home, d, emptyDoctor, false);
    expect(out).toContain('Claude 계정 "../x"  (경로 없음)  계정 id에 쓸 수 없는 글자가 있어요');
  });

  it('설정이나 ORCA_CLI_COMMAND의 상대 경로 명령은 거부한다 (SEC-3)', () => {
    const saved = process.env['ORCA_CLI_COMMAND'];
    try {
      delete process.env['ORCA_CLI_COMMAND'];
      expect(() => resolveOrcaCommand('./orca')).toThrow(AgentSyncConfigError);
      expect(() => resolveOrcaCommand('bin/orca')).toThrow(AgentSyncConfigError);
      expect(resolveOrcaCommand('orca-dev')).toBe('orca-dev');
      process.env['ORCA_CLI_COMMAND'] = 'tools/orca';
      expect(() => resolveOrcaCommand()).toThrow('ORCA_CLI_COMMAND');
      process.env['ORCA_CLI_COMMAND'] = '';
      expect(resolveOrcaCommand()).toBe('orca');
    } finally {
      if (saved === undefined) delete process.env['ORCA_CLI_COMMAND'];
      else process.env['ORCA_CLI_COMMAND'] = saved;
    }
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

  it('사용자 홈이나 orcaDataDir 밖의 계정 홈은 이유와 함께 건너뛴다 (SEC-3)', () => {
    const outside = join(f.root, 'elsewhere/home');
    mkdirSync(outside, { recursive: true });
    const listOrcaAccounts = () => ({
      accounts: [{ kind: 'claude' as const, id: 'far', home: outside, label: 'far' }],
    });
    const plain = discoverTargets({
      home: f.home,
      config: loadAgentSyncConfig(),
      listOrcaAccounts,
    });
    expect(plain.skipped.filter((s) => s.label === 'Claude 계정 far')).toEqual([
      {
        label: 'Claude 계정 far',
        home: outside,
        reason:
          '계정 홈이 사용자 홈 밖이에요. 오르카 데이터 폴더가 홈 밖이면 orcaDataDir를 설정해 주세요',
      },
    ]);

    f.writeConfig({ orcaDataDir: join(f.home, 'orca-data') });
    const scoped = discoverTargets({
      home: f.home,
      config: loadAgentSyncConfig(),
      listOrcaAccounts,
    });
    expect(scoped.skipped.find((s) => s.label === 'Claude 계정 far')?.reason).toBe(
      '계정 홈이 orcaDataDir 밖이에요',
    );
  });

  it('orcaDataDir가 정리된 절대 경로가 아니면 설정 에러다 (SEC-3)', () => {
    for (const orcaDataDir of ['orca-data', '/x/../orca-data']) {
      f.writeConfig({ orcaDataDir });
      expect(() => loadAgentSyncConfig()).toThrow(AgentSyncConfigError);
    }
  });
});
