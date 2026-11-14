import type { HostAction, LauncherSet } from './launcher.js';
import type { ConductorStore } from './store.js';
import {
  ACTIVE_WORKER_STATUSES,
  type Gate,
  type GateDecision,
  type Order,
  type OrderStatus,
  type Worker,
} from './types.js';

/**
 * 사람이 주문을 넘겨받거나 취소하는 자리.
 *
 * 머지 확인 자리에 "머지는 내가 한다"고 답해도 승인과 거절만 있으면 주문은 running으로 돌아간다.
 * 워커가 기다리기만 하면 끊긴 워커로 보여 새 워커가 같은 승인을 다시 묻는다. 그래서 사람이 PR을 쥐는
 * human-owned 상태를 두고 그동안 워커는 거두고 tick은 PR 머지만 지켜본다. 오래 안 움직이면 parked로
 * 내려 tick이 더 안 본다.
 *
 * 넘겨받기 없이 GitHub에서 PR을 바로 머지하거나 닫으면 워커는 끝난 PR에 계속 슬롯을 쓰고 게이트도
 * 열린 채 남는다. running, waiting-gate, escalated 주문의 PR도 같은 간격으로 보고 끝났으면 정리한 뒤 넘긴다.
 */

/** PR 상태를 읽는 어댑터. 테스트에서 바꿔 끼운다 */
export interface PrStateSource {
  state(prRef: string): Promise<PrState>;
}

export interface PrState {
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  mergedAt?: string;
}

export interface RetireResult {
  hostActions: HostAction[];
  errors: string[];
}

/** 넘겨받을 수 있는 상태. 끝났거나 이미 사람 손에 있으면 안 된다 */
const TAKE_OVER_FROM: ReadonlySet<OrderStatus> = new Set([
  'queued',
  'running',
  'waiting-gate',
  'escalated',
]);

/** 취소할 수 있는 상태. 머지된 주문은 머지 뒤 처리가 남아 있어 취소로 덮지 않는다 */
const CANCEL_FROM: ReadonlySet<OrderStatus> = new Set([...TAKE_OVER_FROM, 'human-owned', 'parked']);

/**
 * 컨덕터가 쥐고 있지만 사람이 GitHub에서 PR을 직접 머지하거나 닫을 수 있는 상태.
 * 이 상태에서 PR이 끝나면 워커와 게이트가 할 일이 없어 tick과 mark-merged가 정리하고 넘긴다
 */
const CONDUCTOR_HELD: ReadonlySet<OrderStatus> = new Set(['running', 'waiting-gate', 'escalated']);

/** 사람이 머지했다고 알릴 수 있는 상태 */
const MARK_MERGED_FROM: ReadonlySet<OrderStatus> = new Set([
  'human-owned',
  'parked',
  ...CONDUCTOR_HELD,
]);

export const TAKE_OVER_MESSAGE =
  '사람이 이 주문을 넘겨받았어요. 머지도 수정도 보고도 하지 말고 지금 종료하세요. 워크트리와 브랜치는 그대로 두세요';

export function cancelMessage(reason?: string): string {
  return `주문이 취소됐어요${reason ? `: ${reason}` : ''}. 머지하지 말고 하던 일을 멈춘 뒤 보고 없이 종료하세요`;
}

export const PR_MERGED_MESSAGE =
  'PR이 GitHub에서 직접 머지됐어요. 머지도 수정도 보고도 하지 말고 지금 종료하세요';

export const PR_CLOSED_MESSAGE =
  'PR이 머지 없이 닫혔어요. 머지도 수정도 보고도 하지 말고 지금 종료하세요';

/**
 * 컨덕터가 PR 상태를 지켜볼 주문인지. 배포 실패로 올라간 escalated 주문은 이미 mergedAt이 있어
 * 다시 merged로 넘기면 정산이 같은 실패를 되풀이하므로 뺀다
 */
function watchesPr(order: Order): boolean {
  if (order.status === 'human-owned') return true;
  return CONDUCTOR_HELD.has(order.status) && order.mergedAt === undefined;
}

function mustOrder(store: ConductorStore, orderId: string): Order {
  const order = store.order(orderId);
  if (!order) throw new Error(`모르는 주문이에요: ${orderId}`);
  return order;
}

/** 주문의 열린 게이트를 다 종료한다. 사람이 주문 자체를 정리했으니 남은 질문이 의미가 없다 */
function closeOpenGates(
  store: ConductorStore,
  orderId: string,
  decision: GateDecision,
  answer: string,
  primary?: { gateId: string; answer?: string },
): Gate[] {
  const closed: Gate[] = [];
  for (const g of store.openGates(orderId)) {
    const text = g.id === primary?.gateId && primary.answer ? primary.answer : answer;
    store.append({
      type: 'gate-resolved',
      at: store.timestamp(),
      gateId: g.id,
      decision,
      answer: text,
    });
    closed.push(store.snapshot.gates[g.id]!);
  }
  return closed;
}

/**
 * 주문을 쥔 워커를 거둔다. 살아 있으면 먼저 멈추라고 전한다.
 *
 * keepWorktree면 오르카 터미널만 닫고 git 워크트리는 건드리지 않는다. 사람이 그 자리에서 이어 손볼 수
 * 있어서다. 오르카 release는 워크트리를 안 지우고 git 워크트리 release는 지우므로 keepWorktree일 때
 * git 워크트리 워커는 release를 부르지 않는다. 거두기가 실패하면 finished로 두어 다음 tick의 정리가
 * 다시 시도하게 한다. 그 정리도 실패하면 기존대로 정리 실패 게이트로 올라간다.
 */
async function retireWorker(
  store: ConductorStore,
  launchers: LauncherSet,
  worker: Worker,
  message: string,
  opts: { keepWorktree: boolean },
): Promise<RetireResult> {
  const out: RetireResult = { hostActions: [], errors: [] };
  const live = ACTIVE_WORKER_STATUSES.has(worker.status);
  if (!live && worker.status !== 'stopped') return out;
  const launcher = launchers[worker.kind];
  if (live) {
    if (!launcher) out.errors.push(`${worker.kind} 런처가 없어 ${worker.id}에 못 전했어요`);
    else {
      try {
        const action = await launcher.send(worker, message);
        if (action) out.hostActions.push(action);
      } catch (err) {
        out.errors.push(`${worker.id}에 전하기 실패: ${(err as Error).message}`);
      }
    }
  }
  const skipRelease = opts.keepWorktree && worker.kind === 'git-worktree';
  try {
    if (!skipRelease) {
      if (!launcher) throw new Error(`${worker.kind} 런처가 없어요`);
      await launcher.release(worker);
    }
    store.updateWorker(worker.id, { status: 'released' });
  } catch (err) {
    store.updateWorker(worker.id, { status: 'finished' });
    out.errors.push(
      `${worker.id}를 못 거둬서 다음 tick 정리에 넘겼어요: ${(err as Error).message}`,
    );
  }
  return out;
}

async function stopForMergedCleanup(
  launchers: LauncherSet,
  worker: Worker,
  message: string,
): Promise<RetireResult> {
  const out: RetireResult = { hostActions: [], errors: [] };
  if (!ACTIVE_WORKER_STATUSES.has(worker.status)) return out;
  const launcher = launchers[worker.kind];
  if (!launcher) {
    out.errors.push(`${worker.kind} 런처가 없어 ${worker.id}에 못 전했어요`);
    return out;
  }
  try {
    const action = await launcher.send(worker, message);
    if (action) out.hostActions.push(action);
  } catch (err) {
    out.errors.push(`${worker.id}에 전하기 실패: ${(err as Error).message}`);
  }
  return out;
}

interface PrChangeCleanup extends RetireResult {
  closedGates: Gate[];
}

/**
 * PR이 GitHub에서 끝난 주문의 게이트를 닫고 워커를 거둔다. 상태는 호출한 쪽이 바꾼다.
 * 닫힌 주문은 order cancel처럼 바로 거두고 머지된 주문은 같은 tick의 cleanupWorkers가 거둔다
 */
async function retireForPrChange(
  store: ConductorStore,
  order: Order,
  launchers: LauncherSet,
  kind: 'merged' | 'closed',
): Promise<PrChangeCleanup> {
  const merged = kind === 'merged';
  const closedGates = closeOpenGates(
    store,
    order.id,
    'rejected',
    merged ? 'PR이 GitHub에서 직접 머지됐어요' : 'PR이 머지 없이 닫혔어요',
  );
  const out: PrChangeCleanup = { closedGates, hostActions: [], errors: [] };
  const message = merged ? PR_MERGED_MESSAGE : PR_CLOSED_MESSAGE;
  // 재개로 갈린 앞 회차가 살아 있을 수도 있어 현재 워커만 보지 않는다
  const workers = store
    .workersOf(order.id)
    .filter((w) => w.id === order.workerId || ACTIVE_WORKER_STATUSES.has(w.status));
  for (const w of workers) {
    if (merged) {
      // 머지된 주문의 release는 cleanupWorkers에 넘긴다. 여기서 거두면 removeMergedOrcaWorktrees 옵션 없이
      // released가 돼서 워크트리 정리 대상에서 빠진다
      const r = await stopForMergedCleanup(launchers, w, message);
      out.hostActions.push(...r.hostActions);
      out.errors.push(...r.errors);
      if (ACTIVE_WORKER_STATUSES.has(w.status)) store.updateWorker(w.id, { status: 'finished' });
      continue;
    }
    const r = await retireWorker(store, launchers, w, message, { keepWorktree: false });
    out.hostActions.push(...r.hostActions);
    out.errors.push(...r.errors);
  }
  return out;
}

export interface TakeOverResult extends RetireResult {
  order: Order;
  closedGates: Gate[];
  /** PR이 없어 머지를 지켜볼 수 없을 때 알린다 */
  warnings: string[];
}

/**
 * 사람이 주문을 넘겨받는다. 게이트 resolve --take-over와 order take-over가 부른다.
 * 워커를 거두고 열린 게이트를 닫은 뒤 human-owned로 바꾼다. 워크트리와 브랜치는 남긴다.
 */
export async function takeOver(
  store: ConductorStore,
  orderId: string,
  launchers: LauncherSet,
  opts: { gateId?: string; answer?: string } = {},
): Promise<TakeOverResult> {
  const order = mustOrder(store, orderId);
  if (!TAKE_OVER_FROM.has(order.status))
    throw new Error(`${order.id}는 ${order.status} 상태라 넘겨받을 수 없어요`);
  const closedGates = closeOpenGates(
    store,
    order.id,
    'taken-over',
    '사람이 주문을 넘겨받았어요',
    opts.gateId
      ? { gateId: opts.gateId, ...(opts.answer ? { answer: opts.answer } : {}) }
      : undefined,
  );
  const worker = order.workerId ? store.worker(order.workerId) : undefined;
  const retired = worker
    ? await retireWorker(store, launchers, worker, TAKE_OVER_MESSAGE, { keepWorktree: true })
    : { hostActions: [], errors: [] };
  store.updateOrder(order.id, { status: 'human-owned', humanOwnedAt: store.timestamp() });
  const warnings = order.prRef
    ? []
    : [`${order.id}에 연결된 PR이 없어 머지를 지켜볼 수 없어요. 그대로 두면 parked로 내려가요`];
  return { order: store.order(order.id)!, closedGates, warnings, ...retired };
}

export interface CancelResult extends RetireResult {
  order: Order;
  closedGates: Gate[];
}

/** 주문을 취소한다. 워커 정리는 기존 정리와 같게 release를 부른다 */
export async function cancelOrder(
  store: ConductorStore,
  orderId: string,
  launchers: LauncherSet,
  reason?: string,
): Promise<CancelResult> {
  const order = mustOrder(store, orderId);
  if (!CANCEL_FROM.has(order.status))
    throw new Error(`${order.id}는 ${order.status} 상태라 취소할 수 없어요`);
  const closedGates = closeOpenGates(
    store,
    order.id,
    'rejected',
    `주문을 취소했어요${reason ? `: ${reason}` : ''}`,
  );
  const worker = order.workerId ? store.worker(order.workerId) : undefined;
  const retired = worker
    ? await retireWorker(store, launchers, worker, cancelMessage(reason), { keepWorktree: false })
    : { hostActions: [], errors: [] };
  store.updateOrder(order.id, { status: 'cancelled', ...(reason ? { cancelReason: reason } : {}) });
  return { order: store.order(order.id)!, closedGates, ...retired };
}

export interface ConfirmMergeResult extends RetireResult {
  order: Order;
  closedGates: Gate[];
}

/**
 * 사람이 머지했다고 알린 주문을 gh로 한 번 확인한다. MERGED일 때만 merged로 넘긴다.
 * 컨덕터가 쥐고 있던 주문이면 게이트를 닫고 워커를 거둔 뒤 넘긴다.
 * 머지 뒤 처리(지라 전환, 배포 대기)는 호출한 쪽이 이어서 태운다.
 */
export async function confirmHumanMerge(
  store: ConductorStore,
  orderId: string,
  source: PrStateSource,
  launchers: LauncherSet,
): Promise<ConfirmMergeResult> {
  const order = mustOrder(store, orderId);
  if (!MARK_MERGED_FROM.has(order.status))
    throw new Error(
      `${order.id}는 ${order.status} 상태예요. human-owned, parked, running, waiting-gate, escalated 주문만 머지했다고 알릴 수 있어요`,
    );
  if (order.status === 'escalated' && order.mergedAt !== undefined)
    throw new Error(
      `${order.id}는 이미 머지된 뒤 배포 실패로 올라간 주문이에요. 게이트로 처리하세요`,
    );
  if (!order.prRef) throw new Error(`${order.id}에 연결된 PR이 없어 머지를 확인할 수 없어요`);
  const pr = await source.state(order.prRef);
  if (pr.state !== 'MERGED')
    throw new Error(`${order.prRef}가 아직 ${pr.state} 상태라 merged로 넘기지 않았어요`);
  const cleanup = CONDUCTOR_HELD.has(order.status)
    ? await retireForPrChange(store, order, launchers, 'merged')
    : { closedGates: [], hostActions: [], errors: [] };
  store.updateOrder(order.id, { status: 'merged', mergedAt: pr.mergedAt ?? store.timestamp() });
  return { order: store.order(order.id)!, ...cleanup };
}

export interface HumanOwnedChange {
  orderId: string;
  to: 'merged' | 'cancelled' | 'parked';
  /** human-owned가 아닌 상태에서 넘어갔을 때만 적는다 */
  from?: OrderStatus;
  prRef?: string;
}

export interface WatchOptions {
  now: Date;
  pollMs: number;
  parkAfterMs: number;
  source?: PrStateSource;
  launchers: LauncherSet;
}

export interface WatchResult {
  changes: HumanOwnedChange[];
  hostActions: HostAction[];
  errors: string[];
}

/**
 * human-owned 주문과 컨덕터가 쥔 주문(running, waiting-gate, escalated)의 PR을 주문마다 pollMs 간격으로
 * 확인한다. MERGED면 merged, 머지 없이 CLOSED면 cancelled로 넘긴다. 컨덕터가 쥔 주문이면 넘기기 전에
 * 게이트를 닫고 워커를 거둔다. OPEN이면 확인 시각만 남긴다.
 * human-owned만 넘겨받은 지 parkAfterMs가 지나도 그대로면 parked로 내린다. 컨덕터가 쥔 주문은 워커나
 * 게이트가 아직 움직이고 있어서다. gh 실패는 errors로 모으고 다음 간격에 다시 본다. 매 tick 부르지
 * 않게 실패해도 확인 시각은 남긴다.
 */
export async function watchHumanOwned(
  store: ConductorStore,
  opts: WatchOptions,
): Promise<WatchResult> {
  const changes: HumanOwnedChange[] = [];
  const hostActions: HostAction[] = [];
  const errors: string[] = [];
  const now = opts.now.getTime();
  const at = opts.now.toISOString();
  for (const order of store.orders().filter(watchesPr)) {
    const humanOwned = order.status === 'human-owned';
    const ref = order.prRef ? { prRef: order.prRef } : {};
    const from = humanOwned ? {} : { from: order.status };
    const checked = order.prCheckedAt ? Date.parse(order.prCheckedAt) : Number.NaN;
    const due = Number.isNaN(checked) || now - checked >= opts.pollMs;
    if (order.prRef && opts.source && due) {
      let pr: PrState | undefined;
      try {
        pr = await opts.source.state(order.prRef);
      } catch (err) {
        errors.push(`${order.id} PR 상태 확인 실패: ${(err as Error).message}`);
      }
      if (pr?.state === 'MERGED' || pr?.state === 'CLOSED') {
        const merged = pr.state === 'MERGED';
        if (!humanOwned) {
          const cleanup = await retireForPrChange(
            store,
            order,
            opts.launchers,
            merged ? 'merged' : 'closed',
          );
          hostActions.push(...cleanup.hostActions);
          errors.push(...cleanup.errors);
        }
        store.updateOrder(
          order.id,
          merged
            ? { status: 'merged', mergedAt: pr.mergedAt ?? at, prCheckedAt: at }
            : { status: 'cancelled', prCheckedAt: at, cancelReason: 'PR이 머지 없이 닫혔어요' },
        );
        changes.push({ orderId: order.id, to: merged ? 'merged' : 'cancelled', ...from, ...ref });
        continue;
      }
      store.updateOrder(order.id, { prCheckedAt: at });
    }
    if (!humanOwned) continue;
    const since = Date.parse(order.humanOwnedAt ?? order.updatedAt);
    if (!Number.isNaN(since) && now - since >= opts.parkAfterMs) {
      store.updateOrder(order.id, { status: 'parked' });
      changes.push({ orderId: order.id, to: 'parked', ...ref });
    }
  }
  return { changes, hostActions, errors };
}
