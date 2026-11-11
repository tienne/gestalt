import { newId, type MasterStore } from './store.js';
import {
  TERMINAL_ORDER_STATUSES,
  type BypassRecord,
  type Gate,
  type GateType,
  type NeedKind,
  type Order,
} from './types.js';

/**
 * 사람 확인 게이트 정책.
 *
 * 사람에게 올리는 자리는 넷뿐이다. merge-through가 아닌 주문의 머지 승인, 슬랙 게시 승인,
 * interview-first 주문의 인터뷰 답변, 리뷰 스킬의 수동 전환 지침이 사람에게 넘기라고 한 자리다.
 * 나머지(단순 승인, 수동 검증, 정리, 인증, 계정 전환)는 마스터가 bypass로 처리하고 기록을 남겨
 * 사후 보고한다. 처리할 절차가 없거나 절차가 실패하면 그때만 no-procedure 게이트로 올린다.
 */

export type NeedDecision = { kind: 'gate'; type: GateType } | { kind: 'bypass' };

export function classifyNeed(order: Order | undefined, need: NeedKind): NeedDecision {
  switch (need) {
    case 'merge-approval':
      return order?.scope === 'merge-through'
        ? { kind: 'bypass' }
        : { kind: 'gate', type: 'merge' };
    case 'slack-post':
      return { kind: 'gate', type: 'slack-post' };
    case 'interview-answer':
      // interview-first가 아니면 solve의 자율 루프대로 워커가 맥락에서 답한다
      return order?.scope === 'interview-first'
        ? { kind: 'gate', type: 'interview' }
        : { kind: 'bypass' };
    case 'review-manual-switch':
      return { kind: 'gate', type: 'review-manual-switch' };
    case 'other':
      return { kind: 'gate', type: 'no-procedure' };
    case 'simple-approval':
    case 'manual-verification':
    case 'cleanup':
    case 'auth':
    case 'account-switch':
      return { kind: 'bypass' };
  }
}

export interface BypassInput {
  order?: Order;
  need: NeedKind;
  detail: string;
}

/** bypass 절차 하나. 한 일을 한 줄로 돌려준다. 못 하면 던진다 */
export type BypassHandler = (input: BypassInput) => Promise<string>;
export type BypassHandlers = Partial<Record<NeedKind, BypassHandler>>;

export interface NeedRequest {
  orderId?: string;
  need: NeedKind;
  detail: string;
  refs?: string[];
  payload?: Record<string, string>;
}

export type NeedOutcome =
  | { kind: 'gate'; gate: Gate; reused: boolean }
  | { kind: 'bypass'; record: BypassRecord };

/** 정책대로 게이트를 열거나 bypass 절차를 돌린다 */
export async function handleNeed(
  store: MasterStore,
  req: NeedRequest,
  handlers: BypassHandlers,
): Promise<NeedOutcome> {
  const order = req.orderId ? store.order(req.orderId) : undefined;
  const decision = classifyNeed(order, req.need);
  if (decision.kind === 'gate') {
    return openOrReuse(store, {
      ...req,
      type: decision.type,
      reason: req.detail,
    });
  }

  const handler = handlers[req.need];
  if (!handler) {
    return openOrReuse(store, {
      ...req,
      type: 'no-procedure',
      reason: `${req.need} 처리 절차가 없어요: ${req.detail}`,
    });
  }
  let action: string;
  try {
    action = await handler({ ...(order ? { order } : {}), need: req.need, detail: req.detail });
  } catch (err) {
    return openOrReuse(store, {
      ...req,
      type: 'no-procedure',
      reason: `${req.need} 처리에 실패했어요: ${(err as Error).message}`,
    });
  }
  const record: BypassRecord = {
    ...(req.orderId ? { orderId: req.orderId } : {}),
    need: req.need,
    action,
    at: store.timestamp(),
  };
  store.append({ type: 'bypass', at: record.at, record });
  return { kind: 'bypass', record };
}

interface GateRequest {
  orderId?: string;
  type: GateType;
  reason: string;
  refs?: string[];
  payload?: Record<string, string>;
}

/**
 * 같은 주문에 같은 종류의 게이트가 열려 있으면 새로 열지 않는다.
 * 워커가 같은 요청을 여러 번 올려도 사람이 받는 질문은 하나다. 다시 쓸 때는 사유와 참조를
 * 최신 값으로 바꾼다. 같은 게이트에 다른 원인이 겹치면 사람이 보는 사유가 첫 원인에 묶이기 때문이다.
 */
export function openOrReuse(
  store: MasterStore,
  req: GateRequest,
): { kind: 'gate'; gate: Gate; reused: boolean } {
  const existing = store
    .openGates(req.orderId)
    .find((g) => g.type === req.type && (req.orderId !== undefined || g.reason === req.reason));
  if (existing) {
    const refs = req.refs ?? existing.refs;
    const changed =
      existing.reason !== req.reason ||
      refs.length !== existing.refs.length ||
      refs.some((r, i) => r !== existing.refs[i]);
    if (!changed) return { kind: 'gate', gate: existing, reused: true };
    store.append({
      type: 'gate-updated',
      at: store.timestamp(),
      gateId: existing.id,
      reason: req.reason,
      refs,
    });
    return { kind: 'gate', gate: store.snapshot.gates[existing.id]!, reused: true };
  }

  const gate: Gate = {
    id: newId('gate'),
    ...(req.orderId ? { orderId: req.orderId } : {}),
    type: req.type,
    status: 'open',
    reason: req.reason,
    refs: req.refs ?? [],
    ...(req.payload ? { payload: req.payload } : {}),
    openedAt: store.timestamp(),
  };
  store.openGate(gate);
  const order = req.orderId ? store.order(req.orderId) : undefined;
  if (
    order &&
    !TERMINAL_ORDER_STATUSES.has(order.status) &&
    order.status !== 'waiting-gate' &&
    order.status !== 'escalated'
  ) {
    store.updateOrder(order.id, { status: 'waiting-gate' });
  }
  return { kind: 'gate', gate, reused: false };
}

/**
 * 사람이 게이트에 답한 걸 기록한다.
 *
 * 주문의 다른 게이트가 다 닫히면 주문을 다시 움직인다. 워커가 살아 있으면 running으로,
 * 워커 없이 멈춘 주문이면 승인은 queued(다시 띄움), 거절은 cancelled로 둔다.
 * 이미 머지된 주문(배포 실패로 올라온 주문)은 체인을 다시 돌릴 일이 없다. 승인하면 merged로
 * 돌려 다음 tick이 정산을 다시 시도한다. 거절하면 escalated로 남겨 사람이 마무리한다.
 */
export function resolveGate(
  store: MasterStore,
  gateId: string,
  decision: 'approved' | 'rejected',
  answer?: string,
): Gate {
  store.append({
    type: 'gate-resolved',
    at: store.timestamp(),
    gateId,
    decision,
    ...(answer !== undefined ? { answer } : {}),
  });
  const gate = store.snapshot.gates[gateId]!;
  const order = gate.orderId ? store.order(gate.orderId) : undefined;
  if (!order || (order.status !== 'waiting-gate' && order.status !== 'escalated')) return gate;
  if (store.openGates(order.id).length > 0) return gate;

  if (order.mergedAt !== undefined) {
    if (decision === 'approved') store.updateOrder(order.id, { status: 'merged' });
    else if (order.status !== 'escalated') store.updateOrder(order.id, { status: 'escalated' });
    return gate;
  }

  const live = order.workerId ? store.worker(order.workerId) : undefined;
  const alive = live && (live.status === 'running' || live.status === 'starting');
  if (alive) {
    // 게이트를 기다린 시간은 워커가 끊긴 시간이 아니다. 닫는 시점부터 다시 센다
    store.updateWorker(live.id, { lastSeenAt: store.timestamp() });
    store.updateOrder(order.id, { status: 'running' });
  } else {
    store.updateOrder(order.id, { status: decision === 'approved' ? 'queued' : 'cancelled' });
  }
  return gate;
}
