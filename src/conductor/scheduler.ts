import type { GestaltConfig } from '../core/config.js';
import type { ConductorStore } from './store.js';
import type { Order } from './types.js';
import {
  orderWorkClass,
  totalLimit,
  WORK_CLASSES,
  workerWorkClass,
  type WorkClass,
  type WorkerLimits,
} from './work-class.js';

/**
 * 작업 유형별 동시 상한 스케줄러.
 *
 * 슬롯은 starting이나 running인 워커 수로 유형마다 따로 센다. 전체 한도는 유형별 한도를 더한 값이고
 * 따로 두 번째 상한을 두지 않는다. 상한은 tick마다 설정에서 새로 읽으므로 사용자가 값을 줄이면 다음
 * tick부터 그 유형의 새 워커를 덜 띄운다. 이미 도는 워커를 상한 때문에 멈추지는 않는다.
 * 한 유형이 꽉 차도 다른 유형에 자리가 있으면 그 유형의 대기 주문을 먼저 들어온 순서대로 꺼낸다.
 */

export type ConductorConfig = GestaltConfig['conductor'];

export interface ClassSlot {
  limit: number;
  active: number;
  free: number;
}

export interface SlotPlan {
  /** 유형별 한도의 합 */
  limit: number;
  active: number;
  free: number;
  byClass: Record<WorkClass, ClassSlot>;
  /** 이번 tick에 띄울 주문. 유형마다 빈 자리만큼, 먼저 들어온 순서다 */
  toStart: Order[];
  /** 자기 유형에 자리가 없어 큐에 남는 주문 */
  waiting: Order[];
}

/** 유형별로 도는 워커 수. 옛 워커는 주문의 스킬 체인으로 유형을 고른다 */
export function activeByClass(store: ConductorStore): Record<WorkClass, number> {
  const counts: Record<WorkClass, number> = { lookup: 0, review: 0, work: 0 };
  for (const w of store.activeWorkers()) counts[workerWorkClass(w, store.order(w.orderId))]++;
  return counts;
}

export function planSlots(store: ConductorStore, limits: Readonly<WorkerLimits>): SlotPlan {
  const counts = activeByClass(store);
  const byClass = Object.fromEntries(
    WORK_CLASSES.map((c) => {
      const limit = limits[c];
      return [c, { limit, active: counts[c], free: Math.max(0, limit - counts[c]) }];
    }),
  ) as Record<WorkClass, ClassSlot>;
  const left = Object.fromEntries(WORK_CLASSES.map((c) => [c, byClass[c].free])) as Record<
    WorkClass,
    number
  >;
  const toStart: Order[] = [];
  const waiting: Order[] = [];
  for (const order of store.queuedOrders()) {
    const c = orderWorkClass(order);
    if (left[c] > 0) {
      left[c]--;
      toStart.push(order);
    } else waiting.push(order);
  }
  const active = WORK_CLASSES.reduce((sum, c) => sum + counts[c], 0);
  return {
    limit: totalLimit(limits),
    active,
    free: WORK_CLASSES.reduce((sum, c) => sum + byClass[c].free, 0),
    byClass,
    toStart,
    waiting,
  };
}
