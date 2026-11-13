import {
  checkCheckpoint,
  defaultObserveDeps,
  isShipPhase,
  type CheckReport,
} from '../ship/checkpoint.js';
import { openOrReuse } from './gates.js';
import type { ResumeContext } from './launcher.js';
import type { ConductorStore } from './store.js';
import { isWorkerId, type Checkpoint, type Gate, type Order, type Worker } from './types.js';

/** ship 체크포인트 파일을 읽는 자리. 테스트에서 git 호출 없이 바꿔 끼운다 */
export type ShipReader = (dir: string) => CheckReport;

export const defaultShipReader: ShipReader = (dir) => checkCheckpoint(dir, defaultObserveDeps());

/** 재개를 사람에게 올린 게이트임을 payload로 표시한다. 승인되면 시도 수를 다시 센다 */
const RESUME_GATE_KIND = 'resume';

export interface CheckpointInput {
  workerId: string;
  skill: string;
  phase?: string;
  round?: number | null;
  next: string;
  completedSkills?: string[];
  shipDir?: string;
  refs?: string[];
}

/**
 * 스킬 체인 공통 체크포인트를 남긴다.
 *
 * 끝낸 스킬은 앞 체크포인트와 합친다. 워커가 바뀌어도 이미 끝낸 스킬을 다시 돌리지 않게 하려는 것이다.
 * ship은 단계를 안 적으면 shipDir의 체크포인트 파일에서 단계와 라운드를 읽는다.
 */
export function saveSkillCheckpoint(
  store: ConductorStore,
  input: CheckpointInput,
  readShip: ShipReader = defaultShipReader,
): Checkpoint {
  if (!isWorkerId(input.workerId)) {
    throw new Error(`워커 id 꼴이 아니에요: ${input.workerId.slice(0, 80)}`);
  }
  const worker = store.worker(input.workerId);
  if (!worker) throw new Error(`워커를 못 찾았어요: ${input.workerId}`);
  const order = store.order(worker.orderId);
  if (!order) throw new Error(`주문을 못 찾았어요: ${worker.orderId}`);
  if (input.skill === 'ship' && input.phase !== undefined && !isShipPhase(input.phase)) {
    throw new Error(`ship 단계가 아니에요: ${input.phase}`);
  }

  let { phase, round } = input;
  if (input.skill === 'ship' && phase === undefined && input.shipDir) {
    const report = readShip(input.shipDir);
    if (report.status !== 'none' && report.checkpoint) {
      phase = report.checkpoint.phase;
      round = report.checkpoint.round;
    }
  }

  const previous = store.snapshot.checkpoints[order.id];
  const completed = new Set([
    ...(previous?.completedSkills ?? []),
    ...(input.completedSkills ?? []),
  ]);
  const checkpoint: Checkpoint = {
    orderId: order.id,
    workerId: worker.id,
    skill: input.skill,
    ...(phase !== undefined ? { phase } : {}),
    ...(round !== undefined ? { round } : {}),
    next: input.next,
    completedSkills: order.skillChain.filter((s) => completed.has(s)),
    ...(input.shipDir ? { shipDir: input.shipDir } : {}),
    refs: input.refs ?? [],
    savedAt: store.timestamp(),
  };
  store.saveCheckpoint(checkpoint);
  store.updateWorker(worker.id, { lastSeenAt: checkpoint.savedAt, ...wakeFromRateLimit(worker) });
  return checkpoint;
}

/** 오르카 워커 터미널을 들여다본 결과. 런처의 probe가 돌려준다 */
export type WorkerProbe =
  /** 에이전트가 아직 출력 중이다 */
  | { state: 'working' }
  /** 터미널 끝에 세션 리밋이나 사용량 한도 표시가 있다 */
  | { state: 'rate-limit'; text: string; resetsAt?: string }
  /** 터미널은 살아 있는데 출력도 한도 표시도 없다 */
  | { state: 'idle' }
  /** 터미널이 없거나 프로세스가 끝났다 */
  | { state: 'gone' };

export type ProbeWorker = (worker: Worker) => Promise<WorkerProbe>;

export interface StaleOptions {
  now: Date;
  staleAfterMs: number;
  /** 오르카 워커 터미널을 확인하는 자리. 없으면 오르카 워커도 지금처럼 바로 끊김으로 본다 */
  probe?: ProbeWorker;
  /** 리밋에 걸린 채 이 시간이 지나면 사람에게 올린다. 없으면 올리지 않는다 */
  rateLimitEscalateAfterMs?: number;
}

export interface StaleResult {
  /** 이번에 끊김으로 바꾼 워커. 재개 대상이다 */
  stopped: Worker[];
  /** 이번에 리밋으로 바꾼 워커 */
  rateLimited: Worker[];
  /** 리밋이 오래 안 풀려 이번에 연 게이트 */
  escalated: Gate[];
  /** 터미널 확인이 실패한 자리. tick 보고 warnings로 간다 */
  warnings: string[];
}

/** 리밋이 오래 가는 워커를 올린 게이트임을 payload로 표시한다 */
const RATE_LIMIT_GATE_KIND = 'rate-limit';

/**
 * 소식이 끊긴 워커를 stopped로 바꾼다.
 *
 * 한도 초과나 계정 변경으로 멈춘 세션은 보고를 못 남기고 죽는 경우가 많다.
 * 그래서 보고를 기다리지 않고 마지막 소식(lastSeenAt)이 오래되면 끊긴 것으로 본다.
 *
 * 오르카 워커는 바로 바꾸지 않고 터미널을 먼저 본다. 세션 리밋에 걸려 멈춘 워커를 끊김으로 보고
 * 새 워커를 띄우면 리밋이 풀린 앞 워커가 다시 움직여 한 주문을 둘이 진행한다(2026-11-13 세 주문).
 * 그래서 한도 표시가 보이면 rate-limit으로 남기고 재개하지 않는다. 확인이 실패하면 지금처럼
 * 끊김으로 보되 warnings에 남긴다. git 워크트리와 서브에이전트 워커는 들여다볼 터미널이 없다.
 */
export async function detectStale(store: ConductorStore, opts: StaleOptions): Promise<StaleResult> {
  const result: StaleResult = { stopped: [], rateLimited: [], escalated: [], warnings: [] };
  for (const w of store.activeWorkers()) {
    // 사람 확인을 기다리는 워커는 보고 없이 멈춰 있는 게 정상이다. 끊김으로 보면 승인이 그 워커에 못 닿는다
    if (store.order(w.orderId)?.status === 'waiting-gate') continue;
    const seen = Date.parse(w.lastSeenAt);
    if (Number.isNaN(seen) || opts.now.getTime() - seen < opts.staleAfterMs) continue;

    const probed = canProbe(w) && opts.probe ? await probeOrWarn(w, opts.probe, result) : undefined;
    if (probed?.state === 'working') continue;
    if (probed?.state === 'rate-limit') {
      store.updateWorker(w.id, {
        status: 'stopped',
        stopReason: 'rate-limit',
        rateLimitedAt: opts.now.toISOString(),
        ...(probed.resetsAt ? { rateLimitResetsAt: probed.resetsAt } : {}),
      });
      result.rateLimited.push(store.worker(w.id)!);
      continue;
    }
    store.updateWorker(w.id, { status: 'stopped', stopReason: 'disconnected' });
    result.stopped.push(store.worker(w.id)!);
  }
  await recheckRateLimited(store, opts, result);
  return result;
}

/**
 * 리밋으로 멈춘 워커를 다시 본다.
 *
 * 터미널이 사라졌으면 그때 끊김으로 바꿔 재개로 넘긴다. 상한을 넘기면 사람에게 올린다.
 * 리밋이 풀려 워커가 보고나 체크포인트를 남기면 running으로 돌아오므로 여기서는 안 바꾼다.
 */
async function recheckRateLimited(
  store: ConductorStore,
  opts: StaleOptions,
  result: StaleResult,
): Promise<void> {
  const fresh = new Set(result.rateLimited.map((w) => w.id));
  for (const w of rateLimitedWorkers(store)) {
    if (fresh.has(w.id)) continue;
    const order = store.order(w.orderId)!;
    if (order.status !== 'running') continue;
    const since = Date.parse(w.rateLimitedAt ?? w.lastSeenAt);
    const limit = opts.rateLimitEscalateAfterMs;
    if (limit !== undefined && !Number.isNaN(since) && opts.now.getTime() - since >= limit) {
      const hours = Math.floor((opts.now.getTime() - since) / 3_600_000);
      const { gate } = openOrReuse(store, {
        orderId: order.id,
        type: 'no-procedure',
        reason: `워커 ${w.id}가 세션 리밋에 걸린 채 ${hours}시간째 안 풀렸어요. 승인하면 앞 워커 터미널을 거두고 체크포인트부터 다시 띄우고, 거절하면 주문을 취소해요`,
        refs: w.rateLimitResetsAt ? [`오르카가 알려 준 풀리는 시각: ${w.rateLimitResetsAt}`] : [],
        payload: { kind: RATE_LIMIT_GATE_KIND, workerId: w.id },
      });
      result.escalated.push(gate);
      continue;
    }
    if (!opts.probe) continue;
    let probed: WorkerProbe;
    try {
      probed = await opts.probe(w);
    } catch (err) {
      result.warnings.push(
        `${w.id}: 리밋으로 멈춘 오르카 워커의 터미널을 다시 확인 못 했어요: ${(err as Error).message}`,
      );
      continue;
    }
    if (probed.state === 'gone') {
      store.updateWorker(w.id, { stopReason: 'disconnected' });
      result.stopped.push(store.worker(w.id)!);
    }
  }
}

/**
 * 리밋으로 멈춘 채 주문을 쥐고 있는 오르카 워커. tick 보고와 status가 사람에게 보여 준다.
 * 재개 대상에서 빠지므로 여기 안 보이면 오래 멈춰 있어도 아무도 모른다.
 */
export function rateLimitedWorkers(store: ConductorStore): Worker[] {
  return store.workers().filter((w) => {
    if (!isRateLimited(w)) return false;
    return store.order(w.orderId)?.workerId === w.id;
  });
}

function isRateLimited(w: Worker): boolean {
  return w.kind === 'orca-worktree' && w.status === 'stopped' && w.stopReason === 'rate-limit';
}

function canProbe(w: Worker): boolean {
  return w.kind === 'orca-worktree' && Boolean(w.handle);
}

async function probeOrWarn(
  w: Worker,
  probe: ProbeWorker,
  result: StaleResult,
): Promise<WorkerProbe | undefined> {
  try {
    return await probe(w);
  } catch (err) {
    result.warnings.push(
      `${w.id}: 오르카 터미널을 확인 못 해 끊김으로 보고 재개해요: ${(err as Error).message}`,
    );
    return undefined;
  }
}

/**
 * 리밋으로 멈췄던 워커가 보고나 체크포인트를 남기면 running으로 되돌린다. 리밋이 풀린 것이다.
 * 바꿀 게 없으면 빈 객체를 돌려준다.
 */
export function wakeFromRateLimit(w: Worker): Partial<Worker> {
  if (!isRateLimited(w)) return {};
  return {
    status: 'running',
    stopReason: undefined,
    rateLimitedAt: undefined,
    rateLimitResetsAt: undefined,
  };
}

/** 사람이 재개를 승인한 뒤로 띄운 워커 수. 승인하면 시도 수를 새로 센다 */
function attemptsSinceApproval(store: ConductorStore, orderId: string): number {
  const approvedAt = Object.values(store.snapshot.gates)
    .filter(
      (g) =>
        g.orderId === orderId &&
        g.payload?.kind === RESUME_GATE_KIND &&
        g.status === 'resolved' &&
        g.decision === 'approved',
    )
    .map((g) => g.resolvedAt ?? '')
    .sort()
    .at(-1);
  return store.workersOf(orderId).filter((w) => !approvedAt || w.startedAt > approvedAt).length;
}

export type ResumeDecision =
  | { kind: 'resume'; order: Order; previous: Worker }
  | { kind: 'escalate'; order: Order; previous: Worker; gate: Gate };

/**
 * 멈춘 워커를 가진 주문을 골라 재개할지 사람에게 올릴지 정한다.
 *
 * 재개는 주문을 queued로 되돌리는 데까지만 한다. 실제로 띄우는 건 tick의 launch 단계라
 * 재개도 동시 상한과 계정 확인을 그대로 거친다. 재개가 안 서면 그 주문만 escalated로 두고
 * 다른 주문은 계속 돈다.
 */
export function prepareResumes(
  store: ConductorStore,
  opts: { maxResumeAttempts: number; readShip?: ShipReader },
): ResumeDecision[] {
  const readShip = opts.readShip ?? defaultShipReader;
  const decisions: ResumeDecision[] = [];
  for (const order of store.orders()) {
    if (order.status !== 'running' || !order.workerId) continue;
    const previous = store.worker(order.workerId);
    if (previous?.status !== 'stopped') continue;
    // 리밋이 풀리면 앞 워커가 다시 움직인다. 새로 띄우면 둘이 같은 주문을 진행한다
    if (isRateLimited(previous)) continue;

    const blocker = resumeBlocker(store, order, opts.maxResumeAttempts, readShip);
    if (!blocker) {
      store.updateOrder(order.id, { status: 'queued' });
      decisions.push({ kind: 'resume', order: store.order(order.id)!, previous });
      continue;
    }
    const gate = escalateResume(store, order, previous, blocker);
    decisions.push({ kind: 'escalate', order: store.order(order.id)!, previous, gate });
  }
  return decisions;
}

/** 재개를 멈추고 사람에게 올린다. 승인되면 시도 수를 새로 세고 다시 띄운다 */
export function escalateResume(
  store: ConductorStore,
  order: Order,
  previous: Worker,
  blocker: string,
): Gate {
  const checkpoint = store.snapshot.checkpoints[order.id];
  const { gate } = openOrReuse(store, {
    orderId: order.id,
    type: 'no-procedure',
    reason: `재개 불가: ${blocker} (멈춘 이유 ${previous.stopReason ?? 'unknown'})`,
    refs: checkpoint ? [describeCheckpoint(checkpoint), ...checkpoint.refs] : [],
    payload: { kind: RESUME_GATE_KIND, workerId: previous.id },
  });
  store.updateOrder(order.id, { status: 'escalated' });
  return gate;
}

function resumeBlocker(
  store: ConductorStore,
  order: Order,
  maxResumeAttempts: number,
  readShip: ShipReader,
): string | undefined {
  const resumes = attemptsSinceApproval(store, order.id) - 1;
  if (resumes >= maxResumeAttempts) return `재개를 ${resumes}번 했는데도 멈췄어요`;

  const checkpoint = store.snapshot.checkpoints[order.id];
  if (checkpoint && order.skillChain.every((s) => checkpoint.completedSkills.includes(s))) {
    return '체인을 다 끝냈다는 체크포인트만 있고 결과 보고가 없어요';
  }
  if (checkpoint?.skill === 'ship' && checkpoint.shipDir) {
    const report = readShip(checkpoint.shipDir);
    if (report.status === 'mismatch' && !report.checkpoint) {
      return report.mismatches[0]?.detail ?? 'ship 체크포인트를 못 읽었어요';
    }
  }
  return undefined;
}

function describeCheckpoint(cp: Checkpoint): string {
  const where = [
    cp.skill,
    cp.phase ? `단계 ${cp.phase}` : '',
    cp.round != null ? `라운드 ${cp.round}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `마지막 체크포인트: ${where}, 다음 ${cp.next} (${cp.savedAt})`;
}

export interface ResumeLaunch {
  context: ResumeContext;
  /** 이어받는 앞 워커. 오르카 워커는 새로 띄우기 전에 이 워커의 터미널을 거둔다 */
  previous: Worker;
  previousHandle?: string;
}

/**
 * queued 주문이 멈춘 워커를 이어받는 거면 재개 지시서 재료를 돌려준다. 새 주문이면 undefined다.
 *
 * ship은 저장소의 체크포인트보다 ship 체크포인트 파일을 믿는다. ship이 라운드를 돌 때마다
 * 파일만 갱신하고 컨덕터에 따로 알리지 않을 수 있어서다.
 */
export function resumeLaunchFor(
  store: ConductorStore,
  order: Order,
  readShip: ShipReader = defaultShipReader,
): ResumeLaunch | undefined {
  const previous = order.workerId ? store.worker(order.workerId) : undefined;
  if (previous?.status !== 'stopped') return undefined;

  const saved = store.snapshot.checkpoints[order.id];
  let checkpoint: Checkpoint = saved ?? {
    orderId: order.id,
    workerId: previous.id,
    skill: order.skillChain[0] ?? 'solve',
    next: '체크포인트가 없어 체인 처음부터 다시 한다',
    completedSkills: [],
    refs: [],
    savedAt: previous.lastSeenAt,
  };
  if (checkpoint.skill === 'ship' && checkpoint.shipDir) {
    const report = readShip(checkpoint.shipDir);
    if (report.status !== 'none' && report.checkpoint) {
      checkpoint = {
        ...checkpoint,
        phase: report.checkpoint.phase,
        round: report.checkpoint.round,
      };
    }
  }
  return {
    context: { checkpoint, reason: previous.stopReason ?? 'unknown' },
    previous,
    ...(previous.handle ? { previousHandle: previous.handle } : {}),
  };
}

/** 재개 게이트인지. CLI와 엔진이 게이트 목록을 보여줄 때 쓴다 */
export function isResumeGate(gate: Gate): boolean {
  return gate.payload?.kind === RESUME_GATE_KIND;
}
