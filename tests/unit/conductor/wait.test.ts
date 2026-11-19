import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { TickReport } from '../../../src/conductor/engine.js';
import {
  attentionReasons,
  claimWaitOwner,
  consumeWaitCarry,
  mergeWaitCarry,
  readSeen,
  saveWaitCarry,
  waitForAttention,
  writeSeen,
  type WaitTickOutcome,
} from '../../../src/conductor/wait.js';
import { cleanupStateDirs, tempStateDir } from './fixtures.js';

afterEach(() => cleanupStateDirs());

function report(over: Partial<TickReport> = {}): TickReport {
  return {
    at: '2026-11-15T00:00:00Z',
    created: [],
    launched: [],
    escalated: [],
    hostActions: [],
    slackPosted: [],
    jira: [],
    errors: [],
    warnings: [],
    rateLimited: [],
    humanOwned: [],
    idleTicks: 0,
    counts: {
      queued: 0,
      running: 0,
      waitingGate: 0,
      activeWorkers: 0,
      openGates: 0,
      unansweredThreads: 0,
    },
    ...over,
  };
}

const idle = (): WaitTickOutcome => ({ report: report(), handoffClose: [] });

function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

describe('attentionReasons', () => {
  it('할 일 없는 tick은 이유가 없다', () => {
    expect(attentionReasons(idle())).toEqual([]);
  });

  it('게이트, 호스트 할 일, 사람 담당 변화, 인계, 탭 닫기 결과를 이유로 본다', () => {
    const o: WaitTickOutcome = {
      report: report({
        escalated: ['gate-1'],
        hostActions: [{ kind: 'deliver' } as never],
        humanOwned: [{ orderId: 'ord-1', to: 'merged' } as never],
      }),
      handoff: { sessionId: 's', compactions: 1, thresholdPercent: 70, due: true },
      handoffClose: [{ sessionId: 'old', state: 'closed', detail: '닫음' }],
    };
    expect(attentionReasons(o)).toEqual([
      'hostActions',
      'escalated',
      'humanOwned',
      'handoff',
      'handoffClose',
    ]);
  });

  it('건너뛴 tick의 잠금 오류와 한도 대기는 이유로 안 친다', () => {
    const skipped = {
      report: report({ skipped: true, errors: ['다른 tick이 돌고 있어'] }),
      handoffClose: [],
    };
    expect(attentionReasons(skipped)).toEqual([]);
    const limited = {
      report: report({ rateLimited: [{ orderId: 'o', workerId: 'w', since: 'x' }] }),
      handoffClose: [],
    };
    expect(attentionReasons(limited)).toEqual([]);
  });

  it('접수하다 연 게이트처럼 escalated에 안 실린 게이트는 열린 수가 늘었는지로 본다', () => {
    const o = (n: number) => ({
      report: report({ counts: { ...report().counts, openGates: n } }),
      handoffClose: [],
    });
    expect(attentionReasons(o(2), new Set(), 1)).toEqual(['gatesOpened']);
    expect(attentionReasons(o(1), new Set(), 1)).toEqual([]);
    expect(attentionReasons(o(2))).toEqual([]);
  });

  it('이미 보여 준 오류와 경고는 다시 이유가 되지 않는다', () => {
    const o = {
      report: report({ errors: ['같은 오류'], warnings: ['같은 경고'] }),
      handoffClose: [],
    };
    expect(attentionReasons(o, new Set(['같은 오류', '같은 경고']))).toEqual([]);
    expect(attentionReasons(o, new Set(['같은 오류']))).toEqual(['warnings']);
  });
});

describe('waitForAttention', () => {
  it('할 일 없는 tick은 넘기고 게이트가 열린 tick에서 끝난다', async () => {
    const clock = fakeClock();
    const gate = { report: report({ escalated: ['gate-9'] }), handoffClose: [] };
    const ticks = [idle(), idle(), gate];
    const r = await waitForAttention(
      { runTick: async () => ticks.shift()!, ...clock, stillOwner: () => true },
      { maxWaitMs: 3_600_000, intervalMs: 60_000 },
    );
    expect(r.reason).toBe('attention');
    expect(r.reasons).toEqual(['escalated']);
    expect(r.ticks).toBe(3);
    expect(r.last?.report.escalated).toEqual(['gate-9']);
    expect(clock.sleeps).toEqual([60_000, 60_000]);
  });

  it('상한 시간이 지나면 할 일이 없어도 끝나고 마지막 잠은 남은 시간만큼만 잔다', async () => {
    const clock = fakeClock();
    const r = await waitForAttention(
      { runTick: async () => idle(), ...clock, stillOwner: () => true },
      { maxWaitMs: 150_000, intervalMs: 60_000 },
    );
    expect(r.reason).toBe('timeout');
    expect(r.ticks).toBe(4);
    expect(r.elapsedMs).toBe(150_000);
    expect(clock.sleeps).toEqual([60_000, 60_000, 30_000]);
  });

  it('다른 wait가 이어받으면 tick을 더 돌리지 않고 끝난다', async () => {
    const clock = fakeClock();
    let owner = true;
    let ran = 0;
    const r = await waitForAttention(
      {
        runTick: async () => {
          ran++;
          owner = false;
          return idle();
        },
        ...clock,
        stillOwner: () => owner,
      },
      { maxWaitMs: 3_600_000, intervalMs: 60_000 },
    );
    expect(r.reason).toBe('superseded');
    expect(ran).toBe(1);
  });

  it('tick 소요 시간을 빼고 쉬되 간격보다 오래 걸려도 하한만큼은 쉰다', async () => {
    const clock = fakeClock();
    const tickMs = [50_000, 90_000, 0];
    let t = 0;
    const r = await waitForAttention(
      {
        runTick: async () => {
          t += tickMs.shift()!;
          return tickMs.length === 0
            ? { report: report({ escalated: ['g'] }), handoffClose: [] }
            : idle();
        },
        now: () => clock.now() + t,
        sleep: clock.sleep,
        stillOwner: () => true,
      },
      { maxWaitMs: 3_600_000, intervalMs: 60_000 },
    );
    expect(r.reason).toBe('attention');
    expect(clock.sleeps).toEqual([10_000, 10_000]);
  });

  it('건너뛴 tick뿐이면 본 문장을 모으지 않고 같은 닫기 실패는 다시 이유가 안 된다', async () => {
    const clock = fakeClock();
    const skipped = (): WaitTickOutcome => ({
      report: report({ skipped: true, errors: ['다른 tick이 돌고 있어'] }),
      handoffClose: [],
    });
    const onlySkipped = await waitForAttention(
      { runTick: async () => skipped(), ...clock, stillOwner: () => true },
      { maxWaitMs: 120_000, intervalMs: 60_000 },
    );
    expect(onlySkipped.reason).toBe('timeout');
    expect(onlySkipped.observed).toBeUndefined();

    const fail = { sessionId: 'old', state: 'failed' as const, detail: '탭을 못 닫았어요' };
    const stuck: WaitTickOutcome = { report: report(), handoffClose: [fail] };
    const first = await waitForAttention(
      { runTick: async () => stuck, ...fakeClock(), stillOwner: () => true },
      { maxWaitMs: 120_000, intervalMs: 60_000 },
    );
    expect(first.reasons).toEqual(['handoffClose']);
    const again = await waitForAttention(
      {
        runTick: async () => stuck,
        ...fakeClock(),
        stillOwner: () => true,
        seen: new Set(first.observed),
      },
      { maxWaitMs: 120_000, intervalMs: 60_000 },
    );
    expect(again.reason).toBe('timeout');
  });
});

describe('wait 소유 표식과 본 목록', () => {
  it('나중에 뜬 wait가 표식을 가져가고 앞선 wait는 표식을 되찾지 못한다', () => {
    const dir = tempStateDir();
    const first = claimWaitOwner(dir);
    expect(first.stillOwner()).toBe(true);
    const second = claimWaitOwner(dir);
    expect(first.stillOwner()).toBe(false);
    expect(second.stillOwner()).toBe(true);
  });

  it('보여 준 오류를 쌓아 두고 다음 wait가 읽는다', () => {
    const dir = tempStateDir();
    expect(readSeen(dir).size).toBe(0);
    writeSeen(dir, new Set(), ['오류 A'], ['오류 A']);
    writeSeen(dir, readSeen(dir), ['오류 A', '경고 B'], ['경고 B']);
    expect([...readSeen(dir)]).toEqual(['오류 A', '경고 B']);
  });

  it('이번 wait에서 다시 안 나온 문장은 본 목록에서 빠져 재발하면 다시 이유가 된다', () => {
    const dir = tempStateDir();
    writeSeen(dir, new Set(), ['오류 A', '오류 B'], ['오류 A', '오류 B']);
    writeSeen(dir, readSeen(dir), ['오류 B'], []);
    const seen = readSeen(dir);
    expect([...seen]).toEqual(['오류 B']);
    const again = { report: report({ errors: ['오류 A'] }), handoffClose: [] };
    expect(attentionReasons(again, seen)).toEqual(['errors']);
  });
});

describe('wait 결과 넘김', () => {
  it('두 wait가 같은 파일 목록으로 rename을 경합해도 한쪽만 실행 요청을 받는다', async () => {
    const stateDir = resolve(tempStateDir());
    const action = { type: 'jira-transition' as const, issueKey: 'APP-1', to: 'In-QA' as const };
    saveWaitCarry(
      stateDir,
      { report: report({ hostActions: [action] }), handoffClose: [] },
      ['hostActions'],
      new Set(),
    );

    const program = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { join } from 'node:path';
      const [dir, me, other] = process.argv.slice(1);
      const list = fs.readdirSync;
      fs.readdirSync = (path, ...args) => {
        const names = list(path, ...args);
        if (path === join(dir, 'wait-carry')) {
          fs.writeFileSync(join(dir, me), '');
          const limit = Date.now() + 5000;
          while (!fs.existsSync(join(dir, other))) {
            if (Date.now() > limit) throw new Error('second wait did not list the file');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
        return names;
      };
      syncBuiltinESMExports();
      const { consumeWaitCarry } = await import('./src/conductor/wait.ts');
      consumeWaitCarry(dir, (items) => console.log(JSON.stringify(items.flatMap((i) => i.outcome.report.hostActions))));
    `;
    const run = promisify(execFile);
    const results = await Promise.all([
      run(process.execPath, [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        program,
        stateDir,
        'a',
        'b',
      ]),
      run(process.execPath, [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        program,
        stateDir,
        'b',
        'a',
      ]),
    ]);
    expect(results.flatMap(({ stdout }) => JSON.parse(stdout))).toEqual([action]);
    consumeWaitCarry(stateDir, (next) => expect(next).toEqual([]));
  }, 12_000);

  it('결과를 오래된 순으로 합치고 앞 세션의 인계는 기록으로만 전달한다', () => {
    const stateDir = tempStateDir();
    const hostAction = (issueKey: string) => ({
      type: 'jira-transition' as const,
      issueKey,
      to: 'In-QA' as const,
    });
    const save = (at: string, issue: string, handoff?: WaitTickOutcome['handoff']) =>
      saveWaitCarry(
        stateDir,
        {
          report: report({
            at,
            hostActions: [hostAction(issue)],
            errors: ['이미 본 오류'],
            warnings: [issue],
          }),
          handoffClose: [],
          ...(handoff ? { handoff } : {}),
        },
        handoff ? ['hostActions', 'handoff', 'warnings'] : ['hostActions', 'warnings'],
        new Set(['이미 본 오류']),
      );
    const oldHandoff = { sessionId: 'old', due: true, compactions: 2, thresholdPercent: 70 };
    save('2026-11-15T00:01:00.000Z', 'APP-2');
    save('2026-11-15T00:00:00.000Z', 'APP-1', oldHandoff);
    const now = {
      report: report({ at: '2026-11-15T00:00:30.000Z', hostActions: [hostAction('APP-3')] }),
      handoffClose: [],
    };
    consumeWaitCarry(stateDir, (items) => {
      const merged = mergeWaitCarry(
        { reason: 'attention', reasons: ['hostActions'], ticks: 1, elapsedMs: 1, last: now },
        items,
        'new',
      );
      expect(merged.reasons).toEqual(['hostActions', 'warnings', 'carriedHandoff']);
      expect(merged.last?.report.hostActions).toEqual(['APP-1', 'APP-3', 'APP-2'].map(hostAction));
      expect(merged.last?.report.at).toBe('2026-11-15T00:01:00.000Z');
      expect(merged.last?.report.warnings).toEqual(['APP-1', 'APP-2']);
      expect(merged.last?.report.errors).toEqual([]);
      expect(merged.last?.handoff).toBeUndefined();
      expect(merged.last?.carriedHandoffs).toEqual([oldHandoff]);
    });
  });
});
