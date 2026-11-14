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
  GhPrStateSource,
  GhPrWatchSource,
  prWatchTargets,
  hostJiraClient,
  hostSlackClient,
  writeDeploySignal,
  writeQueueMessage,
} from '../../conductor/adapters.js';
import {
  acquireLock,
  afterHumanMerge,
  rateLimitEntries,
  deliverGateDecision,
  inboxDirOf,
  tick,
  staleTickWarning,
  writeReport,
  type EngineDeps,
  type RateLimitedEntry,
} from '../../conductor/engine.js';
import { existingRepoContext, repoContextPath } from '../../conductor/context.js';
import {
  currentSessionId,
  handoffNotice,
  handoffRecordPath,
  handoffStatus,
  isSessionId,
  resolveHandoffModel,
  launchHandoff,
  readHandoffRecord,
  recordHandoff,
  registerSession,
  writeHandoffFile,
  type HandoffStatus,
} from '../../conductor/handoff.js';
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
  orcaWorktreeName,
  SubagentLauncher,
  workerAt,
  type HostAction,
  type LauncherSet,
} from '../../conductor/launcher.js';
import { measure } from '../../conductor/metrics.js';
import {
  cancelOrder,
  confirmHumanMerge,
  takeOver,
  type HumanOwnedChange,
} from '../../conductor/ownership.js';
import { resolveParentWorktree } from '../../conductor/parent-worktree.js';
import { normalizePrRef } from '../../conductor/pr-ref.js';
import { saveSkillCheckpoint } from '../../conductor/resume.js';
import {
  currentSessionTab,
  nameConductorTab,
  renameHandoffTabs,
} from '../../conductor/tab-title.js';
import {
  closeHandedOffTabs,
  handoffCloseLine,
  type HandoffCloseResult,
} from '../../conductor/handoff-close.js';
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
 * 컨덕터 전용 명령(tick, gate resolve, order add, order remove, deploy report, queue add)을 워커 안에서 부르면 거절한다.
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
    if ('removedAt' in out) {
      if (opts.json) return print({ created: false, removedAt: out.removedAt });
      return console.log(`이 출처의 주문은 ${out.removedAt}에 지웠어요. 다시 받지 않아요`);
    }
    if (opts.json) return print({ created: out.created, order: out.order });
    console.log(
      `${out.created ? '주문을 받았어요' : '이미 받은 주문이에요'}: ${out.order.id} (${out.order.scope})`,
    );
  });
}

/**
 * 끝난 주문을 저장소에서 지운다. 로그 줄을 지우지 않고 order-removed를 덧붙이니 컨덕터 tick이나
 * 워커가 동시에 써도 안전하다. 지운 주문의 출처는 남겨 지라나 PR 감시가 같은 주문을 다시 만들지 않는다.
 * 하나가 거절돼도 나머지는 지운다. 하나도 못 지웠으면 1로 끝난다.
 */
export async function conductorOrderRemoveCommand(
  orderIds: string[],
  opts: ConductorCommonOptions,
): Promise<void> {
  try {
    const ctx = open(opts);
    assertConductorSession(ctx, 'order remove');
    // tick이 게이트를 열거나 워커를 띄우는 사이에 지우지 않게 같은 잠금을 잡고 다시 읽는다
    const lock = acquireLock(ctx.store.dir);
    if (!lock.ok)
      throw new Error(
        `컨덕터 tick이 도는 중이라 못 지웠어요${lock.holder ? ` (pid ${lock.holder})` : ''}. 잠시 뒤 다시 불러 주세요`,
      );
    const removed: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    try {
      ctx.store.reload();
      await ctx.store.deferSnapshot(async () => {
        for (const id of new Set(orderIds)) {
          try {
            ctx.store.removeOrder(id);
            removed.push(id);
          } catch (e) {
            skipped.push({ id, reason: e instanceof Error ? e.message : String(e) });
          }
        }
      });
    } finally {
      lock.release();
    }
    if (opts.json) print({ removed, skipped });
    else if (removed.length > 0) {
      console.log(`주문 ${removed.length}개를 지웠어요: ${removed.join(', ')}`);
      for (const s of skipped) console.log(`못 지웠어요: ${s.reason}`);
    }
    // 하나도 못 지우면 이유를 stderr로 한 번만 낸다. 플러그인처럼 실패하면 stderr만 보는 호출자도 받는다
    if (removed.length === 0 && skipped.length > 0)
      exitWithError(new Error(skipped.map((s) => s.reason).join('\n')));
  } catch (e) {
    exitWithError(e);
  }
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
    if (order.humanOwnedAt) console.log(`사람이 넘겨받은 시각: ${order.humanOwnedAt}`);
    if (order.cancelReason) console.log(`취소 이유: ${terminalText(order.cancelReason)}`);
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
    const { store, config } = open(opts);
    const orders = store.orders().filter((o) => opts.all || o.status !== 'done');
    const gates = store.openGates();
    const limited = new Map(rateLimitEntries(store).map((e) => [e.orderId, e]));
    const bypassesOf = new Map<string, { need: string; action: string; at: string }[]>();
    for (const b of store.snapshot.bypasses) {
      const key = b.orderId ?? '';
      const list = bypassesOf.get(key) ?? [];
      list.push({ need: b.need, action: b.action, at: b.at });
      bypassesOf.set(key, list);
    }
    if (opts.json) {
      return print({
        stateDir: store.dir,
        lastTickAt: store.snapshot.lastTickAt ?? null,
        orders: orders.map((o) => {
          const w = o.workerId ? store.worker(o.workerId) : undefined;
          return {
            id: o.id,
            status: o.status,
            scope: o.scope,
            repo: o.repo,
            title: o.title,
            updatedAt: o.updatedAt,
            ...(o.workerId ? { worker: o.workerId } : {}),
            // 오르카 플러그인 같은 바깥 도구가 워커 워크트리를 찾아 열 때 쓴다
            ...(w ? { workerKind: w.kind, workerStatus: w.status } : {}),
            ...(w?.handle ? { workerHandle: w.handle } : {}),
            ...(w?.kind === 'orca-worktree' ? { worktreeName: orcaWorktreeName(w) } : {}),
            // 바깥 도구가 주문 위계를 그릴 때 쓴다. 하위 주문과 부모 워크트리 둘 다 비면 뿌리 주문이다
            ...(o.parentOrderId ? { parentOrderId: o.parentOrderId } : {}),
            ...(o.parentWorktree ? { parentWorktree: o.parentWorktree } : {}),
            ...(o.baseBranch ? { baseBranch: o.baseBranch } : {}),
            ...(o.prRef ? { pr: o.prRef } : {}),
            ...(o.issueKey ? { issue: o.issueKey } : {}),
            ...(o.humanOwnedAt ? { humanOwnedAt: o.humanOwnedAt } : {}),
            ...(limited.has(o.id) ? { rateLimit: limited.get(o.id) } : {}),
            ...(opts.all && TERMINAL_ORDER_STATUSES.has(o.status)
              ? { lastSummary: store.snapshot.reports[o.id]?.at(-1)?.summary ?? null }
              : {}),
            bypasses: bypassesOf.get(o.id) ?? [],
          };
        }),
        unassignedBypasses: bypassesOf.get('') ?? [],
        gates: gates.map((g) => ({
          id: g.id,
          type: g.type,
          orderId: g.orderId ?? null,
          reason: g.reason,
          openedAt: g.openedAt,
        })),
      });
    }
    console.log(`마지막 tick: ${store.snapshot.lastTickAt ?? '없음'}`);
    const staleWarning = staleTickWarning(
      store.snapshot.lastTickAt,
      new Date().toISOString(),
      config.staleAfterSec * 1000,
    );
    if (staleWarning) console.log(`경고: ${staleWarning}`);
    for (const o of orders) {
      const summary =
        opts.all && TERMINAL_ORDER_STATUSES.has(o.status)
          ? store.snapshot.reports[o.id]?.at(-1)?.summary
          : undefined;
      console.log(
        `${o.id}  ${o.status}  ${o.scope}  ${o.repo}  ${o.title}${summary ? `  ${oneLine(summary, 100)}` : ''}`,
      );
      const limit = limited.get(o.id);
      if (limit) console.log(`  ${rateLimitLine(limit)}`);
      if (o.status === 'human-owned' || o.status === 'parked')
        console.log(
          `  사람 담당: ${o.humanOwnedAt ?? '-'}부터, PR ${o.prRef ?? '없음'}${o.status === 'parked' ? ' (tick이 더 안 봐요. 머지했으면 order mark-merged)' : ''}`,
        );
      for (const b of bypassesOf.get(o.id) ?? [])
        console.log(`  bypass ${b.at}  ${b.need}  ${b.action}`);
    }
    for (const b of bypassesOf.get('') ?? []) console.log(`bypass ${b.at}  ${b.need}  ${b.action}`);
    for (const g of gates) console.log(`게이트 ${g.id}  ${g.type}  ${g.reason}`);
  });
}

function rateLimitLine(e: RateLimitedEntry): string {
  const via = e.source === 'text' ? ', 출력 문구로 판단' : '';
  return `한도 대기: ${e.workerId} ${e.since}부터${e.resetsAt ? `, 풀리는 시각 ${e.resetsAt}` : ''}${via}`;
}

export interface ConductorTickOptions extends ConductorCommonOptions {
  force?: boolean;
  prWatch?: boolean;
  queue?: boolean;
}

// 세션을 처음 등록한 tick에서만 부른다. 실패는 stderr 한 줄로만 알리고 tick은 그대로 돈다
async function nameTabOnce(): Promise<void> {
  const env = process.env;
  const orca = detectOrca(env);
  const failure = await nameConductorTab({
    env,
    cwd: process.cwd(),
    ...(orca ? { orcaCommand: orca } : {}),
  });
  if (failure) console.error(failure);
}

export async function conductorTickCommand(opts: ConductorTickOptions): Promise<void> {
  try {
    const ctx = open(opts);
    assertConductorSession(ctx, 'tick');
    const sessionId = currentSessionId();
    if (sessionId) {
      assertNotHandedOff(ctx, sessionId);
      if (registerSession(ctx.store.dir, sessionId, process.cwd(), new Date())) {
        await nameTabOnce();
      }
    }
    const handoffClose = sessionId ? await closePreviousTabs(ctx, sessionId) : [];
    const deferred: HostAction[] = [];
    const watch =
      opts.prWatch !== false
        ? prWatchTargets(ctx.config.prWatchRepos, ctx.config.repoPaths)
        : undefined;
    // 토큰과 로그인 계정 캐시를 PR 감시와 계정 맞추기가 tick 하나 동안 함께 쓴다
    const gh = new GhAccounts(ctx.config.accounts);
    const prSource =
      watch && Object.keys(watch.repoPaths).length > 0
        ? new GhPrWatchSource({ repoPaths: watch.repoPaths, accounts: gh })
        : undefined;
    const queue = opts.queue !== false ? fileQueue(queueDirOf(ctx)) : undefined;
    const deps: EngineDeps = {
      config: ctx.config,
      ...launchersFor(ctx, process.env),
      jira: hostJiraClient(deferred),
      slack: hostSlackClient(deferred),
      deploy: fileDeploySource(join(ctx.store.dir, 'deploy')),
      ...(prSource ? { prSource } : {}),
      prState: new GhPrStateSource({ accounts: gh }),
      ...(queue ? { queue } : {}),
      ...(Object.keys(ctx.config.accounts).length > 0
        ? { accounts: new GhAccountSwitcher({ accounts: gh }) }
        : {}),
    };
    const report = await tick(ctx.store, deps, { force: opts.force === true });
    report.hostActions.push(...deferred);
    // 건너뛴 tick은 감시를 안 돌았다. 경로 누락 오류를 붙이면 출력이 그걸 건너뛴 이유로 보여 준다
    if (!report.skipped) report.errors.push(...(queue?.errors ?? []), ...(watch?.errors ?? []));
    for (const repo of prSource?.truncatedRepos ?? [])
      report.errors.push(`${repo}: 열린 PR이 상한에 닿아 뒤쪽 PR은 이번 감시에서 빠졌어요`);
    const handoff = sessionId ? sessionHandoff(ctx, sessionId) : undefined;
    if (opts.json)
      return print({
        ...report,
        ...(handoff ? { handoff } : {}),
        ...(handoffClose.length > 0 ? { handoffClose } : {}),
      });
    const handoffLine = handoffNotice(handoff);
    if (report.skipped) {
      console.log(`건너뛰었어요${report.errors[0] ? `: ${report.errors[0]}` : ' (감시 간격 안)'}`);
      for (const r of handoffClose) console.log(handoffCloseLine(r));
      if (handoffLine) console.log(handoffLine);
      return;
    }
    const c = report.counts;
    console.log(
      `대기 ${c.queued}, 진행 ${c.running}, 게이트 ${c.openGates}, 새 주문 ${report.created.length}, 띄움 ${report.launched.length}`,
    );
    for (const a of report.hostActions) console.log(`할 일: ${JSON.stringify(a)}`);
    for (const l of report.rateLimited) console.log(`${l.orderId} ${rateLimitLine(l)}`);
    for (const h of report.humanOwned) console.log(humanOwnedLine(h));
    for (const w of report.warnings) console.log(`경고: ${w}`);
    for (const e of report.errors) console.log(`오류: ${e}`);
    if (report.idleTicks > 0) console.log(`변화 없는 tick ${report.idleTicks}번째`);
    for (const r of handoffClose) console.log(handoffCloseLine(r));
    if (handoffLine) console.log(handoffLine);
  } catch (e) {
    exitWithError(e);
  }
}

const HUMAN_OWNED_TO: Record<HumanOwnedChange['to'], string> = {
  merged: '사람이 머지했어요. 머지 뒤 처리를 이어요',
  cancelled: 'PR이 머지 없이 닫혀 취소했어요',
  parked: '오래 안 움직여 parked로 내렸어요',
};

function humanOwnedLine(h: HumanOwnedChange): string {
  return `${h.orderId}${h.prRef ? ` (${h.prRef})` : ''}: ${HUMAN_OWNED_TO[h.to]}`;
}

// 닫기 실패는 tick을 멈추지 않는다. 결과는 tick 출력의 handoffClose로만 알린다
async function closePreviousTabs(ctx: Ctx, sessionId: string): Promise<HandoffCloseResult[]> {
  try {
    const orca = detectOrca(process.env);
    return await closeHandedOffTabs({
      stateDir: ctx.store.dir,
      sessionId,
      closeAfterSec: ctx.config.handoffCloseAfterSec,
      now: new Date(),
      cwd: process.cwd(),
      ...(orca ? { orcaCommand: orca } : {}),
    });
  } catch (e) {
    console.error(`이전 지휘자 탭 닫기: ${(e as Error).message}`);
    return [];
  }
}

function sessionHandoff(ctx: Ctx, sessionId: string): HandoffStatus {
  return handoffStatus(ctx.store.dir, sessionId, {
    thresholdPercent: ctx.config.handoffContextPercent,
    ...(ctx.config.contextWindowTokens !== undefined
      ? { contextWindowTokens: ctx.config.contextWindowTokens }
      : {}),
  });
}

/** 인계한 세션의 반복이 안 멈췄으면 tick을 거절해 컨덕터가 둘이 되지 않게 한다 */
function assertNotHandedOff(ctx: Ctx, sessionId: string): void {
  const prev = readHandoffRecord(ctx.store.dir, sessionId);
  if (!prev) return;
  const record = handoffRecordPath(ctx.store.dir, sessionId);
  throw new Error(
    `이 세션은 ${prev.at}에 새 세션으로 인계했어요(${prev.file}). 반복을 멈추고 새 세션에서 돌려 주세요. 새 세션이 닫혀 반복이 끊겼을 때만 이 세션에서 이어 돌릴 수 있어요. 새 탭이 닫혔는지 사람에게 확인한 뒤에만 ${record}를 지워 주세요. status의 마지막 tick이 staleAfterSec(기본 30분)보다 오래됐는지는 참고로만 봐요. 간격이 긴 반복에서도 오래돼 보여요`,
  );
}

export interface ConductorHandoffOptions extends ConductorCommonOptions {
  notesFile: string;
  loopPrompt?: string;
  session?: string;
  launch?: boolean;
}

/**
 * 컨덕터 세션을 새 세션으로 넘긴다. 인계 파일을 쓰고 오르카가 있으면 새 세션을 띄워 첫 지시로 넘긴다.
 * 오르카가 없거나 띄우기가 실패하면 파일만 남기고 사람에게 전할 문장을 돌려준다.
 * 띄우기 전에 이 세션을 인계한 것으로 적어 두고 이후 tick을 거절한다. 띄운 뒤 결과를 못 덮어써도
 * 거절은 이미 걸려 있어 컨덕터가 둘 돌지 않는다. 그때는 stderr 한 줄과 결과의 recordError로 알린다.
 * 오르카로 띄웠으면 두 탭 이름도 바꾼다. 실패해도 인계는 성공으로 두고 결과의 renameErrors와 stderr로 알린다.
 */
export async function conductorHandoffCommand(opts: ConductorHandoffOptions): Promise<void> {
  try {
    const ctx = open(opts);
    assertConductorSession(ctx, 'handoff');
    const sessionId = opts.session ?? currentSessionId();
    if (!isSessionId(sessionId)) throw new Error('이 세션의 id를 몰라요. --session <id>로 주세요');
    assertNotHandedOff(ctx, sessionId);
    const notes = readDescriptionFile(opts.notesFile);
    const now = new Date();
    const status = sessionHandoff(ctx, sessionId);
    const file = writeHandoffFile(
      ctx.store.dir,
      sessionId,
      { ...(opts.loopPrompt ? { loopPrompt: opts.loopPrompt } : {}), notes },
      status,
      now,
    );
    recordHandoff(ctx.store.dir, sessionId, {
      at: now.toISOString(),
      file,
      launched: false,
      detail: '띄우는 중',
    });
    const orca = opts.launch === false ? undefined : detectOrca(process.env);
    const previousTab = currentSessionTab(process.env);
    const model = resolveHandoffModel(status, ctx.config.handoffModel);
    const outcome = await launchHandoff(file, {
      cwd: process.cwd(),
      effort: ctx.config.handoffEffort,
      ...(model ? { model } : {}),
      ...(orca ? { orcaCommand: orca } : {}),
    });
    let recordError: string | undefined;
    try {
      recordHandoff(ctx.store.dir, sessionId, {
        at: now.toISOString(),
        file,
        launched: outcome.launched,
        detail: outcome.detail,
        ...(outcome.launched && orca && previousTab ? { previousTab } : {}),
      });
    } catch (e) {
      // 거절은 위의 기록으로 이미 걸려 있다. handoff.json에 '띄우는 중'이 남는다는 것만 알리고 문장은 그대로 낸다
      recordError = (e as Error).message;
      console.error(`인계 기록 갱신 실패: ${recordError}`);
    }
    const renameErrors =
      outcome.launched && orca
        ? await renameHandoffTabs({
            env: process.env,
            orcaCommand: orca,
            now,
            cwd: process.cwd(),
            ...(outcome.tab ? { launched: outcome.tab } : {}),
          })
        : [];
    const result = {
      sessionId,
      file,
      ...outcome,
      ...(recordError ? { recordError } : {}),
      ...(renameErrors.length > 0 ? { renameErrors } : {}),
    };
    // recordError처럼 --json이어도 stderr에 남긴다
    for (const e of renameErrors) console.error(`탭 이름 바꾸기: ${e}`);
    if (opts.json) return print(result);
    console.log(`인계 파일: ${file}`);
    console.log(outcome.detail);
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
  /** 사람이 PR을 넘겨받는다. 승인, 거절과 나란히 두는 세 번째 답이다 */
  takeOver?: boolean;
  answer?: string;
  deferDelivery?: boolean;
}

export async function conductorGateResolveCommand(
  gateId: string,
  opts: ConductorGateResolveOptions,
): Promise<void> {
  try {
    const picked = [opts.approve, opts.reject, opts.takeOver].filter(Boolean).length;
    if (picked !== 1) throw new Error('--approve, --reject, --take-over 중 하나만 주세요');
    const ctx = open(opts);
    assertConductorSession(ctx, 'gate resolve');
    const gate = ctx.store.snapshot.gates[gateId];
    if (!gate) throw new Error(`모르는 게이트예요: ${gateId}`);
    if (gate.status !== 'open') throw new Error(`이미 종료된 게이트예요: ${gateId}`);
    if (opts.takeOver) {
      if (!gate.orderId) throw new Error(`${gateId}는 주문이 없는 게이트라 넘겨받을 주문이 없어요`);
      const r = await takeOver(ctx.store, gate.orderId, launchersFor(ctx, process.env).launchers, {
        gateId,
        ...(opts.answer ? { answer: opts.answer } : {}),
      });
      return printOwnership(opts, r, `${gateId}를 닫고 ${r.order.id}를 사람이 넘겨받았어요`);
    }
    const closed = resolveGate(
      ctx.store,
      gateId,
      opts.approve ? 'approved' : 'rejected',
      opts.answer,
    );
    const delivered = await deliverGateDecision(ctx.store, closed, launchersFor(ctx, process.env), {
      defer: opts.deferDelivery === true,
    });
    if (opts.json) return print({ gate: ctx.store.snapshot.gates[gateId] ?? closed, ...delivered });
    console.log(`${gateId}를 ${closed.decision === 'approved' ? '승인' : '거절'}했어요`);
    if (delivered.deferred) console.log('결정은 다음 tick이 워커에 전해요');
    for (const a of delivered.hostActions) console.log(`할 일: ${JSON.stringify(a)}`);
    for (const e of delivered.errors) console.log(`오류: ${e}`);
  } catch (e) {
    exitWithError(e);
  }
}

interface OwnershipOutput {
  order: { id: string; status: string };
  closedGates: { id: string }[];
  hostActions: HostAction[];
  errors: string[];
  warnings?: string[];
}

function printOwnership(opts: ConductorCommonOptions, r: OwnershipOutput, headline: string): void {
  if (opts.json) return print(r);
  console.log(headline);
  if (r.closedGates.length > 0)
    console.log(`같이 닫은 게이트: ${r.closedGates.map((g) => g.id).join(', ')}`);
  for (const a of r.hostActions) console.log(`할 일: ${JSON.stringify(a)}`);
  for (const w of r.warnings ?? []) console.log(`경고: ${w}`);
  for (const e of r.errors) console.log(`오류: ${e}`);
}

/** 사람이 주문을 넘겨받는다. 확인 자리가 없어도 쓴다 */
export async function conductorOrderTakeOverCommand(
  id: string,
  opts: ConductorCommonOptions,
): Promise<void> {
  try {
    const ctx = open(opts);
    assertConductorSession(ctx, 'order take-over');
    const r = await takeOver(ctx.store, id, launchersFor(ctx, process.env).launchers);
    printOwnership(opts, r, `${id}를 사람이 넘겨받았어요. tick이 PR 머지를 지켜봐요`);
  } catch (e) {
    exitWithError(e);
  }
}

export interface ConductorOrderCancelOptions extends ConductorCommonOptions {
  reason?: string;
}

export async function conductorOrderCancelCommand(
  id: string,
  opts: ConductorOrderCancelOptions,
): Promise<void> {
  try {
    const ctx = open(opts);
    assertConductorSession(ctx, 'order cancel');
    const reason = opts.reason ? oneLine(opts.reason, 300) : undefined;
    const r = await cancelOrder(ctx.store, id, launchersFor(ctx, process.env).launchers, reason);
    printOwnership(opts, r, `${id}를 취소했어요`);
  } catch (e) {
    exitWithError(e);
  }
}

/** 사람이 머지했다고 알린다. gh로 MERGED를 확인한 뒤에만 merged로 넘긴다 */
export async function conductorOrderMarkMergedCommand(
  id: string,
  opts: ConductorCommonOptions,
): Promise<void> {
  try {
    const ctx = open(opts);
    assertConductorSession(ctx, 'order mark-merged');
    const gh = new GhAccounts(ctx.config.accounts);
    const confirmed = await confirmHumanMerge(
      ctx.store,
      id,
      new GhPrStateSource({ accounts: gh }),
      launchersFor(ctx, process.env).launchers,
    );
    const deferred: HostAction[] = [];
    const after = await afterHumanMerge(ctx.store, id, { jira: hostJiraClient(deferred) });
    const hostActions = [...confirmed.hostActions, ...deferred];
    const errors = [...confirmed.errors, ...after.errors];
    if (opts.json)
      return print({
        order: confirmed.order,
        closedGates: confirmed.closedGates,
        hostActions,
        jira: after.jira,
        errors,
      });
    console.log(`${id}를 merged로 넘겼어요. 다음 tick이 머지 뒤 처리를 이어요`);
    if (confirmed.closedGates.length > 0)
      console.log(`같이 닫은 게이트: ${confirmed.closedGates.map((g) => g.id).join(', ')}`);
    for (const a of hostActions) console.log(`할 일: ${JSON.stringify(a)}`);
    for (const e of errors) console.log(`오류: ${e}`);
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
