import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../../core/config.js';
import { gestaltPath } from '../../core/home.js';
import {
  fileDeploySource,
  GhAccountSwitcher,
  GhPrWatchSource,
  hostJiraClient,
  hostSlackClient,
  writeDeploySignal,
} from '../../master/adapters.js';
import {
  deliverGateDecision,
  inboxDirOf,
  tick,
  writeReport,
  type EngineDeps,
} from '../../master/engine.js';
import { resolveGate } from '../../master/gates.js';
import { intakeOrder } from '../../master/intake.js';
import type { DeploySignal } from '../../master/jira.js';
import {
  detectOrca,
  GitWorktreeLauncher,
  OrcaLauncher,
  SubagentLauncher,
  type HostAction,
  type LauncherSet,
} from '../../master/launcher.js';
import { measure } from '../../master/metrics.js';
import { saveSkillCheckpoint } from '../../master/resume.js';
import type { MasterConfig } from '../../master/scheduler.js';
import { draftSlack } from '../../master/slack.js';
import { MasterStore } from '../../master/store.js';
import {
  INTAKE_KINDS,
  ISSUE_TYPES,
  JIRA_STATUSES,
  ORDER_SCOPES,
  WORKER_KINDS,
  type IntakeKind,
  type IssueType,
  type JiraStatus,
  type OrderScope,
  type WorkerKind,
} from '../../master/types.js';

/**
 * `gestalt master` — 마스터 스킬과 워커가 실행 상태 저장소를 읽고 쓰는 명령.
 *
 * 마스터 세션은 이 명령의 짧은 출력만 대화에 싣는다. 저장소를 대화 밖에 두니까
 * 세션이 압축되거나 다시 떠도 `status`로 진행 상황을 되찾는다.
 * 실패하면 stderr에 이유를 쓰고 1로 끝난다.
 */

export interface MasterCommonOptions {
  stateDir?: string;
  json?: boolean;
}

interface Ctx {
  store: MasterStore;
  config: MasterConfig;
}

/** 상태 저장소 위치는 플래그, 환경 변수, 설정, 기본값 순서로 정한다 */
function open(opts: MasterCommonOptions): Ctx {
  const config = loadConfig().master;
  const dir =
    opts.stateDir ??
    process.env['GESTALT_MASTER_STATE_DIR'] ??
    config.stateDir ??
    gestaltPath('master');
  return { store: MasterStore.open(resolve(dir)), config };
}

function launchersFor(
  ctx: Ctx,
  env: NodeJS.ProcessEnv,
): { launchers: LauncherSet; orcaAvailable: boolean } {
  const promptDir = join(ctx.store.dir, 'prompts');
  const orca = detectOrca(env);
  const launchers: LauncherSet = {
    subagent: new SubagentLauncher({ promptDir }),
    'git-worktree': new GitWorktreeLauncher({
      worktreeRoot: join(ctx.store.dir, 'worktrees'),
      promptDir,
      repoPaths: ctx.config.repoPaths,
    }),
  };
  if (orca) {
    launchers['orca-worktree'] = new OrcaLauncher({
      orcaCommand: orca,
      promptDir,
      repoPaths: ctx.config.repoPaths,
    });
  }
  return { launchers, orcaAvailable: orca !== undefined };
}

// ─── order ───────────────────────────────────────────────────────

export interface MasterOrderAddOptions extends MasterCommonOptions {
  repo: string;
  title: string;
  description?: string;
  scope?: string;
  skills?: string;
  workerKind?: string;
  source?: string;
  sourceRef?: string;
  issueKey?: string;
  issueType?: string;
  jiraStatus?: string;
  pr?: string;
}

export function masterOrderAddCommand(opts: MasterOrderAddOptions): void {
  run(() => {
    const ctx = open(opts);
    const source = oneOf<IntakeKind>(opts.source ?? 'spoken', INTAKE_KINDS, '--source');
    const out = intakeOrder(
      ctx.store,
      {
        source,
        repo: opts.repo,
        title: opts.title,
        ...(opts.sourceRef ? { sourceRef: opts.sourceRef } : {}),
        ...(opts.description ? { description: opts.description } : {}),
        ...(opts.scope ? { scope: oneOf<OrderScope>(opts.scope, ORDER_SCOPES, '--scope') } : {}),
        ...(opts.skills ? { skillChain: list(opts.skills) } : {}),
        ...(opts.workerKind
          ? { workerKind: oneOf<WorkerKind>(opts.workerKind, WORKER_KINDS, '--worker-kind') }
          : {}),
        ...(opts.issueKey ? { issueKey: opts.issueKey } : {}),
        ...(opts.issueType
          ? { issueType: oneOf<IssueType>(opts.issueType, ISSUE_TYPES, '--issue-type') }
          : {}),
        ...(opts.jiraStatus
          ? {
              explicitJiraStatus: oneOf<JiraStatus>(
                opts.jiraStatus,
                JIRA_STATUSES,
                '--jira-status',
              ),
            }
          : {}),
        ...(opts.pr ? { prRef: opts.pr } : {}),
      },
      { defaultScope: ctx.config.defaultScope },
    );
    if (opts.json) return print({ created: out.created, order: out.order });
    console.log(
      `${out.created ? '주문을 받았어요' : '이미 받은 주문이에요'}: ${out.order.id} (${out.order.scope})`,
    );
  });
}

// ─── status ──────────────────────────────────────────────────────

export function masterStatusCommand(opts: MasterCommonOptions): void {
  run(() => {
    const { store } = open(opts);
    const orders = store.orders().filter((o) => o.status !== 'done');
    const gates = store.openGates();
    if (opts.json) {
      return print({
        lastTickAt: store.snapshot.lastTickAt ?? null,
        orders: orders.map((o) => ({
          id: o.id,
          status: o.status,
          scope: o.scope,
          repo: o.repo,
          title: o.title,
          ...(o.workerId ? { worker: o.workerId } : {}),
          ...(o.prRef ? { pr: o.prRef } : {}),
          ...(o.issueKey ? { issue: o.issueKey } : {}),
        })),
        gates: gates.map((g) => ({
          id: g.id,
          type: g.type,
          orderId: g.orderId ?? null,
          reason: g.reason,
        })),
      });
    }
    console.log(`마지막 tick: ${store.snapshot.lastTickAt ?? '없음'}`);
    for (const o of orders) console.log(`${o.id}  ${o.status}  ${o.scope}  ${o.repo}  ${o.title}`);
    for (const g of gates) console.log(`게이트 ${g.id}  ${g.type}  ${g.reason}`);
  });
}

// ─── tick ────────────────────────────────────────────────────────

export interface MasterTickOptions extends MasterCommonOptions {
  force?: boolean;
  prWatch?: boolean;
}

export async function masterTickCommand(opts: MasterTickOptions): Promise<void> {
  try {
    const ctx = open(opts);
    const deferred: HostAction[] = [];
    const prWatch = opts.prWatch !== false && Object.keys(ctx.config.repoPaths).length > 0;
    const deps: EngineDeps = {
      config: ctx.config,
      ...launchersFor(ctx, process.env),
      jira: hostJiraClient(deferred),
      slack: hostSlackClient(deferred),
      deploy: fileDeploySource(join(ctx.store.dir, 'deploy')),
      ...(prWatch ? { prSource: new GhPrWatchSource({ repoPaths: ctx.config.repoPaths }) } : {}),
      ...(Object.keys(ctx.config.accounts).length > 0 ? { accounts: new GhAccountSwitcher() } : {}),
    };
    const report = await tick(ctx.store, deps, { force: opts.force === true });
    report.hostActions.push(...deferred);
    if (opts.json) return print(report);
    if (report.skipped) {
      console.log(`건너뛰었어요${report.errors[0] ? `: ${report.errors[0]}` : ' (감시 간격 안)'}`);
      return;
    }
    const c = report.counts;
    console.log(
      `대기 ${c.queued}, 진행 ${c.running}, 게이트 ${c.openGates}, 새 주문 ${report.created.length}, 띄움 ${report.launched.length}`,
    );
    for (const a of report.hostActions) console.log(`할 일: ${JSON.stringify(a)}`);
    for (const e of report.errors) console.log(`오류: ${e}`);
  } catch (e) {
    exitWithError(e);
  }
}

// ─── worker report ───────────────────────────────────────────────

export interface MasterWorkerReportOptions extends MasterCommonOptions {
  worker: string;
  status?: string;
  summary?: string;
  ref?: string[];
  skill?: string;
  pr?: string;
  merged?: boolean;
  stopReason?: string;
  need?: string;
  needDetail?: string;
  spawnTitle?: string;
  spawnDetail?: string;
  file?: string;
}

export function masterWorkerReportCommand(opts: MasterWorkerReportOptions): void {
  run(() => {
    const ctx = open(opts);
    const fromFile = opts.file
      ? (JSON.parse(readFileSync(opts.file, 'utf-8')) as Record<string, unknown>)
      : {};
    const raw: Record<string, unknown> = {
      ...fromFile,
      workerId: opts.worker,
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.summary ? { summary: opts.summary } : {}),
      ...(opts.ref?.length ? { refs: opts.ref } : { refs: fromFile['refs'] ?? [] }),
      ...(opts.skill ? { skill: opts.skill } : {}),
      ...(opts.pr ? { prRef: opts.pr } : {}),
      ...(opts.merged ? { merged: true } : {}),
      ...(opts.stopReason ? { stopReason: opts.stopReason } : {}),
      ...(opts.need ? { need: { kind: opts.need, detail: opts.needDetail ?? '' } } : {}),
      ...(opts.spawnTitle
        ? { spawnRequest: { title: opts.spawnTitle, detail: opts.spawnDetail ?? '' } }
        : {}),
    };
    const name = writeReport(inboxDirOf(ctx.store, {}), raw, ctx.config.resultMaxChars);
    if (opts.json) return print({ queued: name });
    console.log('결과를 넘겼어요. 다음 tick에 반영돼요');
  });
}

// ─── gate ────────────────────────────────────────────────────────

export function masterGateListCommand(opts: MasterCommonOptions): void {
  run(() => {
    const { store } = open(opts);
    const gates = store.openGates();
    if (opts.json) return print(gates);
    if (gates.length === 0) console.log('열린 게이트가 없어요');
    for (const g of gates) {
      console.log(`${g.id}  ${g.type}  ${g.orderId ?? '-'}  ${g.reason}`);
      for (const r of g.refs) console.log(`    ${r}`);
    }
  });
}

export interface MasterGateResolveOptions extends MasterCommonOptions {
  approve?: boolean;
  reject?: boolean;
  answer?: string;
}

export async function masterGateResolveCommand(
  gateId: string,
  opts: MasterGateResolveOptions,
): Promise<void> {
  try {
    if (opts.approve === opts.reject) throw new Error('--approve와 --reject 중 하나만 주세요');
    const ctx = open(opts);
    const gate = ctx.store.snapshot.gates[gateId];
    if (!gate) throw new Error(`모르는 게이트예요: ${gateId}`);
    if (gate.status !== 'open') throw new Error(`이미 닫힌 게이트예요: ${gateId}`);
    const closed = resolveGate(
      ctx.store,
      gateId,
      opts.approve ? 'approved' : 'rejected',
      opts.answer,
    );
    const delivered = await deliverGateDecision(ctx.store, closed, launchersFor(ctx, process.env));
    if (opts.json) return print({ gate: closed, ...delivered });
    console.log(`${gateId}를 ${closed.decision === 'approved' ? '승인' : '거절'}했어요`);
    for (const a of delivered.hostActions) console.log(`할 일: ${JSON.stringify(a)}`);
    for (const e of delivered.errors) console.log(`오류: ${e}`);
  } catch (e) {
    exitWithError(e);
  }
}

// ─── checkpoint ──────────────────────────────────────────────────

export interface MasterCheckpointSaveOptions extends MasterCommonOptions {
  worker: string;
  skill: string;
  next: string;
  phase?: string;
  round?: string;
  done?: string;
  shipDir?: string;
  ref?: string[];
}

export function masterCheckpointSaveCommand(opts: MasterCheckpointSaveOptions): void {
  run(() => {
    const ctx = open(opts);
    const cp = saveSkillCheckpoint(ctx.store, {
      workerId: opts.worker,
      skill: opts.skill,
      next: opts.next,
      ...(opts.phase ? { phase: opts.phase } : {}),
      ...(opts.round !== undefined ? { round: nonNegativeInt(opts.round, '--round') } : {}),
      ...(opts.done ? { completedSkills: list(opts.done) } : {}),
      ...(opts.shipDir ? { shipDir: opts.shipDir } : {}),
      ...(opts.ref?.length ? { refs: opts.ref } : {}),
    });
    if (opts.json) return print(cp);
    console.log(`체크포인트를 남겼어요: ${cp.skill}${cp.phase ? ` ${cp.phase}` : ''}`);
  });
}

// ─── deploy, slack ───────────────────────────────────────────────

export interface MasterDeployReportOptions extends MasterCommonOptions {
  order: string;
  status: string;
  ref?: string;
}

export function masterDeployReportCommand(opts: MasterDeployReportOptions): void {
  run(() => {
    const { store } = open(opts);
    if (!store.order(opts.order)) throw new Error(`모르는 주문이에요: ${opts.order}`);
    const signal = {
      status: opts.status as DeploySignal['status'],
      ...(opts.ref ? { ref: opts.ref } : {}),
    };
    writeDeploySignal(join(store.dir, 'deploy'), opts.order, signal);
    if (opts.json) return print({ orderId: opts.order, ...signal });
    console.log('배포 결과를 남겼어요. 다음 tick에 반영돼요');
  });
}

export interface MasterSlackDraftOptions extends MasterCommonOptions {
  channel: string;
  textFile: string;
  order?: string;
  thread?: string;
}

export function masterSlackDraftCommand(opts: MasterSlackDraftOptions): void {
  run(() => {
    const { store } = open(opts);
    const text = readFileSync(opts.textFile, 'utf-8').trim();
    if (!text) throw new Error('초안이 비었어요');
    const { gate, reused } = draftSlack(
      store,
      {
        channel: opts.channel,
        text,
        ...(opts.order ? { orderId: opts.order } : {}),
        ...(opts.thread ? { threadTs: opts.thread } : {}),
      },
      join(store.dir, 'slack'),
    );
    if (opts.json) return print({ gateId: gate.id, reused });
    console.log(`승인을 기다려요: ${gate.id}${reused ? ' (같은 초안이 이미 올라가 있어요)' : ''}`);
  });
}

// ─── metrics ─────────────────────────────────────────────────────

export interface MasterMetricsOptions {
  since: string;
  root?: string;
  json?: boolean;
}

export function masterMetricsCommand(opts: MasterMetricsOptions): void {
  run(() => {
    const since = Date.parse(opts.since);
    if (Number.isNaN(since)) throw new Error(`--since 날짜를 못 읽었어요: ${opts.since}`);
    const root = opts.root ?? join(homedir(), '.claude', 'projects');
    const r = measure({ root, since });
    if (opts.json) return print(r);
    const c = r.comparison;
    const pct = (v: number | null) => (v === null ? '-' : `${Math.round(v * 100)}%`);
    console.log(`기준 세션 ${c.baseline.sessions}개, 마스터 세션 ${c.current.sessions}개`);
    console.log(
      `끼어든 발화 감소 ${pct(c.interventionReduction)} (목표 40%), 토큰 변화 ${pct(c.tokenDelta)} (목표 +10% 이내)`,
    );
    console.log(`판정: ${c.passed ? '통과' : '미달'}`);
    for (const n of c.notes) console.log(`- ${n}`);
  });
}

// ─── 보조 ────────────────────────────────────────────────────────

function list(v: string): string[] {
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function oneOf<T extends string>(v: string, allowed: readonly string[], flag: string): T {
  if (!allowed.includes(v)) throw new Error(`${flag}는 ${allowed.join(', ')} 중 하나예요: ${v}`);
  return v as T;
}

function nonNegativeInt(v: string, flag: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${flag}는 0 이상의 정수여야 해요: ${v}`);
  return n;
}

function print(v: unknown): void {
  console.log(JSON.stringify(v, null, 2));
}

function run(body: () => void): void {
  try {
    body();
  } catch (e) {
    exitWithError(e);
  }
}

function exitWithError(e: unknown): never {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
