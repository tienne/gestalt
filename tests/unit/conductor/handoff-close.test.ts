/**
 * 인계한 이전 지휘자 탭 닫기 — 새 세션의 tick이 기한 뒤에 닫는다. 새 세션 근거가 없거나 채팅 탭이면 남긴다.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  conductorHandoffCommand,
  conductorTickCommand,
} from '../../../src/cli/commands/conductor.js';
import { closeHandedOffTabs, handoffCloseLine } from '../../../src/conductor/handoff-close.js';
import {
  readHandoffRecord,
  recordHandoff,
  registerSession,
  type HandoffRecord,
} from '../../../src/conductor/handoff.js';
import type { CommandRunner } from '../../../src/conductor/launcher.js';
import { cleanupStateDirs, tempStateDir } from './fixtures.js';

const HANDED_AT = new Date('2026-11-14T00:00:00Z');
const at = (sec: number) => new Date(HANDED_AT.getTime() + sec * 1000);

let base: string;

beforeEach(() => {
  base = resolve('.gestalt-test', `conductor-handoff-close-${randomUUID()}`);
  mkdirSync(base, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  cleanupStateDirs();
  rmSync(base, { recursive: true, force: true });
});

function handedOff(stateDir: string, over: Partial<HandoffRecord> = {}): string {
  const old = randomUUID();
  registerSession(stateDir, old, '/w', new Date(HANDED_AT.getTime() - 3_600_000));
  recordHandoff(stateDir, old, {
    at: HANDED_AT.toISOString(),
    file: '/h.md',
    launched: true,
    detail: '띄웠어요',
    previousTab: { kind: 'terminal', handle: 'term_old' },
    ...over,
  });
  return old;
}

function recorder(code = 0): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: CommandRunner = (_cmd, args) => {
    calls.push(args);
    return Promise.resolve({ code, stdout: '', stderr: code ? 'no such terminal' : '' });
  };
  return { runner, calls };
}

describe('closeHandedOffTabs', () => {
  it('기한 안에 새 세션이 등록됐으면 기한 뒤 tick에서 이전 터미널 탭을 한 번만 닫는다', async () => {
    const stateDir = tempStateDir();
    const old = handedOff(stateDir);
    const fresh = randomUUID();
    registerSession(stateDir, fresh, '/w', at(30));
    const { runner, calls } = recorder();
    const opts = { stateDir, sessionId: fresh, closeAfterSec: 600, orcaCommand: 'orca', runner };

    expect(await closeHandedOffTabs({ ...opts, now: at(599) })).toEqual([]);
    expect(calls).toEqual([]);

    const done = await closeHandedOffTabs({ ...opts, now: at(600) });
    expect(done).toEqual([{ sessionId: old, state: 'closed', detail: expect.any(String) }]);
    expect(calls).toEqual([['terminal', 'close', '--terminal=term_old', '--tab', '--json']]);
    expect(readHandoffRecord(stateDir, old)?.close).toMatchObject({ state: 'closed' });

    expect(await closeHandedOffTabs({ ...opts, now: at(1200) })).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('기한 안에 새 세션의 첫 tick이 없었으면 닫지 않고 남긴다', async () => {
    const stateDir = tempStateDir();
    const old = handedOff(stateDir);
    const late = randomUUID();
    registerSession(stateDir, late, '/w', at(601));
    const { runner, calls } = recorder();
    const done = await closeHandedOffTabs({
      stateDir,
      sessionId: late,
      closeAfterSec: 600,
      now: at(700),
      orcaCommand: 'orca',
      runner,
    });
    expect(done).toEqual([
      { sessionId: old, state: 'skipped', detail: expect.stringContaining('첫 tick이 없어') },
    ]);
    expect(calls).toEqual([]);
  });

  it('인계 전부터 있던 세션은 새 세션 근거로 안 친다', async () => {
    const stateDir = tempStateDir();
    const other = randomUUID();
    registerSession(stateDir, other, '/w', at(-10));
    const old = handedOff(stateDir);
    const { runner, calls } = recorder();
    const done = await closeHandedOffTabs({
      stateDir,
      sessionId: other,
      closeAfterSec: 600,
      now: at(700),
      orcaCommand: 'orca',
      runner,
    });
    expect(done).toEqual([{ sessionId: old, state: 'skipped', detail: expect.any(String) }]);
    expect(calls).toEqual([]);
  });

  it('띄우지 못한 인계와 탭을 모르는 기록, 0초 설정은 건드리지 않는다', async () => {
    const stateDir = tempStateDir();
    const notLaunched = handedOff(stateDir, { launched: false });
    const noTab = handedOff(stateDir, { previousTab: undefined });
    const fresh = randomUUID();
    registerSession(stateDir, fresh, '/w', at(30));
    const { runner, calls } = recorder();
    const opts = { stateDir, sessionId: fresh, now: at(700), orcaCommand: 'orca', runner };
    expect(await closeHandedOffTabs({ ...opts, closeAfterSec: 600 })).toEqual([]);
    const third = handedOff(stateDir);
    expect(await closeHandedOffTabs({ ...opts, closeAfterSec: 0 })).toEqual([]);
    expect(calls).toEqual([]);
    for (const id of [notLaunched, noTab, third])
      expect(readHandoffRecord(stateDir, id)?.close).toBeUndefined();
  });

  it('채팅 탭이거나 오르카가 없으면 닫지 않고 경고로 남긴다', async () => {
    const stateDir = tempStateDir();
    const chat = handedOff(stateDir, { previousTab: { kind: 'chat' } });
    const fresh = randomUUID();
    registerSession(stateDir, fresh, '/w', at(30));
    const { runner, calls } = recorder();
    const [r] = await closeHandedOffTabs({
      stateDir,
      sessionId: fresh,
      closeAfterSec: 600,
      now: at(700),
      orcaCommand: 'orca',
      runner,
    });
    expect(r).toMatchObject({ sessionId: chat, state: 'skipped' });
    expect(r!.detail).toContain('채팅 탭');
    expect(handoffCloseLine(r!)).toMatch(/^경고: /);

    const term = handedOff(stateDir);
    const [r2] = await closeHandedOffTabs({
      stateDir,
      sessionId: fresh,
      closeAfterSec: 600,
      now: at(700),
    });
    expect(r2).toMatchObject({ sessionId: term, state: 'skipped' });
    expect(r2!.detail).toContain('오르카가 없어');
    expect(calls).toEqual([]);
  });

  it('닫기가 실패하면 failed로 남기고 다시 시도하지 않는다', async () => {
    const stateDir = tempStateDir();
    const old = handedOff(stateDir);
    const fresh = randomUUID();
    registerSession(stateDir, fresh, '/w', at(30));
    const { runner, calls } = recorder(2);
    const opts = {
      stateDir,
      sessionId: fresh,
      closeAfterSec: 600,
      now: at(700),
      orcaCommand: 'orca',
      runner,
    };
    const [r] = await closeHandedOffTabs(opts);
    expect(r).toMatchObject({ sessionId: old, state: 'failed' });
    expect(r!.detail).toContain('no such terminal');
    expect(await closeHandedOffTabs(opts)).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe('handoff 명령과 tick', () => {
  function fakeOrca(): { bin: string; log: string } {
    const log = join(base, 'orca-calls');
    const bin = join(base, 'orca');
    const reply = join(base, 'launch-reply.json');
    writeFileSync(
      reply,
      JSON.stringify({ result: { launch: { outcome: { kind: 'terminal', handle: 'term_new' } } } }),
    );
    writeFileSync(
      bin,
      [
        '#!/bin/sh',
        `echo "$@" >> '${log}'`,
        'if [ "$1" = agent ]; then',
        `  cat '${reply}'`,
        'fi',
        'exit 0',
        '',
      ].join('\n'),
    );
    chmodSync(bin, 0o755);
    return { bin, log };
  }

  it('오르카로 띄우면 넘긴 탭을 적고 새 세션의 tick이 기한 뒤 그 탭을 닫는다', async () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((v: unknown) => void out.push(String(v)));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const stateDir = tempStateDir();
    const { bin, log } = fakeOrca();
    vi.stubEnv('ORCA_CLI_COMMAND', bin);
    vi.stubEnv('GESTALT_HOME', base);
    vi.stubEnv('ORCA_STRUCTURED_SESSION', '');
    vi.stubEnv('ORCA_TERMINAL_HANDLE', 'term_old');
    vi.stubEnv('GESTALT_CONDUCTOR_WORKER_ID', '');
    const old = randomUUID();
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', old);
    const notes = join(base, 'notes.md');
    writeFileSync(notes, '- 규칙');
    await conductorHandoffCommand({ stateDir, json: true, notesFile: notes });
    const record = readHandoffRecord(resolve(stateDir), old)!;
    expect(record.previousTab).toEqual({ kind: 'terminal', handle: 'term_old' });

    // 인계 시각을 앞당겨 기한이 지난 것처럼 만들고 새 세션은 그 안에 등록된 것으로 둔다
    const fresh = randomUUID();
    const handedAt = new Date(Date.now() - 700_000);
    recordHandoff(resolve(stateDir), old, { ...record, at: handedAt.toISOString() });
    registerSession(resolve(stateDir), fresh, '/w', new Date(handedAt.getTime() + 30_000));
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', fresh);
    vi.stubEnv('ORCA_TERMINAL_HANDLE', 'term_new');
    await conductorTickCommand({ stateDir, json: true, force: true, queue: false, prWatch: false });
    const report = JSON.parse(out.at(-1)!) as { handoffClose?: unknown[] };
    expect(report.handoffClose).toEqual([
      { sessionId: old, state: 'closed', detail: expect.stringContaining('term_old') },
    ]);
    const calls = readFileSync(log, 'utf-8').trim().split('\n');
    expect(calls).toContain('terminal close --terminal=term_old --tab --json');
  });

  it('띄우지 않은 인계는 넘긴 탭을 적지 않는다', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const stateDir = tempStateDir();
    vi.stubEnv('ORCA_TERMINAL_HANDLE', 'term_old');
    vi.stubEnv('ORCA_STRUCTURED_SESSION', '');
    vi.stubEnv('GESTALT_CONDUCTOR_WORKER_ID', '');
    const old = randomUUID();
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', old);
    const notes = join(base, 'notes.md');
    writeFileSync(notes, '- 규칙');
    await conductorHandoffCommand({ stateDir, json: true, notesFile: notes, launch: false });
    const record = readHandoffRecord(resolve(stateDir), old)!;
    expect(record.launched).toBe(false);
    expect(record.previousTab).toBeUndefined();
    expect(existsSync(join(base, 'orca-calls'))).toBe(false);
  });
});
