import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from '../../core/config.js';
import { gestaltPath } from '../../core/home.js';
import {
  fileDeploySource,
  fileQueue,
  GhAccounts,
  GhAccountSwitcher,
  GhPrWatchSource,
  hostJiraClient,
  hostSlackClient,
  writeDeploySignal,
  writeQueueMessage,
} from '../../conductor/adapters.js';
import {
  deliverGateDecision,
  inboxDirOf,
  tick,
  writeReport,
  type EngineDeps,
} from '../../conductor/engine.js';
import { existingRepoContext, repoContextPath } from '../../conductor/context.js';
import { resolveGate } from '../../conductor/gates.js';
import {
  intakeOrder,
  isControlChar,
  ISSUE_KEY_RE,
  KNOWN_SKILLS,
  oneLine,
} from '../../conductor/intake.js';
import type { DeploySignal } from '../../conductor/jira.js';
import {
  assertCanSpawn,
  detectOrca,
  GitWorktreeLauncher,
  OrcaLauncher,
  SubagentLauncher,
  workerAt,
  type HostAction,
  type LauncherSet,
} from '../../conductor/launcher.js';
import { measure } from '../../conductor/metrics.js';
import { resolveParentWorktree } from '../../conductor/parent-worktree.js';
import { normalizePrRef } from '../../conductor/pr-ref.js';
import { saveSkillCheckpoint } from '../../conductor/resume.js';
import type { ConductorConfig } from '../../conductor/scheduler.js';
import { draftSlack } from '../../conductor/slack.js';
import { ConductorStore } from '../../conductor/store.js';
import {
  INTAKE_KINDS,
  ISSUE_TYPES,
  JIRA_STATUSES,
  ORDER_SCOPES,
  WORKER_KINDS,
  TERMINAL_ORDER_STATUSES,
  type IntakeKind,
  type IssueType,
  type JiraStatus,
  type OrderScope,
  type WorkerKind,
} from '../../conductor/types.js';

/**
 * `gestalt conductor` — 컨덕터 스킬과 워커가 실행 상태 저장소를 읽고 쓰는 명령.
 *
 * 컨덕터 세션은 이 명령의 짧은 출력만 대화에 싣는다. 저장소를 대화 밖에 두니까
 * 세션이 압축되거나 다시 떠도 `status`로 진행 상황을 되찾는다.
 * 실패하면 stderr에 이유를 쓰고 1로 끝난다.
 */

export interface ConductorCommonOptions {
  stateDir?: string;
  json?: boolean;
}

interface Ctx {
  store: ConductorStore;
  config: ConductorConfig;
}

/** 상태 저장소 위치는 플래그, 환경 변수, 설정, 기본값 순서로 정한다 */
function open(opts: ConductorCommonOptions): Ctx {
  const config = loadConfig().conductor;
  const dir =
    opts.stateDir ??
    process.env['GESTALT_CONDUCTOR_STATE_DIR'] ??
    config.stateDir ??
    gestaltPath('conductor');
  return { store: ConductorStore.open(resolve(dir)), config };
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

/**
 * 컨덕터 전용 명령(tick, gate resolve, order add, deploy report, queue add)을 워커 안에서 부르면 거절한다.
 *
 * 환경 변수는 호스트가 git 워크트리 세션을 열 때 넣어 준 경우에만 있다. 오르카 워커는 환경이
 * 컨덕터와 같아서 작업 디렉토리가 살아 있는 워커의 워크트리 안인지로 가른다. 서브에이전트는
 * 컨덕터와 같은 자리, 같은 환경이라 여기서 못 막고 지시서 규칙에만 기댄다. 사고를 막는 장치이지
 * 적대적인 워커를 막는 경계는 아니다.
 */
function assertConductorSession(ctx: Ctx, command: string, cwd = process.cwd()): void {
  assertCanSpawn(process.env);
  const w = workerAt(cwd, ctx.store.workers());
  if (w)
    throw new Error(
      `여기는 워커 ${w.id}(${w.orderId})의 워크트리라 \`gestalt conductor ${command}\`를 못 불러요. 컨덕터 세션에서 불러 주세요`,
    );
}

/**
 * 워커 세션에서 다른 워커 이름으로 보고나 체크포인트를 남기면 거절한다.
 *
 * `GESTALT_CONDUCTOR_WORKER_ID`는 git 워크트리 런처가 세션을 열 때만 넣는다. 오르카와 서브에이전트
 * 워커는 이 값이 없어서 여기서 못 막는다. 실수로 남의 id를 적는 걸 막는 장치다.
 */
function assertOwnWorkerId(worker: string, env: NodeJS.ProcessEnv = process.env): void {
  const self = env['GESTALT_CONDUCTOR_WORKER_ID'];
  if (self && self !== worker) {
    throw new Error(`이 세션은 워커 ${self}라 ${worker} 이름으로 못 남겨요`);
  }
}

export interface ConductorOrderAddOptions extends ConductorCommonOptions {
  repo: string;
  title: string;
  description?: string;
  /** 긴 설명은 셸 인용이 깨지기 쉬워 파일로 받는다. `-`면 stdin */
  descriptionFile?: string;
  scope?: string;
  skills?: string;
  workerKind?: string;
  agent?: string;
  parentWorktree?: string;
  baseBranch?: string;
  source?: string;
  sourceRef?: string;
  issueKey?: string;
  issueType?: string;
  jiraStatus?: string;
  pr?: string;
}

function resolveParent(
  input: string | undefined,
  repo: string,
  repoPaths: Record<string, string>,
): string | undefined {
  if (input === undefined) return undefined;
  const orca = detectOrca(process.env);
  return resolveParentWorktree(input, repo, { repoPaths, ...(orca ? { orcaCommand: orca } : {}) });
}

export function conductorOrderAddCommand(opts: ConductorOrderAddOptions): void {
  run(() => {
    const ctx = open(opts);
    assertConductorSession(ctx, 'order add');
    const source = oneOf<IntakeKind>(opts.source ?? 'spoken', INTAKE_KINDS, '--source');
    if (opts.description !== undefined && opts.descriptionFile !== undefined)
      throw new Error('--description과 --description-file은 하나만 써 주세요');
    const description =
      opts.descriptionFile !== undefined
        ? readDescriptionFile(opts.descriptionFile)
        : opts.description;
    const parentWorktree = resolveParent(opts.parentWorktree, opts.repo, ctx.config.repoPaths);
    const out = intakeOrder(
      ctx.store,
      {
        source,
        ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
        repo: opts.repo,
        title: opts.title,
        ...(opts.sourceRef ? { sourceRef: opts.sourceRef } : {}),
        ...(description ? { description } : {}),
        ...(opts.scope ? { scope: oneOf<OrderScope>(opts.scope, ORDER_SCOPES, '--scope') } : {}),
        ...(opts.skills ? { skillChain: skillList(opts.skills, '--skills') } : {}),
        ...(opts.workerKind
          ? { workerKind: oneOf<WorkerKind>(opts.workerKind, WORKER_KINDS, '--worker-kind') }
          : {}),
        ...(parentWorktree ? { parentWorktree } : {}),
        ...(opts.baseBranch !== undefined ? { baseBranch: opts.baseBranch } : {}),
        ...(opts.issueKey ? { issueKey: issueKey(opts.issueKey) } : {}),
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
        ...(opts.pr ? { prRef: prRef(opts.pr) } : {}),
      },
      { defaultScope: ctx.config.defaultScope },
      { trusted: true },
    );
    if (opts.json) return print({ created: out.created, order: out.order });
    console.log(
      `${out.created ? '주문을 받았어요' : '이미 받은 주문이에요'}: ${out.order.id} (${out.order.scope})`,
    );
  });
}

/**
 * 워커 보고처럼 바깥에서 온 값을 터미널에 찍을 꼴로 바꾼다. ESC 같은 제어 문자가 화면을 조작하지 못하게
 * 개행 말고는 공백으로 바꾸고 이어지는 줄은 들여써 다른 항목 줄로 보이지 않게 한다. 전문을 읽는 자리라 자르지 않는다
 */
function terminalText(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    out += ch !== '\n' && isControlChar(c) ? ' ' : ch;
  }
  return out.replace(/\n/g, '\n    ');
}

export function conductorOrderShowCommand(id: string, opts: ConductorCommonOptions): void {
  run(() => {
    const { store } = open(opts);
    const order = store.order(id);
    if (!order) throw new Error(`모르는 주문이에요: ${id}`);
    const workers = store.workersOf(id);
    const reports = store.snapshot.reports[id] ?? [];
    const gates = Object.values(store.snapshot.gates).filter((g) => g.orderId === id);
    const bypasses = store.snapshot.bypasses.filter((b) => b.orderId === id);
    const refs = [...new Set(reports.flatMap((r) => r.refs))];
    if (opts.json) return print({ order, workers, reports, refs, gates, bypasses });
    console.log(`${order.id}  ${terminalText(order.title)}`);
    console.log(`레포: ${order.repo}  범위: ${order.scope}  상태: ${order.status}`);
    console.log(`설명: ${order.description ? terminalText(order.description) : '없음'}`);
    console.log(`체인: ${order.skillChain.join(' → ')}`);
    console.log(`PR: ${order.prRef ? terminalText(order.prRef) : '없음'}`);
    if (order.agent) console.log(`주문 에이전트: ${order.agent}`);
    console.log('워커:');
    for (const w of workers)
      console.log(
        `  ${w.id}  ${w.kind}  에이전트: ${w.agent ?? (w.kind === 'orca-worktree' ? 'claude (기존 기록)' : '호스트에서 결정')}  ${w.status}`,
      );
    console.log('보고 이력:');
    for (const r of reports) {
      console.log(`  ${r.at}  ${r.workerId}  ${r.status}  ${terminalText(r.summary)}`);
      if (r.skill) console.log(`    스킬: ${terminalText(r.skill)}`);
      if (r.prRef) console.log(`    PR: ${terminalText(r.prRef)}`);
      if (r.merged !== undefined) console.log(`    머지: ${r.merged}`);
      if (r.stopReason) console.log(`    중단: ${r.stopReason}`);
      if (r.need) console.log(`    요청: ${r.need.kind}  ${terminalText(r.need.detail)}`);
    }
    console.log(`refs: ${refs.map(terminalText).join(', ') || '없음'}`);
    console.log('gate:');
    for (const g of gates)
      console.log(
        `  ${g.id}  ${g.type}  ${g.status}  ${g.decision ?? '-'}  ${terminalText(g.reason)}${g.answer ? `  답: ${terminalText(g.answer)}` : ''}`,
      );
    console.log('bypass:');
    for (const b of bypasses)
      console.log(`  ${b.at}  ${terminalText(b.need)}  ${terminalText(b.action)}`);
  });
}

/** 신뢰 경로라 길이로 자르지 않으니 엉뚱한 파일을 통째로 싣지 않게 크기에서 막는다 */
const DESCRIPTION_FILE_MAX = 64 * 1024;

function readDescriptionFile(file: string): string {
  if (file !== '-') {
    const st = statSync(file, { throwIfNoEntry: false });
    if (!st) throw new Error(`설명 파일을 찾을 수 없어요: ${file}`);
    if (!st.isFile()) throw new Error(`설명 파일이 일반 파일이 아니에요: ${file}`);
    if (st.size > DESCRIPTION_FILE_MAX)
      throw new Error(`설명 파일이 ${DESCRIPTION_FILE_MAX / 1024}KB를 넘어요: ${file}`);
  }
  const raw = readFileSync(file === '-' ? 0 : file, 'utf-8');
  if (Buffer.byteLength(raw) > DESCRIPTION_FILE_MAX)
    throw new Error(`설명이 ${DESCRIPTION_FILE_MAX / 1024}KB를 넘어요`);
  const text = raw.trim();
  if (!text) throw new Error(`설명 파일이 비어 있어요: ${file}`);
  return text;
}

export interface ConductorContextPathOptions extends ConductorCommonOptions {
  repo: string;
}

/**
 * 레포 공통 맥락 파일 경로를 알려 준다. 디렉토리는 만들어 두고 파일은 만들지 않는다.
 * 컨덕터가 경로를 받아 직접 쓰고 워커는 지시서에 실린 경로로 읽는다.
 */
export function conductorContextPathCommand(opts: ConductorContextPathOptions): void {
  run(() => {
    const ctx = open(opts);
    const path = repoContextPath(resolve(ctx.store.dir), opts.repo);
    mkdirSync(dirname(path), { recursive: true });
    if (opts.json)
      return print({
        repo: opts.repo,
        path,
        exists: existingRepoContext(ctx.store.dir, opts.repo) !== undefined,
      });
    console.log(path);
  });
}

export interface ConductorStatusOptions extends ConductorCommonOptions {
  /** 끝난 주문도 보여준다. bypass로 넘긴 일을 사후 보고할 때 쓴다 */
  all?: boolean;
}

export function conductorStatusCommand(opts: ConductorStatusOptions): void {
  run(() => {
    const { store } = open(opts);
    const orders = store.orders().filter((o) => opts.all || o.status !== 'done');
    const gates = store.openGates();
    const bypassesOf = new Map<string, { need: string; action: string; at: string }[]>();
    for (const b of store.snapshot.bypasses) {
      const key = b.orderId ?? '';
      const list = bypassesOf.get(key) ?? [];
      list.push({ need: b.need, action: b.action, at: b.at });
      bypassesOf.set(key, list);
    }
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
          ...(opts.all && TERMINAL_ORDER_STATUSES.has(o.status)
            ? { lastSummary: store.snapshot.reports[o.id]?.at(-1)?.summary ?? null }
            : {}),
          bypasses: bypassesOf.get(o.id) ?? [],
        })),
        unassignedBypasses: bypassesOf.get('') ?? [],
        gates: gates.map((g) => ({
          id: g.id,
          type: g.type,
          orderId: g.orderId ?? null,
          reason: g.reason,
        })),
      });
    }
    console.log(`마지막 tick: ${store.snapshot.lastTickAt ?? '없음'}`);
    for (const o of orders) {
      const summary =
        opts.all && TERMINAL_ORDER_STATUSES.has(o.status)
          ? store.snapshot.reports[o.id]?.at(-1)?.summary
          : undefined;
      console.log(
        `${o.id}  ${o.status}  ${o.scope}  ${o.repo}  ${o.title}${summary ? `  ${oneLine(summary, 100)}` : ''}`,
      );
      for (const b of bypassesOf.get(o.id) ?? [])
        console.log(`  bypass ${b.at}  ${b.need}  ${b.action}`);
    }
    for (const b of bypassesOf.get('') ?? []) console.log(`bypass ${b.at}  ${b.need}  ${b.action}`);
    for (const g of gates) console.log(`게이트 ${g.id}  ${g.type}  ${g.reason}`);
  });
}

export interface ConductorTickOptions extends ConductorCommonOptions {
  force?: boolean;
  prWatch?: boolean;
  queue?: boolean;
}

export async function conductorTickCommand(opts: ConductorTickOptions): Promise<void> {
  try {
    const ctx = open(opts);
    assertConductorSession(ctx, 'tick');
    const deferred: HostAction[] = [];
    const prWatch = opts.prWatch !== false && Object.keys(ctx.config.repoPaths).length > 0;
    // 토큰과 로그인 계정 캐시를 PR 감시와 계정 맞추기가 tick 하나 동안 함께 쓴다
    const gh = new GhAccounts(ctx.config.accounts);
    const prSource = prWatch
      ? new GhPrWatchSource({ repoPaths: ctx.config.repoPaths, accounts: gh })
      : undefined;
    const queue = opts.queue !== false ? fileQueue(queueDirOf(ctx)) : undefined;
    const deps: EngineDeps = {
      config: ctx.config,
      ...launchersFor(ctx, process.env),
      jira: hostJiraClient(deferred),
      slack: hostSlackClient(deferred),
      deploy: fileDeploySource(join(ctx.store.dir, 'deploy')),
      ...(prSource ? { prSource } : {}),
      ...(queue ? { queue } : {}),
      ...(Object.keys(ctx.config.accounts).length > 0
        ? { accounts: new GhAccountSwitcher({ accounts: gh }) }
        : {}),
    };
    const report = await tick(ctx.store, deps, { force: opts.force === true });
    report.hostActions.push(...deferred);
    report.errors.push(...(queue?.errors ?? []));
    for (const repo of prSource?.truncatedRepos ?? [])
      report.errors.push(`${repo}: 열린 PR이 상한에 닿아 뒤쪽 PR은 이번 감시에서 빠졌어요`);
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
    for (const w of report.warnings) console.log(`경고: ${w}`);
    for (const e of report.errors) console.log(`오류: ${e}`);
  } catch (e) {
    exitWithError(e);
  }
}

export interface ConductorWorkerReportOptions extends ConductorCommonOptions {
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

export function conductorWorkerReportCommand(opts: ConductorWorkerReportOptions): void {
  run(() => {
    assertOwnWorkerId(opts.worker);
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
      ...(opts.pr ? { prRef: prRef(opts.pr) } : {}),
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

export function conductorGateListCommand(opts: ConductorCommonOptions): void {
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

export interface ConductorGateResolveOptions extends ConductorCommonOptions {
  approve?: boolean;
  reject?: boolean;
  answer?: string;
}

export async function conductorGateResolveCommand(
  gateId: string,
  opts: ConductorGateResolveOptions,
): Promise<void> {
  try {
    if (opts.approve === opts.reject) throw new Error('--approve와 --reject 중 하나만 주세요');
    const ctx = open(opts);
    assertConductorSession(ctx, 'gate resolve');
    const gate = ctx.store.snapshot.gates[gateId];
    if (!gate) throw new Error(`모르는 게이트예요: ${gateId}`);
    if (gate.status !== 'open') throw new Error(`이미 종료된 게이트예요: ${gateId}`);
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

export interface ConductorCheckpointSaveOptions extends ConductorCommonOptions {
  worker: string;
  skill: string;
  next: string;
  phase?: string;
  round?: string;
  done?: string;
  shipDir?: string;
  ref?: string[];
}

export function conductorCheckpointSaveCommand(opts: ConductorCheckpointSaveOptions): void {
  run(() => {
    assertOwnWorkerId(opts.worker);
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

export interface ConductorDeployReportOptions extends ConductorCommonOptions {
  order: string;
  status: string;
  ref?: string;
}

export function conductorDeployReportCommand(opts: ConductorDeployReportOptions): void {
  run(() => {
    const ctx = open(opts);
    assertConductorSession(ctx, 'deploy report');
    const { store } = ctx;
    if (!store.order(opts.order)) throw new Error(`모르는 주문이에요: ${opts.order}`);
    const signal = {
      status: oneOf<DeploySignal['status']>(opts.status, DEPLOY_STATUSES, '--status'),
      ...(opts.ref ? { ref: opts.ref } : {}),
    };
    writeDeploySignal(join(store.dir, 'deploy'), opts.order, signal);
    if (opts.json) return print({ orderId: opts.order, ...signal });
    console.log('배포 결과를 남겼어요. 다음 tick에 반영돼요');
  });
}

export interface ConductorQueueAddOptions extends ConductorCommonOptions {
  bodyFile: string;
  id?: string;
}

/** 외부 큐에 메시지를 넣는다. 웹훅 수신기 같은 바깥 프로세스가 부른다. `-`면 stdin에서 읽는다 */
export function conductorQueueAddCommand(opts: ConductorQueueAddOptions): void {
  run(() => {
    const ctx = open(opts);
    // 워커가 큐로 주문을 만들면 하위 워커를 컨덕터 몰래 띄우는 길이 된다
    assertConductorSession(ctx, 'queue add');
    const raw = readFileSync(opts.bodyFile === '-' ? 0 : opts.bodyFile, 'utf-8');
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch (err) {
      throw new Error(`JSON이 아니에요: ${String(err)}`, { cause: err });
    }
    const id = writeQueueMessage(queueDirOf(ctx), body, opts.id);
    if (opts.json) return print({ id, sourceRef: `queue:${id}` });
    console.log(`큐에 넣었어요: ${id}. 다음 tick에 주문으로 받아요`);
  });
}

function queueDirOf(ctx: Ctx): string {
  return join(ctx.store.dir, 'queue');
}

export interface ConductorSlackDraftOptions extends ConductorCommonOptions {
  channel: string;
  textFile: string;
  order?: string;
  thread?: string;
}

export function conductorSlackDraftCommand(opts: ConductorSlackDraftOptions): void {
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

export interface ConductorMetricsOptions {
  since: string;
  root?: string;
  json?: boolean;
}

export function conductorMetricsCommand(opts: ConductorMetricsOptions): void {
  run(() => {
    const since = Date.parse(opts.since);
    if (Number.isNaN(since)) throw new Error(`--since 날짜를 못 읽었어요: ${opts.since}`);
    const root = opts.root ?? join(homedir(), '.claude', 'projects');
    const r = measure({ root, since });
    if (opts.json) return print(r);
    const c = r.comparison;
    const pct = (v: number | null) => (v === null ? '-' : `${Math.round(v * 100)}%`);
    console.log(`기준 세션 ${c.baseline.sessions}개, 컨덕터 세션 ${c.current.sessions}개`);
    console.log(
      `끼어든 발화 감소 ${pct(c.interventionReduction)} (목표 40%), 토큰 변화 ${pct(c.tokenDelta)} (목표 +10% 이내)`,
    );
    console.log(`판정: ${c.passed ? '통과' : '미달'}`);
    for (const n of c.notes) console.log(`- ${n}`);
  });
}

function list(v: string): string[] {
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const DEPLOY_STATUSES = ['success', 'failed', 'pending', 'unknown'] as const;

function skillList(v: string, flag: string): string[] {
  const skills = list(v);
  const unknown = skills.filter((s) => !KNOWN_SKILLS.has(s));
  if (unknown.length > 0)
    throw new Error(
      `${flag}에 모르는 스킬이 있어요: ${unknown.join(', ')}. ${[...KNOWN_SKILLS].join(', ')} 중에서 골라 주세요`,
    );
  return skills;
}

function issueKey(v: string): string {
  if (!ISSUE_KEY_RE.test(v)) throw new Error(`--issue-key는 PROJ-123 꼴이어야 해요: ${v}`);
  return v;
}

function prRef(v: string): string {
  const ref = normalizePrRef(v);
  if (!ref) throw new Error(`--pr은 owner/name#번호나 GitHub PR 주소여야 해요: ${v}`);
  return ref;
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
