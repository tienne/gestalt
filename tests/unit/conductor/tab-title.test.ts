/**
 * 컨덕터 세션 오르카 탭 이름 — 탭 종류 판정, 실패해도 안 던지는 것, tick이 처음 등록할 때만 바꾸는 것.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { conductorTickCommand } from '../../../src/cli/commands/conductor.js';
import type { CommandRunner } from '../../../src/conductor/launcher.js';
import {
  CONDUCTOR_TAB_TITLE,
  nameConductorTab,
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
      '--terminal',
      'term_abc',
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
    expect(await nameConductorTab({ env: {}, orcaCommand: '/orca', runner })).toMatchObject({
      renamed: false,
    });
    expect(await nameConductorTab({ env: { ORCA_TERMINAL_HANDLE: 't' }, runner })).toMatchObject({
      renamed: false,
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it('실패해도 던지지 않고 failed로 알린다', async () => {
    const env = { ORCA_TERMINAL_HANDLE: 't' };
    const exit1: CommandRunner = async () => ({ code: 1, stdout: '', stderr: 'no such terminal' });
    expect(await nameConductorTab({ env, orcaCommand: '/orca', runner: exit1 })).toMatchObject({
      renamed: false,
      failed: true,
    });
    const throws: CommandRunner = () => Promise.reject(new Error('spawn ENOENT'));
    const r = await nameConductorTab({ env, orcaCommand: '/orca', runner: throws });
    expect(r.failed).toBe(true);
    expect(r.detail).toContain('ENOENT');
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
      `terminal rename --terminal term_conductor --title ${CONDUCTOR_TAB_TITLE} --json`,
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
});
