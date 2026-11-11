import {
  checkCheckpoint,
  defaultObserveDeps,
  isShipPhase,
  type CheckReport,
} from '../ship/checkpoint.js';
import { openOrReuse } from './gates.js';
import type { ResumeContext } from './launcher.js';
import type { MasterStore } from './store.js';
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
  store: MasterStore,
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
  store.updateWorker(worker.id, { lastSeenAt: checkpoint.savedAt });
  return checkpoint;
}

/**
 * 소식이 끊긴 워커를 stopped로 바꾼다.
 *
 * 한도 초과나 계정 변경으로 멈춘 세션은 보고를 못 남기고 죽는 경우가 많다.
 * 그래서 보고를 기다리지 않고 마지막 소식(lastSeenAt)이 오래되면 끊긴 것으로 본다.
 */
export function detectStale(
  store: MasterStore,
  opts: { now: Date; staleAfterMs: number },
): Worker[] {
  const stale: Worker[] = [];
  for (const w of store.activeWorkers()) {
    // 사람 확인을 기다리는 워커는 보고 없이 멈춰 있는 게 정상이다. 끊김으로 보면 승인이 그 워커에 못 닿는다
    if (store.order(w.orderId)?.status === 'waiting-gate') continue;
    const seen = Date.parse(w.lastSeenAt);
    if (Number.isNaN(seen) || opts.now.getTime() - seen < opts.staleAfterMs) continue;
    store.updateWorker(w.id, { status: 'stopped', stopReason: 'disconnected' });
    stale.push(store.worker(w.id)!);
  }
  return stale;
}

/** 사람이 재개를 승인한 뒤로 띄운 워커 수. 승인하면 시도 수를 새로 센다 */
function attemptsSinceApproval(store: MasterStore, orderId: string): number {
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
  store: MasterStore,
  opts: { maxResumeAttempts: number; readShip?: ShipReader },
): ResumeDecision[] {
  const readShip = opts.readShip ?? defaultShipReader;
  const decisions: ResumeDecision[] = [];
  for (const order of store.orders()) {
    if (order.status !== 'running' || !order.workerId) continue;
    const previous = store.worker(order.workerId);
    if (previous?.status !== 'stopped') continue;

    const blocker = resumeBlocker(store, order, opts.maxResumeAttempts, readShip);
    if (!blocker) {
      store.updateOrder(order.id, { status: 'queued' });
      decisions.push({ kind: 'resume', order: store.order(order.id)!, previous });
      continue;
    }
    const checkpoint = store.snapshot.checkpoints[order.id];
    const { gate } = openOrReuse(store, {
      orderId: order.id,
      type: 'no-procedure',
      reason: `재개 불가: ${blocker} (멈춘 이유 ${previous.stopReason ?? 'unknown'})`,
      refs: checkpoint ? [describeCheckpoint(checkpoint), ...checkpoint.refs] : [],
      payload: { kind: RESUME_GATE_KIND, workerId: previous.id },
    });
    store.updateOrder(order.id, { status: 'escalated' });
    decisions.push({ kind: 'escalate', order: store.order(order.id)!, previous, gate });
  }
  return decisions;
}

function resumeBlocker(
  store: MasterStore,
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
  previousHandle?: string;
}

/**
 * queued 주문이 멈춘 워커를 이어받는 거면 재개 지시서 재료를 돌려준다. 새 주문이면 undefined다.
 *
 * ship은 저장소의 체크포인트보다 ship 체크포인트 파일을 믿는다. ship이 라운드를 돌 때마다
 * 파일만 갱신하고 마스터에 따로 알리지 않을 수 있어서다.
 */
export function resumeLaunchFor(
  store: MasterStore,
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
    ...(previous.handle ? { previousHandle: previous.handle } : {}),
  };
}

/** 재개 게이트인지. CLI와 엔진이 게이트 목록을 보여줄 때 쓴다 */
export function isResumeGate(gate: Gate): boolean {
  return gate.payload?.kind === RESUME_GATE_KIND;
}
