import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../core/json-file.js';
import { log } from '../core/log.js';
import {
  ACTIVE_WORKER_STATUSES,
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
 * 이벤트를 `events.jsonl`에 한 줄씩 덧붙이고 상태는 그 로그를 처음부터 재생해서 만든다.
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

export function emptySnapshot(): ConductorSnapshot {
  return {
    orders: {},
    workers: {},
    checkpoints: {},
    gates: {},
    bypasses: [],
    jiraTransitions: [],
    slackPosted: {},
    appliedReports: {},
    ticks: 0,
    eventCount: 0,
  };
}

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
      s.workers[e.worker.id] = { ...e.worker };
      return;
    case 'worker-updated': {
      const w = s.workers[e.workerId];
      if (w) s.workers[e.workerId] = { ...w, ...e.patch };
      return;
    }
    case 'checkpoint-saved':
      s.checkpoints[e.checkpoint.orderId] = { ...e.checkpoint };
      return;
    case 'gate-opened':
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
        };
      }
      return;
    }
    case 'bypass':
      s.bypasses.push(e.record);
      return;
    case 'jira-transition':
      s.jiraTransitions.push(e.record);
      return;
    case 'slack-posted':
      s.slackPosted[e.gateId] = e.ref;
      return;
    case 'report-applied':
      s.appliedReports[e.name] = e.at;
      return;
    case 'tick':
      s.ticks += 1;
      s.lastTickAt = e.at;
      for (const name of e.clearedReports ?? []) delete s.appliedReports[name];
      return;
    case 'tail-repaired':
      return;
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

  private constructor(dir: string, state: ConductorSnapshot, now: () => Date) {
    this.dir = dir;
    this.state = state;
    this.now = now;
  }

  /** 로그를 처음부터 재생해 연다. 디렉토리가 없으면 만든다 */
  static open(dir: string, opts: { now?: () => Date } = {}): ConductorStore {
    mkdirSync(dir, { recursive: true });
    return new ConductorStore(dir, replay(join(dir, EVENTS_FILE)), opts.now ?? (() => new Date()));
  }

  get snapshot(): Readonly<ConductorSnapshot> {
    return this.state;
  }

  timestamp(): string {
    return this.now().toISOString();
  }

  /** 다른 프로세스가 덧붙인 이벤트까지 다시 읽는다 */
  reload(): void {
    this.state = replay(join(this.dir, EVENTS_FILE));
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
    if (this.deferDepth === 0) this.flushSnapshot();
  }

  /** 사람과 도구가 읽는 사본을 지금 상태로 쓴다 */
  flushSnapshot(): void {
    writeJsonAtomic(join(this.dir, SNAPSHOT_FILE), this.state);
  }

  /**
   * fn이 도는 동안 append마다 사본을 다시 쓰지 않고 끝에 한 번만 쓴다.
   * 사본은 줄지 않는 목록까지 통째로 담아 이벤트마다 쓰면 tick 하나가 수십 번 직렬화한다
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

  startWorker(worker: Worker): void {
    this.append({ type: 'worker-started', at: this.timestamp(), worker });
  }

  updateWorker(workerId: string, patch: Partial<Omit<Worker, 'id' | 'spawnedBy'>>): void {
    this.append({ type: 'worker-updated', at: this.timestamp(), workerId, patch });
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
    return Object.values(this.state.gates).filter(
      (g) => g.status === 'open' && (orderId === undefined || g.orderId === orderId),
    );
  }

  findOrderBySourceRef(sourceRef: string): Order | undefined {
    return this.orders().find((o) => o.sourceRef === sourceRef);
  }

  workersOf(orderId: string): Worker[] {
    return this.workers()
      .filter((w) => w.orderId === orderId)
      .sort((a, b) => a.attempt - b.attempt);
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
  if (event.type === 'worker-updated' && !s.workers[event.workerId]) {
    throw new Error(`모르는 워커예요: ${event.workerId}`);
  }
  if (event.type === 'gate-updated' && !s.gates[event.gateId]) {
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
export function replay(path: string): ConductorSnapshot {
  const s = emptySnapshot();
  if (!existsSync(path)) return s;
  const lines = readFileSync(path, 'utf-8').split('\n');
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
    applyEvent(s, event);
  }
  return s;
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
