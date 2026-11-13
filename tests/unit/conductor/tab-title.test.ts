/**
 * 컨덕터 세션이 오르카 탭 이름을 바꾸는 동작을 검증한다. 탭 종류를 가르는 것, 실패해도 안 던지는 것,
 * tick이 세션을 처음 등록할 때만 바꾸는 것, 워커 세션의 tick은 거절돼 안 바꾸는 것을 본다.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { conductorTickCommand } from '../../../src/cli/commands/conductor.js';
import type { CommandRunner } from '../../../src/conductor/launcher.js';
import {
  CONDUCTOR_TAB_TITLE,
  handedOffTabTitle,
  nameConductorTab,
  renameHandoffTabs,
  tabRenameArgs,
} from '../../../src/conductor/tab-title.js';
import { cleanupStateDirs, tempStateDir } from './fixtures.js';

let base: string;

beforeEach(() => {
  base = resolve('.gestalt-test', `conductor-tab-${randomUUID()}`);
  mkdirSync(base, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  cleanupStateDirs();
  rmSync(base, { recursive: true, force: true });
});

describe('tabRenameArgs', () => {
  it('터미널 탭은 자기 핸들로 terminal rename을 부른다', () => {
    expect(tabRenameArgs({ ORCA_TERMINAL_HANDLE: 'term_abc' })).toEqual([
      'terminal',
      'rename',
      '--terminal=term_abc',
      '--title',
      '🤴 지휘자 세션 🤴',
      '--json',
    ]);
  });

  it('채팅 탭은 핸들이 있어도 chat rename으로 지금 채팅을 바꾼다', () => {
    expect(
      tabRenameArgs({ ORCA_STRUCTURED_SESSION: '1', ORCA_TERMINAL_HANDLE: 'structworker_x' }),
    ).toEqual(['chat', 'rename', '--name', CONDUCTOR_TAB_TITLE, '--json']);
  });

  it('오르카 밖이면 아무것도 안 한다', () => {
    expect(tabRenameArgs({})).toBeUndefined();
  });
});

describe('nameConductorTab', () => {
  it('오르카 밖이거나 CLI가 없으면 부르지 않는다', async () => {
    const runner = vi.fn<CommandRunner>();
    expect(await nameConductorTab({ env: {}, orcaCommand: '/orca', runner })).toBeUndefined();
    expect(await nameConductorTab({ env: { ORCA_TERMINAL_HANDLE: 't' }, runner })).toBeUndefined();
    expect(runner).not.toHaveBeenCalled();
  });

  it('바꾸면 실패 메시지 없이 끝난다', async () => {
    const ok = vi.fn<CommandRunner>(async () => ({ code: 0, stdout: '', stderr: '' }));
    const env = { ORCA_TERMINAL_HANDLE: 't' };
    expect(await nameConductorTab({ env, orcaCommand: '/orca', runner: ok })).toBeUndefined();
    expect(ok).toHaveBeenCalledOnce();
  });

  it('실패해도 던지지 않고 실패 메시지를 돌려준다', async () => {
    const env = { ORCA_TERMINAL_HANDLE: 't' };
    const exit1: CommandRunner = async () => ({ code: 1, stdout: '', stderr: 'no such terminal' });
    expect(await nameConductorTab({ env, orcaCommand: '/orca', runner: exit1 })).toContain(
      'rename 실패(1)',
    );
    const throws: CommandRunner = () => Promise.reject(new Error('spawn ENOENT'));
    expect(await nameConductorTab({ env, orcaCommand: '/orca', runner: throws })).toContain(
      'ENOENT',
    );
  });
});

describe('renameHandoffTabs', () => {
  const now = new Date(2026, 10, 3, 9, 0);

  function recorder(code = 0): { calls: string[][]; runner: CommandRunner } {
    const calls: string[][] = [];
    const runner: CommandRunner = async (_cmd, args) => {
      calls.push(args);
      return { code, stdout: '', stderr: code === 0 ? '' : 'nope' };
    };
    return { calls, runner };
  }

  it('넘긴 탭에는 인계 완료와 날짜를, 새 채팅 탭에는 컨덕터 이름을 붙인다', async () => {
    expect(handedOffTabTitle(now)).toBe('지휘자 세션 (인계 완료, 11/03)');
    const { calls, runner } = recorder();
    const errors = await renameHandoffTabs({
      env: { ORCA_STRUCTURED_SESSION: '1' },
      orcaCommand: '/orca',
      launched: { kind: 'chat', sessionId: 'claude_new' },
      now,
      runner,
    });
    expect(errors).toEqual([]);
    expect(calls).toEqual([
      ['chat', 'rename', '--name', '지휘자 세션 (인계 완료, 11/03)', '--json'],
      ['chat', 'rename', '--session=claude_new', '--name', CONDUCTOR_TAB_TITLE, '--json'],
    ]);
  });

  it('새 탭이 터미널이면 핸들로 바꾸고 응답에서 탭을 못 읽었으면 넘긴 탭만 바꾼다', async () => {
    const term = recorder();
    await renameHandoffTabs({
      env: { ORCA_TERMINAL_HANDLE: 'term_old' },
      orcaCommand: '/orca',
      launched: { kind: 'terminal', handle: 'term_new' },
      now,
      runner: term.runner,
    });
    expect(term.calls).toEqual([
      ['terminal', 'rename', '--terminal=term_old', '--title', handedOffTabTitle(now), '--json'],
      ['terminal', 'rename', '--terminal=term_new', '--title', CONDUCTOR_TAB_TITLE, '--json'],
    ]);
    const unknown = recorder();
    const errors = await renameHandoffTabs({
      env: { ORCA_STRUCTURED_SESSION: '1' },
      orcaCommand: '/orca',
      now,
      runner: unknown.runner,
    });
    expect(unknown.calls).toHaveLength(1);
    expect(errors).toEqual([expect.stringContaining('첫 tick')]);
  });

  it('실패해도 던지지 않고 탭마다 실패 메시지를 모은다', async () => {
    const { runner } = recorder(2);
    const errors = await renameHandoffTabs({
      env: { ORCA_STRUCTURED_SESSION: '1' },
      orcaCommand: '/orca',
      launched: { kind: 'chat', sessionId: 'claude_new' },
      now,
      runner,
    });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('rename 실패(2)');
  });

  it('러너가 던져도 탭마다 실패 메시지로 바꿔 모은다', async () => {
    const throws: CommandRunner = () => Promise.reject(new Error('spawn ENOENT'));
    const errors = await renameHandoffTabs({
      env: { ORCA_STRUCTURED_SESSION: '1' },
      orcaCommand: '/orca',
      launched: { kind: 'chat', sessionId: 'claude_new' },
      now,
      runner: throws,
    });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('spawn ENOENT');
  });
});

describe('tick의 탭 이름', () => {
  function fakeOrca(exitCode: number): { bin: string; log: string } {
    const log = join(base, 'orca-calls');
    const bin = join(base, 'orca');
    writeFileSync(bin, `#!/bin/sh\necho "$@" >> '${log}'\nexit ${exitCode}\n`);
    chmodSync(bin, 0o755);
    return { bin, log };
  }

  function stubSession(bin: string): string {
    const sid = randomUUID();
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', sid);
    vi.stubEnv('GESTALT_CONDUCTOR_WORKER_ID', '');
    vi.stubEnv('ORCA_CLI_COMMAND', bin);
    vi.stubEnv('ORCA_TERMINAL_HANDLE', 'term_conductor');
    return sid;
  }

  const tick = (stateDir: string) =>
    conductorTickCommand({ stateDir, json: true, force: true, queue: false, prWatch: false });

  it('세션을 처음 등록한 tick에서만 바꾼다', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { bin, log } = fakeOrca(0);
    stubSession(bin);
    const stateDir = tempStateDir();

    await tick(stateDir);
    await tick(stateDir);
    const calls = readFileSync(log, 'utf-8').trim().split('\n');
    expect(calls).toEqual([
      `terminal rename --terminal=term_conductor --title ${CONDUCTOR_TAB_TITLE} --json`,
    ]);
  });

  it('바꾸기가 실패해도 tick은 끝까지 돌고 stderr에 한 줄 남긴다', async () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((v: unknown) => void out.push(String(v)));
    vi.spyOn(console, 'error').mockImplementation((v: unknown) => void err.push(String(v)));
    const { bin } = fakeOrca(3);
    const sid = stubSession(bin);
    const stateDir = tempStateDir();

    await tick(stateDir);
    expect(JSON.parse(out.at(-1)!)).toHaveProperty('handoff');
    expect(existsSync(join(resolve(stateDir), 'sessions', sid, 'session.json'))).toBe(true);
    expect(err.some((l) => l.includes('rename 실패(3)'))).toBe(true);
  });

  it('워커 세션의 tick은 거절돼 탭 이름도 세션 등록도 안 남긴다', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const { bin, log } = fakeOrca(0);
    const sid = stubSession(bin);
    vi.stubEnv('GESTALT_CONDUCTOR_WORKER_ID', 'wrk-1');
    const stateDir = tempStateDir();

    await expect(tick(stateDir)).rejects.toThrow('exit 1');
    expect(existsSync(log)).toBe(false);
    expect(existsSync(join(resolve(stateDir), 'sessions', sid, 'session.json'))).toBe(false);
  });
});
