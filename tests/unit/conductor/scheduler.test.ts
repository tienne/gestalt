import { afterEach, describe, expect, it } from 'vitest';
import { planSlots } from '../../../src/conductor/scheduler.js';
import { ConductorStore } from '../../../src/conductor/store.js';
import { cleanupStateDirs, order, tempStateDir, worker } from './fixtures.js';

afterEach(cleanupStateDirs);

function seed(n: number) {
  const s = ConductorStore.open(tempStateDir());
  for (let i = 0; i < n; i++) {
    s.addOrder(
      order({ id: `ord-${i}`, createdAt: `2026-11-01T00:00:${String(i).padStart(2, '0')}.000Z` }),
    );
  }
  return s;
}

describe('planSlots', () => {
  it('상한만큼만 꺼내고 나머지는 들어온 순서대로 큐에 남긴다', () => {
    const s = seed(12);
    const plan = planSlots(s, 10);
    expect(plan.toStart.map((o) => o.id)).toEqual(Array.from({ length: 10 }, (_, i) => `ord-${i}`));
    expect(plan.waiting.map((o) => o.id)).toEqual(['ord-10', 'ord-11']);
  });

  it('도는 워커가 슬롯을 차지하고 끝나면 자리가 난다', () => {
    const s = seed(3);
    s.updateOrder('ord-0', { status: 'running', workerId: 'wrk-a' });
    s.startWorker(worker('ord-0', { id: 'wrk-a' }));
    expect(planSlots(s, 2).toStart.map((o) => o.id)).toEqual(['ord-1']);
    s.updateWorker('wrk-a', { status: 'finished' });
    expect(planSlots(s, 2).toStart.map((o) => o.id)).toEqual(['ord-1', 'ord-2']);
  });

  it('상한을 줄이면 새로 띄우지 않고 도는 워커는 그대로 둔다', () => {
    const s = seed(4);
    for (const i of [0, 1, 2]) {
      s.updateOrder(`ord-${i}`, { status: 'running' });
      s.startWorker(worker(`ord-${i}`, { id: `wrk-${i}` }));
    }
    const plan = planSlots(s, 2);
    expect(plan.free).toBe(0);
    expect(plan.toStart).toEqual([]);
    expect(s.activeWorkers()).toHaveLength(3);
  });
});
