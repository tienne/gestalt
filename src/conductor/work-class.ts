import type { Order, Worker } from './types.js';

/**
 * 주문의 작업 유형. 동시 실행 슬롯을 유형마다 따로 센다.
 *
 * 워커 종류(workerKind)나 에이전트(agent)와는 다른 칸이다. 그 둘은 워커를 어떻게 띄울지 정하고
 * 이 값은 어느 슬롯을 차지할지 정한다. 서브에이전트로 도는 리뷰도, 오르카 워크트리로 도는 리뷰도 리뷰 슬롯이다.
 */
export const WORK_CLASSES = ['lookup', 'review', 'work'] as const;
export type WorkClass = (typeof WORK_CLASSES)[number];

export const WORK_CLASS_LABEL: Record<WorkClass, string> = {
  lookup: '조회',
  review: '리뷰',
  work: '작업',
};

export type WorkerLimits = Record<WorkClass, number>;

/** 유형별 기본 한도. 합계 20이 전체 한도다 */
export const DEFAULT_WORKER_LIMITS: Readonly<WorkerLimits> = { lookup: 5, review: 5, work: 10 };

export function isWorkClass(v: unknown): v is WorkClass {
  return typeof v === 'string' && (WORK_CLASSES as readonly string[]).includes(v);
}

/** 독립 조회와 상태 확인. 코드를 고치지 않고 짧게 끝난다 */
const LOOKUP_SKILLS: ReadonlySet<string> = new Set(['blast-radius', 'diff-radius', 'explain']);

/**
 * 독립 리뷰와 재리뷰. review-reply는 받은 리뷰를 반영해 코드를 고치므로 여기 없다(작업이다).
 * doubt는 결정을 반박받는 검토라 리뷰로 센다
 */
const REVIEW_SKILLS: ReadonlySet<string> = new Set(['review', 'review-loop', 'doubt']);

/**
 * 스킬 체인으로 유형을 고른다. 체인에 조회나 리뷰가 아닌 스킬이 하나라도 있으면 작업이다.
 * 구현 체인 안의 리뷰 단계(ship의 로컬 리뷰 같은)는 같은 워커가 이어 돌리므로 작업 슬롯을 그대로 쓴다.
 * 레포 스킬(`repo:`)과 모르는 스킬, 빈 체인도 작업이다. 무엇을 하는지 모르면 가장 큰 슬롯에 넣는다
 */
export function classifyWork(skillChain: readonly string[]): WorkClass {
  if (skillChain.length === 0) return 'work';
  if (skillChain.every((s) => LOOKUP_SKILLS.has(s))) return 'lookup';
  if (skillChain.every((s) => LOOKUP_SKILLS.has(s) || REVIEW_SKILLS.has(s))) return 'review';
  return 'work';
}

/**
 * 접수 때 남길 유형. 직접 정한 값은 스킬 체인이 고른 유형보다 크거나 같을 때만 쓴다.
 * 구현 체인을 조회나 리뷰로 내리면 복합 작업이 작은 슬롯에 들어가 작업 한도를 건너뛴다
 */
export function resolveWorkClass(
  skillChain: readonly string[],
  requested: WorkClass | undefined,
): WorkClass {
  const classified = classifyWork(skillChain);
  if (!requested) return classified;
  return WORK_CLASSES.indexOf(requested) > WORK_CLASSES.indexOf(classified)
    ? requested
    : classified;
}

/**
 * 주문의 유형. 접수 때 남긴 값이 먼저다. 이 칸이 생기기 전에 들어온 주문은 스킬 체인으로 다시 고른다.
 * 같은 체인이면 언제 읽어도 같은 유형이 나와 재시작과 재개에서도 슬롯이 바뀌지 않는다
 */
export function orderWorkClass(order: Pick<Order, 'workClass' | 'skillChain'>): WorkClass {
  // 저장소 파일을 손으로 고쳤거나 다른 버전이 쓴 값이 목록 밖이면 한도 검사에서 빠지므로 체인으로 다시 고른다
  return isWorkClass(order.workClass) ? order.workClass : classifyWork(order.skillChain ?? []);
}

/** 워커가 차지한 슬롯. 띄울 때 남긴 값이 먼저고 없으면(옛 워커) 주문으로 고른다 */
export function workerWorkClass(
  worker: Pick<Worker, 'workClass'>,
  order: Pick<Order, 'workClass' | 'skillChain'> | undefined,
): WorkClass {
  if (isWorkClass(worker.workClass)) return worker.workClass;
  return order ? orderWorkClass(order) : 'work';
}

/** 유형마다 값을 하나씩 만든다. 유형이 늘면 여기 한 곳에서 키가 따라 늘어난다 */
export function mapClasses<T>(fn: (c: WorkClass) => T): Record<WorkClass, T> {
  return Object.fromEntries(WORK_CLASSES.map((c) => [c, fn(c)])) as Record<WorkClass, T>;
}

export function totalLimit(limits: Readonly<WorkerLimits>): number {
  return WORK_CLASSES.reduce((sum, c) => sum + limits[c], 0);
}
