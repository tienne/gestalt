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
import { isAccountName } from './account-name.js';
import { existingRepoContext } from './context.js';
import { handleNeed, openOrReuse, type BypassHandlers } from './gates.js';
import {
  intakeOrder,
  pollJira,
  pollQueue,
  type ExternalQueue,
  type JiraIntakeSource,
} from './intake.js';
import { QA_TYPES, syncJira, type DeploySource, type JiraClient, type OrderStage } from './jira.js';
import {
  assertCanSpawn,
  buildWorkerPrompt,
  chooseWorkerKind,
  ensureAccount,
  type AccountSwitcher,
  type HostAction,
  type LauncherSet,
  type ReleaseOptions,
} from './launcher.js';
import { repoOfPrRef } from './pr-ref.js';
import { pollPrs, type PrWatchSource } from './pr-watch.js';
import { parseWorkerReport } from './result.js';
import {
  detectStale,
  escalateResume,
  prepareResumes,
  rateLimitedWorkers,
  resumeLaunchFor,
  wakeFromRateLimit,
  type ResumeLaunch,
  type ShipReader,
} from './resume.js';
import type { ConductorConfig } from './scheduler.js';
import { planSlots } from './scheduler.js';
import { publishApprovedSlack, type SlackClient } from './slack.js';
import { newId, type ConductorStore } from './store.js';
import type {
  Gate,
  JiraStatus,
  Order,
  OrderScope,
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
  jira?: JiraClient;
  deploy?: DeploySource;
  slack?: SlackClient;
  accounts?: AccountSwitcher;
  bypass?: BypassHandlers;
  readShip?: ShipReader;
  env?: NodeJS.ProcessEnv;
}

export interface TickReport {
  at: string;
  /** 감시 주기 안에 다시 불려 건너뛰었으면 true */
  skipped?: boolean;
  created: string[];
  launched: { orderId: string; workerId: string; kind: WorkerKind; resumed: boolean }[];
  escalated: string[];
  hostActions: HostAction[];
  slackPosted: string[];
  jira: { orderId: string; to: JiraStatus }[];
  errors: string[];
  /** 멈출 일은 아니지만 사람이 알아야 할 자리. 런처가 주문 옵션을 다 못 따른 경우 같은 것 */
  warnings: string[];
  /** 세션 한도에 걸려 재개하지 않고 기다리는 오르카 워커. 풀리기 전까지 tick마다 싣는다 */
  rateLimited: RateLimitedEntry[];
  counts: {
    queued: number;
    running: number;
    waitingGate: number;
    activeWorkers: number;
    openGates: number;
    unansweredThreads: number;
  };
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
const CLEANUP_FAILED = 'cleanup-failed';
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
    'simple-approval': async ({ detail }) => `단순 승인이라 컨덕터가 승인했어요: ${detail}`,
    'manual-verification': async () => '수동 검증은 워커가 직접 돌리고 결과를 다음 보고에 남겨요',
    cleanup: async () => '정리는 워커가 직접 하고 한 일을 다음 보고에 남겨요',
    'account-switch': switchAccount,
    auth: switchAccount,
  };
}

export async function tick(
  store: ConductorStore,
  deps: EngineDeps,
  opts: { force?: boolean } = {},
): Promise<TickReport> {
  assertCanSpawn(deps.env);
  const report = emptyReport(store.timestamp());

  const lock = acquireLock(store.dir);
  if (!lock.ok) {
    report.errors.push(
      `다른 tick이 돌고 있어 이번엔 건너뛰어요${lock.holder ? ` (pid ${lock.holder})` : ''}`,
    );
    return { ...report, skipped: true, counts: counts(store, 0) };
  }
  try {
    // 잠금을 잡은 뒤에 읽어야 앞 tick이 띄운 주문을 queued로 보고 또 띄우지 않는다
    store.reload();
    const last = store.snapshot.lastTickAt;
    const interval = deps.config.pollIntervalSec * 1000;
    if (!opts.force && last && Date.parse(report.at) - Date.parse(last) < interval) {
      return { ...report, skipped: true, counts: counts(store, 0) };
    }
    return await store.deferSnapshot(() => runTick(store, deps, report));
  } finally {
    lock.release();
  }
}

async function runTick(
  store: ConductorStore,
  deps: EngineDeps,
  report: TickReport,
): Promise<TickReport> {
  let unanswered = 0;
  let cleared: string[] = [];
  await step(report, () => ingestReports(store, deps, report).then((c) => (cleared = c)));
  await step(report, () => intake(store, deps, report).then((n) => (unanswered = n)));
  await step(report, async () => {
    const orca = deps.launchers['orca-worktree'];
    const stale = await detectStale(store, {
      now: new Date(report.at),
      staleAfterMs: deps.config.staleAfterSec * 1000,
      rateLimitEscalateAfterMs: deps.config.rateLimitEscalateAfterSec * 1000,
      ...(orca?.probe ? { probe: (w: Worker) => orca.probe!(w) } : {}),
      ...(orca?.peek ? { peek: (w: Worker) => orca.peek!(w) } : {}),
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
  await step(report, () => launchQueued(store, deps, report));
  await step(report, () => settleMerged(store, deps, report));
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
  store.append({
    type: 'tick',
    at: report.at,
    ...(cleared.length > 0 ? { clearedReports: cleared } : {}),
  });
  return { ...report, counts: counts(store, unanswered) };
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
  for (const g of Object.values(store.snapshot.gates)) {
    if (g.type !== 'review-manual-switch' || g.orderId || g.decision !== 'approved') continue;
    const prRef = g.payload?.prRef;
    const repo = prRef ? repoOfPrRef(prRef) : null;
    if (!prRef || !repo) continue;
    const out = intakeOrder(
      store,
      {
        source: 'pr-watch',
        sourceRef: `${g.payload?.sourceRef ?? g.id}:approved`,
        repo,
        title: `재리뷰: ${prRef}`,
        prRef,
        skillChain: ['review-loop'],
      },
      cfg,
    );
    if (out.created) report.created.push(out.order.id);
  }
  for (const o of store.orders()) {
    if (o.status === 'queued' && o.issueKey && !o.jiraStatus)
      await moveJira(store, deps, report, o.id, 'identified');
  }
  return unanswered;
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
          report: pickStoredReport(r),
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
          report: pickStoredReport(r),
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

/** 이력에 남길 칸만 고른다. 하위 주문 요청은 적용할 때 주문으로 옮겨졌다 */
function pickStoredReport(r: WorkerReport): StoredReport {
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
  // 한도 게이트를 거절해 취소한 주문은 앞 터미널이 남아 있어 한도가 풀리면 다시 보고할 수 있다
  if (order.status === 'cancelled')
    throw new Error(`${worker.id}는 취소된 주문의 워커라 결과를 무시해요`);
  // 상태를 하나라도 바꾸기 전에 거른다. 반쯤 적용된 채 failed로 옮겨지면 되살릴 때 앞부분이 겹친다
  if (r.status === 'needs' && !r.need) throw new Error('status needs인데 need가 없어요');

  store.updateWorker(worker.id, {
    lastSeenAt: report.at,
    ...(worker.status === 'starting' ? { status: 'running' } : {}),
    ...wakeFromRateLimit(worker),
  });
  if (r.prRef && order.prRef !== r.prRef) store.updateOrder(order.id, { prRef: r.prRef });

  if (r.spawnRequest) await spawnFromReport(store, deps, report, order, worker, r.spawnRequest);

  switch (r.status) {
    case 'progress':
      if (r.prRef || (r.skill && REVIEW_SKILLS.has(r.skill)))
        await moveJira(store, deps, report, order.id, 'review');
      return;
    case 'done':
      store.updateWorker(worker.id, { status: 'finished' });
      if (r.merged) {
        store.updateOrder(order.id, { status: 'merged', mergedAt: report.at });
        await moveJira(store, deps, report, order.id, 'merged');
      } else {
        store.updateOrder(order.id, { status: 'done' });
      }
      return;
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
        { orderId: order.id, need: r.need.kind, detail: r.need.detail, refs: r.refs },
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
  if (store.findOrderBySourceRef(sourceRef)) return;
  const made = store.orders().filter((o) => o.parentOrderId === order.id).length;
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
 */
export async function deliverGateDecision(
  store: ConductorStore,
  gate: Gate,
  deps: Pick<EngineDeps, 'launchers'>,
): Promise<{ hostActions: HostAction[]; errors: string[] }> {
  const out = { hostActions: [] as HostAction[], errors: [] as string[] };
  const order = gate.orderId ? store.order(gate.orderId) : undefined;
  const worker = order?.workerId ? store.worker(order.workerId) : undefined;
  if (!worker || (worker.status !== 'running' && worker.status !== 'starting')) return out;
  const text = decisionMessage(gate);
  const fake = emptyReport(store.timestamp());
  await sendTo(deps, fake, worker, text);
  return { hostActions: fake.hostActions, errors: fake.errors };
}

function decisionMessage(gate: Gate): string {
  const ok = gate.decision === 'approved';
  const note = gate.answer ? `: ${gate.answer}` : '';
  switch (gate.type) {
    case 'merge':
      return ok
        ? '머지 승인됐어요. 머지하고 결과를 보고하세요'
        : `머지 거절${note}. 머지하지 말고 다음 지시를 기다리세요`;
    case 'interview':
      return `인터뷰 답${note || ': (빈 답)'}`;
    case 'review-manual-switch':
      return ok ? `사람이 확인했어요${note}. 다음 라운드로 진행하세요` : `여기서 멈추세요${note}`;
    default:
      return ok ? `사람이 처리했어요${note}. 이어서 진행하세요` : `중단하세요${note}`;
  }
}

async function sendTo(
  deps: Pick<EngineDeps, 'launchers'>,
  report: Pick<TickReport, 'hostActions' | 'errors'>,
  worker: Worker,
  text: string,
): Promise<void> {
  const launcher = deps.launchers[worker.kind];
  if (!launcher) {
    report.errors.push(`${worker.kind} 런처가 없어 ${worker.id}에 못 전했어요`);
    return;
  }
  try {
    const action = await launcher.send(worker, text);
    if (action) report.hostActions.push(action);
  } catch (err) {
    report.errors.push(`${worker.id}에 전하기 실패: ${message(err)}`);
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
  const plan = planSlots(store, deps.config.maxConcurrentWorkers);
  for (const order of plan.toStart) {
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
    if (resume && !(await retirePrevious(store, deps, report, order, resume))) continue;
    const worker: Worker = {
      id: newId('wrk'),
      orderId: order.id,
      kind,
      ...(kind === 'orca-worktree'
        ? { agent: resolveWorkerAgent(order, store.workersOf(order.id), deps.config) }
        : {}),
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
      });
      store.startWorker({
        ...worker,
        handle: started.handle,
        status: started.hostAction ? 'starting' : 'running',
      });
      store.updateOrder(order.id, { status: 'running', workerId: worker.id });
      if (started.hostAction) report.hostActions.push(started.hostAction);
      if (started.warnings) report.warnings.push(...started.warnings);
      report.launched.push({
        orderId: order.id,
        workerId: worker.id,
        kind,
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
 * 진행한다. 그래서 거두기가 실패하면 새 워커를 안 띄우고 재개 게이트로 사람에게 올린다.
 * git 워크트리와 서브에이전트 워커는 지금처럼 앞 워커를 건드리지 않는다.
 */
async function retirePrevious(
  store: ConductorStore,
  deps: EngineDeps,
  report: TickReport,
  order: Order,
  resume: ResumeLaunch,
): Promise<boolean> {
  const { previous } = resume;
  if (previous.kind !== 'orca-worktree') return true;
  const launcher = deps.launchers['orca-worktree'];
  try {
    if (!launcher) throw new Error('오르카 런처가 없어 앞 워커 터미널을 못 거둬요');
    await launcher.release(previous, { requireClosed: true });
    return true;
  } catch (err) {
    const gate = escalateResume(
      store,
      order,
      previous,
      `앞 워커 터미널을 못 거뒀어요: ${message(err)}`,
    );
    report.escalated.push(gate.id);
    return false;
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
  const waitsDeploy =
    order.issueKey !== undefined && order.issueType !== undefined && QA_TYPES.has(order.issueType);
  if (!waitsDeploy) {
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
  }
}

/** 이번 tick에 거둘 워커인지. 머지된 주문의 오르카 워크트리는 재개로 멈춘 앞 회차도 거둔다 */
function isCleanupTarget(w: Worker, removeWorktree: boolean): boolean {
  if (w.status === 'finished' || w.status === 'failed') return true;
  return removeWorktree && w.status === 'stopped';
}

/**
 * 끝난 워커의 자원을 정리한다. 멈춘 워커는 재개가 그 dispatch id나 워크트리를 다시 쓸 수 있어 남긴다.
 *
 * removeMergedOrcaWorktrees를 켜면 머지된 주문의 오르카 워커는 워크트리까지 지운다. 재개로 갈린
 * 앞 회차는 stopped로 남는데 주문이 머지되면 다시 쓸 일이 없어 같이 거둔다. 머지 안 된 주문의
 * 워크트리는 확인할 거리가 남았을 수 있어 그대로 둔다.
 *
 * 정리가 실패하면 주문 없는 게이트로 올린다. 주문에 붙이면 주문이 waiting-gate로 바뀌어 머지 뒤
 * 정산까지 멈추는데 정리는 주문 진행과 무관하다. 그 게이트가 열린 동안은 다시 시도하지 않는다.
 * 사람이 승인하면 직접 정리한 것으로 보고 released로 두고 거절하면 다음 tick에 다시 시도한다.
 */
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
    const removeWorktree =
      deps.config.removeMergedOrcaWorktrees === true &&
      w.kind === 'orca-worktree' &&
      order?.mergedAt !== undefined;
    if (!isCleanupTarget(w, removeWorktree)) continue;
    const mine = cleanupGates.filter((g) => g.payload?.workerId === w.id);
    if (mine.some((g) => g.status === 'open')) continue;
    if (mine.some((g) => g.decision === 'approved')) {
      store.updateWorker(w.id, { status: 'released' });
      continue;
    }
    targets.push({
      worker: w,
      opts: removeWorktree
        ? {
            removeWorktree,
            ...(order?.parentWorktree ? { parentWorktree: order.parentWorktree } : {}),
          }
        : {},
    });
  }
  // release마다 외부 명령 타임아웃이 걸려 있어 차례로 기다리면 tick이 워커 수만큼 길어진다.
  // 워크트리 삭제만은 같은 레포의 git 락이 겹치지 않게 레포마다 차례로 돌린다
  const repoChains = new Map<string, Promise<void>>();
  const results = await Promise.allSettled(
    targets.map(({ worker, opts }) => {
      const run = async (): Promise<void> => {
        await deps.launchers[worker.kind]?.release(worker, opts);
      };
      if (!opts.removeWorktree) return run();
      const repo = store.order(worker.orderId)?.repo ?? '';
      const next = (repoChains.get(repo) ?? Promise.resolve()).then(run, run);
      repoChains.set(repo, next);
      return next;
    }),
  );
  results.forEach((r, i) => {
    const { worker: w, opts } = targets[i]!;
    if (r.status === 'fulfilled') {
      const at = store.timestamp();
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
      store.updateWorker(w.id, { status: 'released' });
      return;
    }
    const { gate } = openOrReuse(store, {
      type: 'no-procedure',
      reason: `${w.id} 정리에 실패했어요: ${message(r.reason)}`,
      payload: { kind: CLEANUP_FAILED, workerId: w.id, orderId: w.orderId },
    });
    report.escalated.push(gate.id);
  });
}

async function moveJira(
  store: ConductorStore,
  deps: EngineDeps,
  report: TickReport,
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

type LockResult = { ok: true; release: () => void } | { ok: false; holder?: number };

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
function acquireLock(dir: string): LockResult {
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
