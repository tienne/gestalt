/**
 * 컨덕터 도메인 타입.
 *
 * 컨덕터는 주문을 받아 워커에 나눠 주고 정해진 끝 자리까지 끌고 간다. 상태는 대화 밖
 * 저장소(`store.ts`)에 이벤트로 쌓는다. 여기 타입은 그 이벤트와 스냅샷의 꼴이다.
 */

import { ORDER_SCOPES } from '../core/constants.js';

export { ORDER_SCOPES };
/** 주문 하나가 사람 손을 어디서 거치는지. merge-through는 머지까지 무승인이다 */
export type OrderScope = (typeof ORDER_SCOPES)[number];

export const INTAKE_KINDS = ['spoken', 'jira', 'external-queue', 'pr-watch'] as const;
export type IntakeKind = (typeof INTAKE_KINDS)[number];

export const ISSUE_TYPES = ['sub-task', 'task', 'bug', 'sub-bug', 'story', 'other'] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export const WORKER_KINDS = ['subagent', 'orca-worktree', 'git-worktree'] as const;
export type WorkerKind = (typeof WORKER_KINDS)[number];

export const ORDER_STATUSES = [
  'queued',
  'running',
  'waiting-gate',
  'merged',
  'done',
  'failed',
  'escalated',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * 끝난 주문. tick이 더 손대지 않는다.
 * escalated는 여기 없다. 사람 결정을 기다리며 슬롯만 비운 상태라 게이트 승인으로 다시 움직인다.
 * 그동안 PR 감시가 같은 PR에 주문을 또 만들면 안 된다
 */
export const TERMINAL_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set([
  'done',
  'failed',
  'cancelled',
]);

export const JIRA_STATUSES = ['TODO', 'In Progress', 'PR', 'Done', 'In-QA'] as const;
export type JiraStatus = (typeof JIRA_STATUSES)[number];

export interface Order {
  id: string;
  source: IntakeKind;
  /** 같은 주문이 두 번 들어오는지 가리는 키. 지라 키, 큐 메시지 id, PR 주소 같은 값이다 */
  sourceRef: string;
  /** `owner/name` 꼴 */
  repo: string;
  title: string;
  description?: string;
  scope: OrderScope;
  issueKey?: string;
  issueType?: IssueType;
  /** 워커가 차례로 돌릴 스킬 이름 */
  skillChain: string[];
  /** 사용자가 워커 종류를 직접 정했을 때. 비우면 런처가 handoff 표로 고른다 */
  workerKind?: WorkerKind;
  /**
   * 오르카 워커를 이 워크트리 아래 하위 워크트리로 띄운다. 접수 때 레포와 맞는지 확인하고 절대 경로로 풀어 둔다.
   * git 워크트리 워커는 이 값을 무시하고 경고만 남긴다
   */
  parentWorktree?: string;
  /** 워커 워크트리를 갈라낼 기준 브랜치나 ref. 비우면 런처 기본값을 따른다 */
  baseBranch?: string;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
  workerId?: string;
  prRef?: string;
  jiraStatus?: JiraStatus;
  /** 사용자가 컨덕터 세션에서 직접 정한 지라 상태. 기본 규칙보다 먼저 본다 */
  explicitJiraStatus?: JiraStatus;
  mergedAt?: string;
  deployedAt?: string;
  /** 워커의 spawnRequest로 생긴 주문이면 그 워커가 맡았던 주문. 이 주문의 워커는 더 못 늘린다 */
  parentOrderId?: string;
}

export const WORKER_STATUSES = [
  'starting',
  'running',
  'stopped',
  'finished',
  'failed',
  'released',
] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

/** 슬롯을 차지하는 워커 상태 */
export const ACTIVE_WORKER_STATUSES: ReadonlySet<WorkerStatus> = new Set(['starting', 'running']);

export const STOP_REASONS = [
  'rate-limit',
  'account-changed',
  'orca-issue',
  'disconnected',
  'error',
  'unknown',
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/** 워커 id는 inbox 파일 이름에 들어가므로 경로 문자가 없는 꼴만 받는다 */
export const WORKER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isWorkerId(v: string): boolean {
  return WORKER_ID_PATTERN.test(v);
}

export interface Worker {
  id: string;
  orderId: string;
  kind: WorkerKind;
  /** 워커는 하위 워커를 못 띄운다. 이 값이 conductor가 아니면 저장소가 거절한다 */
  spawnedBy: 'conductor';
  /** 같은 주문에서 몇 번째로 띄운 워커인지. 1부터 센다 */
  attempt: number;
  status: WorkerStatus;
  /** 런처가 워커를 다시 찾는 식별자. 오르카 dispatch id, 워크트리 경로, 서브에이전트 이름 중 하나다 */
  handle?: string;
  account?: string;
  startedAt: string;
  lastSeenAt: string;
  stopReason?: StopReason;
}

export interface Checkpoint {
  orderId: string;
  workerId: string;
  /** 지금 돌던 스킬 */
  skill: string;
  /** ship이면 SHIP_PHASES 중 하나, 다른 스킬은 스킬이 정한 단계 이름 */
  phase?: string;
  round?: number | null;
  /** 다음에 할 일 한 줄 */
  next: string;
  completedSkills: string[];
  /** ship 체크포인트 디렉토리. 있으면 재개 때 `checkCheckpoint`로 git, PR 상태와 맞춰 본다 */
  shipDir?: string;
  /** 워커가 남긴 파일 경로나 PR 주소. 재개 프롬프트에는 본문이 아니라 이 참조만 싣는다 */
  refs: string[];
  savedAt: string;
}

export const GATE_TYPES = [
  'merge',
  'slack-post',
  'interview',
  'review-manual-switch',
  'no-procedure',
] as const;
/** 사람 확인이 필요한 자리. no-procedure는 컨덕터가 처리 절차를 못 세운 경우다 */
export type GateType = (typeof GATE_TYPES)[number];

export interface Gate {
  id: string;
  orderId?: string;
  type: GateType;
  status: 'open' | 'resolved';
  reason: string;
  refs: string[];
  /** 슬랙 초안의 채널과 본문 경로처럼 승인 뒤 다시 쓸 값 */
  payload?: Record<string, string>;
  openedAt: string;
  resolvedAt?: string;
  decision?: 'approved' | 'rejected';
  /** interview 게이트에 사람이 적은 답 */
  answer?: string;
}

export const NEED_KINDS = [
  'merge-approval',
  'slack-post',
  'interview-answer',
  'review-manual-switch',
  'simple-approval',
  'manual-verification',
  'cleanup',
  'auth',
  'account-switch',
  'other',
] as const;
/** 워커가 혼자 못 넘는 자리. 컨덕터가 게이트로 올릴지 bypass로 처리할지 가른다 */
export type NeedKind = (typeof NEED_KINDS)[number];

export const REPORT_STATUSES = ['progress', 'done', 'failed', 'stopped', 'needs'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** 워커가 컨덕터에 돌려주는 결과. 원문 로그나 diff는 담지 않고 요약과 참조만 담는다 */
export interface WorkerReport {
  workerId: string;
  status: ReportStatus;
  summary: string;
  refs: string[];
  skill?: string;
  prRef?: string;
  merged?: boolean;
  stopReason?: StopReason;
  need?: { kind: NeedKind; detail: string };
  /** 워커가 하위 워커가 필요하다고 판단했을 때. 컨덕터가 새 주문으로 받는다 */
  spawnRequest?: { title: string; detail: string };
}

export interface BypassRecord {
  orderId?: string;
  need: NeedKind;
  action: string;
  at: string;
}

export interface JiraTransitionRecord {
  orderId: string;
  issueKey: string;
  from?: JiraStatus;
  to: JiraStatus;
  at: string;
}

/** 저장소에 한 줄씩 쌓는 이벤트. 스냅샷은 이걸 재생해서 만든다 */
export type ConductorEvent =
  | { type: 'order-added'; at: string; order: Order }
  | { type: 'order-updated'; at: string; orderId: string; patch: Partial<Omit<Order, 'id'>> }
  | { type: 'worker-started'; at: string; worker: Worker }
  | {
      type: 'worker-updated';
      at: string;
      workerId: string;
      patch: Partial<Omit<Worker, 'id' | 'spawnedBy'>>;
    }
  | { type: 'checkpoint-saved'; at: string; checkpoint: Checkpoint }
  | { type: 'gate-opened'; at: string; gate: Gate }
  | { type: 'gate-updated'; at: string; gateId: string; reason: string; refs: string[] }
  | {
      type: 'gate-resolved';
      at: string;
      gateId: string;
      decision: 'approved' | 'rejected';
      answer?: string;
    }
  | { type: 'bypass'; at: string; record: BypassRecord }
  | { type: 'jira-transition'; at: string; record: JiraTransitionRecord }
  | { type: 'slack-posted'; at: string; gateId: string; ref: string }
  /** clearedReports는 이번 tick이 inbox에서 지운 보고 파일이다. 적용 기록에서 뺀다 */
  | { type: 'tick'; at: string; clearedReports?: string[] }
  /** inbox의 보고 파일 하나를 적용했다. 지우기에 실패해 다음 tick에 다시 보여도 또 적용하지 않는다 */
  | { type: 'report-applied'; at: string; name: string }
  /** 앞 프로세스가 줄 중간에 죽은 꼬리를 개행으로 끊었다는 표시. replay가 바로 앞 깨진 줄을 건너뛴다 */
  | { type: 'tail-repaired'; at: string };

export interface ConductorSnapshot {
  orders: Record<string, Order>;
  workers: Record<string, Worker>;
  /** 주문마다 마지막 체크포인트 하나 */
  checkpoints: Record<string, Checkpoint>;
  gates: Record<string, Gate>;
  bypasses: BypassRecord[];
  jiraTransitions: JiraTransitionRecord[];
  slackPosted: Record<string, string>;
  /** 적용한 보고 파일 이름과 시각 */
  appliedReports: Record<string, string>;
  ticks: number;
  /** 마지막 tick 시각. 감시 주기보다 자주 돌지 않게 막는 데 쓴다 */
  lastTickAt?: string;
  /** 재생한 이벤트 수. 스냅샷 파일이 로그보다 뒤처졌는지 가린다 */
  eventCount: number;
}

export function isOrderScope(v: string): v is OrderScope {
  return (ORDER_SCOPES as readonly string[]).includes(v);
}

export function isWorkerKind(v: string): v is WorkerKind {
  return (WORKER_KINDS as readonly string[]).includes(v);
}

export function isNeedKind(v: string): v is NeedKind {
  return (NEED_KINDS as readonly string[]).includes(v);
}

export function isStopReason(v: string): v is StopReason {
  return (STOP_REASONS as readonly string[]).includes(v);
}

export function isJiraStatus(v: string): v is JiraStatus {
  return (JIRA_STATUSES as readonly string[]).includes(v);
}

export function isIssueType(v: string): v is IssueType {
  return (ISSUE_TYPES as readonly string[]).includes(v);
}
