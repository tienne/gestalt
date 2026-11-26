import { afterEach, describe, expect, it } from 'vitest';
import { planSlots } from '../../../src/conductor/scheduler.js';
import { ConductorStore } from '../../../src/conductor/store.js';
import type { Order } from '../../../src/conductor/types.js';
import {
  classifyWork,
  DEFAULT_WORKER_LIMITS,
  orderWorkClass,
  totalLimit,
} from '../../../src/conductor/work-class.js';
import { cleanupStateDirs, order, tempStateDir, worker } from './fixtures.js';

afterEach(cleanupStateDirs);

const at = (i: number) => `2026-11-01T00:00:${String(i).padStart(2, '0')}.000Z`;
const limits = (work: number, review = 5, lookup = 5) => ({ lookup, review, work });

function seed(n: number, over: Partial<Order> = {}, prefix = 'ord') {
  const s = ConductorStore.open(tempStateDir());
  add(s, n, over, prefix);
  return s;
}

function add(s: ConductorStore, n: number, over: Partial<Order> = {}, prefix = 'ord', from = 0) {
  for (let i = 0; i < n; i++)
    s.addOrder(order({ id: `${prefix}-${i}`, createdAt: at(from + i), ...over }));
}

describe('planSlots', () => {
  it('상한만큼만 꺼내고 나머지는 들어온 순서대로 큐에 남긴다', () => {
    const s = seed(12);
    const plan = planSlots(s, limits(10));
    expect(plan.toStart.map((o) => o.id)).toEqual(Array.from({ length: 10 }, (_, i) => `ord-${i}`));
    expect(plan.waiting.map((o) => o.id)).toEqual(['ord-10', 'ord-11']);
  });

  it('도는 워커가 슬롯을 차지하고 끝나면 자리가 난다', () => {
    const s = seed(3);
    s.updateOrder('ord-0', { status: 'running', workerId: 'wrk-a' });
    s.startWorker(worker('ord-0', { id: 'wrk-a' }));
    expect(planSlots(s, limits(2)).toStart.map((o) => o.id)).toEqual(['ord-1']);
    s.updateWorker('wrk-a', { status: 'finished' });
    expect(planSlots(s, limits(2)).toStart.map((o) => o.id)).toEqual(['ord-1', 'ord-2']);
  });

  it('상한을 줄이면 새로 띄우지 않고 도는 워커는 그대로 둔다', () => {
    const s = seed(4);
    for (const i of [0, 1, 2]) {
      s.updateOrder(`ord-${i}`, { status: 'running' });
      s.startWorker(worker(`ord-${i}`, { id: `wrk-${i}` }));
    }
    const plan = planSlots(s, limits(2));
    expect(plan.byClass.work.free).toBe(0);
    expect(plan.toStart).toEqual([]);
    expect(s.activeWorkers()).toHaveLength(3);
  });

  it('기본 한도의 합 20이 전체 한도다', () => {
    expect(totalLimit(DEFAULT_WORKER_LIMITS)).toBe(20);
    const s = seed(0);
    const plan = planSlots(s, DEFAULT_WORKER_LIMITS);
    expect(plan.limit).toBe(20);
    expect(plan.free).toBe(20);
  });

  it('사용자가 유형 한도를 바꾸면 전체 한도도 그 합으로 바뀐다', () => {
    const s = seed(0);
    expect(planSlots(s, limits(3, 1, 2)).limit).toBe(6);
  });

  it('작업 슬롯이 꽉 차도 리뷰와 조회 주문은 빈 자리에 뜬다', () => {
    const s = seed(3);
    add(s, 2, { skillChain: ['review-loop'] }, 'rev', 10);
    add(s, 1, { skillChain: ['blast-radius'] }, 'look', 20);
    s.updateOrder('ord-0', { status: 'running' });
    s.startWorker(worker('ord-0', { id: 'wrk-0', workClass: 'work' }));
    const plan = planSlots(s, limits(1, 1, 1));
    expect(plan.toStart.map((o) => o.id)).toEqual(['rev-0', 'look-0']);
    expect(plan.waiting.map((o) => o.id)).toEqual(['ord-1', 'ord-2', 'rev-1']);
    expect(plan.byClass).toEqual({
      lookup: { limit: 1, active: 0, free: 1 },
      review: { limit: 1, active: 0, free: 1 },
      work: { limit: 1, active: 1, free: 0 },
    });
  });

  it('유형 칸이 없는 옛 주문과 워커는 스킬 체인으로 슬롯을 고른다', () => {
    const s = seed(1, { skillChain: ['review'] }, 'old');
    add(s, 1, { skillChain: ['review'] }, 'new', 5);
    s.updateOrder('old-0', { status: 'running' });
    s.startWorker(worker('old-0', { id: 'wrk-old' }));
    const plan = planSlots(s, limits(10, 1));
    expect(plan.byClass.review.active).toBe(1);
    expect(plan.toStart).toEqual([]);
    expect(plan.waiting.map((o) => o.id)).toEqual(['new-0']);
  });

  it('워커가 띄울 때 남긴 유형이 주문 칸보다 먼저다', () => {
    const s = seed(1, { workClass: 'review' });
    s.updateOrder('ord-0', { status: 'running' });
    s.startWorker(worker('ord-0', { id: 'wrk-0', workClass: 'work' }));
    expect(planSlots(s, limits(10)).byClass.work.active).toBe(1);
  });
});

describe('classifyWork', () => {
  it('조회 스킬만 있으면 조회다', () => {
    expect(classifyWork(['blast-radius'])).toBe('lookup');
    expect(classifyWork(['diff-radius', 'explain'])).toBe('lookup');
  });

  it('리뷰와 재리뷰는 리뷰다. 조회가 섞여도 리뷰다', () => {
    expect(classifyWork(['review'])).toBe('review');
    expect(classifyWork(['review-loop'])).toBe('review');
    expect(classifyWork(['blast-radius', 'review'])).toBe('review');
  });

  it('구현 체인은 안에 리뷰 단계가 있어도 작업이다', () => {
    expect(classifyWork(['solve', 'ship'])).toBe('work');
    expect(classifyWork(['execute', 'review'])).toBe('work');
    expect(classifyWork(['review-reply'])).toBe('work');
  });

  it('모르는 스킬과 레포 스킬, 빈 체인은 작업이다', () => {
    expect(classifyWork([])).toBe('work');
    expect(classifyWork(['repo:deploy'])).toBe('work');
    expect(classifyWork(['something-new'])).toBe('work');
  });

  it('주문에 남긴 유형이 스킬 체인보다 먼저다', () => {
    expect(orderWorkClass({ workClass: 'lookup', skillChain: ['solve'] })).toBe('lookup');
    expect(orderWorkClass({ skillChain: ['review'] })).toBe('review');
  });
});
