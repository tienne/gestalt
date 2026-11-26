import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { log } from '../core/log.js';
import { isAccountName } from './account-name.js';
import {
  fileOverlaps,
  GATE_STALL_MESSAGE,
  gateStalled,
  refreshWorkerActivity,
  type WorkerActivitySnapshot,
} from './activity-tick.js';
import { updateWorkerInfo } from './activity.js';
import { changedApprovalOverlap, overlapScope } from './approval-overlap.js';
import { changedApprovalTarget, type ReadApprovalEvidence } from './bot-approval.js';
import { saveFinishedSummaries } from './work-log.js';
import { existingRepoContext } from './context.js';
import type { ReadDeploymentEvidence } from './deployment-evidence.js';
import { reconcileDeployments, reconcileWorker } from './gate-completion.js';
import { approvedFollowUpRef, handleNeed, openOrReuse, type BypassHandlers } from './gates.js';
import {
  intakeOrder,
  pollJira,
  pollQueue,
  type ExternalQueue,
  type JiraIntakeSource,
} from './intake.js';
import {
  syncJira,
  waitsForDeploy,
  type DeploySource,
  type JiraClient,
  type OrderStage,
} from './jira.js';
import {
  assertCanSpawn,
  buildWorkerPrompt,
  chooseWorkerKind,
  ensureAccount,
  execRunner,
  OrcaReleaseLiveError,
  type AccountSwitcher,
  type CommandRunner,
  type HostAction,
  type LauncherSet,
  type ReleaseOptions,
} from './launcher.js';
import { watchHumanOwned, type HumanOwnedChange, type PrStateSource } from './ownership.js';
import { repoOfPrRef } from './pr-ref.js';
import {
  openReviewReapproval,
  pollPrs,
  recordedReviewReapproval,
  type PrWatchSource,
} from './pr-watch.js';
import { copyReportRefs } from './ref-copy.js';
import { parseWorkerReport } from './result.js';
import {
  detectStale,
  escalateResume,
  prepareResumes,
  rateLimitedWorkers,
  resumeLaunchFor,
  wakeFromRateLimit,
  type ShipReader,
} from './resume.js';
import type { ConductorConfig } from './scheduler.js';
import { planSlots } from './scheduler.js';
import { orderWorkClass, WORK_CLASSES, type WorkClass } from './work-class.js';
import { publishApprovedSlack, type SlackClient } from './slack.js';
import { orderHasPendingSlack, orderSlackBlocker } from './slack-state.js';
import { newId, type ConductorStore } from './store.js';
import { recordSuccessfulTick } from './successful-tick.js';
import { CLEANUP_FAILED, CLEANUP_ORDER_STATUSES } from './worker-completion.js';
import type {
  Gate,
  GateDeliveryOutcome,
  JiraStatus,
  Order,
  OrderScope,
  RefCopy,
  StoredReport,
  Worker,
  WorkerKind,
  WorkerReport,
} from './types.js';

/**
 * 컨덕터 tick 한 번.
 *
 * 결과 수신, 접수, 끊김 감지와 재개, 배정과 띄우기, 머지 뒤 마무리, 슬랙 게시, 정리를
 * 차례로 돈다. 결과 수신이 접수보다 앞인 건 워커가 방금 보고한 PR 주소를 PR 감시가 먼저 알게
 * 하려는 것이다. 순서가 바뀌면 그 PR에 달린 코멘트를 남의 코멘트로 읽고 주문을 하나 더 만든다.
 * 상태는 전부 저장소에 남기고 컨덕터 세션에는 짧은 TickReport만 돌려준다.
 * 컨덕터 세션이 대신 해야 하는 일(서브에이전트 띄우기, git 워크트리 세션 열기, 메시지 전하기)은
 * hostActions로 돌려준다. Passthrough 설계라 여기서 LLM을 부르지 않는다.
 */

export interface EngineDeps {
  config: ConductorConfig;
  launchers: LauncherSet;
  orcaAvailable: boolean;
  /** 워커 결과 파일이 쌓이는 곳. 기본은 저장소 아래 inbox */
  inboxDir?: string;
  jiraSource?: JiraIntakeSource;
  queue?: ExternalQueue;
  prSource?: PrWatchSource;
  /** 사람이 넘겨받은 주문의 PR 머지를 확인한다. 없으면 머지 확인 없이 parked로 내리기만 한다 */
  prState?: PrStateSource;
  readApprovalEvidence?: ReadApprovalEvidence;
  jira?: JiraClient;
  deploy?: DeploySource;
  deploymentEvidence?: ReadDeploymentEvidence;
  slack?: SlackClient;
  accounts?: AccountSwitcher;
  bypass?: BypassHandlers;
  readShip?: ShipReader;
  env?: NodeJS.ProcessEnv;
  /** 워크트리에서 고친 파일을 구할 때 쓰는 git 실행기. 테스트가 바꿔 끼운다 */
  gitRunner?: CommandRunner;
  /** 워커 트랜스크립트를 찾을 projects 폴더. 테스트가 바꿔 끼운다 */
  transcriptRoots?: string[];
  /**
   * tick이 잠금을 놓은 뒤 부르는 보관. 하루에 한 번만 실제로 돌고 나머지는 undefined다.
   * 보관이 엔진을 가져다 쓰므로 CLI가 끼운다. 없으면 보관하지 않는다
   */
  archive?: (now: Date) => Promise<TickArchiveReport | undefined>;
}

/** tick 끝에 돈 보관 결과. 하루 한 번 돈 tick에만 붙는다 */
export interface TickArchiveReport {
  orders: string[];
  removed: string[];
  gates: number;
  blocked: { id: string; reason: string }[];
  compressed: string[];
  swept: { prompts: number; activity: number; handoffs: number };
  warnings: string[];
}

export interface TickReport {
  at: string;
  /** 감시 주기 안에 다시 불려 건너뛰었으면 true */
  skipped?: boolean;
  created: string[];
  launched: {
    orderId: string;
    workerId: string;
    kind: WorkerKind;
    workClass: WorkClass;
    resumed: boolean;
  }[];
  escalated: string[];
  hostActions: HostAction[];
  slackPosted: string[];
  jira: { orderId: string; to: JiraStatus }[];
  errors: string[];
  /** 멈출 일은 아니지만 사람이 알아야 할 자리. 런처가 주문 옵션을 다 못 따른 경우 같은 것 */
  warnings: string[];
  /** 세션 한도에 걸려 재개하지 않고 기다리는 오르카 워커. 풀리기 전까지 tick마다 싣는다 */
  rateLimited: RateLimitedEntry[];
  /** 사람이 넘겨받은 주문 중 이번 tick에 상태가 바뀐 것. 바뀐 게 없으면 비어 있다 */
  humanOwned: HumanOwnedChange[];
  /** 배포 주문이 끝나 대상 주문에 배포 성공을 남기거나 건너뛴 자리. 머지되지 않은 대상은 warnings에 간다 */
  deployTargets: DeployTargetOutcome[];
  archive?: TickArchiveReport;
  /**
   * 상태가 안 바뀐 tick이 이번까지 연달아 몇 번 왔는지. 새 주문, 띄운 워커, 올린 확인 자리, 호스트 할 일,
   * 오류가 없고 앞 tick 뒤로 저장소에 쌓인 이벤트도 없어야 센다. 하나라도 있으면 0이다
   */
  idleTicks: number;
  counts: {
    queued: number;
    running: number;
    waitingGate: number;
    activeWorkers: number;
    openGates: number;
    unansweredThreads: number;
  };
}

export interface DeployTargetOutcome {
  deployOrderId: string;
  orderId: string;
  outcome: 'recorded' | 'skipped';
  /** 건너뛴 이유 */
  reason?: string;
}

export interface RateLimitedEntry {
  orderId: string;
  workerId: string;
  /** 컨덕터가 한도 표시를 처음 본 시각 */
  since: string;
  resetsAt?: string;
  /** failure는 오르카 표식, text는 출력 문구로 알았다는 뜻이다. 문구로 알았으면 잘못 걸렸을 수 있다 */
  source?: 'failure' | 'text';
}

export function rateLimitEntries(store: ConductorStore): RateLimitedEntry[] {
  return rateLimitedWorkers(store).map((w) => ({
    orderId: w.orderId,
    workerId: w.id,
    since: w.rateLimitedAt ?? w.lastSeenAt,
    ...(w.rateLimitResetsAt ? { resetsAt: w.rateLimitResetsAt } : {}),
    ...(w.rateLimitSource ? { source: w.rateLimitSource } : {}),
  }));
}

export function inboxDirOf(store: ConductorStore, deps: Pick<EngineDeps, 'inboxDir'>): string {
  return deps.inboxDir ?? join(store.dir, 'inbox');
}

/** 이 스킬이 돌기 시작하면 지라를 PR로 옮긴다 */
const REVIEW_SKILLS = new Set(['ship', 'local-pr', 'review-reply', 'review-loop']);

const LOCK_FILE = 'tick.lock';
/** 내용을 못 읽는 잠금(옛 꼴이나 반쯤 쓴 파일)은 이 시간이 지나면 낡았다고 본다 */
const LOCK_STALE_MS = 10 * 60 * 1000;
/**
 * 적힌 프로세스가 살아 있어도 잡은 지 이 시간이 지나면 낡았다고 본다. 죽은 프로세스의 pid를
 * 다른 프로세스가 물려받았거나 tick이 멈춘 채 살아 있으면 잠금이 영영 안 풀리기 때문이다
 */
const LOCK_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** 낡은 잠금을 걷어내는 프로세스를 하나로 줄 세우는 파일. 걷어내다 죽었으면 이 시간 뒤 다시 걷는다 */
const STEAL_STALE_MS = 60 * 1000;
/** 잠금을 풀 때 steal 줄에 서려고 다시 해보는 횟수와 간격. 걷는 쪽은 읽기, 지우기, 만들기 한 번씩만 하고 놓는다 */
const RELEASE_RETRIES = 20;
const RELEASE_RETRY_MS = 50;
/** 정리에 실패한 워커의 게이트를 알아보는 표식 */
export { CLEANUP_FAILED };
/** 주문 하나의 워커들이 spawnRequest로 만들 수 있는 하위 주문 수. 넘는 요청은 거절해 워커에 알린다 */
export const MAX_SPAWN_PER_ORDER = 3;
/** 보고를 적용하다 실패한 원문을 남기는 자리. inbox 아래에 둔다 */
export const FAILED_REPORTS_DIR = 'failed';
/** 적용은 끝났는데 report-applied 기록만 실패한 원문. 다음 tick이 다시 적용하지 않고 기록만 남긴다 */
export const UNRECORDED_REPORTS_DIR = 'unrecorded';

/**
 * 사람 확인 자리가 아닌 요청을 컨덕터가 대신 넘기는 기본 절차. 호스트가 `deps.bypass`로 덮어쓸 수 있다.
 * 수동 검증과 정리는 워커가 자기 워크트리에서 직접 할 수 있어 진행하라고만 돌려준다.
 * 계정은 설정에 적힌 레포만 맞추고 그 밖은 절차가 없다고 던져 사람에게 올린다.
 */
function policyBypass(deps: EngineDeps): BypassHandlers {
  const switchAccount = async ({ order }: { order?: Order }): Promise<string> => {
    const wanted = order ? deps.config.accounts[order.repo] : undefined;
    if (!order || !wanted || !deps.accounts) throw new Error('맞출 계정이 설정에 없어요');
    if (!isAccountName(wanted))
      throw new Error(`${order.repo}에 적힌 계정이 계정 이름 꼴이 아니에요`);
    await deps.accounts.switchTo(order.repo, wanted);
    return `${order.repo} 계정을 ${wanted}로 맞췄어요`;
  };
  return {
    'merge-approval': async ({ order }) =>
      `${order?.scope ?? 'merge-through'} 주문이라 승인 없이 머지를 진행해요`,
    'interview-answer': async () => '인터뷰 답은 워커가 스펙과 레포를 보고 정해요',
    'simple-approval': async ({ detail, step }) =>
      `ship 단계(${step ?? '-'})의 단순 승인이라 컨덕터가 승인했어요: ${detail}`,
    'manual-verification': async () => '수동 검증은 워커가 직접 돌리고 결과를 다음 보고에 남겨요',
    cleanup: async () => '정리는 워커가 직접 하고 한 일을 다음 보고에 남겨요',
    'account-switch': switchAccount,
    auth: switchAccount,
  };
}

/**
 * 앞 tick과 이번 tick 사이가 끊긴 워커를 보는 기준(staleAfterSec)보다 길면 경고 문장을 돌려준다.
 * 반복은 세션 안의 크론이나 ScheduleWakeup이라 탭이 닫히면 같이 사라지고 아무도 알리지 않는다.
 * 다시 돈 첫 tick에서라도 공백을 드러내 사람이 언제부터 감시가 멈췄는지 알게 한다.
 */
export function tickGapWarning(
  lastTickAt: string | undefined,
  now: string,
  thresholdMs: number,
): string | undefined {
  const gap = gapOverThreshold(lastTickAt, now, thresholdMs);
  if (gap === undefined) return undefined;
  return `앞 tick(${lastTickAt}) 뒤로 ${formatGap(gap)} 동안 tick이 없었어요. 반복을 걸어 둔 컨덕터 세션이 닫혔거나 반복이 끊겼을 수 있어요`;
}

/**
 * status용. tick 사이 공백이 아니라 마지막 tick 뒤로 지금까지 지난 시간을 본다.
 * 아직 다음 tick이 안 돌았을 뿐일 수 있어 tickGapWarning과 문장을 나눈다.
 */
export function staleTickWarning(
  lastTickAt: string | undefined,
  now: string,
  thresholdMs: number,
): string | undefined {
  const gap = gapOverThreshold(lastTickAt, now, thresholdMs);
  if (gap === undefined) return undefined;
  return `마지막 tick(${lastTickAt}) 뒤로 ${formatGap(gap)} 지났어요. 반복을 걸어 둔 컨덕터 세션이 닫혔거나 반복이 끊겼을 수 있어요`;
}

function gapOverThreshold(
  lastTickAt: string | undefined,
  now: string,
  thresholdMs: number,
): number | undefined {
  if (!lastTickAt) return undefined;
  const gapMs = Date.parse(now) - Date.parse(lastTickAt);
  if (!Number.isFinite(gapMs) || gapMs <= thresholdMs) return undefined;
  return gapMs;
}

function formatGap(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}시간` : `${hours}시간 ${rest}분`;
}

export async function tick(
  store: ConductorStore,
  deps: EngineDeps,
  opts: { force?: boolean; admit?: () => void; inputErrors?: () => string[] } = {},
): Promise<TickReport> {
  assertCanSpawn(deps.env);
  const report = emptyReport(store.timestamp());

  const lock = acquireLock(store.dir);
  if (!lock.ok) {
    report.errors.push(
      `다른 tick이 돌고 있어 이번엔 건너뛰어요${lock.holder ? ` (pid ${lock.holder})` : ''}`,
    );
    return {
      ...report,
      skipped: true,
      idleTicks: store.snapshot.idleTicks ?? 0,
      counts: counts(store, 0),
    };
  }
  let result: TickReport;
  try {
    // 잠금을 잡은 뒤에 읽어야 앞 tick이 띄운 주문을 queued로 보고 또 띄우지 않는다
    opts.admit?.();
    store.reload();
    const last = store.snapshot.lastTickAt;
    const interval = deps.config.pollIntervalSec * 1000;
    if (!opts.force && last && Date.parse(report.at) - Date.parse(last) < interval) {
      return {
        ...report,
        skipped: true,
        idleTicks: store.snapshot.idleTicks ?? 0,
        counts: counts(store, 0),
      };
    }
    const gap = tickGapWarning(last, report.at, deps.config.staleAfterSec * 1000);
    if (gap) report.warnings.push(gap);
    result = await store.deferSnapshot(() => runTick(store, deps, report));
    result.errors.push(...(opts.inputErrors?.() ?? []));
  } finally {
    lock.release();
  }
  // 보관은 같은 잠금을 스스로 잡으므로 놓은 뒤에 부른다
  if (deps.archive) await archiveStep(store, deps.archive, result);
  if (result.errors.length === 0) {
    try {
      recordSuccessfulTick(store.dir, result.at);
    } catch (e) {
      result.errors.push(`tick 성공 시각을 기록하지 못했어요: ${(e as Error).message}`);
    }
  }
  return result;
}

async function archiveStep(
  store: ConductorStore,
  archive: NonNullable<EngineDeps['archive']>,
  report: TickReport,
): Promise<void> {
  try {
    const r = await archive(new Date(report.at));
    if (!r) return;
    report.archive = r;
    report.warnings.push(...r.warnings.map((w) => `보관: ${w}`));
    if (r.blocked.length > 0)
      report.warnings.push(
        `보관 기간이 지났지만 못 옮긴 주문 ${r.blocked.length}개: ${r.blocked
          .slice(0, 5)
          .map((b) => b.id)
          .join(
            ', ',
          )}${r.blocked.length > 5 ? ' 외' : ''}. 이유는 \`gestalt conductor archive --dry-run\`으로 확인해 주세요`,
      );
  } catch (e) {
    report.errors.push(`보관 실패: ${(e as Error).message}`);
  } finally {
    // 보관이 상태에서 주문을 뺐을 수 있다. 중간에 던졌어도 base.json은 이미 바뀌었을 수 있어 늘 다시 읽는다
    try {
      store.reload();
    } catch (e) {
      report.errors.push(`보관 뒤 상태 다시 읽기 실패: ${(e as Error).message}`);
    }
  }
}

async function runTick(
  store: ConductorStore,
  deps: EngineDeps,
  report: TickReport,
): Promise<TickReport> {
  let unanswered = 0;
  let cleared: string[] = [];
  const eventsBefore = store.snapshot.eventCount;
  const quietSinceLastTick = store.snapshot.lastTickEventCount === eventsBefore;
  await step(report, () => ingestReports(store, deps, report).then((c) => (cleared = c)));
  await step(report, () => deliverSignedDecisions(store, deps, report));
  await step(report, () => intake(store, deps, report).then((n) => (unanswered = n)));
  let activity = new Map<string, WorkerActivitySnapshot>();
  await step(report, async () => {
    activity = await refreshWorkerActivity(store.activeWorkers(), (w) => store.order(w.orderId), {
      stateDir: store.dir,
      runner: deps.gitRunner ?? execRunner,
      launchers: deps.launchers,
      now: new Date(report.at),
      ...(deps.transcriptRoots ? { transcriptRoots: deps.transcriptRoots } : {}),
    });
  });
  await step(report, () => nudgeStalledGates(store, deps, report, activity));
  await step(report, async () => checkFileOverlaps(store, deps, report, activity));
  await step(report, async () => {
    saveFinishedSummaries(store.dir, store.workers(), {
      now: report.at,
      ...(deps.transcriptRoots ? { roots: deps.transcriptRoots } : {}),
      nextStartOf: (w) =>
        store
          .workersOf(w.orderId)
          .filter((n) => n.attempt > w.attempt)
          .sort((a, b) => a.attempt - b.attempt)[0]?.startedAt,
    });
  });
  await step(report, async () => {
    const orca = deps.launchers['orca-worktree'];
    const stale = await detectStale(store, {
      now: new Date(report.at),
      staleAfterMs: deps.config.staleAfterSec * 1000,
      waitingEscalateAfterMs: deps.config.waitingEscalateAfterSec * 1000,
      rateLimitEscalateAfterMs: deps.config.rateLimitEscalateAfterSec * 1000,
      ...(orca?.probe ? { probe: (w: Worker) => orca.probe!(w) } : {}),
      ...(orca?.peek ? { peek: (w: Worker) => orca.peek!(w) } : {}),
      activityAt: (w: Worker) => activity.get(w.id)?.lastEventAt,
    });
    report.warnings.push(...stale.warnings);
    report.escalated.push(...stale.escalated.map((g) => g.id));
    for (const d of prepareResumes(store, {
      maxResumeAttempts: deps.config.maxResumeAttempts,
      ...(deps.readShip ? { readShip: deps.readShip } : {}),
    })) {
      if (d.kind === 'escalate') report.escalated.push(d.gate.id);
    }
  });
  await step(report, () => deliverPendingDecisions(store, deps, report));
  await step(report, () => launchQueued(store, deps, report));
  // 사람이 넘겨받은 주문의 PR을 확인만 하고 바뀐 게 없으면 prCheckedAt 기록만 남는다. 이건 idle 판정에서 뺀다
  let prCheckEvents = 0;
  await step(report, async () => {
    const before = store.snapshot.eventCount;
    const changesBefore = report.humanOwned.length;
    await watchHumanPrs(store, deps, report);
    if (report.humanOwned.length === changesBefore)
      prCheckEvents = store.snapshot.eventCount - before;
  });
  // 이번 tick에 남긴 배포 신호를 같은 tick의 정산이 바로 읽도록 정산 앞에 둔다
  await step(report, () => recordDeployTargets(store, deps, report));
  await step(report, () => settleMerged(store, deps, report));
  await step(report, () => reconcileDeployments(store, deps.deploymentEvidence, report));
  if (deps.slack) {
    const slack = deps.slack;
    await step(report, async () => {
      const r = await publishApprovedSlack(store, slack);
      report.slackPosted.push(...r.posted.map((p) => p.gateId));
      report.errors.push(...r.failed.map((f) => `슬랙 게시 실패 ${f.gateId}: ${f.error}`));
    });
  }
  await step(report, () => cleanupWorkers(store, deps, report));
  report.rateLimited = rateLimitEntries(store);
  const idle = isIdleTick(
    report,
    quietSinceLastTick && store.snapshot.eventCount - prCheckEvents === eventsBefore,
  );
  store.append({
    type: 'tick',
    at: report.at,
    ...(cleared.length > 0 ? { clearedReports: cleared } : {}),
    ...(idle ? { idle: true } : {}),
  });
  return {
    ...report,
    idleTicks: store.snapshot.idleTicks ?? 0,
    counts: counts(store, unanswered),
  };
}

/**
 * 같은 레포 워커끼리 고친 파일이 겹치면 경고를 남기고 워커 작업 내용에 겹친 파일을 적는다.
 * 겹친 파일이 overlapGateFiles를 넘으면 뒤에 뜬 주문에 게이트를 연다. 상대 주문마다 한 번만 열고
 * 열린 게이트가 있으면 답을 받은 뒤 다음 상대를 묻는다
 */
function checkFileOverlaps(
  store: ConductorStore,
  deps: EngineDeps,
  report: TickReport,
  activity: Map<string, WorkerActivitySnapshot>,
): void {
  const workers = store.activeWorkers().filter((w) => activity.has(w.id));
  const overlaps = fileOverlaps(
    workers,
    (w) => store.order(w.orderId)?.repo,
    (w) => activity.get(w.id)?.changedFiles,
  );
  const byWorker = new Map<string, { orderId: string; files: string[] }[]>();
  const note = (w: Worker, orderId: string, files: string[]) =>
    byWorker.set(w.id, [...(byWorker.get(w.id) ?? []), { orderId, files }]);
  const limit = deps.config.overlapGateFiles ?? 5;
  // 게이트 기록은 문턱을 넘는 겹침이 있을 때만 훑는다. 겹침이 없는 tick이 대부분이라서다
  let history: ReturnType<typeof overlapGateHistory> | undefined;
  for (const { first, later, files } of overlaps) {
    note(first, later.orderId, files);
    note(later, first.orderId, files);
    report.warnings.push(
      `${first.orderId}와 ${later.orderId}가 같은 파일 ${files.length}개를 고치고 있어요`,
    );
    if (files.length <= limit) continue;
    const key = `${later.orderId}\0${first.orderId}`;
    // openOrReuse는 같은 주문의 열린 게이트를 재사용하며 payload를 안 바꿔서 상대가 둘이면 이력이 한쪽만 남는다
    history ??= overlapGateHistory(store);
    const { asked, waiting } = history;
    if (asked.has(key) || waiting.has(later.orderId)) continue;
    openOrReuse(store, {
      orderId: later.orderId,
      type: 'file-overlap',
      reason: `${first.orderId}와 같은 파일 ${files.length}개를 고치고 있어요(기준 ${limit}개). 이어서 할지 정해 주세요`,
      ...overlapScope(first.orderId, files),
    });
    asked.add(key);
    waiting.add(later.orderId);
  }
  for (const w of workers) {
    const next = byWorker.get(w.id) ?? [];
    const prev = activity.get(w.id)!.info.overlaps ?? [];
    if (JSON.stringify(prev) !== JSON.stringify(next))
      updateWorkerInfo(store.dir, w.id, { overlaps: next });
  }
}

/** 재개로 워커 id가 바뀌어도 사람이 한 번 답한 상대로 다시 묻지 않게 주문의 게이트 이력으로 본다 */
function overlapGateHistory(store: ConductorStore): { asked: Set<string>; waiting: Set<string> } {
  const asked = new Set<string>();
  const waiting = new Set<string>();
  for (const g of Object.values(store.snapshot.gates)) {
    if (g.type !== 'file-overlap' || !g.orderId) continue;
    const other = g.payload?.['overlapWith'];
    if (other) asked.add(`${g.orderId}\0${other}`);
    if (g.status === 'open') waiting.add(g.orderId);
  }
  return { asked, waiting };
}

/** 백그라운드 gate 뒤 멈춘 워커에 포그라운드 재실행을 한 번 보낸다. 보낸 뒤엔 같은 워커에 다시 안 보낸다 */
async function nudgeStalledGates(
  store: ConductorStore,
  deps: EngineDeps,
  report: TickReport,
  activity: ReadonlyMap<string, WorkerActivitySnapshot>,
): Promise<void> {
  const now = new Date(report.at);
  for (const w of store.activeWorkers()) {
    if (!gateStalled(activity.get(w.id), now, (deps.config.gateStallAfterSec ?? 900) * 1000))
      continue;
    if ((await sendTo(deps, report, w, GATE_STALL_MESSAGE)) !== 'sent') continue;
    updateWorkerInfo(store.dir, w.id, { gateStallNotifiedAt: report.at });
    report.warnings.push(`${w.orderId}: 백그라운드 gate 뒤 멈춰 포그라운드 재실행을 보냈어요`);
  }
}

/**
 * 상태가 안 바뀐 tick인지. 오류가 난 tick은 장애가 간격 늘리기에 묻히지 않게 idle로 안 센다.
 * rateLimited와 warnings는 풀릴 때까지 tick마다 같은 값이 실리는 자리라 보지 않는다
 */
function isIdleTick(report: TickReport, storeQuiet: boolean): boolean {
  return (
    storeQuiet &&
    report.errors.length === 0 &&
    report.humanOwned.length === 0 &&
    report.created.length === 0 &&
    report.launched.length === 0 &&
    report.escalated.length === 0 &&
    report.hostActions.length === 0
  );
}

async function intake(
  store: ConductorStore,
  deps: EngineDeps,
  report: TickReport,
): Promise<number> {
  const cfg = { defaultScope: deps.config.defaultScope };
  if (deps.jiraSource) {
    const r = await pollJira(store, deps.jiraSource, cfg);
    report.created.push(...r.created.map((o) => o.id));
    if (r.truncated) report.errors.push('지라 담당 티켓이 페이지 상한에 닿아 뒤를 못 읽었어요');
  }
  if (deps.queue) {
    const r = await pollQueue(store, deps.queue, cfg);
    report.created.push(...r.created.map((o) => o.id));
  }
  let unanswered = 0;
  if (deps.prSource) {
    const r = await pollPrs(store, deps.prSource, cfg);
    report.created.push(...r.created.map((o) => o.id));
    unanswered = r.unansweredThreads;
  }
  // 사람이 답글만 온 PR을 보고 재리뷰를 승인했으면 review-loop 주문으로 잇는다
  // 보관은 후속 주문이 생긴 게이트만 색인으로 옮기므로(archive.ts keepsFollowUp) 상태에 남은 게이트만 보면 된다
  for (const g of Object.values(store.snapshot.gates)) {
    if (g.type !== 'review-manual-switch' || g.orderId || g.decision !== 'approved') continue;
    if (!g.receipt) createReviewFollowUp(store, deps, report, g);
  }
  for (const o of store.orders()) {
    if (o.status === 'queued' && o.issueKey && !o.jiraStatus)
      await moveJira(store, deps, report, o.id, 'identified');
  }
  return unanswered;
}

function createReviewFollowUp(
  store: ConductorStore,
  deps: EngineDeps,
  report: TickReport,
  gate: Gate,
): void {
  const sourceRef = approvedFollowUpRef(gate);
  if (store.hasSourceRef(sourceRef)) return;
  const prRef = gate.payload?.prRef;
  const repo = prRef ? repoOfPrRef(prRef) : null;
  if (!prRef || !repo) return;
  const out = intakeOrder(
    store,
    {
      source: 'pr-watch',
      sourceRef,
      repo,
      title: `재리뷰: ${prRef}`,
      prRef,
      skillChain: ['review-loop'],
    },
    { defaultScope: deps.config.defaultScope },
  );
  if (out.created) report.created.push(out.order.id);
}

/** 워커가 낸 결과를 inbox에 둔다. 검증은 여기서 하고 걸리면 던진다 */
export function writeReport(inboxDir: string, raw: unknown, maxChars: number): string {
  const report = parseWorkerReport(raw, maxChars);
  mkdirSync(inboxDir, { recursive: true });
  const name = `${Date.now()}-${report.workerId}-${randomUUID().slice(0, 8)}.json`;
  const tmp = join(inboxDir, `.${name}`);
  writeFileSync(tmp, JSON.stringify(report));
  // tick이 반쯤 쓴 파일을 읽지 않게 다 쓴 뒤 이름을 바꾼다
  renameSync(tmp, join(inboxDir, name));
  return name;
}

/** 지운 보고 파일 이름을 돌려준다. 이 이름은 다시 안 보이니 tick 이벤트가 적용 기록에서 뺀다 */
async function ingestReports(
  store: ConductorStore,
  deps: EngineDeps,
  report: TickReport,
): Promise<string[]> {
  const cleared: string[] = [];
  const dir = inboxDirOf(store, deps);
  if (!existsSync(dir)) return cleared;
  recordUnrecorded(store, deps, report, dir, cleared);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
    .sort();
  for (const f of files) {
    const path = join(dir, f);
    // 앞 tick이 적용만 하고 못 지운 파일이다. 다시 적용하면 needs의 bypass와 전하기가 한 번 더 돈다
    if (store.snapshot.appliedReports[f] === undefined) {
      let r: WorkerReport;
      try {
        r = parseWorkerReport(JSON.parse(readFileSync(path, 'utf-8')), deps.config.resultMaxChars);
        await applyReport(store, deps, report, r);
      } catch (err) {
        // 지우면 done merged나 needs 같은 보고를 되살릴 길이 없다. 원문을 옮겨 두고 사람이 본다
        report.errors.push(`결과 ${f}: ${message(err)} (${moveToFailed(dir, f)})`);
        continue;
      }
      try {
        store.append({
          type: 'report-applied',
          at: report.at,
          name: f,
          report: pickStoredReport(r, copyRefs(store, f, r)),
        });
      } catch (err) {
        // inbox에 두면 다음 tick이 다시 적용하고 failed로 보내면 사람이 다시 넣을 수 있다.
        // 둘 다 bypass와 전하기, 하위 주문을 한 번 더 돌리므로 기록만 다시 하는 자리로 옮긴다
        report.errors.push(
          `결과 ${f}: 적용은 됐고 이력 기록만 실패했어요: ${message(err)} (${moveAside(dir, f, UNRECORDED_REPORTS_DIR)})`,
        );
        continue;
      }
    }
    try {
      unlinkSync(path);
      cleared.push(f);
    } catch (err) {
      report.errors.push(`결과 ${f}를 못 지웠어요: ${message(err)}`);
    }
  }
  return cleared;
}

/** 적용은 끝난 보고의 기록만 다시 남긴다. applyReport를 다시 부르지 않는다 */
function recordUnrecorded(
  store: ConductorStore,
  deps: EngineDeps,
  report: TickReport,
  dir: string,
  cleared: string[],
): void {
  const sub = join(dir, UNRECORDED_REPORTS_DIR);
  if (!existsSync(sub)) return;
  const files = readdirSync(sub)
    .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
    .sort();
  for (const f of files) {
    const path = join(sub, f);
    try {
      if (store.snapshot.appliedReports[f] === undefined) {
        const r = parseWorkerReport(
          JSON.parse(readFileSync(path, 'utf-8')),
          deps.config.resultMaxChars,
        );
        store.append({
          type: 'report-applied',
          at: report.at,
          name: f,
          report: pickStoredReport(r, copyRefs(store, f, r)),
        });
      }
      unlinkSync(path);
      cleared.push(f);
    } catch (err) {
      report.errors.push(
        `결과 ${UNRECORDED_REPORTS_DIR}/${f}의 이력을 아직 못 남겼어요: ${message(err)}`,
      );
    }
  }
}

/**
 * 보고 refs 중 저장소 밖 텍스트 파일을 `refs/<주문 id>/`로 복사한다. 사본은 결과를 남기려는 것이라
 * 복사가 어떻게 실패해도 보고 적용과 기록은 그대로 간다.
 */
function copyRefs(store: ConductorStore, reportName: string, r: WorkerReport): RefCopy[] {
  const orderId = store.worker(r.workerId)?.orderId;
  if (!orderId || r.refs.length === 0) return [];
  try {
    return copyReportRefs({ stateDir: store.dir, orderId, reportName, refs: r.refs });
  } catch (err) {
    log(`결과 ${reportName}의 refs를 복사하지 못했어요: ${message(err)}`);
    return [];
  }
}

/** 이력에 남길 칸만 고른다. 하위 주문 요청은 적용할 때 주문으로 옮겨졌다 */
function pickStoredReport(r: WorkerReport, refCopies: RefCopy[] = []): StoredReport {
  return {
    workerId: r.workerId,
    status: r.status,
    summary: r.summary,
    refs: r.refs,
    ...(r.skill !== undefined ? { skill: r.skill } : {}),
    ...(r.prRef !== undefined ? { prRef: r.prRef } : {}),
    ...(r.merged !== undefined ? { merged: r.merged } : {}),
    ...(r.stopReason !== undefined ? { stopReason: r.stopReason } : {}),
    ...(r.need !== undefined ? { need: r.need } : {}),
    ...(r.deployRef !== undefined ? { deployRef: r.deployRef } : {}),
    ...(refCopies.length > 0 ? { refCopies } : {}),
  };
}

function moveToFailed(dir: string, f: string): string {
  return moveAside(dir, f, FAILED_REPORTS_DIR);
}

function moveAside(dir: string, f: string, subdir: string): string {
  try {
    mkdirSync(join(dir, subdir), { recursive: true });
    renameSync(join(dir, f), join(dir, subdir, f));
    return `${subdir}/${f}로 옮겼어요`;
  } catch (err) {
    return `${subdir}로 못 옮겼어요: ${message(err)}`;
  }
}

async function applyReport(
  store: ConductorStore,
  deps: EngineDeps,
  report: TickReport,
  r: WorkerReport,
): Promise<void> {
  const worker = store.worker(r.workerId);
  if (!worker) throw new Error(`모르는 워커예요: ${r.workerId}`);
  const order = store.order(worker.orderId);
  if (!order) throw new Error(`모르는 주문이에요: ${worker.orderId}`);
  if (order.workerId !== worker.id)
    throw new Error(`${worker.id}는 이미 다른 워커로 바뀐 주문의 앞 워커라 결과를 무시해요`);
  // 취소된 주문의 보고는 워커 종류와 상관없이 안 받는다. 한도 게이트를 거절한 오르카 워커는 터미널이 남아 한도가 풀리면 다시 보고한다
  if (order.status === 'cancelled')
    throw new Error(`${worker.id}는 취소된 주문의 워커라 결과를 무시해요`);
  // 넘겨받은 뒤 늦게 도착한 보고가 주문을 running이나 done으로 되돌리지 않게 막는다
  if (order.status === 'human-owned' || order.status === 'parked')
    throw new Error(`${worker.id}는 사람이 넘겨받은 주문의 워커라 결과를 무시해요`);
  // GitHub에서 직접 머지돼 거둔 워커의 늦은 보고가 mergedAt을 덮거나 지라를 한 번 더 옮기지 않게 막는다
  if (order.status === 'merged' || order.status === 'done')
    throw new Error(`${worker.id}는 이미 머지된 주문의 워커라 결과를 무시해요`);
  // 상태를 하나라도 바꾸기 전에 거른다. 반쯤 적용된 채 failed로 옮겨지면 되살릴 때 앞부분이 겹친다
  if (r.status === 'needs' && !r.need) throw new Error('status needs인데 need가 없어요');

  store.updateWorker(worker.id, {
    lastSeenAt: report.at,
    ...(worker.status === 'starting' ? { status: 'running' } : {}),
    ...wakeFromRateLimit(worker),
    // 대기는 waiting 보고 하나에만 걸린다. 다른 보고가 오면 대기가 끝난 것이다
    ...(r.status === 'waiting' && r.wait
      ? {
          waiting: {
            reason: r.wait.reason,
            since: report.at,
            ...(r.wait.until ? { until: r.wait.until } : {}),
          },
        }
      : worker.waiting
        ? { waiting: undefined }
        : {}),
  });
  if (r.prRef && order.prRef !== r.prRef) store.updateOrder(order.id, { prRef: r.prRef });

  if (r.spawnRequest) await spawnFromReport(store, deps, report, order, worker, r.spawnRequest);

  switch (r.status) {
    case 'waiting':
      return;
    case 'progress':
      if (r.prRef || (r.skill && REVIEW_SKILLS.has(r.skill)))
        await moveJira(store, deps, report, order.id, 'review');
      return;
    case 'done': {
      store.updateWorker(worker.id, { status: 'finished' });
      const deployResult = order.deploys?.length
        ? { deployResult: { at: report.at, ...(r.deployRef ? { ref: r.deployRef } : {}) } }
        : {};
      if (r.merged) {
        store.updateOrder(order.id, { status: 'merged', mergedAt: report.at, ...deployResult });
        await moveJira(store, deps, report, order.id, 'merged');
      } else {
        store.updateOrder(order.id, { status: 'done', ...deployResult });
      }
      return;
    }
    case 'failed':
      store.updateWorker(worker.id, { status: 'failed' });
      store.updateOrder(order.id, { status: 'failed' });
      return;
    case 'stopped':
      store.updateWorker(worker.id, { status: 'stopped', stopReason: r.stopReason ?? 'unknown' });
      return;
    case 'needs': {
      if (!r.need) throw new Error('status needs인데 need가 없어요');
      const outcome = await handleNeed(
        store,
        {
          orderId: order.id,
          need: r.need.kind,
          detail: r.need.detail,
          ...(r.need.step ? { step: r.need.step } : {}),
          refs: r.refs,
        },
        { ...policyBypass(deps), ...deps.bypass },
      );
      if (outcome.kind === 'bypass') {
        await sendTo(
          deps,
          report,
          store.worker(worker.id)!,
          `처리했어요: ${outcome.record.action}. 이어서 진행하세요`,
        );
      }
      return;
    }
  }
}

/**
 * 워커가 요청한 하위 작업을 새 주문으로 받는다.
 *
 * 워커는 하위 워커를 직접 못 띄우는데 이 길로 사람 확인 없이 주문을 늘릴 수 있다. 그래서
 * 자식 주문은 부모가 merge-through여도 approval로 낮춰 머지 전에 사람을 거치게 한다.
 * 한 단계만 받는다. 자식 주문의 워커가 또 요청하면 3, 9, 27개로 불어나므로 거절한다.
 * 수는 부모 주문 기준으로 센다. 워커 기준이면 재개로 새 워커가 뜰 때마다 몫이 다시 생긴다.
 * 거절은 게이트로 올리지 않고 워커에 알린다. 사람이 승인해도 상한이 그대로라 할 일이 없다.
 * 거절은 기록하지 않아서 같은 요청을 다시 내면 매번 같은 거절을 돌려준다. 재개로 새로 뜬 워커도
 * 거절 이유를 들어야 해서 워커 id 없이 요청만으로 막지 않는다.
 */
async function spawnFromReport(
  store: ConductorStore,
  deps: EngineDeps,
  report: TickReport,
  order: Order,
  worker: Worker,
  req: NonNullable<WorkerReport['spawnRequest']>,
): Promise<void> {
  const refuse = async (why: string): Promise<void> => {
    report.errors.push(`${worker.id}의 하위 주문 요청을 거절했어요(${why}): ${req.title}`);
    await sendTo(deps, report, worker, `하위 주문을 만들지 않았어요(${why}): ${req.title}`);
  };
  if (order.parentOrderId) return refuse('하위 주문의 하위 주문은 만들 수 없어요');
  const sourceRef = `spawn:${order.id}:${req.title}`;
  if (store.hasSourceRef(sourceRef)) return;
  const made = store.childOrderCount(order.id);
  if (made >= MAX_SPAWN_PER_ORDER)
    return refuse(`주문 하나에 ${MAX_SPAWN_PER_ORDER}개까지만 만들어요`);
  const scope: OrderScope = order.scope === 'merge-through' ? 'approval' : order.scope;
  const out = intakeOrder(
    store,
    {
      source: 'spoken',
      sourceRef,
      repo: order.repo,
      title: req.title,
      description: req.detail,
      scope,
      parentOrderId: order.id,
    },
    { defaultScope: deps.config.defaultScope },
  );
  if (out.created) report.created.push(out.order.id);
}

/**
 * 사람이 종료한 게이트의 결정을 살아 있는 워커에 전한다. `gestalt conductor gate resolve`가 부른다.
 * 워커가 없거나 끝났으면 전할 곳이 없으니 아무것도 안 한다. 주문은 resolveGate가 이미 옮겨 뒀다.
 *
 * `defer`는 hostActions를 실행할 수 없는 호출자(오르카 플러그인)가 켠다. 그때 런처가 직접 못 전하고
 * hostAction으로 돌려준 결정은 게이트에 전달 대기로 남기고 다음 tick이 컨덕터 세션의 hostActions로 내보낸다.
 * 호출자 쪽에 그 워커의 런처가 없거나 send가 던졌을 때도 대기로 남겨 다음 tick이 다시 전한다.
 */
export async function deliverGateDecision(
  store: ConductorStore,
  gate: Gate,
  deps: Pick<EngineDeps, 'launchers'>,
  opts: { defer?: boolean } = {},
): Promise<{
  hostActions: HostAction[];
  errors: string[];
  deferred: boolean;
  retry: boolean;
  outcome?: GateDeliveryOutcome;
}> {
  const out = {
    hostActions: [] as HostAction[],
    errors: [] as string[],
    deferred: false,
    retry: false,
  };
  const order = gate.orderId ? store.order(gate.orderId) : undefined;
  const worker = order?.workerId ? store.worker(order.workerId) : undefined;
  if (!worker || (worker.status !== 'running' && worker.status !== 'starting'))
    return { ...out, outcome: 'no-worker' };
  const text = decisionMessage(gate);
  const fake = emptyReport(store.timestamp());
  const result = await sendTo(deps, fake, worker, text);
  if (opts.defer && (fake.hostActions.length > 0 || result !== 'sent')) {
    // 플러그인 프로세스에 런처가 없는 건 컨덕터 세션에서는 다를 수 있어 오류로 안 돌려준다
    const errors = result === 'no-launcher' ? [] : fake.errors;
    store.append({
      type: 'gate-delivery',
      at: store.timestamp(),
      gateId: gate.id,
      pending: true,
      ...(result === 'failed' ? { attempts: 1 } : {}),
    });
    return { hostActions: [], errors, deferred: true, retry: false };
  }
  // 런처가 없으면 다시 해도 같으니 send가 던졌을 때만 다시 해 볼 만하다
  return {
    hostActions: fake.hostActions,
    errors: fake.errors,
    deferred: false,
    retry: result === 'failed',
    outcome: fake.hostActions.length ? 'host-action' : result === 'sent' ? 'delivered' : 'failed',
  };
}

/**
 * 시간 초과로 실패했어도 실제로는 닿았을 수 있다.
 * 계속 다시 보내면 같은 결정이 여러 번 갈 수 있으므로 재시도 횟수에 상한을 둔다
 */
const MAX_DELIVERY_ATTEMPTS = 3;

async function deliverSignedDecisions(
  store: ConductorStore,
  deps: EngineDeps,
  report: TickReport,
): Promise<void> {
  for (const id of Object.keys(store.snapshot.gates)) {
    const gate = store.snapshot.gates[id]!;
    if (!gate.receipt || !gate.deliveryPending) continue;
    try {
      await deliverSignedDecision(store, gate, deps, report);
    } catch (error) {
      const detail = message(error);
      report.errors.push(`${gate.id}: ${detail}`);
      if (!store.snapshot.gates[gate.id]?.deliveryPending) continue;
      store.append({
        type: 'gate-delivery',
        at: store.timestamp(),
        gateId: gate.id,
        pending: true,
        outcome:
          store.snapshot.gates[gate.id]?.deliveryOutcome === 'unknown' ? 'unknown' : 'failed',
        detail,
      });
    }
  }
}

async function deliverSignedDecision(
  store: ConductorStore,
  gate: Gate,
  deps: EngineDeps,
  report: TickReport,
): Promise<void> {
  const receipt = gate.receipt!;
  const followUp =
    gate.type === 'review-manual-switch' && !gate.orderId && gate.decision === 'approved';
  if (followUp && store.hasSourceRef(approvedFollowUpRef(gate))) {
    recordGateDelivery(store, gate.id, 'no-worker');
    return;
  }
  const changed = await recheckSignedDecision(store, gate, deps);
  const order = gate.orderId ? store.order(gate.orderId) : undefined;
  if (changed) {
    if (changed.replacement) report.escalated.push(changed.replacement);
    return;
  }
  if (followUp) createReviewFollowUp(store, deps, report, gate);
  const worker = order?.workerId ? store.worker(order.workerId) : undefined;
  if (
    !worker ||
    (worker.status !== 'running' && worker.status !== 'starting') ||
    (order?.status !== 'running' &&
      order?.status !== 'waiting-gate' &&
      order?.status !== 'escalated')
  ) {
    if (gate.deliveryOutcome === 'unknown' || gate.hostOfferedAt) {
      recordGateDelivery(
        store,
        gate.id,
        'unknown',
        '워커가 종료돼 마지막 전달 결과를 확인할 수 없어요',
      );
    } else {
      recordGateDelivery(store, gate.id, 'no-worker');
    }
    return;
  }
  const launcher = deps.launchers[worker.kind];
  if (!launcher) throw new Error(`${worker.kind} 런처가 없어 ${worker.id}에 못 전했어요`);

  if (worker.kind !== 'orca-worktree') {
    const command = [
      'gestalt conductor worker decision',
      `--state-dir '${store.dir.replaceAll("'", "'\\''")}'`,
      `--worker ${worker.id}`,
      `--delivery ${receipt.deliveryId}`,
    ].join(' ');
    store.append({
      type: 'gate-delivery',
      at: store.timestamp(),
      gateId: gate.id,
      pending: true,
      outcome: 'host-action',
    });
    report.hostActions.push({
      type: 'send',
      workerId: worker.id,
      message: `서명한 게이트 결정이 왔어요. \`${command}\`로 결정과 처리 기록을 확인하세요. 같은 전달 ID로 실행한 결과가 있으면 대조하고, 결과를 모르면 결정을 다시 실행하기 전에 컨덕터에 알려 주세요. 결과를 확인하면 같은 명령에 --report <결과-참조>를 붙여 기록하세요.`,
    });
    return;
  }

  // Orca가 받은 직후 응답을 잃어도 다음 tick은 같은 요청 ID로 이전 결과를 읽는다.
  store.append({
    type: 'gate-delivery',
    at: store.timestamp(),
    gateId: gate.id,
    pending: true,
    attempts: (gate.deliveryAttempts ?? 0) + 1,
    outcome: 'unknown',
  });
  try {
    await launcher.send(
      worker,
      `${decisionMessage(gate)}\n전달 ID: ${receipt.deliveryId}`,
      receipt.deliveryId,
    );
  } catch (error) {
    const detail = message(error);
    store.append({
      type: 'gate-delivery',
      at: store.timestamp(),
      gateId: gate.id,
      pending: true,
      outcome: 'unknown',
      detail,
    });
    report.errors.push(`${gate.id}: 결정 전달 결과를 확인하지 못했어요. ${detail}`);
    return;
  }
  recordGateDelivery(store, gate.id, 'delivered');
}

export async function recheckSignedDecision(
  store: ConductorStore,
  gate: Gate,
  deps: Pick<EngineDeps, 'gitRunner' | 'launchers' | 'readApprovalEvidence'>,
): Promise<{ detail: string; replacement?: string } | undefined> {
  const recorded = recordedReviewReapproval(store, gate);
  if (recorded) {
    recordGateDelivery(store, gate.id, 'superseded', recorded.detail);
    return recorded;
  }
  const overlap = await changedApprovalOverlap(
    store,
    gate,
    deps.gitRunner ?? execRunner,
    deps.launchers,
  );
  const change = overlap
    ? {
        reason: `${overlap.payload.overlapWith}와 겹치는 파일 범위가 달라졌어요(현재 ${overlap.count}개)`,
      }
    : await changedApprovalTarget(store, gate, deps.readApprovalEvidence);
  if (!change) return;

  const { reason } = change;
  let detail = reason;
  let replacement: string | undefined;
  const order = gate.orderId ? store.order(gate.orderId) : undefined;
  if (order && ['running', 'waiting-gate', 'escalated', 'queued'].includes(order.status)) {
    const existing =
      !overlap &&
      store
        .openGates(order.id)
        .find(
          (g) =>
            g.type === gate.type &&
            (gate.type !== 'file-overlap' || g.payload?.overlapWith === gate.payload?.overlapWith),
        );
    const payload = overlap?.payload ?? gate.payload;
    replacement = (
      existing ||
      openOrReuse(store, {
        orderId: order.id,
        type: gate.type,
        reason: overlap ? `${reason}. 이어서 할지 다시 정해 주세요` : `${reason}. ${gate.reason}`,
        refs: overlap?.refs ?? gate.refs,
        ...(payload ? { payload } : {}),
      }).gate
    ).id;
  } else if (!gate.orderId && change.reviewScope) {
    replacement = openReviewReapproval(store, gate, change.reviewScope, reason);
    const current = store.snapshot.gates[gate.id];
    if (replacement && current?.deliveryOutcome === 'superseded' && current.deliveryDetail)
      return { detail: current.deliveryDetail, replacement };
  }
  if (replacement) detail = `${reason}. 새 게이트 ${replacement}에서 다시 결정해 주세요`;
  recordGateDelivery(store, gate.id, 'superseded', detail);
  return { detail, ...(replacement ? { replacement } : {}) };
}

/**
 * 플러그인이 종료하고 못 전한 결정을 이번 tick의 hostActions로 내보낸다. 워커가 끝났으면 버린다.
 * send가 던지면 대기를 남겨 다음 tick에 다시 하고 MAX_DELIVERY_ATTEMPTS번 실패하면 그만둔다
 */
async function deliverPendingDecisions(
  store: ConductorStore,
  deps: EngineDeps,
  report: TickReport,
): Promise<void> {
  for (const gate of Object.values(store.snapshot.gates)) {
    if (!gate.deliveryPending || gate.receipt) continue;
    const r = await deliverGateDecision(store, gate, deps);
    report.hostActions.push(...r.hostActions);
    report.errors.push(...r.errors);
    if (r.retry) {
      const attempts = (gate.deliveryAttempts ?? 0) + 1;
      if (attempts < MAX_DELIVERY_ATTEMPTS) {
        store.append({
          type: 'gate-delivery',
          at: store.timestamp(),
          gateId: gate.id,
          pending: true,
          attempts,
        });
        continue;
      }
      report.errors.push(
        `${gate.id} 결정을 ${MAX_DELIVERY_ATTEMPTS}번 못 전해서 그만뒀어요. 워커에 직접 전해 주세요`,
      );
    }
    recordGateDelivery(store, gate.id, r.outcome ?? 'failed');
  }
}

export function recordGateDelivery(
  store: ConductorStore,
  gateId: string,
  outcome: GateDeliveryOutcome,
  detail?: string,
): void {
  store.append({
    type: 'gate-delivery',
    at: store.timestamp(),
    gateId,
    pending: false,
    outcome,
    ...(detail ? { detail } : {}),
  });
}

/**
 * 게이트 결정을 워커에 전할 문장. 사람이 적은 답은 승인이든 거절이든 싣고 고정 문구보다 먼저라고 밝힌다.
 * 머지 거절은 워커가 기다리지 않고 done으로 끝내게 한다. 기다리기만 하면 주문은 running이라
 * 끊긴 워커로 보여 새 워커가 같은 승인을 다시 묻는다.
 */
export function decisionMessage(gate: Gate): string {
  const ok = gate.decision === 'approved';
  const note = gate.answer ? `: ${gate.answer}` : '';
  const answer = gate.answer
    ? `사람의 답: "${gate.answer}". 아래 기본 지시와 다르면 답을 먼저 따르세요. `
    : '';
  switch (gate.type) {
    case 'merge':
      if (ok) return `머지 승인됐어요. ${answer}기본 지시: 머지하고 결과를 보고하세요`;
      return gate.answer
        ? `머지 거절됐어요. ${answer}머지하지 말고 답대로 처리한 뒤 --status done으로 보고하고 종료하세요`
        : '머지 거절됐어요. 머지하지 말고 PR은 그대로 둔 채 --status done으로 보고하고 종료하세요. 기다리지 마세요';
    case 'interview':
      return `인터뷰 답${note || ': (빈 답)'}`;
    case 'review-manual-switch':
      return ok ? `사람이 확인했어요${note}. 다음 라운드로 진행하세요` : `여기서 멈추세요${note}`;
    case 'file-overlap':
      return ok
        ? `다른 주문과 파일이 겹치는 걸 사람이 확인했어요${note}. 이어서 진행하세요`
        : `다른 주문과 같은 파일을 고치고 있어 여기서 멈추세요${note}. 고친 내용은 그대로 두고 --status done으로 보고하세요`;
    default:
      return ok ? `사람이 처리했어요${note}. 이어서 진행하세요` : `중단하세요${note}`;
  }
}

async function sendTo(
  deps: Pick<EngineDeps, 'launchers'>,
  report: Pick<TickReport, 'hostActions' | 'errors'>,
  worker: Worker,
  text: string,
): Promise<'sent' | 'no-launcher' | 'failed'> {
  const launcher = deps.launchers[worker.kind];
  if (!launcher) {
    report.errors.push(`${worker.kind} 런처가 없어 ${worker.id}에 못 전했어요`);
    return 'no-launcher';
  }
  try {
    const action = await launcher.send(worker, text);
    if (action) report.hostActions.push(action);
    return 'sent';
  } catch (err) {
    report.errors.push(`${worker.id}에 전하기 실패: ${message(err)}`);
    return 'failed';
  }
}

/**
 * 오르카 워커가 쓸 에이전트. 주문 > 앞 오르카 워커 > 레포 설정 > 기본 설정 순이다.
 * 앞 워커는 마지막 오르카 워커를 본다. 중간에 git-worktree로 돌았어도 설정 변경으로 에이전트가 바뀌지 않게 한다.
 * 에이전트 기록이 없는 옛 오르카 워커는 그때 기본값인 claude로 이어 간다
 */
export function resolveWorkerAgent(
  order: Pick<Order, 'agent' | 'repo'>,
  workers: readonly Pick<Worker, 'kind' | 'agent'>[],
  config: Pick<ConductorConfig, 'repoAgents' | 'defaultAgent'>,
): string {
  const lastOrca = workers.filter((w) => w.kind === 'orca-worktree').at(-1);
  return (
    order.agent ??
    (lastOrca ? (lastOrca.agent ?? 'claude') : undefined) ??
    config.repoAgents[order.repo] ??
    config.defaultAgent
  );
}

async function launchQueued(
  store: ConductorStore,
  deps: EngineDeps,
  report: TickReport,
): Promise<void> {
  // 이미 기다리기 시작한 release의 기한은 새 워커를 띄울 자리가 없어도 확인한다.
  const retried = new Map<string, Awaited<ReturnType<typeof retirePrevious>>>();
  for (const order of store.queuedOrders()) {
    const previous = order.workerId ? store.worker(order.workerId) : undefined;
    if (!previous?.releaseRefusedAt) continue;
    if (previous.status === 'running') {
      // release 대기 사이에 한도가 풀린 워커가 같은 주문을 계속 진행한다.
      store.updateWorker(previous.id, { releaseRefusedAt: undefined });
      store.updateOrder(order.id, { status: 'running' });
    } else if (previous.status === 'stopped') {
      retried.set(order.id, await retirePrevious(store, deps, report, order, previous));
    }
  }

  // 재시작과 재개도 이 자리를 지나므로 유형별 한도를 똑같이 검사한다.
  const plan = planSlots(store, deps.config.workerLimits);
  const remaining = Object.fromEntries(
    WORK_CLASSES.map((c) => [c, plan.byClass[c].free]),
  ) as Record<WorkClass, number>;
  for (const order of [...plan.toStart, ...plan.waiting]) {
    if (WORK_CLASSES.every((c) => remaining[c] === 0)) break;
    const workClass = orderWorkClass(order);
    if (remaining[workClass] === 0) continue;
    if (retried.get(order.id) === 'deferred') continue;
    remaining[workClass]--;
    const account = await ensureAccount(store, order, deps.config.accounts, deps.accounts);
    if (!account.ok) continue;

    const kind = chooseWorkerKind(order, { orcaAvailable: deps.orcaAvailable });
    const launcher = deps.launchers[kind];
    if (!launcher) {
      const { gate } = openOrReuse(store, {
        orderId: order.id,
        type: 'no-procedure',
        reason: `${kind} 워커를 띄울 런처가 없어요`,
      });
      report.escalated.push(gate.id);
      continue;
    }

    const resume = resumeLaunchFor(store, order, deps.readShip);
    if (resume && !retried.has(order.id)) {
      const retirement = await retirePrevious(store, deps, report, order, resume.previous);
      if (retirement === 'deferred') remaining[workClass]++;
      if (retirement !== 'released') continue;
    }
    const worker: Worker = {
      id: newId('wrk'),
      orderId: order.id,
      kind,
      ...(kind === 'orca-worktree'
        ? { agent: resolveWorkerAgent(order, store.workersOf(order.id), deps.config) }
        : {}),
      workClass,
      spawnedBy: 'conductor',
      attempt: store.workersOf(order.id).length + 1,
      status: 'starting',
      ...(account.account ? { account: account.account } : {}),
      startedAt: report.at,
      lastSeenAt: report.at,
    };
    try {
      const stateDir = resolve(store.dir);
      const repoContextFile = existingRepoContext(stateDir, order.repo);
      const prompt = buildWorkerPrompt(order, worker, resume?.context, {
        stateDir,
        ...(repoContextFile ? { repoContextFile } : {}),
      });
      const started = await launcher.start({
        order,
        worker,
        prompt,
        ...(resume?.previousHandle ? { previousHandle: resume.previousHandle } : {}),
        ...(resume?.previous.branch ? { previousBranch: resume.previous.branch } : {}),
        ...(resume
          ? {
              previousWorker: {
                orderId: resume.previous.orderId,
                attempt: resume.previous.attempt,
              },
            }
          : {}),
      });
      store.startWorker({
        ...worker,
        handle: started.handle,
        ...(started.branch ? { branch: started.branch } : {}),
        ...(started.sessionId ? { sessionId: started.sessionId } : {}),
        status: started.hostAction ? 'starting' : 'running',
      });
      store.updateOrder(order.id, { status: 'running', workerId: worker.id });
      if (started.hostAction) report.hostActions.push(started.hostAction);
      if (started.warnings) report.warnings.push(...started.warnings);
      report.launched.push({
        orderId: order.id,
        workerId: worker.id,
        kind,
        workClass,
        resumed: resume !== undefined,
      });
      await moveJira(store, deps, report, order.id, 'started');
    } catch (err) {
      const { gate } = openOrReuse(store, {
        orderId: order.id,
        type: 'no-procedure',
        reason: `워커를 못 띄웠어요: ${message(err)}`,
      });
      report.escalated.push(gate.id);
    }
  }
}

/**
 * 재개로 새 오르카 워커를 띄우기 전에 앞 워커 터미널을 거둔다. 워크트리는 지우지 않는다.
 *
 * 앞 터미널을 남긴 채 띄우면 한도가 풀리거나 계정이 바뀐 앞 워커가 다시 움직여 한 주문을 둘이
 * 진행한다. 앞 워커가 살아 있으면 다음 tick에 거두기를 다시 시도한다. 기한을 넘기면 사람에게 올린다.
 * git 워크트리와 서브에이전트 워커는 지금처럼 앞 워커를 건드리지 않는다.
 */
async function retirePrevious(
  store: ConductorStore,
  deps: EngineDeps,
  report: TickReport,
  order: Order,
  previous: Worker,
): Promise<'released' | 'deferred' | 'escalated'> {
  if (previous.kind !== 'orca-worktree') return 'released';
  if (orderHasPendingDecisionDelivery(store, order.id)) return 'deferred';
  const launcher = deps.launchers['orca-worktree'];
  try {
    if (!launcher) throw new Error('오르카 런처가 없어 앞 워커 터미널을 못 거둬요');
    await launcher.release(previous, { requireClosed: true });
    if (previous.releaseRefusedAt) store.updateWorker(previous.id, { releaseRefusedAt: undefined });
    return 'released';
  } catch (err) {
    if (shouldRetryRelease(store, deps, previous, err)) return 'deferred';
    const gate = escalateResume(
      store,
      order,
      previous,
      `앞 워커 터미널을 못 거뒀어요: ${message(err)}`,
    );
    report.escalated.push(gate.id);
    return 'escalated';
  }
}

/** 연속 거절의 첫 시각만 남겨야 재시도마다 이벤트가 쌓이지 않는다. */
function shouldRetryRelease(
  store: ConductorStore,
  deps: EngineDeps,
  worker: Worker,
  err: unknown,
): boolean {
  if (!(err instanceof OrcaReleaseLiveError)) {
    if (worker.releaseRefusedAt) store.updateWorker(worker.id, { releaseRefusedAt: undefined });
    return false;
  }
  const now = store.timestamp();
  if (!worker.releaseRefusedAt) {
    store.updateWorker(worker.id, { releaseRefusedAt: now });
    return true;
  }
  return (
    Date.parse(now) - Date.parse(worker.releaseRefusedAt) <
    deps.config.orcaReleaseRetryMaxSec * 1000
  );
}

/**
 * 사람이 넘겨받은 주문과 컨덕터가 쥔 주문의 PR을 본다. 머지됐으면 지라를 옮겨 이어지는 정산이
 * 마무리하게 한다
 */
async function watchHumanPrs(
  store: ConductorStore,
  deps: EngineDeps,
  report: TickReport,
): Promise<void> {
  const r = await watchHumanOwned(store, {
    now: new Date(report.at),
    pollMs: deps.config.humanOwnedPollSec * 1000,
    parkAfterMs: deps.config.humanOwnedParkAfterSec * 1000,
    ...(deps.prState ? { source: deps.prState } : {}),
    launchers: deps.launchers,
  });
  report.humanOwned.push(...r.changes);
  report.hostActions.push(...r.hostActions);
  report.errors.push(...r.errors);
  for (const c of r.changes)
    if (c.to === 'merged') await moveJira(store, deps, report, c.orderId, 'merged');
}

/**
 * 사람이 머지했다고 알린 주문의 머지 뒤 처리를 시작한다. 지라는 여기서 옮기고 배포 대기와 정리는
 * 다음 tick의 정산이 이어 받는다. `gestalt conductor order mark-merged`가 부른다
 */
export async function afterHumanMerge(
  store: ConductorStore,
  orderId: string,
  deps: Pick<EngineDeps, 'jira'>,
): Promise<Pick<TickReport, 'jira' | 'errors'>> {
  const out = emptyReport(store.timestamp());
  await moveJira(store, deps, out, orderId, 'merged');
  return { jira: out.jira, errors: out.errors };
}

/**
 * 워커가 done으로 끝낸 배포 주문의 대상 주문마다 `deploy report`와 같은 성공 신호를 남긴다. 지라 이동과
 * done 전환은 뒤이은 정산(settleOne)이 맡는다. 대상마다 한 번만 보고 배포 주문에 남긴 시각으로 다시 안 돈다.
 * 머지되지 않은 대상은 이 배포에 안 들어갔으니 기록하지 않고 경고만 남긴다. 신호를 남길 자리가 없거나 쓰다 실패하면
 * 다음 tick에 다시 시도하게 시각을 안 남긴다
 */
async function recordDeployTargets(
  store: ConductorStore,
  deps: EngineDeps,
  report: TickReport,
): Promise<void> {
  const pending = store
    .orders()
    .filter((o) => o.deploys?.length && o.deployResult && !o.deploysRecordedAt);
  for (const d of pending) {
    const deploy = deps.deploy;
    if (!deploy?.record) {
      report.errors.push(
        `${d.id}: 배포 신호를 남길 자리가 없어 대상 주문에 배포 성공을 못 남겼어요`,
      );
      continue;
    }
    const ref = d.deployResult!.ref ?? d.id;
    let failed = false;
    for (const id of d.deploys!) {
      const target = store.order(id);
      const skip = (reason: string) =>
        report.deployTargets.push({ deployOrderId: d.id, orderId: id, outcome: 'skipped', reason });
      if (!target) {
        report.warnings.push(`${d.id}: 배포 대상 ${id}가 저장소에 없어 배포 성공을 안 남겼어요`);
        continue;
      }
      if (target.status === 'done') {
        skip('이미 끝난 주문이에요');
        continue;
      }
      if (!waitsForDeploy(target)) {
        skip('배포를 기다리지 않는 유형이에요');
        continue;
      }
      if (target.status !== 'merged') {
        report.warnings.push(
          `${d.id}: 배포 대상 ${id}가 머지된 상태가 아니라(${target.status}) 배포 성공을 안 남겼어요. ` +
            '이 배포 주문으로는 다시 안 봐요. 머지된 뒤 배포됐으면 다음 배포 주문의 --deploys에 넣거나 deploy report로 남겨 주세요',
        );
        continue;
      }
      try {
        // 호스트가 남긴 실패를 덮으면 실패한 배포의 지라가 In-QA로 옮겨진다
        if ((await deploy.status(target)).status === 'failed') {
          skip('이미 배포 실패 신호가 있어요');
          continue;
        }
      } catch (err) {
        failed = true;
        report.errors.push(`${d.id}: 배포 대상 ${id}의 배포 신호를 못 읽었어요: ${message(err)}`);
        continue;
      }
      try {
        await deploy.record(id, { status: 'success', ref });
        report.deployTargets.push({ deployOrderId: d.id, orderId: id, outcome: 'recorded' });
      } catch (err) {
        failed = true;
        report.errors.push(`${d.id}: 배포 대상 ${id}에 배포 성공을 못 남겼어요: ${message(err)}`);
      }
    }
    // 못 남긴 대상이 있으면 다음 tick에 다시 돈다. 이미 남긴 대상은 정산으로 done이 돼 그때 건너뛴다
    if (!failed) store.updateOrder(d.id, { deploysRecordedAt: report.at });
  }
}

/**
 * 머지된 주문을 끝낸다. bug, task, sub-bug는 배포 파이프라인이 성공해야 In-QA로 옮기고 끝낸다.
 * 배포가 실패하면 그 주문만 사람에게 올린다.
 */
async function settleMerged(
  store: ConductorStore,
  deps: EngineDeps,
  report: TickReport,
): Promise<void> {
  for (const order of store.orders().filter((o) => o.status === 'merged')) {
    try {
      await settleOne(store, deps, report, order);
    } catch (err) {
      report.errors.push(`${order.id} 정산 실패: ${message(err)}`);
    }
  }
}

async function settleOne(
  store: ConductorStore,
  deps: EngineDeps,
  report: TickReport,
  order: Order,
): Promise<void> {
  if (!waitsForDeploy(order)) {
    store.updateOrder(order.id, { status: 'done' });
    return;
  }
  if (!deps.deploy) {
    report.errors.push(`${order.id}: 배포 감지 어댑터가 없어 In-QA로 못 옮기고 끝냈어요`);
    store.updateOrder(order.id, { status: 'done' });
    return;
  }
  const signal = await deps.deploy.status(order);
  if (signal.status === 'success') {
    await moveJira(store, deps, report, order.id, 'deployed', signal);
    store.updateOrder(order.id, { status: 'done', deployedAt: report.at });
  } else if (signal.status === 'failed') {
    const { gate } = openOrReuse(store, {
      orderId: order.id,
      type: 'no-procedure',
      reason: '머지 뒤 배포 파이프라인이 실패했어요',
      refs: signal.ref ? [signal.ref] : [],
    });
    store.updateOrder(order.id, { status: 'escalated' });
    report.escalated.push(gate.id);
  } else if (
    signal.status === 'pending' &&
    Date.parse(report.at) - Date.parse(order.mergedAt ?? order.updatedAt) >=
      deps.config.deployWaitMaxSec * 1000
  ) {
    store.updateOrder(order.id, { status: 'done' });
    report.warnings.push(
      `${order.id}: 배포 신호를 ${deps.config.deployWaitMaxSec}초 기다려 지라 이동 없이 끝냈어요`,
    );
  }
}

/**
 * 이번 tick에 거둘 워커인지. 멈춘 워커는 주문이 done, failed, cancelled이거나 머지돼 워크트리까지
 * 지울 때만 거둔다. 워크트리까지 지울 때는 주문 상태를 안 본다
 */
function isCleanupTarget(w: Worker, order: Order | undefined, removeWorktree: boolean): boolean {
  if (w.status === 'finished' || w.status === 'failed') return true;
  if (w.status !== 'stopped') return false;
  if (removeWorktree) return true;
  return order !== undefined && CLEANUP_ORDER_STATUSES.has(order.status);
}

/**
 * 오르카 워커의 워크트리까지 지울지와 브랜치를 남길지. 머지된 주문은 removeMergedOrcaWorktrees로,
 * 머지 없이 done으로 끝난 주문은 removeDoneOrcaWorktrees로 켠다. 뒤쪽은 머지를 확인 못 해 브랜치를 남긴다.
 * failed, cancelled, parked 주문은 확인할 거리가 남았을 수 있어 어느 쪽도 지우지 않는다
 */
function worktreeRemoval(
  w: Worker,
  order: Order | undefined,
  config: EngineDeps['config'],
): 'delete-branch' | 'keep-branch' | undefined {
  if (w.kind !== 'orca-worktree' || !order) return undefined;
  if (order.mergedAt !== undefined)
    return config.removeMergedOrcaWorktrees === true ? 'delete-branch' : undefined;
  if (order.status === 'done' && config.removeDoneOrcaWorktrees === true) return 'keep-branch';
  return undefined;
}

/**
 * 끝난 워커의 자원을 정리한다. 멈춘 워커는 재개가 그 dispatch id나 워크트리를 다시 쓸 수 있어 남긴다.
 * 다만 주문이 done, failed, cancelled면 재개될 일이 없어 finished 워커와 같은 방식으로 거둔다. 안 거두면
 * order remove가 멈춘 워커 때문에 계속 거절한다.
 *
 * removeMergedOrcaWorktrees를 켜면 머지된 주문의 오르카 워커는 워크트리까지 지운다. 재개로 갈린
 * 앞 회차는 stopped로 남는데 주문이 머지되면 다시 쓸 일이 없어 같이 거둔다. removeDoneOrcaWorktrees를
 * 켜면 머지 없이 done으로 끝난 주문도 브랜치는 남기고 워크트리만 지운다. 그 밖의 주문은 그대로 둔다.
 *
 * 정리가 실패하면 주문 없는 게이트로 올린다. 주문에 붙이면 주문이 waiting-gate로 바뀌어 머지 뒤
 * 정산까지 멈추는데 정리는 주문 진행과 무관하다. 그 게이트가 열린 동안은 다시 시도하지 않는다.
 * 사람이 승인한 Orca 워커는 종료와 정리 증빙까지 맞으면 released로 둔다.
 * 거절한 게이트는 기존 자동 정리 경로에서 다시 시도한다.
 */
function orderHasPendingDecisionDelivery(store: ConductorStore, orderId: string): boolean {
  return Object.values(store.snapshot.gates).some(
    (g) => g.orderId === orderId && g.deliveryPending,
  );
}

async function cleanupWorkers(
  store: ConductorStore,
  deps: EngineDeps,
  report: TickReport,
): Promise<void> {
  const cleanupGates = Object.values(store.snapshot.gates).filter(
    (g) => g.payload?.kind === CLEANUP_FAILED,
  );
  const targets: { worker: Worker; opts: ReleaseOptions }[] = [];
  for (const w of store.workers()) {
    const order = store.order(w.orderId);
    const mode = worktreeRemoval(w, order, deps.config);
    const removeWorktree = mode !== undefined;
    if (!isCleanupTarget(w, order, removeWorktree)) continue;
    if (orderHasPendingDecisionDelivery(store, w.orderId)) {
      report.warnings.push(`${w.id} 워커 정리 보류: 승인 결정 전달 결과를 확인 중이에요`);
      continue;
    }
    const mine = cleanupGates.filter((g) => g.payload?.workerId === w.id);
    const open = mine.find((g) => g.status === 'open');
    if (open) {
      if (w.kind === 'orca-worktree')
        report.warnings.push(`${open.id} 워커 정리 보류: 승인 결정이 없어요`);
      continue;
    }
    const latest = mine.at(-1);
    const slackBlocker = orderSlackBlocker(store.snapshot, w.orderId);
    if (slackBlocker) {
      report.warnings.push(`${w.id} 워커 정리 보류: Slack 게시가 남아 있어요. ${slackBlocker}`);
      continue;
    }
    if (latest?.decision === 'approved') {
      if (w.kind === 'orca-worktree') {
        if (!latest.completion)
          await reconcileWorker(
            store,
            deps.launchers['orca-worktree'],
            report,
            w,
            latest,
            removeWorktree,
          );
      } else {
        store.updateWorker(w.id, {
          status: 'released',
          ...(w.releaseRefusedAt ? { releaseRefusedAt: undefined } : {}),
        });
      }
      continue;
    }
    targets.push({
      worker: w,
      opts: removeWorktree
        ? {
            removeWorktree,
            ...(mode === 'keep-branch' ? { keepBranch: true } : {}),
            ...(order?.parentWorktree ? { parentWorktree: order.parentWorktree } : {}),
          }
        : {},
    });
  }
  // release마다 외부 명령 타임아웃이 걸려 있어 차례로 기다리면 tick이 워커 수만큼 길어진다.
  // 워크트리 삭제만은 같은 레포의 git 락이 겹치지 않게 레포마다 차례로 돌린다. git 워커는 늘 워크트리를 지운다
  const repoChains = new Map<string, Promise<boolean>>();
  const results = await Promise.allSettled(
    targets.map(({ worker, opts }) => {
      const run = async (): Promise<boolean> => {
        store.reload();
        if (
          !isDeepStrictEqual(store.worker(worker.id), worker) ||
          orderHasPendingSlack(store.snapshot, worker.orderId) ||
          orderHasPendingDecisionDelivery(store, worker.orderId)
        ) {
          report.warnings.push(
            `${worker.id} 워커 정리 보류: 정리 대상, 승인 결정 전달 또는 Slack 게시 상태가 바뀌었어요`,
          );
          return false;
        }
        await deps.launchers[worker.kind]?.release(worker, opts);
        return true;
      };
      if (!opts.removeWorktree && worker.kind !== 'git-worktree') return run();
      const repo = store.order(worker.orderId)?.repo ?? '';
      const next = (repoChains.get(repo) ?? Promise.resolve()).then(run, run);
      repoChains.set(repo, next);
      return next;
    }),
  );
  results.forEach((r, i) => {
    const { worker: w, opts } = targets[i]!;
    if (r.status === 'fulfilled') {
      if (!r.value) return;
      const at = store.timestamp();
      const saved = store.appendIfCurrent(
        {
          type: 'worker-updated',
          at,
          workerId: w.id,
          patch: { status: 'released' },
          ...(w.releaseRefusedAt ? { unset: ['releaseRefusedAt'] } : {}),
        },
        () =>
          isDeepStrictEqual(store.worker(w.id), w) &&
          !orderHasPendingSlack(store.snapshot, w.orderId) &&
          !orderHasPendingDecisionDelivery(store, w.orderId),
      );
      if (!saved) {
        report.warnings.push(
          `${w.id} 워커 정리 보류: 정리 중 워커, 승인 결정 전달 또는 Slack 게시 상태가 바뀌었어요`,
        );
        return;
      }
      store.append({
        type: 'bypass',
        at,
        record: {
          orderId: w.orderId,
          need: 'cleanup',
          action: opts.removeWorktree
            ? `${w.kind} 워커 ${w.id}를 워크트리까지 정리했어요`
            : `${w.kind} 워커 ${w.id}를 정리했어요`,
          at,
        },
      });
      return;
    }
    if (shouldRetryRelease(store, deps, w, r.reason)) return;
    const { gate } = openOrReuse(store, {
      type: 'no-procedure',
      reason: `${w.id} 정리에 실패했어요: ${message(r.reason)}`,
      payload: {
        kind: CLEANUP_FAILED,
        workerId: w.id,
        orderId: w.orderId,
        ...(w.handle ? { dispatchId: w.handle } : {}),
        ...(opts.removeWorktree ? { removeWorktree: 'true' } : {}),
      },
    });
    report.escalated.push(gate.id);
  });
}

async function moveJira(
  store: ConductorStore,
  deps: Pick<EngineDeps, 'jira'>,
  report: Pick<TickReport, 'jira' | 'errors'>,
  orderId: string,
  stage: OrderStage,
  signal?: Parameters<typeof syncJira>[4],
): Promise<void> {
  if (!deps.jira) return;
  try {
    const to = await syncJira(store, orderId, stage, deps.jira, signal);
    if (to) report.jira.push({ orderId, to });
  } catch (err) {
    report.errors.push(`지라 전환 실패 ${orderId}: ${message(err)}`);
  }
}

function emptyReport(at: string): TickReport {
  return {
    at,
    created: [],
    launched: [],
    escalated: [],
    hostActions: [],
    slackPosted: [],
    jira: [],
    errors: [],
    warnings: [],
    rateLimited: [],
    humanOwned: [],
    deployTargets: [],
    idleTicks: 0,
    counts: {
      queued: 0,
      running: 0,
      waitingGate: 0,
      activeWorkers: 0,
      openGates: 0,
      unansweredThreads: 0,
    },
  };
}

function counts(store: ConductorStore, unansweredThreads: number): TickReport['counts'] {
  const by = (s: Order['status']) => store.orders().filter((o) => o.status === s).length;
  return {
    queued: by('queued'),
    running: by('running'),
    waitingGate: by('waiting-gate'),
    activeWorkers: store.activeWorkers().length,
    openGates: store.openGates().length,
    unansweredThreads,
  };
}

/** 한 단계가 실패해도 다음 단계와 다른 주문은 계속 돈다 */
async function step(report: TickReport, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    report.errors.push(message(err));
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type LockResult = { ok: true; release: () => void } | { ok: false; holder?: number };

interface LockInfo {
  pid: number;
  startedAt: number;
  host: string;
}

/**
 * 컨덕터 세션이 둘 떠도 같은 주문을 두 번 띄우지 않게 tick을 하나만 돌린다.
 *
 * 잠금 파일에 pid와 잡은 시각, 호스트, 토큰을 적는다. 같은 호스트에서 적힌 프로세스가 살아 있으면
 * 잡은 지 LOCK_MAX_AGE_MS가 지나기 전에는 걷어내지 않는다. 다른 호스트의 pid는 살아 있는지 볼 수
 * 없어 시간 상한만 본다. 걷어내는 쪽은 steal 파일로 한 프로세스씩 줄 세운다. 줄을 선 프로세스는
 * 잠금을 다시 읽어 낡았다고 본 그 내용일 때만 지우고 새로 잡는다.
 * 풀 때도 같은 steal 줄에 서서 자기 토큰일 때만 지운다(releaseLock).
 */
export function acquireLock(dir: string): LockResult {
  const path = join(dir, LOCK_FILE);
  const token = `${process.pid}:${Date.now()}:${hostname()}:${randomUUID()}`;
  const release = () => releaseLock(path, token);
  if (tryCreateLock(path, token)) return { ok: true, release };

  let seen: string;
  try {
    seen = readFileSync(path, 'utf-8');
  } catch {
    return { ok: false };
  }
  const info = parseLock(seen);
  const holder = info ? { holder: info.pid } : {};
  if (!isStaleLock(path, info)) return { ok: false, ...holder };

  const stealPath = `${path}.steal`;
  if (!tryCreateLock(stealPath, token)) {
    clearStaleSteal(stealPath);
    return { ok: false, ...holder };
  }
  try {
    let now: string | undefined;
    try {
      now = readFileSync(path, 'utf-8');
    } catch {
      now = undefined;
    }
    // 줄을 서는 사이 주인이 풀고 다른 프로세스가 새로 잡았다
    if (now !== undefined && now !== seen) return { ok: false };
    if (now !== undefined) unlinkSync(path);
    return tryCreateLock(path, token) ? { ok: true, release } : { ok: false };
  } catch {
    return { ok: false, ...holder };
  } finally {
    removeIfOwned(stealPath, token);
  }
}

/**
 * 잠금을 푼다. 걷는 쪽은 잠금을 다시 읽어 비교한 뒤 지운다. 그 사이에 주인이 풀고 제3자가 새로
 * 잡으면 걷는 쪽이 제3자의 잠금을 지운다. 주인이 읽고 지우는 사이에 걷는 쪽이 끼어들면 주인이
 * 걷는 쪽이 새로 잡은 잠금을 지운다. 그래서 푸는 쪽도 steal 줄에 선다.
 */
function releaseLock(path: string, token: string): void {
  const stealPath = `${path}.steal`;
  for (let i = 0; i < RELEASE_RETRIES; i++) {
    if (tryCreateLock(stealPath, token)) {
      try {
        removeIfOwned(path, token);
      } finally {
        removeIfOwned(stealPath, token);
      }
      return;
    }
    clearStaleSteal(stealPath);
    sleepSync(RELEASE_RETRY_MS);
  }
  // 끝내 줄을 못 서도 잠금은 지운다. 남기면 다른 호스트에서는 상한까지 tick이 멈춘다
  removeIfOwned(path, token);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isStaleLock(path: string, info: LockInfo | undefined): boolean {
  if (!info) {
    try {
      return Date.now() - statSync(path).mtimeMs >= LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
  if (Date.now() - info.startedAt >= LOCK_MAX_AGE_MS) return true;
  return info.host === hostname() && !isAlive(info.pid);
}

/** 걷어내다 죽은 프로세스의 steal 파일만 지운다. 지운 다음 tick이 다시 줄을 선다 */
function clearStaleSteal(stealPath: string): void {
  try {
    const content = readFileSync(stealPath, 'utf-8');
    const info = parseLock(content);
    const dead = info !== undefined && info.host === hostname() && !isAlive(info.pid);
    if (dead || Date.now() - statSync(stealPath).mtimeMs >= STEAL_STALE_MS) {
      removeIfOwned(stealPath, content);
    }
  } catch {
    // 그 사이 주인이 지웠으면 할 일이 없다
  }
}

function removeIfOwned(path: string, token: string): void {
  try {
    if (readFileSync(path, 'utf-8') === token) unlinkSync(path);
  } catch {
    // 이미 지워졌으면 할 일이 없다
  }
}

function tryCreateLock(path: string, token: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx');
  } catch {
    return false;
  }
  try {
    writeSync(fd, token);
  } finally {
    closeSync(fd);
  }
  return true;
}

function parseLock(content: string): LockInfo | undefined {
  // 끝 칸은 randomUUID라 ':'가 없다. 가운데를 넓게 잡아 ':'가 든 호스트 이름도 읽는다
  const m = /^(\d+):(\d+):(.*):[^:]+$/.exec(content);
  if (!m) return undefined;
  const pid = Number(m[1]!);
  const startedAt = Number(m[2]!);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(startedAt)) return undefined;
  return { pid, startedAt, host: m[3]! };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // 권한이 없어 신호를 못 보내는 것도 프로세스가 살아 있다는 뜻이다
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
