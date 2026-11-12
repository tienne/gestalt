import { afterEach, describe, expect, it } from 'vitest';
import { resolveGate } from '../../../src/conductor/gates.js';
import { buildWorkerPrompt } from '../../../src/conductor/launcher.js';
import {
  detectStale,
  prepareResumes,
  resumeLaunchFor,
  saveSkillCheckpoint,
  type ShipReader,
} from '../../../src/conductor/resume.js';
import type { ShipCheckpoint } from '../../../src/ship/checkpoint.js';
import { cleanupStateDirs, clockedStore, order, worker } from './fixtures.js';

afterEach(cleanupStateDirs);

function shipAt(phase: ShipCheckpoint['phase'], round: number | null): ShipReader {
  return () => ({
    status: 'match',
    checkpoint: { phase, round } as ShipCheckpoint,
    observed: {} as never,
    mismatches: [],
  });
}

function running() {
  const c = clockedStore();
  c.store.addOrder(order({ id: 'ord-1', status: 'running', workerId: 'wrk-1' }));
  c.store.startWorker(
    worker('ord-1', {
      id: 'wrk-1',
      kind: 'git-worktree',
      handle: '/wt/ord-1',
      lastSeenAt: c.now().toISOString(),
    }),
  );
  return c;
}

describe('체크포인트', () => {
  it('끝낸 스킬은 앞 체크포인트와 합치고 ship 단계는 체크포인트 파일에서 읽는다', () => {
    const { store } = running();
    saveSkillCheckpoint(store, {
      workerId: 'wrk-1',
      skill: 'solve',
      next: '실행',
      completedSkills: [],
    });
    const cp = saveSkillCheckpoint(
      store,
      {
        workerId: 'wrk-1',
        skill: 'ship',
        next: '로컬 리뷰',
        completedSkills: ['solve'],
        shipDir: '.ship',
      },
      shipAt('2', 1),
    );
    expect(cp).toMatchObject({ phase: '2', round: 1, completedSkills: ['solve'] });
    const later = saveSkillCheckpoint(store, {
      workerId: 'wrk-1',
      skill: 'ship',
      phase: '3',
      next: 'PR',
    });
    expect(later.completedSkills).toEqual(['solve']);
    expect(() =>
      saveSkillCheckpoint(store, { workerId: 'wrk-1', skill: 'ship', phase: '9', next: 'x' }),
    ).toThrow(/ship 단계/);
    expect(() =>
      saveSkillCheckpoint(store, { workerId: '../wrk-1', skill: 'solve', next: 'x' }),
    ).toThrow(/워커 id 꼴/);
  });
});

describe('끊김 감지와 재개', () => {
  it('소식이 끊긴 워커를 멈춤으로 보고 체크포인트 자리부터 다시 띄울 재료를 만든다', () => {
    const c = running();
    saveSkillCheckpoint(
      c.store,
      {
        workerId: 'wrk-1',
        skill: 'ship',
        next: '라운드 2',
        completedSkills: ['solve'],
        shipDir: '.ship',
      },
      shipAt('2', 1),
    );
    c.advance(60_000);
    expect(detectStale(c.store, { now: c.now(), staleAfterMs: 300_000 })).toEqual([]);
    c.advance(300_000);
    expect(detectStale(c.store, { now: c.now(), staleAfterMs: 300_000 }).map((w) => w.id)).toEqual([
      'wrk-1',
    ]);

    const decisions = prepareResumes(c.store, { maxResumeAttempts: 3, readShip: shipAt('2', 2) });
    expect(decisions.map((d) => d.kind)).toEqual(['resume']);
    expect(c.store.order('ord-1')?.status).toBe('queued');

    const launch = resumeLaunchFor(c.store, c.store.order('ord-1')!, shipAt('2', 2));
    expect(launch?.previousHandle).toBe('/wt/ord-1');
    expect(launch?.context.checkpoint).toMatchObject({ phase: '2', round: 2 });
    const prompt = buildWorkerPrompt(
      c.store.order('ord-1')!,
      worker('ord-1', { id: 'wrk-2' }),
      launch!.context,
    );
    expect(prompt).toContain('남은 체인: ship');
    expect(prompt).toContain('끝낸 스킬: solve (다시 돌리지 않는다)');
  });

  it('상한을 넘으면 그 주문만 게이트를 한 번 열고 다른 주문은 계속 재개한다', () => {
    const c = running();
    c.store.addOrder(order({ id: 'ord-2', status: 'running', workerId: 'wrk-b' }));
    c.store.startWorker(
      worker('ord-2', { id: 'wrk-b', status: 'stopped', stopReason: 'rate-limit' }),
    );
    for (const n of [2, 3])
      c.store.startWorker(worker('ord-1', { id: `wrk-${n}`, attempt: n, status: 'released' }));
    c.store.updateWorker('wrk-1', { status: 'stopped', stopReason: 'account-changed' });
    saveSkillCheckpoint(c.store, {
      workerId: 'wrk-1',
      skill: 'solve',
      next: '실행',
      refs: ['plan.md'],
    });

    const out = prepareResumes(c.store, { maxResumeAttempts: 2 });
    expect(out.map((d) => `${d.order.id}:${d.kind}`).sort()).toEqual([
      'ord-1:escalate',
      'ord-2:resume',
    ]);
    const gates = c.store.openGates('ord-1');
    expect(gates).toHaveLength(1);
    expect(gates[0]?.reason).toMatch(/account-changed/);
    expect(gates[0]?.refs[0]).toMatch(/마지막 체크포인트: solve/);
    expect(c.store.order('ord-1')?.status).toBe('escalated');
    expect(prepareResumes(c.store, { maxResumeAttempts: 2 })).toEqual([]);

    c.advance(1000);
    resolveGate(c.store, gates[0]!.id, 'approved');
    expect(c.store.order('ord-1')?.status).toBe('queued');
  });

  it('체크포인트가 없으면 체인 처음부터 다시 하라고 적는다', () => {
    const c = running();
    c.store.updateWorker('wrk-1', { status: 'stopped', stopReason: 'orca-issue' });
    prepareResumes(c.store, { maxResumeAttempts: 3 });
    const launch = resumeLaunchFor(c.store, c.store.order('ord-1')!);
    expect(launch?.context).toMatchObject({
      reason: 'orca-issue',
      checkpoint: { skill: 'solve', completedSkills: [] },
    });
  });
});
