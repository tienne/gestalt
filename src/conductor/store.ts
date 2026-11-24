import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { isPlainObject, writeJsonAtomic } from '../core/json-file.js';
import { log } from '../core/log.js';
import {
  ACTIVE_WORKER_STATUSES,
  TERMINAL_ORDER_STATUSES,
  type Checkpoint,
  type Gate,
  type ConductorEvent,
  type ConductorSnapshot,
  type Order,
  type Worker,
} from './types.js';

/**
 * 컨덕터 실행 상태 저장소.
 *
 * 이벤트를 `events.jsonl`에 한 줄씩 덧붙이고 상태는 그 로그를 재생해서 만든다. 떼어 낸 로그는
 * `base.json`에 반영돼 있어 재생은 거기서 시작한다(replayStore).
 * 컨덕터 세션이 압축되거나 새로 떠도 이 디렉토리만 있으면 주문과 워커, 체크포인트,
 * 승인 대기를 같게 복원한다. `snapshot.json`은 사람과 도구가 빨리 읽으라고 두는
 * 사본이라 복원에는 쓰지 않는다. 둘이 어긋나면 로그가 맞다. tick처럼 이벤트를 몰아 쓰는
 * 자리는 `deferSnapshot`으로 묶어 사본을 끝에 한 번만 쓴다.
 *
 * 워커 프로세스도 `gestalt conductor checkpoint save`로 같은 로그에 덧붙인다. 한 줄짜리
 * append는 O_APPEND로 쓴다. 줄 단위로 섞이지 않는다는 전제는 store.test.ts의
 * '두 프로세스가 동시에 덧붙여도 모든 줄이 온전하다'가 확인한다. 다른 프로세스가 쓰는
 * 도중에 끝을 읽으면 멀쩡한 줄 뒤에도 tail-repaired가 붙을 수 있는데, replay는 못 읽는
 * 줄만 버리므로 이벤트는 빠지지 않는다. 결과 보고는 inbox에 파일로 두고 tick이 읽는다.
 */

export const EVENTS_FILE = 'events.jsonl';
export const SNAPSHOT_FILE = 'snapshot.json';
/** 떼어 낸 로그를 반영한 기준점 상태. 재생은 여기서 시작한다 */
export const BASE_FILE = 'base.json';
/** `events.jsonl`에서 떼어 낸 로그. 반영한 뒤에도 다음 반영 때까지 남겨 둔다 */
export const SEGMENTS_DIR = 'segments';
/** 떼어 낸 순번 10자리가 앞이라 이름 순서가 떼어 낸 순서다. 이 꼴이 아닌 이름은 읽지도 지우지도 않는다 */
export const SEGMENT_NAME = /^\d{10}-[0-9A-Z-]+\.jsonl$/;
/** 반영하는 사이 저장소 모양이 바뀌면 다시 읽는 횟수 */
export const MAX_REPLAY_ATTEMPTS = 5;

export interface FoldedSegment {
  name: string;
  /** base.json 상태에 반영한 앞쪽 바이트 수. 늘 줄 끝에서 끊는다 */
  size: number;
}

export interface BaseFile {
  version: 1;
  /** 반영한 segment와 반영한 길이. 그 뒤에 늦게 붙은 줄만 재생한다 */
  foldedSegments: FoldedSegment[];
  state: ConductorSnapshot;
  /**
   * 주문별 로그(`order-logs/`)에 마지막으로 덧붙이고 이 base.json까지 쓴 반영의 id. 덧붙이기 전에 적어 둔
   * `order-logs/.staging.json`의 id와 다르면 그 반영은 base.json을 못 쓰고 죽은 것이다
   */
  orderLogsFold?: string;
}

export function emptySnapshot(): ConductorSnapshot {
  return {
    orders: {},
    removedOrders: {},
    archivedOrders: {},
    askedSourceRefs: {},
    workers: {},
    checkpoints: {},
    gates: {},
    bypasses: [],
    jiraTransitions: [],
    slackPosted: {},
    appliedReports: {},
    reports: {},
    ticks: 0,
    eventCount: 0,
  };
}

/** 손으로 고친 이벤트 줄이 칸을 지워도 워커가 깨지지 않게 꼭 있어야 하는 칸은 안 지운다 */
const REQUIRED_WORKER_KEYS = new Set([
  'id',
  'orderId',
  'kind',
  'attempt',
  'status',
  'startedAt',
  'lastSeenAt',
  'spawnedBy',
]);

/** 이벤트 하나를 스냅샷에 반영한다. 재생과 실시간 반영이 같은 함수를 지나야 복원 결과가 같다 */
export function applyEvent(s: ConductorSnapshot, e: ConductorEvent): void {
  s.eventCount += 1;
  switch (e.type) {
    case 'order-added':
      s.orders[e.order.id] = { ...e.order };
      return;
    case 'order-updated': {
      const o = s.orders[e.orderId];
      if (o) s.orders[e.orderId] = { ...o, ...e.patch, updatedAt: e.at };
      return;
    }
    case 'worker-started':
      if (isRetired(s, e.worker.orderId)) return;
      s.workers[e.worker.id] = { ...e.worker };
      return;
    case 'worker-updated': {
      const w = s.workers[e.workerId];
      if (!w) return;
      // undefined 값은 JSON에 안 남아 재생 때는 칸이 그대로다. 실시간 반영도 같게 두고 지우기는 unset만 한다
      const next: Record<string, unknown> = { ...w };
      for (const [k, v] of Object.entries(e.patch)) if (v !== undefined) next[k] = v;
      for (const k of e.unset ?? []) if (!REQUIRED_WORKER_KEYS.has(k)) delete next[k];
      s.workers[e.workerId] = next as unknown as Worker;
      return;
    }
    case 'checkpoint-saved':
      if (isRetired(s, e.checkpoint.orderId)) return;
      s.checkpoints[e.checkpoint.orderId] = { ...e.checkpoint };
      return;
    case 'gate-opened':
      if (e.gate.orderId !== undefined && isRetired(s, e.gate.orderId)) return;
      s.gates[e.gate.id] = { ...e.gate };
      return;
    case 'gate-updated': {
      const g = s.gates[e.gateId];
      if (g) s.gates[e.gateId] = { ...g, reason: e.reason, refs: [...e.refs] };
      return;
    }
    case 'gate-resolved': {
      const g = s.gates[e.gateId];
      if (g) {
        s.gates[e.gateId] = {
          ...g,
          status: 'resolved',
          decision: e.decision,
          resolvedAt: e.at,
          ...(e.answer !== undefined ? { answer: e.answer } : {}),
          ...(e.deliveryPending ? { deliveryPending: true } : {}),
          ...(e.decisionBy ? { decisionBy: e.decisionBy } : {}),
        };
      }
      return;
    }
    case 'bypass':
      if (e.record.orderId !== undefined && isRetired(s, e.record.orderId)) return;
      s.bypasses.push(e.record);
      return;
    case 'jira-transition':
      if (isRetired(s, e.record.orderId)) return;
      s.jiraTransitions.push(e.record);
      return;
    case 'gate-delivery': {
      const g = s.gates[e.gateId];
      if (!g) return;
      const next: Gate = { ...g };
      if (e.pending) {
        next.deliveryPending = true;
        if (e.attempts !== undefined) next.deliveryAttempts = e.attempts;
      } else {
        delete next.deliveryPending;
        delete next.deliveryAttempts;
        if (e.outcome) next.deliveryOutcome = e.outcome;
      }
      s.gates[e.gateId] = next;
      return;
    }
    case 'slack-posted':
      // 주문과 함께 빠졌거나 보관에서 버린 게이트에 늦게 온 줄이다
      if (!s.gates[e.gateId]) return;
      s.slackPosted[e.gateId] = e.ref;
      return;
    case 'order-removed':
      removeFromSnapshot(s, e.orderId, e.at);
      return;
    case 'report-applied':
      s.appliedReports[e.name] = e.at;
      if (e.report) {
        const orderId = s.workers[e.report.workerId]?.orderId;
        if (orderId) (s.reports[orderId] ??= []).push({ ...e.report, at: e.at });
      }
      return;
    case 'tick':
      s.ticks += 1;
      s.lastTickAt = e.at;
      s.idleTicks = e.idle ? (s.idleTicks ?? 0) + 1 : 0;
      s.lastTickEventCount = s.eventCount;
      for (const name of e.clearedReports ?? []) delete s.appliedReports[name];
      return;
    case 'tail-repaired':
      return;
  }
}

const REMOVAL_WORDS = {
  remove: { can: '지울', cannot: '지워요' },
  archive: { can: '옮길', cannot: '옮겨요' },
} as const;

/**
 * 주문 id로 찾는 워커와 게이트, 상태에 남은 게이트의 `payload.sourceRef`. 주문마다 배열을 훑으면 주문 수의
 * 제곱으로 늘어서 한 번 모아 둔다. 상태를 고치면 다시 만든다. 다른 주문을 상태에서 빼는 건 괜찮다
 */
export interface OrderIndex {
  workers: ReadonlyMap<string, Worker[]>;
  gates: ReadonlyMap<string, Gate[]>;
  gateSourceRefs: ReadonlySet<string>;
}

export function indexByOrder(s: ConductorSnapshot): OrderIndex {
  const workers = new Map<string, Worker[]>();
  for (const w of Object.values(s.workers)) {
    const list = workers.get(w.orderId);
    if (list) list.push(w);
    else workers.set(w.orderId, [w]);
  }
  const gates = new Map<string, Gate[]>();
  const gateSourceRefs = new Set<string>();
  for (const g of Object.values(s.gates)) {
    const ref = g.payload?.sourceRef;
    if (ref !== undefined) gateSourceRefs.add(ref);
    if (g.orderId === undefined) continue;
    const list = gates.get(g.orderId);
    if (list) list.push(g);
    else gates.set(g.orderId, [g]);
  }
  return { workers, gates, gateSourceRefs };
}

function workersOfOrder(s: ConductorSnapshot, orderId: string, index?: OrderIndex): Worker[] {
  if (index) return index.workers.get(orderId) ?? [];
  return Object.values(s.workers).filter((w) => w.orderId === orderId);
}

function gatesOfOrder(s: ConductorSnapshot, orderId: string, index?: OrderIndex): Gate[] {
  if (index) return index.gates.get(orderId) ?? [];
  return Object.values(s.gates).filter((g) => g.orderId === orderId);
}

/** 주문과 지우거나 보관한 주문이 받은 출처. 하나라도 있으면 같은 출처로 주문을 다시 안 만든다 */
export function takenSourceRefs(s: ConductorSnapshot): Set<string> {
  return new Set([
    ...Object.values(s.orders).map((o) => o.sourceRef),
    ...Object.values(s.removedOrders).map((r) => r.sourceRef),
    ...Object.values(s.archivedOrders).map((a) => a.sourceRef),
  ]);
}

/**
 * 주문을 못 지우는 이유를 준다. 지울 수 있으면 undefined. 보관 명령은 `action`을 `archive`로 줘서 같은 규칙을
 * 옮기는 쪽 문구로 받는다.
 * 멈춘 워커도 막는다. 그 워크트리가 남아 있을 수 있어서 워커 기록을 지우면 workerAt 가드가 풀린다
 */
export function removalBlocker(
  s: ConductorSnapshot,
  orderId: string,
  action: keyof typeof REMOVAL_WORDS = 'remove',
  index?: OrderIndex,
): string | undefined {
  const { can, cannot } = REMOVAL_WORDS[action];
  const o = s.orders[orderId];
  if (!o) return `모르는 주문이에요: ${orderId}`;
  if (!TERMINAL_ORDER_STATUSES.has(o.status))
    return `끝난 주문만 ${can} 수 있어요: ${orderId}(${o.status})`;
  if (gatesOfOrder(s, o.id, index).some((g) => g.status === 'open'))
    return `열린 게이트가 있어서 못 ${cannot}: ${orderId}`;
  const workers = workersOfOrder(s, o.id, index);
  if (workers.some((w) => ACTIVE_WORKER_STATUSES.has(w.status)))
    return `도는 워커가 있어서 못 ${cannot}: ${orderId}`;
  if (workers.some((w) => w.status === 'stopped'))
    return `멈춘 워커의 워크트리가 남아 있을 수 있어서 못 ${cannot}: ${orderId}`;
  return undefined;
}

/** 지우거나 보관한 주문. 늦게 온 이벤트로 워커나 게이트가 다시 붙지 않게 재생이 거른다 */
function isRetired(s: ConductorSnapshot, orderId: string): boolean {
  return orderId in s.removedOrders || orderId in s.archivedOrders;
}

function removeFromSnapshot(s: ConductorSnapshot, orderId: string, at: string): void {
  // 재생은 validate를 안 거친다. 다른 프로세스가 지우기와 경합해 게이트나 워커를 붙였으면 무시한다
  if (removalBlocker(s, orderId) !== undefined) return;
  const o = detachOrder(s, orderId);
  s.removedOrders[orderId] = {
    sourceRef: o.sourceRef,
    ...(o.parentOrderId ? { parentOrderId: o.parentOrderId } : {}),
    removedAt: at,
  };
}

/** 주문과 거기 붙은 워커, 체크포인트, 게이트, 기록을 상태에서 뺀다. 지우기와 보관이 같은 규칙을 쓴다 */
export function detachOrder(s: ConductorSnapshot, orderId: string, index?: OrderIndex): Order {
  const o = s.orders[orderId]!;
  delete s.orders[orderId];
  for (const w of workersOfOrder(s, orderId, index)) delete s.workers[w.id];
  delete s.checkpoints[orderId];
  for (const g of gatesOfOrder(s, orderId, index)) {
    delete s.gates[g.id];
    delete s.slackPosted[g.id];
  }
  s.bypasses = s.bypasses.filter((b) => b.orderId !== orderId);
  s.jiraTransitions = s.jiraTransitions.filter((t) => t.orderId !== orderId);
  delete s.reports[orderId];
  return o;
}

/**
 * 이벤트가 붙는 주문. 적용하기 전 상태로 찾는다. 워커와 게이트 이벤트는 id만 들고 있어 그 시점 상태에서 주문을 찾는다.
 * tick과 tail-repaired, 주문 없는 컨덕터 게이트는 주문에 안 붙는다
 */
export function orderOfEvent(e: ConductorEvent, s: ConductorSnapshot): string | undefined {
  switch (e.type) {
    case 'order-added':
      return e.order.id;
    case 'order-updated':
    case 'order-removed':
      return e.orderId;
    case 'worker-started':
      return e.worker.orderId;
    case 'worker-updated':
      return s.workers[e.workerId]?.orderId;
    case 'report-applied':
      return e.report ? s.workers[e.report.workerId]?.orderId : undefined;
    case 'checkpoint-saved':
      return e.checkpoint.orderId;
    case 'gate-opened':
      return e.gate.orderId;
    case 'gate-updated':
    case 'gate-resolved':
    case 'gate-delivery':
    case 'slack-posted':
      return s.gates[e.gateId]?.orderId;
    case 'bypass':
    case 'jira-transition':
      return e.record.orderId;
    case 'tick':
    case 'tail-repaired':
      return undefined;
    default: {
      // 새 이벤트 종류를 넣으면 여기서 타입 에러가 난다. 재생은 멈추지 않게 던지지 않는다
      const unhandled: never = e;
      void unhandled;
      return undefined;
    }
  }
}

export function newId(prefix: 'ord' | 'wrk' | 'gate'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export class ConductorStore {
  readonly dir: string;
  private state: ConductorSnapshot;
  private readonly now: () => Date;
  private deferDepth = 0;
  private removedIndex?: {
    state: ConductorSnapshot;
    size: number;
    removed: Map<string, string>;
    archived: Map<string, string>;
  };
  private orderIndex?: { state: ConductorSnapshot; eventCount: number; index: OrderIndex };

  private constructor(dir: string, state: ConductorSnapshot, now: () => Date) {
    this.dir = dir;
    this.state = state;
    this.now = now;
  }

  /** base.json과 남은 로그를 재생해 연다. 디렉토리가 없으면 만든다 */
  static open(dir: string, opts: { now?: () => Date } = {}): ConductorStore {
    mkdirSync(dir, { recursive: true });
    return new ConductorStore(dir, replayStore(dir), opts.now ?? (() => new Date()));
  }

  get snapshot(): Readonly<ConductorSnapshot> {
    return this.state;
  }

  timestamp(): string {
    return this.now().toISOString();
  }

  /** 다른 프로세스가 덧붙인 이벤트까지 다시 읽는다 */
  reload(): void {
    this.state = replayStore(this.dir);
  }

  append(event: ConductorEvent): void {
    validate(event, this.state);
    const path = join(this.dir, EVENTS_FILE);
    // 앞 프로세스가 줄 중간에 죽었으면 개행부터 붙인다. 안 그러면 깨진 꼬리와 새 이벤트가
    // 한 줄로 합쳐져 중간 줄이 깨진 로그가 된다. 표시 이벤트를 같은 write에 실어 replay가
    // 이 깨진 줄을 버려도 되는 줄로 알아본다
    const repair: ConductorEvent | undefined = endsWithoutNewline(path)
      ? { type: 'tail-repaired', at: this.timestamp() }
      : undefined;
    const prefix = repair ? `\n${JSON.stringify(repair)}\n` : '';
    appendFileSync(path, `${prefix}${JSON.stringify(event)}\n`, 'utf-8');
    if (repair) applyEvent(this.state, repair);
    applyEvent(this.state, event);
  }

  /** 사람과 도구가 읽는 사본을 지금 상태로 쓴다 */
  flushSnapshot(): void {
    writeJsonAtomic(join(this.dir, SNAPSHOT_FILE), this.state, { indent: 0 });
  }

  /**
   * 사본은 누적 기록까지 통째로 담아 비용이 크므로 필요한 작업이 끝날 때 한 번만 쓴다.
   */
  async deferSnapshot<T>(fn: () => Promise<T>): Promise<T> {
    this.deferDepth += 1;
    try {
      return await fn();
    } finally {
      this.deferDepth -= 1;
      if (this.deferDepth === 0) this.flushSnapshot();
    }
  }

  addOrder(order: Order): void {
    this.append({ type: 'order-added', at: this.timestamp(), order });
  }

  updateOrder(orderId: string, patch: Partial<Omit<Order, 'id'>>): void {
    this.append({ type: 'order-updated', at: this.timestamp(), orderId, patch });
  }

  /** 끝난 주문을 지운다. 도는 워커나 멈춘 워커, 열린 게이트가 있으면 거절한다 */
  removeOrder(orderId: string): void {
    this.append({ type: 'order-removed', at: this.timestamp(), orderId });
  }

  startWorker(worker: Worker): void {
    this.append({ type: 'worker-started', at: this.timestamp(), worker });
  }

  updateWorker(workerId: string, patch: Partial<Omit<Worker, 'id' | 'spawnedBy'>>): void {
    const unset = Object.keys(patch).filter((k) => patch[k as keyof typeof patch] === undefined);
    this.append({
      type: 'worker-updated',
      at: this.timestamp(),
      workerId,
      patch,
      ...(unset.length > 0 ? { unset } : {}),
    });
  }

  saveCheckpoint(checkpoint: Checkpoint): void {
    this.append({ type: 'checkpoint-saved', at: this.timestamp(), checkpoint });
  }

  openGate(gate: Gate): void {
    this.append({ type: 'gate-opened', at: this.timestamp(), gate });
  }

  order(id: string): Order | undefined {
    return this.state.orders[id];
  }

  worker(id: string): Worker | undefined {
    return this.state.workers[id];
  }

  orders(): Order[] {
    return Object.values(this.state.orders);
  }

  workers(): Worker[] {
    return Object.values(this.state.workers);
  }

  activeWorkers(): Worker[] {
    return this.workers().filter((w) => ACTIVE_WORKER_STATUSES.has(w.status));
  }

  /** 먼저 들어온 주문이 먼저 뜬다 */
  queuedOrders(): Order[] {
    return this.orders()
      .filter((o) => o.status === 'queued')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  openGates(orderId?: string): Gate[] {
    const gates =
      orderId === undefined
        ? Object.values(this.state.gates)
        : (this.byOrder().gates.get(orderId) ?? []);
    return gates.filter((g) => g.status === 'open');
  }

  /**
   * 같은 출처로 이미 게이트를 열어 물었는지. 상태에 남은 게이트와 보관하며 색인으로 옮긴 게이트를 함께 본다.
   * 사람이 거절한 것도 물은 것으로 친다
   */
  askedSourceRef(sourceRef: string): boolean {
    return (
      this.byOrder().gateSourceRefs.has(sourceRef) ||
      Object.hasOwn(this.state.askedSourceRefs, sourceRef)
    );
  }

  /** 상태는 이벤트로만 바뀌고 그때마다 eventCount가 는다. 다시 읽으면 상태 객체가 바뀐다 */
  private byOrder(): OrderIndex {
    const cached = this.orderIndex;
    if (cached?.state === this.state && cached.eventCount === this.state.eventCount)
      return cached.index;
    const index = indexByOrder(this.state);
    this.orderIndex = { state: this.state, eventCount: this.state.eventCount, index };
    return index;
  }

  findOrderBySourceRef(sourceRef: string): Order | undefined {
    return this.orders().find((o) => o.sourceRef === sourceRef);
  }

  /** 지운 주문의 출처면 지운 시각을 준다. 접수가 이걸 보고 같은 출처를 다시 받지 않는다 */
  removedAtOf(sourceRef: string): string | undefined {
    return this.retiredIndex().removed.get(sourceRef);
  }

  /** 보관한 주문의 출처면 보관한 시각을 준다. 지운 주문과 같게 다시 받지 않는다 */
  archivedAtOf(sourceRef: string): string | undefined {
    return this.retiredIndex().archived.get(sourceRef);
  }

  /** 받은 적 있는 출처인지 본다. 지우거나 보관한 주문도 받은 것으로 친다 */
  hasSourceRef(sourceRef: string): boolean {
    return (
      this.findOrderBySourceRef(sourceRef) !== undefined ||
      this.removedAtOf(sourceRef) !== undefined ||
      this.archivedAtOf(sourceRef) !== undefined
    );
  }

  /** 지우거나 보관한 하위 주문까지 센다. 안 그러면 끝난 하위 주문을 치울 때마다 상한이 다시 열린다 */
  childOrderCount(parentOrderId: string): number {
    const { orders, removedOrders, archivedOrders } = this.state;
    return [
      ...Object.values(orders),
      ...Object.values(removedOrders),
      ...Object.values(archivedOrders),
    ].filter((o) => o.parentOrderId === parentOrderId).length;
  }

  /** 사람에게 넘긴 채 보관한 주문의 PR. PR 감시가 그 PR로 주문을 다시 만들지 않게 한다 */
  archivedHumanPrs(): string[] {
    return Object.values(this.state.archivedOrders).flatMap((a) => (a.humanPr ? [a.humanPr] : []));
  }

  private retiredIndex(): { removed: Map<string, string>; archived: Map<string, string> } {
    // poll마다 티켓별로 불려서 출처 색인을 둔다. 두 기록은 늘기만 해서 크기로 낡았는지 본다
    const { removedOrders, archivedOrders } = this.state;
    const size = Object.keys(removedOrders).length + Object.keys(archivedOrders).length;
    if (this.removedIndex?.state !== this.state || this.removedIndex.size !== size) {
      const removed = new Map<string, string>();
      for (const r of Object.values(removedOrders))
        if (!removed.has(r.sourceRef)) removed.set(r.sourceRef, r.removedAt);
      const archived = new Map<string, string>();
      for (const a of Object.values(archivedOrders))
        if (!archived.has(a.sourceRef)) archived.set(a.sourceRef, a.archivedAt);
      this.removedIndex = { state: this.state, size, removed, archived };
    }
    return this.removedIndex;
  }

  workersOf(orderId: string): Worker[] {
    return [...(this.byOrder().workers.get(orderId) ?? [])].sort((a, b) => a.attempt - b.attempt);
  }
}

function validate(event: ConductorEvent, s: ConductorSnapshot): void {
  if (event.type === 'worker-started') {
    // 타입으로 막아도 JSON으로 들어오는 값은 런타임에서 다시 본다
    if ((event.worker as { spawnedBy: string }).spawnedBy !== 'conductor') {
      throw new Error('워커는 컨덕터만 띄워요. 워커가 띄운 워커는 기록하지 않아요');
    }
    if (!s.orders[event.worker.orderId]) {
      throw new Error(`모르는 주문의 워커예요: ${event.worker.orderId}`);
    }
  }
  if (event.type === 'order-added' && s.orders[event.order.id]) {
    throw new Error(`이미 있는 주문 id예요: ${event.order.id}`);
  }
  if (event.type === 'order-updated' && !s.orders[event.orderId]) {
    throw new Error(`모르는 주문이에요: ${event.orderId}`);
  }
  if (event.type === 'order-removed') {
    const blocker = removalBlocker(s, event.orderId);
    if (blocker) throw new Error(blocker);
  }
  if (event.type === 'worker-updated' && !s.workers[event.workerId]) {
    throw new Error(`모르는 워커예요: ${event.workerId}`);
  }
  if ((event.type === 'gate-updated' || event.type === 'gate-delivery') && !s.gates[event.gateId]) {
    throw new Error(`모르는 게이트예요: ${event.gateId}`);
  }
  if (event.type === 'gate-resolved') {
    const g = s.gates[event.gateId];
    if (!g) throw new Error(`모르는 게이트예요: ${event.gateId}`);
    if (g.status !== 'open') throw new Error(`이미 종료된 게이트예요: ${event.gateId}`);
  }
}

function endsWithoutNewline(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return false;
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return false;
    const buf = Buffer.alloc(1);
    readSync(fd, buf, 0, 1, size - 1);
    return buf[0] !== 0x0a;
  } finally {
    closeSync(fd);
  }
}

/**
 * 로그를 재생한다. append 도중 끊겨 반쯤 써진 줄은 둘 중 하나일 때만 버린다.
 * 마지막 줄이거나, 다음 append가 개행을 붙이고 남긴 tail-repaired 표시가 바로 뒤에 올 때다.
 * 그 밖의 중간 줄이 깨졌으면 복원 결과를 믿을 수 없으니 멈춘다.
 */
export function replay(
  path: string,
  s: ConductorSnapshot = emptySnapshot(),
  range: { from?: number; to?: number } = {},
  /** 이벤트를 적용하기 직전에 부른다. 반영이 이벤트를 주문별로 모으는 자리다 */
  onEvent?: (event: ConductorEvent, line: string, before: ConductorSnapshot) => void,
): ConductorSnapshot {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (e) {
    // 떼어 내기가 이름을 바꾸거나 지운 파일. replayStore가 모양이 바뀐 걸 보고 다시 읽는다
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return s;
    throw e;
  }
  const lines = buf
    .subarray(range.from ?? 0, range.to ?? buf.length)
    .toString('utf-8')
    .split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    let event: ConductorEvent;
    try {
      event = JSON.parse(line) as ConductorEvent;
    } catch {
      const next = nextNonEmpty(lines, i + 1);
      if (next === undefined) break;
      if (isTailRepaired(next)) {
        log(`${path} ${i + 1}번째 줄이 반쯤 써져 있어 건너뛰어요`);
        continue;
      }
      throw new Error(`${path} ${i + 1}번째 줄을 못 읽어요. 저장소가 깨졌어요`);
    }
    onEvent?.(event, line, s);
    applyEvent(s, event);
  }
  return s;
}

/**
 * 저장소 디렉토리 하나를 재생한다. base.json에서 시작해 segment를 이름 순서로, 그다음 `events.jsonl`을
 * 재생한다. base.json에 반영한 segment는 반영한 길이 뒤에 붙은 줄만 읽는다. base.json이 없으면
 * 빈 상태에서 시작하므로 떼어 낸 적 없는 저장소는 예전과 같게 돈다.
 *
 * 떼어 내기(fold.ts)는 잠금 없이 읽는 쪽과 겹칠 수 있다. 읽는 사이 segment가 생기거나
 * base.json이 바뀌면 이벤트를 빠뜨리거나 두 번 반영할 수 있어서 앞뒤 모양이 같을 때까지
 * 다시 읽는다. MAX_REPLAY_ATTEMPTS번 읽어도 계속 바뀌면 어긋난 상태를 돌려주지 않고 던진다.
 */
export function replayStore(
  dir: string,
  /** 테스트가 재생과 비교 사이에 저장소 모양을 바꿔 보는 자리 */
  hooks: { afterReplay?: () => void } = {},
): ConductorSnapshot {
  for (let attempt = 1; ; attempt++) {
    const before = storeLayout(dir);
    const base = readBase(dir);
    const s = base ? base.state : emptySnapshot();
    const folded = new Map(base?.foldedSegments.map((f) => [f.name, f.size]) ?? []);
    for (const name of listSegments(dir)) {
      replay(join(dir, SEGMENTS_DIR, name), s, { from: folded.get(name) ?? 0 });
    }
    replay(join(dir, EVENTS_FILE), s);
    hooks.afterReplay?.();
    if (storeLayout(dir) === before) return s;
    if (attempt >= MAX_REPLAY_ATTEMPTS) {
      throw new Error(`${dir}를 읽는 동안 저장소가 계속 바뀌어요. 잠시 뒤 다시 열어 주세요`);
    }
  }
}

/**
 * 반영해도 되는 바이트 수. 마지막 줄바꿈까지가 기본이다. 줄바꿈 없이 끝난 마지막 줄도 JSON으로 읽히면
 * `replay`가 그 줄을 적용하므로 포함한다. 여기서 빼면 반영한 길이 뒤에 남은 줄로 보고 지울 때 버린다
 */
export function completeLength(buf: Buffer): number {
  const end = buf.lastIndexOf(0x0a) + 1;
  if (end === buf.length) return end;
  try {
    JSON.parse(buf.subarray(end).toString('utf-8'));
    return buf.length;
  } catch {
    return end;
  }
}

/** segment 파일 이름을 떼어 낸 순서로 */
export function listSegments(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(join(dir, SEGMENTS_DIR));
  } catch {
    return [];
  }
  return names.filter((n) => SEGMENT_NAME.test(n)).sort();
}

export function readBase(dir: string): BaseFile | undefined {
  const path = join(dir, BASE_FILE);
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!isBaseFile(parsed)) throw new Error(`${path}를 못 읽어요. 저장소가 깨졌어요`);
  // 보관이 들어가기 전에 쓴 base.json에는 이 칸이 없다
  if (!isPlainObject(parsed.state.archivedOrders)) parsed.state.archivedOrders = {};
  // 게이트 색인이 들어가기 전에 쓴 base.json에는 이 칸이 없다
  if (!isPlainObject(parsed.state.askedSourceRefs)) parsed.state.askedSourceRefs = {};
  return parsed;
}

const SNAPSHOT_RECORDS = [
  'orders',
  'removedOrders',
  'workers',
  'checkpoints',
  'gates',
  'slackPosted',
  'appliedReports',
  'reports',
] as const;

function isBaseFile(v: unknown): v is BaseFile {
  if (!isPlainObject(v) || v.version !== 1 || !Array.isArray(v.foldedSegments)) return false;
  const st = v.state;
  if (!isPlainObject(st)) return false;
  if (!SNAPSHOT_RECORDS.every((k) => isPlainObject(st[k]))) return false;
  if (!Array.isArray(st.bypasses) || !Array.isArray(st.jiraTransitions)) return false;
  if (!Number.isSafeInteger(st.ticks) || !Number.isSafeInteger(st.eventCount)) return false;
  return v.foldedSegments.every(
    (f) =>
      isPlainObject(f) &&
      typeof f.name === 'string' &&
      SEGMENT_NAME.test(f.name) &&
      Number.isSafeInteger(f.size) &&
      (f.size as number) >= 0,
  );
}

function statKey(path: string): string {
  try {
    const st = statSync(path);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return '-';
  }
}

/** base.json과 segment 목록. 떼어 내기가 끼었는지 보는 값이라 덧붙이기로는 안 바뀐다 */
export function storeLayout(dir: string): string {
  return `${statKey(join(dir, BASE_FILE))}|${listSegments(dir).join(',')}`;
}

/**
 * 저장소 내용이 바뀌었는지 가늠하는 값. 다시 재생할지 정하는 캐시 키로 쓴다.
 * 반영한 segment에 늦게 붙은 줄도 잡도록 segment마다 크기와 mtime을 넣는다
 */
export function storeStamp(dir: string): string {
  const segments = listSegments(dir).map((n) => `${n}:${statKey(join(dir, SEGMENTS_DIR, n))}`);
  return `${statKey(join(dir, BASE_FILE))}|${segments.join(',')}|${statKey(join(dir, EVENTS_FILE))}`;
}

function nextNonEmpty(lines: string[], from: number): string | undefined {
  for (let j = from; j < lines.length; j++) {
    if (lines[j]!.trim()) return lines[j]!;
  }
  return undefined;
}

function isTailRepaired(line: string): boolean {
  try {
    return (JSON.parse(line) as { type?: unknown }).type === 'tail-repaired';
  } catch {
    return false;
  }
}
