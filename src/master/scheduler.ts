import type { GestaltConfig } from '../core/config.js';
import type { MasterStore } from './store.js';
import type { Order } from './types.js';

/**
 * 동시 상한 스케줄러.
 *
 * 슬롯은 starting이나 running인 워커 수로 센다. 상한은 tick마다 설정에서 새로 읽으므로
 * 사용자가 값을 줄이면 다음 tick부터 새 워커를 덜 띄운다. 이미 도는 워커를 상한 때문에
 * 멈추지는 않는다. 자리가 나면 먼저 들어온 주문부터 사람 발화 없이 꺼낸다.
 */

export type MasterConfig = GestaltConfig['master'];

export interface SlotPlan {
  limit: number;
  active: number;
  free: number;
  /** 이번 tick에 띄울 주문. 먼저 들어온 순서다 */
  toStart: Order[];
  /** 자리가 없어 큐에 남는 주문 */
  waiting: Order[];
}

export function planSlots(store: MasterStore, limit: number): SlotPlan {
  const active = store.activeWorkers().length;
  const free = Math.max(0, limit - active);
  const queued = store.queuedOrders();
  return {
    limit,
    active,
    free,
    toStart: queued.slice(0, free),
    waiting: queued.slice(free),
  };
}
