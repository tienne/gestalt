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
} from 'node:fs';
import { join, resolve } from 'node:path';
import { handleNeed, openOrReuse, type BypassHandlers } from './gates.js';
import {
  intakeOrder,
  pollJira,
  pollQueue,
  type ExternalQueue,
  type JiraIntakeSource,
} from './intake.js';
import { syncJira, type DeploySource, type JiraClient, type OrderStage } from './jira.js';
import {
  assertCanSpawn,
  buildWorkerPrompt,
  chooseWorkerKind,
  ensureAccount,
  type AccountSwitcher,
  type HostAction,
  type LauncherSet,
} from './launcher.js';
import { pollPrs, type PrWatchSource } from './pr-watch.js';
import { parseWorkerReport } from './result.js';
import { detectStale, prepareResumes, resumeLaunchFor, type ShipReader } from './resume.js';
import type { MasterConfig } from './scheduler.js';
import { planSlots } from './scheduler.js';
import { publishApprovedSlack, type SlackClient } from './slack.js';
import { newId, type MasterStore } from './store.js';
import type { Gate, JiraStatus, Order, Worker, WorkerKind, WorkerReport } from './types.js';

/**
 * 마스터 tick 한 번.
 *
 * 접수, 결과 수신, 끊김 감지와 재개, 배정과 띄우기, 머지 뒤 마무리, 슬랙 게시, 정리를
 * 차례로 돈다. 상태는 전부 저장소에 남기고 마스터 세션에는 짧은 TickReport만 돌려준다.
 * 마스터 세션이 대신 해야 하는 일(서브에이전트 띄우기, git 워크트리 세션 열기, 메시지 전하기)은
 * hostActions로 돌려준다. Passthrough 설계라 여기서 LLM을 부르지 않는다.
 */

export interface EngineDeps {
  config: MasterConfig;
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
  counts: {
    queued: number;
    running: number;
    waitingGate: number;
    activeWorkers: number;
    openGates: number;
    unansweredThreads: number;
  };
}

export function inboxDirOf(store: MasterStore, deps: Pick<EngineDeps, 'inboxDir'>): string {
  return deps.inboxDir ?? join(store.dir, 'inbox');
}

/** 배포를 기다렸다가 In-QA로 가는 유형 */
const DEPLOY_TYPES = new Set(['bug', 'task', 'sub-bug']);
/** 이 스킬이 돌기 시작하면 지라를 PR로 옮긴다 */
const REVIEW_SKILLS = new Set(['ship', 'local-pr', 'review-reply', 'review-loop']);

const LOCK_FILE = 'tick.lock';
const LOCK_STALE_MS = 10 * 60 * 1000;

/**
 * 사람 확인 자리가 아닌 요청을 마스터가 대신 넘기는 기본 절차. 호스트가 `deps.bypass`로 덮어쓸 수 있다.
 * 수동 검증과 정리는 워커가 자기 워크트리에서 직접 할 수 있어 진행하라고만 돌려준다.
 * 계정은 설정에 적힌 레포만 맞추고 그 밖은 절차가 없다고 던져 사람에게 올린다.
 */
function policyBypass(deps: EngineDeps): BypassHandlers {
  const switchAccount = async ({ order }: { order?: Order }): Promise<string> => {
    const wanted = order ? deps.config.accounts[order.repo] : undefined;
    if (!order || !wanted || !deps.accounts) throw new Error('맞출 계정이 설정에 없어요');
    await deps.accounts.switchTo(order.repo, wanted);
    return `${order.repo} 계정을 ${wanted}로 맞췄어요`;
  };
  return {
    'merge-approval': async ({ order }) =>
      `${order?.scope ?? 'merge-through'} 주문이라 승인 없이 머지를 진행해요`,
    'interview-answer': async () => '인터뷰 답은 워커가 스펙과 레포를 보고 정해요',
    'simple-approval': async ({ detail }) => `단순 승인이라 마스터가 승인했어요: ${detail}`,
    'manual-verification': async () => '수동 검증은 워커가 직접 돌리고 결과를 다음 보고에 남겨요',
    cleanup: async () => '정리는 워커가 직접 하고 한 일을 다음 보고에 남겨요',
    'account-switch': switchAccount,
    auth: switchAccount,
  };
}

export async function tick(
  store: MasterStore,
  deps: EngineDeps,
  opts: { force?: boolean } = {},
): Promise<TickReport> {
  assertCanSpawn(deps.env);
  store.reload();
  const report = emptyReport(store.timestamp());

  const last = store.snapshot.lastTickAt;
  const interval = deps.config.pollIntervalSec * 1000;
  if (!opts.force && last && Date.parse(report.at) - Date.parse(last) < interval) {
    return { ...report, skipped: true, counts: counts(store, 0) };
  }

  const release = acquireLock(store.dir);
  if (!release) {
    report.errors.push('다른 tick이 돌고 있어 이번엔 건너뛰어요');
    return { ...report, skipped: true, counts: counts(store, 0) };
  }
  try {
    let unanswered = 0;
    await step(report, () => intake(store, deps, report).then((n) => (unanswered = n)));
    await step(report, () => ingestReports(store, deps, report));
    await step(report, async () => {
      detectStale(store, {
        now: new Date(report.at),
        staleAfterMs: deps.config.staleAfterSec * 1000,
      });
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
    store.append({ type: 'tick', at: report.at });
    return { ...report, counts: counts(store, unanswered) };
  } finally {
    release();
  }
}

// ─── 접수 ────────────────────────────────────────────────────────

async function intake(store: MasterStore, deps: EngineDeps, report: TickReport): Promise<number> {
  const cfg = { defaultScope: deps.config.defaultScope };
  if (deps.jiraSource) {
    const r = await pollJira(store, deps.jiraSource, cfg);
    report.created.push(...r.created.map((o) => o.id));
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
    const repo = prRef?.split('#')[0];
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

// ─── 결과 수신 ───────────────────────────────────────────────────

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

async function ingestReports(
  store: MasterStore,
  deps: EngineDeps,
  report: TickReport,
): Promise<void> {
  const dir = inboxDirOf(store, deps);
  if (!existsSync(dir)) return;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
    .sort();
  for (const f of files) {
    const path = join(dir, f);
    try {
      const r = parseWorkerReport(
        JSON.parse(readFileSync(path, 'utf-8')),
        deps.config.resultMaxChars,
      );
      await applyReport(store, deps, report, r);
    } catch (err) {
      report.errors.push(`결과 ${f}: ${message(err)}`);
    }
    unlinkSync(path);
  }
}

async function applyReport(
  store: MasterStore,
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

  store.updateWorker(worker.id, {
    lastSeenAt: report.at,
    ...(worker.status === 'starting' ? { status: 'running' } : {}),
  });
  if (r.prRef && order.prRef !== r.prRef) store.updateOrder(order.id, { prRef: r.prRef });

  if (r.spawnRequest) {
    const out = intakeOrder(
      store,
      {
        source: 'spoken',
        sourceRef: `spawn:${worker.id}:${r.spawnRequest.title}`,
        repo: order.repo,
        title: r.spawnRequest.title,
        description: r.spawnRequest.detail,
        scope: order.scope,
      },
      { defaultScope: deps.config.defaultScope },
    );
    if (out.created) report.created.push(out.order.id);
  }

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

// ─── 게이트 결정 전달 ────────────────────────────────────────────

/**
 * 사람이 닫은 게이트의 결정을 살아 있는 워커에 전한다. `gestalt master gate resolve`가 부른다.
 * 워커가 없거나 끝났으면 전할 곳이 없으니 아무것도 안 한다. 주문은 resolveGate가 이미 옮겨 뒀다.
 */
export async function deliverGateDecision(
  store: MasterStore,
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

// ─── 띄우기 ──────────────────────────────────────────────────────

async function launchQueued(
  store: MasterStore,
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
    const worker: Worker = {
      id: newId('wrk'),
      orderId: order.id,
      kind,
      spawnedBy: 'master',
      attempt: store.workersOf(order.id).length + 1,
      status: 'starting',
      ...(account.account ? { account: account.account } : {}),
      startedAt: report.at,
      lastSeenAt: report.at,
    };
    try {
      const prompt = buildWorkerPrompt(order, worker, resume?.context, {
        stateDir: resolve(store.dir),
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

// ─── 머지 뒤 ─────────────────────────────────────────────────────

/**
 * 머지된 주문을 끝낸다. bug, task, sub-bug는 배포 파이프라인이 성공해야 In-QA로 옮기고 끝낸다.
 * 배포가 실패하면 그 주문만 사람에게 올린다.
 */
async function settleMerged(
  store: MasterStore,
  deps: EngineDeps,
  report: TickReport,
): Promise<void> {
  for (const order of store.orders().filter((o) => o.status === 'merged')) {
    const waitsDeploy =
      order.issueKey !== undefined &&
      order.issueType !== undefined &&
      DEPLOY_TYPES.has(order.issueType);
    if (!waitsDeploy) {
      store.updateOrder(order.id, { status: 'done' });
      continue;
    }
    if (!deps.deploy) {
      report.errors.push(`${order.id}: 배포 감지 어댑터가 없어 In-QA로 못 옮기고 끝냈어요`);
      store.updateOrder(order.id, { status: 'done' });
      continue;
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
}

// ─── 정리 ────────────────────────────────────────────────────────

/** 끝난 워커의 자원을 bypass로 정리한다. 멈춘 워커는 재개가 손잡이를 다시 쓸 수 있어 남긴다 */
async function cleanupWorkers(
  store: MasterStore,
  deps: EngineDeps,
  report: TickReport,
): Promise<void> {
  for (const w of store.workers()) {
    if (w.status !== 'finished' && w.status !== 'failed') continue;
    const launcher = deps.launchers[w.kind];
    const outcome = await handleNeed(
      store,
      { orderId: w.orderId, need: 'cleanup', detail: `${w.id} 정리` },
      {
        ...deps.bypass,
        cleanup: async () => {
          if (launcher) await launcher.release(w);
          return `${w.kind} 워커 ${w.id}를 정리했어요`;
        },
      },
    );
    if (outcome.kind === 'bypass') store.updateWorker(w.id, { status: 'released' });
    else report.escalated.push(outcome.gate.id);
  }
}

// ─── 지라 ────────────────────────────────────────────────────────

async function moveJira(
  store: MasterStore,
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

// ─── 보조 ────────────────────────────────────────────────────────

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

function counts(store: MasterStore, unansweredThreads: number): TickReport['counts'] {
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

/** 마스터 세션이 둘 떠도 같은 주문을 두 번 띄우지 않게 tick을 하나만 돌린다 */
function acquireLock(dir: string): (() => void) | undefined {
  const path = join(dir, LOCK_FILE);
  try {
    closeSync(openSync(path, 'wx'));
  } catch {
    // 앞 tick이 죽고 남긴 잠금이면 걷어내고 한 번 더 시도한다
    try {
      if (Date.now() - statSync(path).mtimeMs < LOCK_STALE_MS) return undefined;
      unlinkSync(path);
      closeSync(openSync(path, 'wx'));
    } catch {
      return undefined;
    }
  }
  return () => {
    try {
      unlinkSync(path);
    } catch {
      // 이미 지워졌으면 할 일이 없다
    }
  };
}
