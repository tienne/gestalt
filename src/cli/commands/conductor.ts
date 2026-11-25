import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { handleGithubOrder, readGithubOrder } from '../../conductor/bot-github.js';
import { handoffBot, type BotHandoffOptions } from '../../conductor/bot-handoff.js';
import {
  automationCoordinationDir,
  automationCoordinationRoot,
  handoffCancellationPending,
} from '../../conductor/bot-handoff-coordination.js';
import { readEditReceipt } from '../../conductor/bot-handoff-edit.js';
import {
  decisionId,
  decisionReceipt,
  decisionTarget,
  gateApprovalMessage,
  matchBotGate,
  readBotPolicy,
  loadBotPolicy,
  approverStatus,
  approverGuidance,
  assertApproverReady,
  terminalResolveCommand,
  approverRegistry,
  peekBotPolicy,
  type ApproverGap,
  type ApproverRegistry,
  readMergeEvidence,
  verifyGateApproval,
  type BotGate,
} from '../../conductor/bot-approval.js';
import {
  officialOrcaApprovalIssuer,
  ORCA_APPROVAL_UNAVAILABLE,
  orcaApprovalTargetHash,
  verifyOrcaApproval,
  type OrcaApprovalIssuer,
} from '../../conductor/orca-approval-attestation.js';
import {
  itemBinding,
  OrcaContractError,
  readItemDecision,
  readOrcaItem,
} from '../../conductor/orca-item-approval.js';
import {
  assertBotOwner,
  changeBotOwner,
  currentBotOwner,
  targetBotOwner,
  readBotOwnership,
  type BotHandoffRecord,
  type BotOwner,
} from '../../conductor/bot-owner.js';
import { loadConfig, WAIT_MAX_SEC_LIMIT } from '../../core/config.js';
import { getVersion } from '../../core/version.js';
import { writeJsonAtomic } from '../../core/json-file.js';
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
import { approveDeployment, readDeploymentEvidence } from '../../conductor/deployment-evidence.js';
import {
  acquireLock,
  afterHumanMerge,
  rateLimitEntries,
  deliverGateDecision,
  decisionMessage,
  recordGateDelivery,
  recheckSignedDecision,
  inboxDirOf,
  tick,
  staleTickWarning,
  writeReport,
  type EngineDeps,
  type RateLimitedEntry,
} from '../../conductor/engine.js';
import { orderActivity } from '../../conductor/activity.js';
import { existingRepoContext, repoContextPath } from '../../conductor/context.js';
import {
  currentSessionId,
  handoffNotice,
  handoffRecordPath,
  handoffStatus,
  isSessionId,
  resolveHandoffModel,
  launchHandoff,
  readCompactions,
  readHandoffRecord,
  readSessionRegisteredAt,
  recordHandoff,
  registerSession,
  writeHandoffFile,
  type HandoffStatus,
} from '../../conductor/handoff.js';
import {
  findActiveConductor,
  readSupersededRecord,
  supersededRecordPath,
  supersedeOthers,
  touchSessionTick,
} from '../../conductor/session-owner.js';
import { readAutoCompactWindow } from '../../conductor/claude-settings.js';
import { readRecentEvents, type RecentEvent } from '../../conductor/recent-events.js';
import { readConductorMonitor } from '../../conductor/monitor.js';
import { readLastSuccessfulTick } from '../../conductor/successful-tick.js';
import { removeOrderRefCopies } from '../../conductor/ref-copy.js';
import {
  archiveAndCompress,
  DEFAULT_ARCHIVE_DAYS,
  PROMPTS_DIR,
  pruneArchive,
  dailyArchiveFor,
} from '../../conductor/archive.js';
import { resolveGate } from '../../conductor/gates.js';
import { terminalText } from '../../conductor/terminal-text.js';
import {
  intakeOrder,
  isRepoSkill,
  ISSUE_KEY_RE,
  KNOWN_SKILLS,
  oneLine,
} from '../../conductor/intake.js';
import { isAwaitingDeploy, type DeploySignal } from '../../conductor/jira.js';
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
  type LaunchedTab,
  type SessionTab,
} from '../../conductor/tab-title.js';
import {
  clearCloseClaim,
  closeHandedOffTabs,
  handoffCloseLine,
  type HandoffCloseResult,
} from '../../conductor/handoff-close.js';
import type { ConductorConfig } from '../../conductor/scheduler.js';
import { confirmSlackDelivery, draftSlack, pendingSlackDelivery } from '../../conductor/slack.js';
import { isSlackChannelId } from '../../conductor/slack-state.js';
import {
  claimWaitOwner,
  consumeWaitCarry,
  hasWaitCarry,
  mergeWaitCarry,
  readSeen,
  saveWaitCarry,
  shownLines,
  WAIT_REPORT_FILE,
  waitForAttention,
  withWaitOwnerLock,
  writeSeen,
  type WaitLoopDeps,
  type WaitResult,
  type WaitTickOutcome,
} from '../../conductor/wait.js';
import { ConductorStore } from '../../conductor/store.js';
import {
  APPROVAL_PORT,
  assertionSchema,
  verifyWebAuthnAssertion,
  webAuthnApprovers,
  webAuthnChallenge,
  type WebAuthnAssertion,
} from '../../conductor/webauthn-approval.js';
import { InputError } from '../../conductor/input-error.js';
import type { GateOptions } from '../../conductor/approval-server.js';
import { resolveStateDir } from '../../conductor/state-dir.js';
import {
  type DecisionVia,
  INTAKE_KINDS,
  ISSUE_TYPES,
  JIRA_STATUSES,
  ORDER_SCOPES,
  WORKER_KINDS,
  TERMINAL_ORDER_STATUSES,
  type IntakeKind,
  type IssueType,
  type JiraStatus,
  type Gate,
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

export interface Ctx {
  store: ConductorStore;
  config: ConductorConfig;
}

export function open(opts: ConductorCommonOptions): Ctx {
  const config = loadConfig().conductor;
  return { store: ConductorStore.open(resolveStateDir(opts.stateDir, config)), config };
}

function launchersFor(
  ctx: Ctx,
  env: NodeJS.ProcessEnv,
): { launchers: LauncherSet; orcaAvailable: boolean } {
  const promptDir = join(ctx.store.dir, PROMPTS_DIR);
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
export function assertConductorSession(ctx: Ctx, command: string, cwd = process.cwd()): void {
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
  /** 이 배포 주문이 배포할 주문 id. 쉼표로 이어 적어도 받는다 */
  deploys?: string[];
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
        ...(opts.deploys?.length
          ? {
              deploys: opts.deploys
                .flatMap((v) => v.split(','))
                .map((v) => v.trim())
                .filter(Boolean),
            }
          : {}),
      },
      { defaultScope: ctx.config.defaultScope, repoPaths: ctx.config.repoPaths },
      { trusted: true },
    );
    if ('removedAt' in out) {
      if (opts.json) return print({ created: false, removedAt: out.removedAt });
      return console.log(`이 출처의 주문은 ${out.removedAt}에 지웠어요. 다시 받지 않아요`);
    }
    if ('archivedAt' in out) {
      if (opts.json) return print({ created: false, archivedAt: out.archivedAt });
      return console.log(
        `이 출처의 주문은 ${out.archivedAt}에 보관소로 옮겼어요. 다시 받지 않아요`,
      );
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
    const warnings: string[] = [];
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
      // 사본을 못 지워도 주문 삭제는 되돌리지 않는다. 남은 사본은 경고로만 알린다
      for (const id of removed) {
        const warning = removeOrderRefCopies(ctx.store.dir, id);
        if (warning) warnings.push(warning);
      }
    } finally {
      lock.release();
    }
    if (opts.json) print({ removed, skipped, ...(warnings.length > 0 ? { warnings } : {}) });
    else if (removed.length > 0) {
      console.log(`주문 ${removed.length}개를 지웠어요: ${removed.join(', ')}`);
      for (const s of skipped) console.log(`못 지웠어요: ${s.reason}`);
      for (const w of warnings) console.log(`경고: ${w}`);
    }
    // 하나도 못 지우면 이유를 stderr로 한 번만 낸다. 플러그인처럼 실패하면 stderr만 보는 호출자도 받는다
    if (removed.length === 0 && skipped.length > 0)
      exitWithError(new Error(skipped.map((s) => s.reason).join('\n')));
  } catch (e) {
    exitWithError(e);
  }
}

export interface ConductorArchiveOptions extends ConductorCommonOptions {
  olderThan?: string;
  before?: string;
  dryRun?: boolean;
}

/**
 * 끝나고 기간이 지난 주문을 `archive/<YYYY-MM>/<주문 id>/`로 옮긴다. `events.jsonl`을 떼어 base.json에 반영하는
 * 일도 같이 한다. tick과 같은 잠금을 잡고 못 잡으면 1로 끝난다
 */
export async function conductorArchiveCommand(opts: ConductorArchiveOptions): Promise<void> {
  try {
    const ctx = open(opts);
    assertConductorSession(ctx, 'archive');
    if (opts.before !== undefined) throw new Error('--before는 archive prune에서만 받아요');
    // Number('')가 0이라 빈 값이 끝난 주문을 전부 옮기지 않게 숫자만 받는다
    if (opts.olderThan !== undefined && !/^\d+$/.test(opts.olderThan))
      throw new Error(`--older-than은 0 이상의 정수(일)로 주세요: ${opts.olderThan}`);
    const days = opts.olderThan === undefined ? DEFAULT_ARCHIVE_DAYS : Number(opts.olderThan);
    if (!Number.isSafeInteger(days))
      throw new Error(`--older-than은 0 이상의 정수(일)로 주세요: ${opts.olderThan}`);
    // 묶기는 보관을 마쳐 잠금을 놓은 뒤 다시 잡는다. 그사이 tick이 잡았으면 다음 보관 때 묶는다
    const result = await archiveAndCompress(ctx.store.dir, {
      days,
      dryRun: opts.dryRun === true,
      now: () => new Date(),
    });
    if (result.status === 'locked') throw lockedError(result.holder);
    if (opts.json) return print(result);
    const months = result.status === 'archived' ? result.compressed : [];
    const warnings = result.status === 'archived' ? result.warnings : [];
    const verb = result.status === 'dry-run' ? '옮길' : '옮긴';
    console.log(
      `${verb} 주문 ${result.orders.length}개, 지운 주문의 이벤트 ${result.removed.length}개, 버린 컨덕터 게이트 ${result.gates.length}개 (${days}일 기준)`,
    );
    for (const o of result.orders)
      console.log(`  ${o.id}  ${o.status}  archive/${o.month}/${o.id}`);
    for (const r of result.removed) console.log(`  ${r.id}  removed  archive/${r.month}/${r.id}`);
    for (const b of result.blocked) console.log(`못 옮겨요: ${b.reason}`);
    if (result.status === 'archived') {
      const { prompts, activity, handoffs } = result.swept;
      if (prompts + activity + handoffs > 0)
        console.log(
          `지운 운영 파일: prompts ${prompts}개, activity ${activity}개, handoffs ${handoffs}개`,
        );
    }
    for (const m of months) console.log(`묶었어요: archive/${m}.tar.gz`);
    for (const w of warnings) console.log(`경고: ${w}`);
  } catch (e) {
    exitWithError(e);
  }
}

function lockedError(holder: number | undefined): Error {
  return new Error(
    `다른 프로세스(${holder ?? '알 수 없음'})가 저장소를 쓰는 중이에요. 잠시 뒤 다시 불러 주세요`,
  );
}

/** `archive [action]`을 나눈다. 모르는 동작도 다른 오류처럼 exitWithError로 끝낸다 */
export async function conductorArchiveAction(
  action: string | undefined,
  opts: ConductorArchiveOptions,
): Promise<void> {
  if (action === undefined) return conductorArchiveCommand(opts);
  if (action === 'prune') return conductorArchivePruneCommand(opts);
  exitWithError(new Error(`모르는 동작이에요: ${action}. prune만 받아요`));
}

/** `before`보다 앞선 달의 보관소를 지운다. 자동으로는 안 돌고 사람이 부른다 */
export function conductorArchivePruneCommand(opts: ConductorArchiveOptions): void {
  run(() => {
    const ctx = open(opts);
    assertConductorSession(ctx, 'archive prune');
    if (opts.before === undefined) throw new Error('archive prune은 --before <YYYY-MM>이 필요해요');
    if (opts.olderThan !== undefined) throw new Error('--older-than은 archive prune에서 안 받아요');
    const before = opts.before;
    const result = pruneArchive(ctx.store.dir, before, { dryRun: opts.dryRun === true });
    if (result.status === 'locked') throw lockedError(result.holder);
    if (opts.json) return print(result);
    const verb = result.status === 'dry-run' ? '지울' : '지운';
    console.log(`${verb} 달 ${result.months.length}개 (${before}보다 앞선 달)`);
    for (const p of result.paths) console.log(`  ${p}`);
  });
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
    if (opts.json)
      return print({ order, workers, reports, refs, gates, bypasses, stateDir: store.dir });
    console.log(`${order.id}  ${terminalText(order.title)}`);
    console.log(`레포: ${order.repo}  범위: ${order.scope}  상태: ${order.status}`);
    console.log(`설명: ${order.description ? terminalText(order.description) : '없음'}`);
    console.log(`체인: ${order.skillChain.join(' → ')}`);
    console.log(`PR: ${order.prRef ? terminalText(order.prRef) : '없음'}`);
    if (order.deploys?.length) {
      const recorded = order.deploysRecordedAt
        ? ` (${order.deploysRecordedAt}에 배포 성공 기록)`
        : '';
      console.log(`배포 대상: ${order.deploys.join(', ')}${recorded}`);
    }
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
      for (const c of r.refCopies ?? [])
        console.log(
          `    사본: ${terminalText(c.ref)} → ${c.path ? `${c.path}${c.truncated ? ' (앞부분만)' : ''}` : `건너뜀(${c.skipped})`}`,
        );
    }
    console.log(`refs: ${refs.map(terminalText).join(', ') || '없음'}`);
    console.log('gate:');
    for (const g of gates) {
      console.log(
        `  ${g.id}  ${g.type}  ${g.status}  ${g.decision ?? '-'}  ${terminalText(g.reason)}${g.answer ? `  답: ${terminalText(g.answer)}` : ''}`,
      );
      if (g.receipt) {
        for (const line of botDecisionStatus(g).itemReport?.split('\n') ?? [])
          console.log(`    ${terminalText(line)}`);
      }
    }
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

export interface ConductorExecPathOutput {
  node: string;
  args: string[];
  env: Record<string, string>;
  version: string;
}

/**
 * 지금 도는 CLI를 런처 없이 다시 부를 명령을 알려 준다. 오르카 플러그인이 한 번 받아 두고
 * 이후 호출은 `node <args> ...`로 바로 부른다. 셸 런처와 npm exec를 매번 타면 호출마다 2~3초가 더 든다.
 * 런처가 다른 버전으로 넘겼어도 이 명령은 넘겨받은 마지막 프로세스에서 돌아서 그 경로가 나온다
 */
export function execPathOf(
  proc: Pick<NodeJS.Process, 'execPath' | 'execArgv' | 'argv' | 'env'> = process,
): ConductorExecPathOutput {
  const entry = proc.argv[1];
  if (!entry) throw new Error('실행 중인 CLI 경로를 못 찾았어요');
  // 개발 체크아웃은 tsx 로더로 돈다. 로더가 대상 프로젝트 tsconfig를 안 읽게 런처가 건 값을 그대로 넘긴다
  const tsconfig = proc.env['TSX_TSCONFIG_PATH'];
  return {
    node: proc.execPath,
    args: [...proc.execArgv, realpathSync(entry)],
    env: tsconfig ? { TSX_TSCONFIG_PATH: tsconfig } : {},
    version: getVersion(),
  };
}

export function conductorExecPathCommand(opts: { json?: boolean }): void {
  run(() => {
    const out = execPathOf();
    if (opts.json) return print(out);
    console.log([out.node, ...out.args].join(' '));
  });
}

export interface ConductorStatusOptions extends ConductorCommonOptions {
  /** 끝난 주문도 보여준다. bypass로 넘긴 일을 사후 보고할 때 쓴다 */
  all?: boolean;
  /** JSON 주문마다 작업 내용(지금 tool, 고친 파일, todo, 서브에이전트)을 싣는다. 기본 출력은 그대로 둔다 */
  withActivity?: boolean;
}

export async function conductorMonitorCommand(
  opts: Pick<ConductorCommonOptions, 'stateDir'>,
): Promise<void> {
  try {
    const dir = resolveStateDir(opts.stateDir, loadConfig().conductor);
    const owner = readBotOwnership(dir).active;
    const orca = await readConductorMonitor(owner);
    print({ owner: owner ?? null, orca });
  } catch (e) {
    exitWithError(e);
  }
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
        lastSuccessfulTickAt: readLastSuccessfulTick(store.dir),
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
            ...(o.deploys?.length ? { deploys: o.deploys } : {}),
            ...(o.deployResult ? { deployResult: o.deployResult } : {}),
            ...(o.deploysRecordedAt ? { deploysRecordedAt: o.deploysRecordedAt } : {}),
            // 상태는 merged 그대로라 바깥 화면이 끝난 주문과 배포 대기를 이 값으로 가른다
            awaitingDeploy: isAwaitingDeploy(o),
            ...(o.humanOwnedAt ? { humanOwnedAt: o.humanOwnedAt } : {}),
            ...(limited.has(o.id) ? { rateLimit: limited.get(o.id) } : {}),
            // 오르카 터미널 화면이 워커가 어느 스킬의 어느 단계에 있는지 그릴 때 쓴다
            skillChain: o.skillChain,
            ...checkpointOf(store, o.id),
            ...(w?.waiting ? { waiting: w.waiting } : {}),
            ...(w?.account ? { account: w.account } : {}),
            ...(w?.rateLimitedAt ? { rateLimitedAt: w.rateLimitedAt } : {}),
            ...(w?.rateLimitResetsAt ? { rateLimitResetsAt: w.rateLimitResetsAt } : {}),
            ...(opts.all && TERMINAL_ORDER_STATUSES.has(o.status)
              ? { lastSummary: store.snapshot.reports[o.id]?.at(-1)?.summary ?? null }
              : {}),
            bypasses: bypassesOf.get(o.id) ?? [],
            ...(opts.withActivity ? orderActivity(store.dir, o, w, { readOnly: true }) : {}),
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
        conductor: conductorSummary({ store, config }),
        approvers: statusApprovers(store, config, orders),
        ...recentEventsField(store),
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
    const approvers = statusApprovers(store, config, orders);
    if (approvers.policy !== 'present')
      console.log(
        `승인자: 봇 정책 파일이 ${approvers.policy === 'missing' ? '없어요' : '깨져서 못 읽어요'}. 봇 채팅에서는 게이트를 못 닫아요`,
      );
    else
      for (const a of approvers.repos)
        console.log(
          `승인자 ${a.repo}  머지 ${a.merge ? `${a.merge}명` : '미등록'}  게이트 ${a.gate ? `${a.gate}명` : '미등록'}`,
        );
    for (const g of gates) console.log(`게이트 ${g.id}  ${g.type}  ${g.reason}`);
  });
}

/** 주문의 마지막 체크포인트. 재개에만 쓰는 refs와 shipDir는 싣지 않는다 */
function checkpointOf(store: ConductorStore, orderId: string): { checkpoint?: object } {
  const c = store.snapshot.checkpoints[orderId];
  if (!c) return {};
  return {
    checkpoint: {
      skill: c.skill,
      ...(c.phase ? { phase: c.phase } : {}),
      ...(c.round !== undefined && c.round !== null ? { round: c.round } : {}),
      next: c.next,
      completedSkills: c.completedSkills,
      savedAt: c.savedAt,
    },
  };
}

/** 지금 보이는 주문과 경로를 등록한 레포, 정책에 적힌 레포의 승인자 등록 상태 */
function statusApprovers(
  store: Ctx['store'],
  config: Ctx['config'],
  orders: readonly { repo: string }[],
): ApproverRegistry {
  return approverRegistry(store.dir, [
    ...orders.map((o) => o.repo),
    ...Object.keys(config.repoPaths ?? {}),
  ]);
}

/**
 * 컨덕터 자체의 값. 저장소와 설정에서 이미 아는 것만 싣는다.
 * 컴팩트 횟수와 세션 id, 작업 디렉토리는 살아 있는 컨덕터 세션을 찾았을 때만 싣는다.
 * 오르카 플러그인이 세션 id와 디렉토리로 컨덕터 탭을 찾아간다
 */
function conductorSummary(ctx: Ctx): Record<string, unknown> {
  const { store, config } = ctx;
  const disconnected = store
    .workers()
    .filter(
      (w) =>
        w.status === 'stopped' &&
        w.stopReason === 'disconnected' &&
        store.order(w.orderId)?.workerId === w.id &&
        !TERMINAL_ORDER_STATUSES.has(store.order(w.orderId)!.status),
    ).length;
  const { active: botOwner, revision: botOwnerRevision, handoffs } = readBotOwnership(store.dir);
  const latestHandoff = handoffs.at(-1);
  const cancelCleanupPending =
    latestHandoff &&
    handoffCancellationPending(store.dir, latestHandoff, automationCoordinationRoot());
  const session = botOwner
    ? undefined
    : findActiveConductor(store.dir, '', Date.now(), activeConductorWindowMs(config));
  return {
    pollIntervalSec: config.pollIntervalSec,
    maxWorkers: config.maxConcurrentWorkers,
    activeWorkers: store.activeWorkers().length,
    queuedOrders: store.queuedOrders().length,
    prWatchRepos: config.prWatchRepos,
    disconnectedWorkers: disconnected,
    ...(botOwner ? { botOwner, botOwnerRevision } : {}),
    ...(latestHandoff
      ? {
          botHandoff: {
            requestId: latestHandoff.id,
            automationId: latestHandoff.automationId,
            fromChatId: latestHandoff.from,
            toChatId: latestHandoff.to,
            status: cancelCleanupPending ? 'partial' : (latestHandoff.outcome ?? 'partial'),
            ...(!cancelCleanupPending && latestHandoff.outcome === 'cancelled'
              ? { cancelScope: 'gestalt' }
              : {}),
            ...botHandoffEditStatus(latestHandoff),
            ...(cancelCleanupPending ? { retryStage: 'reconcile-edit' } : {}),
            responsibleChatId: botOwner?.chatId,
            verifiedNextRunAt: latestHandoff.nextRunAt,
          },
        }
      : {}),
    ...(session
      ? {
          compactions: readCompactions(store.dir, session.sessionId).count,
          session: { id: session.sessionId, ...(session.cwd ? { cwd: session.cwd } : {}) },
        }
      : {}),
  };
}

function botHandoffEditStatus(handoff: BotHandoffRecord): Record<string, unknown> {
  const editAttemptId = handoff.editAttempt;
  if (!editAttemptId)
    return !handoff.outcome && handoff.editUncertain !== undefined
      ? { retryStage: 'reconcile-edit' }
      : {};
  let receipt: ReturnType<typeof readEditReceipt>;
  let editReceipt: 'prepared' | 'dispatched' | 'applied' | 'rejected' | 'unreadable';
  try {
    const dir = automationCoordinationDir(automationCoordinationRoot(), handoff.automationId);
    receipt = readEditReceipt(dir, handoff.approval, editAttemptId);
    editReceipt = receipt?.outcome ?? 'prepared';
  } catch {
    editReceipt = 'unreadable';
  }
  return {
    editAttemptId,
    editReceipt,
    ...(receipt?.dispatchedAt ? { editDispatchedAt: receipt.dispatchedAt } : {}),
    ...(!handoff.outcome && (editReceipt === 'dispatched' || editReceipt === 'unreadable')
      ? { retryStage: 'reconcile-edit' }
      : {}),
  };
}

function rateLimitLine(e: RateLimitedEntry): string {
  const via = e.source === 'text' ? ', 출력 문구로 판단' : '';
  return `한도 대기: ${e.workerId} ${e.since}부터${e.resetsAt ? `, 풀리는 시각 ${e.resetsAt}` : ''}${via}`;
}

export interface ConductorTickOptions extends ConductorCommonOptions {
  force?: boolean;
  takeOver?: boolean;
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
  // handoff.json에 기록되면 다시 안 실리는 결과라 tick 본문이 예외로 끝나도 stderr로 남긴다
  let handoffClose: HandoffCloseResult[] = [];
  try {
    const ctx = open(opts);
    assertConductorSession(ctx, 'tick');
    const caller = await tickBotCaller(ctx);
    const sessionId = await enterTickSession(ctx, opts.takeOver === true, caller);
    const outcome = await runConductorTick(ctx, opts, sessionId, caller, (r) => (handoffClose = r));
    if (opts.json) return print(tickJson(outcome));
    printTickLines(outcome);
  } catch (e) {
    for (const r of handoffClose) console.error(handoffCloseLine(r));
    exitWithError(e);
  }
}

export async function tickBotCaller(ctx: Ctx): Promise<BotOwner | undefined> {
  try {
    return await currentBotOwner();
  } catch (error) {
    if (readBotOwnership(ctx.store.dir).active || process.env['ORCA_STRUCTURED_SESSION'])
      throw error;
    return undefined;
  }
}

/**
 * 인계했거나 넘겨받힌 세션이면 거절하고 처음 보는 세션이면 등록해 탭 이름을 붙인다. 세션 id를 돌려준다.
 * 다른 탭에서 주문만 넣으려다 컨덕터가 둘이 되지 않도록, 처음 등록하는 세션은 최근에 tick을 돌린
 * 다른 컨덕터 세션이 있으면 거절한다. takeOver면 그 세션을 넘겨받는다.
 */
async function enterTickSession(
  ctx: Ctx,
  takeOver: boolean,
  caller?: BotOwner,
): Promise<string | undefined> {
  assertBotOwner(ctx.store.dir, caller);
  if (caller) return undefined;
  const sessionId = currentSessionId();
  if (!sessionId) return undefined;
  const dir = ctx.store.dir;
  const isNew = withWaitOwnerLock(dir, () => {
    if (takeOver) rmSync(supersededRecordPath(dir, sessionId), { force: true });
    // 등록과 탭 이름 붙이기 전에 거절한다. 인계한 세션이 자기를 새 세션으로 다시 올리면 안 된다
    assertStillConductor(ctx, sessionId);
    const now = new Date();
    const registered = readSessionRegisteredAt(dir, sessionId) !== undefined;
    if (!registered && !takeOver) {
      const active = findActiveConductor(
        dir,
        sessionId,
        now.getTime(),
        activeConductorWindowMs(ctx.config),
      );
      if (active) {
        throw new Error(
          `다른 컨덕터 세션이 돌고 있어요(세션 ${active.sessionId}${active.cwd ? `, ${active.cwd}` : ''}, 마지막 tick ${active.lastTickAt}). 이 세션은 컨덕터로 등록하지 않았어요. 주문만 넣으려면 order add를 쓰면 그 세션이 다음 tick에 받아요. 그 세션이 닫힌 게 맞으면 tick --take-over로 넘겨받아요`,
        );
      }
    }
    const isNew = registerSession(dir, sessionId, process.cwd(), now);
    if (isNew || takeOver) {
      for (const id of supersedeOthers(dir, sessionId, now))
        console.error(`컨덕터 세션 ${id}를 넘겨받았어요. 그 세션의 tick은 이제 거절돼요`);
    }
    return isNew;
  });
  if (isNew) await nameTabOnce();
  return sessionId;
}

/**
 * 다른 세션이 살아 있는 컨덕터인지 보는 기한. 반복이 한가할 때 깨우는 간격이 staleAfterSec 근처까지
 * 늘어나서 그 두 배를 쓴다. 이보다 오래 tick이 없었으면 닫힌 세션으로 보고 새 세션이 넘겨받는다
 */
function activeConductorWindowMs(config: ConductorConfig): number {
  return config.staleAfterSec * 2 * 1000;
}

/** tick 한 번. tick 명령과 wait가 함께 쓴다. onClose는 tick 본문이 던져도 닫기 결과를 남기게 한다 */
async function runConductorTick(
  ctx: Ctx,
  opts: Pick<ConductorTickOptions, 'force' | 'prWatch' | 'queue'>,
  sessionId: string | undefined,
  caller: BotOwner | undefined,
  onClose: (r: HandoffCloseResult[]) => void = () => {},
): Promise<WaitTickOutcome> {
  // wait가 도는 사이 인계했거나 다른 세션이 넘겨받았으면 다음 tick에서 거절해 wait를 끝낸다
  if (sessionId) {
    withWaitOwnerLock(ctx.store.dir, () => {
      assertStillConductor(ctx, sessionId);
      touchSessionTick(ctx.store.dir, sessionId, new Date());
    });
  }
  const handoffClose = sessionId ? await closePreviousTabs(ctx, sessionId) : [];
  onClose(handoffClose);
  const deferred: HostAction[] = [];
  const watch =
    opts.prWatch !== false
      ? prWatchTargets(ctx.config.prWatchRepos, ctx.config.repoPaths)
      : undefined;
  // 토큰과 로그인 계정 캐시를 PR 감시와 계정 맞추기가 tick 하나 동안 함께 쓴다.
  // wait도 tick마다 새로 만든다. 길게 들고 있으면 그사이 gh auth switch로 바뀐 계정을 못 본다
  const gh = new GhAccounts(ctx.config.accounts);
  const prSource =
    watch && Object.keys(watch.repoPaths).length > 0
      ? new GhPrWatchSource({ repoPaths: watch.repoPaths, accounts: gh })
      : undefined;
  const queue = opts.queue !== false ? fileQueue(queueDirOf(ctx)) : undefined;
  const archive = dailyArchiveFor(ctx.config, ctx.store.dir);
  const deps: EngineDeps = {
    config: ctx.config,
    ...launchersFor(ctx, process.env),
    jira: hostJiraClient(deferred),
    slack: hostSlackClient(deferred),
    deploy: fileDeploySource(join(ctx.store.dir, 'deploy')),
    deploymentEvidence: (target) => readDeploymentEvidence(target, gh),
    ...(prSource ? { prSource } : {}),
    prState: new GhPrStateSource({ accounts: gh }),
    readApprovalEvidence: (ref) => readMergeEvidence(ref, gh),
    ...(queue ? { queue } : {}),
    ...(Object.keys(ctx.config.accounts).length > 0
      ? { accounts: new GhAccountSwitcher({ accounts: gh }) }
      : {}),
    ...(archive ? { archive } : {}),
  };
  const report = await tick(ctx.store, deps, {
    force: opts.force === true,
    admit: () => assertBotOwner(ctx.store.dir, caller),
    inputErrors: () => [
      ...(queue?.errors ?? []),
      ...(watch?.errors ?? []),
      ...[...(prSource?.truncatedRepos ?? [])].map(
        (repo) => `${repo}: 열린 PR이 상한에 닿아 뒤쪽 PR은 이번 감시에서 빠졌어요`,
      ),
    ],
  });
  report.hostActions.push(...deferred);
  const handoff = sessionId ? sessionHandoff(ctx, sessionId) : undefined;
  return { report, ...(handoff ? { handoff } : {}), handoffClose };
}

function tickJson(o: WaitTickOutcome): Record<string, unknown> {
  return {
    ...o.report,
    ...(o.handoff ? { handoff: o.handoff } : {}),
    ...(o.carriedHandoffs ? { carriedHandoffs: o.carriedHandoffs } : {}),
    ...(o.handoffClose.length > 0 ? { handoffClose: o.handoffClose } : {}),
  };
}

function printTickLines({ report, handoff, handoffClose }: WaitTickOutcome): void {
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
  for (const d of report.deployTargets)
    console.log(
      d.outcome === 'recorded'
        ? `배포 성공 기록: ${d.orderId} (배포 주문 ${d.deployOrderId})`
        : `배포 기록 건너뜀: ${d.orderId} (${d.reason ?? '-'})`,
    );
  for (const w of report.warnings) console.log(`경고: ${w}`);
  for (const e of report.errors) console.log(`오류: ${e}`);
  if (report.idleTicks > 0) console.log(`변화 없는 tick ${report.idleTicks}번째`);
  for (const r of handoffClose) console.log(handoffCloseLine(r));
  if (handoffLine) console.log(handoffLine);
}

export interface ConductorWaitOptions extends ConductorTickOptions {
  maxWaitSec?: number;
}

/** 출력이 이 글자 수를 넘으면 tick 결과 전체는 파일로 두고 경로만 싣는다 */
const WAIT_INLINE_MAX = 6000;

/**
 * 할 일이 생길 때까지 tick을 감시 간격마다 돌린다. 지휘자 세션이 백그라운드로 띄우고 끝나면 결과만 처리한다.
 * 할 일 없는 tick은 출력하지 않는다. 상한 시간이 지나면 할 일이 없어도 한 줄 남기고 끝난다.
 */
export async function conductorWaitCommand(
  opts: ConductorWaitOptions,
  loop: Partial<Pick<WaitLoopDeps, 'sleep' | 'now'>> = {},
): Promise<void> {
  // tick 명령과 같다. 닫기 결과는 handoff.json에 기록되면 다시 안 실려서 tick이 던져도 stderr로 남긴다
  let handoffClose: HandoffCloseResult[] = [];
  try {
    const ctx = open(opts);
    assertConductorSession(ctx, 'wait');
    const maxWaitSec = opts.maxWaitSec ?? ctx.config.waitMaxSec;
    if (!Number.isInteger(maxWaitSec) || maxWaitSec < 1 || maxWaitSec > WAIT_MAX_SEC_LIMIT)
      throw new Error(`--max-wait-sec는 1~${WAIT_MAX_SEC_LIMIT} 사이의 정수여야 해요`);
    const caller = await tickBotCaller(ctx);
    const sessionId = await enterTickSession(ctx, opts.takeOver === true, caller);
    const owner = claimWaitOwner(ctx.store.dir, sessionId, () => {
      assertBotOwner(ctx.store.dir, caller);
      if (sessionId || caller) return;
      const active = findActiveConductor(
        ctx.store.dir,
        '',
        Date.now(),
        activeConductorWindowMs(ctx.config),
      );
      if (active) {
        throw new Error(
          `다른 컨덕터 세션이 돌고 있어요(세션 ${active.sessionId}, 마지막 tick ${active.lastTickAt}). 세션 id가 없는 wait는 이 저장소의 감시를 넘겨받을 수 없어요`,
        );
      }
    });
    const seen = readSeen(ctx.store.dir);
    const result = await waitForAttention(
      {
        // 간격은 wait가 직접 잰다. 시계 하한에 맡기면 호스트가 방금 돌린 tick 때문에 첫 주기를 통째로 건너뛴다
        runTick: async () => {
          handoffClose = [];
          return runConductorTick(
            ctx,
            { ...opts, force: true },
            sessionId,
            caller,
            (r) => (handoffClose = r),
          );
        },
        sleep: loop.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
        now: loop.now ?? (() => Date.now()),
        stillOwner: owner.stillOwner,
        hasCarry: () => hasWaitCarry(ctx.store.dir),
        seen,
        openGatesBefore: ctx.store.openGates().length,
      },
      { maxWaitMs: maxWaitSec * 1000, intervalMs: ctx.config.pollIntervalSec * 1000 },
    );
    withWaitOwnerLock(ctx.store.dir, () => {
      if (result.reason === 'superseded' || !owner.stillOwner()) {
        if (result.last) saveWaitCarry(ctx.store.dir, result.last, result.reasons, seen);
        printWaitResult(ctx, opts, { ...result, reason: 'superseded', reasons: [] });
        return;
      }
      consumeWaitCarry(ctx.store.dir, (carried) => {
        const merged = mergeWaitCarry(result, carried, sessionId);
        const shown = merged.reason === 'attention' && merged.last ? shownLines(merged.last) : [];
        if (merged.observed || shown.length > 0) {
          writeSeen(ctx.store.dir, seen, merged.observed, shown);
        }
        printWaitResult(ctx, opts, merged, carried.length > 0);
      });
    });
  } catch (e) {
    for (const r of handoffClose) console.error(handoffCloseLine(r));
    exitWithError(e);
  }
}

function printWaitResult(
  ctx: Ctx,
  opts: ConductorWaitOptions,
  result: WaitResult,
  carried = false,
): void {
  const minutes = Math.round(result.elapsedMs / 60_000);
  const latestFile = join(ctx.store.dir, WAIT_REPORT_FILE);
  // superseded로 끝난 앞선 wait가 이어받은 wait의 보고서를 덮지 않게 한다.
  const full = result.reason === 'attention' && result.last ? tickJson(result.last) : undefined;
  const inline = full !== undefined && JSON.stringify(full).length <= WAIT_INLINE_MAX;
  // 다음 wait가 공용 사본을 갱신해도 알림에 실린 넘김 결과는 그대로 읽을 수 있어야 한다.
  const separateFile = full && carried && !inline;
  const reportFile = separateFile
    ? join(ctx.store.dir, 'wait-reports', `${randomUUID()}.json`)
    : latestFile;
  if (full) {
    if (separateFile) writeJsonAtomic(reportFile, full, { mode: 0o600 });
    writeJsonAtomic(latestFile, full, { mode: 0o600 });
  }
  if (opts.json)
    return print({
      reason: result.reason,
      reasons: result.reasons,
      ticks: result.ticks,
      elapsedSec: Math.round(result.elapsedMs / 1000),
      ...(full ? { reportFile } : {}),
      ...(inline ? { tick: full } : {}),
    });
  if (result.reason === 'superseded') {
    console.log('다른 wait가 이어받아 이 wait는 끝났어요. 다시 띄우지 않아요');
    return;
  }
  if (result.reason === 'timeout') {
    console.log(`할 일 없이 ${minutes}분 지나 끝났어요(tick ${result.ticks}번). 다시 띄워 주세요`);
    return;
  }
  console.log(
    `할 일이 생겨 끝났어요: ${result.reasons.join(', ')} (tick ${result.ticks}번, ${minutes}분)`,
  );
  if (!inline) {
    console.log(`결과가 길어 파일로 뒀어요: ${reportFile}`);
    return;
  }
  printTickLines(result.last!);
}

const HUMAN_OWNED_TO: Record<HumanOwnedChange['to'], string> = {
  merged: '사람이 머지했어요. 머지 뒤 처리를 이어요',
  cancelled: 'PR이 머지 없이 닫혀 취소했어요',
  parked: '오래 안 움직여 parked로 내렸어요',
};

function humanOwnedLine(h: HumanOwnedChange): string {
  return `${h.orderId}${h.prRef ? ` (${h.prRef})` : ''}: ${HUMAN_OWNED_TO[h.to]}`;
}

// 닫기 실패는 tick을 멈추지 않는다. 예외만 stderr로 남기고 나머지 결과는 handoffClose로 알린다
async function closePreviousTabs(ctx: Ctx, sessionId: string): Promise<HandoffCloseResult[]> {
  try {
    const orca = detectOrca(process.env);
    const currentTab = currentSessionTab(process.env);
    return await closeHandedOffTabs({
      stateDir: ctx.store.dir,
      sessionId,
      ...(currentTab ? { currentTab } : {}),
      closeAfterSec: ctx.config.handoffCloseAfterSec,
      now: new Date(),
      cwd: process.cwd(),
      ...(orca ? { orcaCommand: orca } : {}),
    });
  } catch (e) {
    console.error(`경고: 이전 지휘자 탭을 닫지 못했어요: ${(e as Error).message}`);
    return [];
  }
}

function sessionHandoff(ctx: Ctx, sessionId: string): HandoffStatus {
  return handoffStatus(ctx.store.dir, sessionId, {
    thresholdPercent: ctx.config.handoffContextPercent,
    ...(ctx.config.contextWindowTokens !== undefined
      ? { contextWindowTokens: ctx.config.contextWindowTokens }
      : { autoCompactWindowTokens: () => readAutoCompactWindow({ cwd: process.cwd() }) }),
  });
}

/** 인계했거나 다른 세션이 넘겨받은 세션의 반복이 안 멈췄으면 tick을 거절해 컨덕터가 둘이 되지 않게 한다 */
function assertStillConductor(ctx: Ctx, sessionId: string): void {
  const superseded = readSupersededRecord(ctx.store.dir, sessionId);
  if (superseded) {
    throw new Error(
      `이 세션은 ${superseded.at}에 다른 컨덕터 세션(${superseded.by})이 넘겨받았어요. 반복을 멈춰 주세요. 이 세션에서 다시 돌리려면 tick --take-over를 써요`,
    );
  }
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
    assertStillConductor(ctx, sessionId);
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
    clearCloseClaim(ctx.store.dir, sessionId);
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
        ...(outcome.launched && orca && previousTab && !sameTab(previousTab, outcome.tab)
          ? { previousTab }
          : {}),
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
  needStep?: string;
  waitFor?: string;
  waitUntil?: string;
  spawnTitle?: string;
  spawnDetail?: string;
  deployRef?: string;
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
      ...(opts.need
        ? {
            need: {
              kind: opts.need,
              detail: opts.needDetail ?? '',
              ...(opts.needStep ? { step: opts.needStep } : {}),
            },
          }
        : {}),
      ...(opts.waitFor
        ? {
            wait: {
              reason: opts.waitFor,
              ...(opts.waitUntil ? { until: opts.waitUntil } : {}),
            },
          }
        : {}),
      ...(opts.spawnTitle
        ? { spawnRequest: { title: opts.spawnTitle, detail: opts.spawnDetail ?? '' } }
        : {}),
      ...(opts.deployRef ? { deployRef: opts.deployRef } : {}),
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
  completedDeploy?: string;
}

export async function conductorWorkerDecisionCommand(
  opts: ConductorCommonOptions & { worker: string; delivery: string; report?: string },
): Promise<void> {
  try {
    assertOwnWorkerId(opts.worker);
    const ctx = open(opts);
    const lock = await waitForDecisionLock(ctx);
    try {
      ctx.store.reload();
      const gate = Object.values(ctx.store.snapshot.gates).find(
        (g) => g.receipt?.deliveryId === opts.delivery,
      );
      const order = gate?.orderId ? ctx.store.order(gate.orderId) : undefined;
      const worker = ctx.store.worker(opts.worker);
      if (
        !gate ||
        (gate.receipt?.workerId ?? order?.workerId) !== opts.worker ||
        !worker ||
        worker.kind === 'orca-worktree' ||
        worker.orderId !== gate.orderId
      )
        throw new Error('이 워커가 받을 수 있는 전달 ID가 아니에요');
      const received = (alreadyReceived: boolean, report?: Gate['workerReport']) => ({
        deliveryId: opts.delivery,
        alreadyReceived,
        processing: report ? 'reported' : 'pending',
        ...(report ? { workerReport: report } : {}),
      });
      if (gate.workerReport) return print(received(true, gate.workerReport));

      if (opts.report !== undefined) {
        const ref = opts.report.trim();
        if (!gate.hostOfferedAt || !ref || ref.length > 500)
          throw new Error('결정을 조회한 뒤 처리 결과를 확인할 참조를 500자 이내로 주세요');
        const at = ctx.store.timestamp();
        const workerReport = { at, workerId: worker.id, ref };
        ctx.store.append({
          type: 'gate-delivery',
          at,
          gateId: gate.id,
          pending: false,
          outcome: gate.deliveryOutcome === 'superseded' ? 'superseded' : 'delivered',
          ...(gate.deliveryDetail && gate.deliveryOutcome === 'superseded'
            ? { detail: gate.deliveryDetail }
            : {}),
          workerReport,
        });
        return print(received(true, workerReport));
      }

      if (
        order?.workerId !== opts.worker ||
        (order.status !== 'running' &&
          order.status !== 'waiting-gate' &&
          order.status !== 'escalated') ||
        (worker.status !== 'running' && worker.status !== 'starting') ||
        (!gate.deliveryPending && gate.deliveryOutcome !== 'delivered')
      )
        throw new Error('이 결정은 지금 받을 수 없어요. 컨덕터에서 전달 상태를 확인해 주세요');
      const gh = new GhAccounts(ctx.config.accounts);
      const changed = await recheckSignedDecision(ctx.store, gate, {
        ...launchersFor(ctx, process.env),
        readApprovalEvidence: (ref) => readMergeEvidence(ref, gh),
      });
      if (changed) throw new Error(changed.detail);
      if (!gate.hostOfferedAt) {
        const at = ctx.store.timestamp();
        ctx.store.append({
          type: 'gate-delivery',
          at,
          gateId: gate.id,
          pending: true,
          outcome: 'host-action',
          hostOfferedAt: at,
        });
      }
      return print({
        ...received(Boolean(gate.hostOfferedAt) || gate.deliveryOutcome === 'delivered'),
        decision: gate.decision,
        message: decisionMessage(gate),
        nextAction:
          '같은 전달 ID의 기존 처리 결과를 먼저 대조하세요. 처리 후 --report로 결과 참조를 남겨 주세요.',
      });
    } finally {
      lock.release();
    }
  } catch (error) {
    exitWithError(error);
  }
}

export async function conductorGateResolveCommand(
  gateId: string,
  opts: ConductorGateResolveOptions,
): Promise<void> {
  try {
    const picked = [opts.approve, opts.reject, opts.takeOver].filter(Boolean).length;
    if (picked !== 1) throw new Error('--approve, --reject, --take-over 중 하나만 주세요');
    if (opts.completedDeploy !== undefined && (!opts.approve || opts.deferDelivery))
      throw new Error('--completed-deploy는 이미 끝난 배포 주문의 --approve에만 쓸 수 있어요');
    const ctx = open(opts);
    assertConductorSession(ctx, 'gate resolve');
    if (await tickBotCaller(ctx))
      throw new Error('봇 채팅에서는 서명한 결정만 bot decide로 접수해요');
    const lock = acquireLock(ctx.store.dir);
    if (!lock.ok)
      throw new Error('컨덕터가 상태를 갱신 중이에요. 잠시 뒤 게이트를 다시 확인해 주세요');
    try {
      ctx.store.reload();
      const gate = ctx.store.snapshot.gates[gateId];
      if (!gate) throw new Error(`모르는 게이트예요: ${gateId}`);
      if (gate.status !== 'open') throw new Error(`이미 종료된 게이트예요: ${gateId}`);
      if (opts.completedDeploy !== undefined) {
        const order = gate.orderId ? ctx.store.order(gate.orderId) : undefined;
        if (order?.scope !== 'approval' || order.status !== 'done')
          throw new Error('끝난 승인 주문의 배포 게이트만 완료 대조를 예약할 수 있어요');
        const approvedDeployment = approveDeployment(gate, order.repo, opts.completedDeploy);
        const closed = resolveGate(ctx.store, gateId, 'approved', opts.answer, {
          approvedDeployment,
        });
        if (opts.json) return print({ gate: closed });
        console.log(`${gateId} 배포 범위를 승인했어요. 다음 tick에서 성공 증빙을 대조해요`);
        return;
      }
      if (opts.takeOver) {
        if (!gate.orderId)
          throw new Error(`${gateId}는 주문이 없는 게이트라 넘겨받을 주문이 없어요`);
        const r = await takeOver(
          ctx.store,
          gate.orderId,
          launchersFor(ctx, process.env).launchers,
          {
            gateId,
            ...(opts.answer ? { answer: opts.answer } : {}),
          },
        );
        return printOwnership(opts, r, `${gateId}를 닫고 ${r.order.id}를 사람이 넘겨받았어요`);
      }
      const { closed, delivered } = await closeAndDeliver(
        ctx,
        gateId,
        opts.approve ? 'approved' : 'rejected',
        {
          ...(opts.answer !== undefined ? { answer: opts.answer } : {}),
          defer: opts.deferDelivery === true,
        },
      );
      if (opts.json)
        return print({ gate: ctx.store.snapshot.gates[gateId] ?? closed, ...delivered });
      console.log(`${gateId}를 ${closed.decision === 'approved' ? '승인' : '거절'}했어요`);
      if (delivered.deferred) console.log('결정은 다음 tick이 워커에 전해요');
      for (const a of delivered.hostActions) console.log(`할 일: ${JSON.stringify(a)}`);
      for (const e of delivered.errors) console.log(`오류: ${e}`);
    } finally {
      lock.release();
    }
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
    const lock = acquireDecisionLock(ctx);
    try {
      ctx.store.reload();
      const r = await takeOver(ctx.store, id, launchersFor(ctx, process.env).launchers);
      printOwnership(opts, r, `${id}를 사람이 넘겨받았어요. tick이 PR 머지를 지켜봐요`);
    } finally {
      lock.release();
    }
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
    const lock = acquireDecisionLock(ctx);
    try {
      ctx.store.reload();
      const reason = opts.reason ? oneLine(opts.reason, 300) : undefined;
      const r = await cancelOrder(ctx.store, id, launchersFor(ctx, process.env).launchers, reason);
      printOwnership(opts, r, `${id}를 취소했어요`);
    } finally {
      lock.release();
    }
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
    const ctx = open(opts);
    const { store } = ctx;
    if (!isSlackChannelId(opts.channel)) throw new Error('Slack 채널 이름 대신 채널 ID를 주세요');
    const text = readFileSync(opts.textFile, 'utf-8').trim();
    if (!text) throw new Error('초안이 비었어요');
    const lock = acquireDecisionLock(ctx);
    try {
      store.reload();
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
      console.log(
        `승인을 기다려요: ${gate.id}${reused ? ' (같은 초안이 이미 올라가 있어요)' : ''}`,
      );
    } finally {
      lock.release();
    }
  });
}

export async function conductorSlackDeliveryCommand(
  gateId: string,
  opts: ConductorCommonOptions,
): Promise<void> {
  try {
    const ctx = open(opts);
    assertConductorSession(ctx, 'slack delivery');
    assertBotOwner(ctx.store.dir, await tickBotCaller(ctx));
    ctx.store.reload();
    print(pendingSlackDelivery(ctx.store, gateId));
  } catch (error) {
    exitWithError(error);
  }
}

export async function conductorSlackPostedCommand(
  gateId: string,
  opts: ConductorCommonOptions & { resultFile: string },
): Promise<void> {
  try {
    const ctx = open(opts);
    assertConductorSession(ctx, 'slack posted');
    const caller = await tickBotCaller(ctx);
    const resultData: unknown = JSON.parse(readFileSync(opts.resultFile, 'utf8'));
    const lock = acquireDecisionLock(ctx);
    try {
      assertBotOwner(ctx.store.dir, caller);
      const result = confirmSlackDelivery(ctx.store, gateId, resultData);
      ctx.store.flushSnapshot();
      if (opts.json) return print({ gateId, ...result });
      console.log(
        result.recorded ? 'Slack 게시 결과를 남겼어요' : '같은 Slack 게시 결과가 이미 있어요',
      );
    } finally {
      lock.release();
    }
  } catch (error) {
    exitWithError(error);
  }
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

/** 레포 스킬(`repo:<이름>`)은 꼴과 존재를 접수가 대상 레포 경로에서 본다 */
function skillList(v: string, flag: string): string[] {
  const skills = list(v);
  const unknown = skills.filter((s) => !KNOWN_SKILLS.has(s) && !isRepoSkill(s));
  if (unknown.length > 0)
    throw new Error(
      `${flag}에 모르는 스킬이 있어요: ${unknown.join(', ')}. ${[...KNOWN_SKILLS].join(', ')} 중에서 고르거나 대상 레포의 프로젝트 스킬이면 repo:<이름>으로 적어 주세요`,
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

export function print(v: unknown): void {
  console.log(JSON.stringify(v, null, 2));
}

function run(body: () => void): void {
  try {
    body();
  } catch (e) {
    exitWithError(e);
  }
}

export function exitWithError(e: unknown): never {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

/** 새로 띄운 탭이 지금 탭과 같으면 previousTab을 적지 않는다. 그 탭을 닫으면 지휘자가 다 사라진다 */
function sameTab(previous: SessionTab, launched: LaunchedTab | undefined): boolean {
  return (
    previous.kind === 'terminal' &&
    launched?.kind === 'terminal' &&
    launched.handle === previous.handle
  );
}

/** 최근 이벤트는 보조 칸이라 읽다 실패해도 status 전체를 실패로 만들지 않는다 */
function recentEventsField(store: ConductorStore): {
  recentEvents: RecentEvent[];
  recentEventsError?: string;
} {
  try {
    return { recentEvents: readRecentEvents(store.dir, store.snapshot) };
  } catch (e) {
    return { recentEvents: [], recentEventsError: (e as Error).message };
  }
}

export async function conductorBotBindCommand(
  opts: ConductorCommonOptions & { bot: string; chat: string; fromChat?: string },
): Promise<void> {
  try {
    const ctx = open(opts);
    assertConductorSession(ctx, 'bot bind');
    if (await tickBotCaller(ctx)) throw new Error('운영권은 운영자 터미널에서 등록해 주세요');
    const next = await targetBotOwner(opts.bot, opts.chat);
    changeBotOwner(ctx.store.dir, opts.fromChat, next);
    if (opts.json) return print(next);
    console.log(`운영권을 ${next.name}의 채팅 ${next.chatId}에 등록했어요`);
  } catch (error) {
    exitWithError(error);
  }
}

export async function conductorBotReleaseCommand(
  opts: ConductorCommonOptions & { fromChat: string },
): Promise<void> {
  try {
    const ctx = open(opts);
    assertConductorSession(ctx, 'bot release');
    if (await tickBotCaller(ctx)) throw new Error('운영권은 운영자 터미널에서 종료해 주세요');
    changeBotOwner(ctx.store.dir, opts.fromChat);
    if (opts.json) return print({ released: opts.fromChat });
    console.log('봇의 운영권을 종료했어요');
  } catch (error) {
    exitWithError(error);
  }
}

export async function conductorBotHandoffCommand(
  opts: ConductorCommonOptions & BotHandoffOptions,
): Promise<void> {
  try {
    const ctx = open(opts);
    assertConductorSession(ctx, 'bot handoff');
    if (await tickBotCaller(ctx)) throw new Error('인계는 운영자 터미널에서 실행해 주세요');
    const result = await handoffBot(ctx.store.dir, opts);
    if (opts.json) print(result);
    else {
      const labels = {
        ready: '승인 가능',
        blocked: '인계 보류',
        partial: '인계 진행 중',
        completed: '인계 완료',
        cancelled: '로컬 인계 요청 취소',
      };
      console.log(`${labels[result.status]} · 요청 ${result.requestId}`);
      console.log(`인계 채팅 ${result.fromChatId} → ${result.toChatId}`);
      console.log(
        `현재 책임 채팅: ${result.responsibleChatId ?? '등록 없음'} (리비전 ${result.ownerRevision})`,
      );
      const automationLabel = result.replayed ? '종료 당시 자동화' : '자동화';
      console.log(
        `${automationLabel} ${result.automationId}: ${result.automationChatId ?? '현재 대상 미확인'}`,
      );
      if (result.schedule) console.log(`주기: ${result.schedule}`);
      if (result.orcaVerification === 'observed')
        console.log('Orca의 채팅과 일정은 별도로 조회했어요');
      if (result.verifiedNextRunAt !== undefined)
        console.log(
          `조회 당시 다음 정기 실행: ${new Date(result.verifiedNextRunAt).toISOString()}`,
        );
      if (result.approval) console.log(`인계 승인: 같은 명령에 --approve ${result.approval}`);
      if (result.retryStage) console.log(`재개 단계: ${result.retryStage}`);
      if (result.editAttemptId) console.log(`Orca 편집 시도 ID ${result.editAttemptId}`);
      if (result.editDispatchedAt) console.log(`Orca 편집 요청 시각 ${result.editDispatchedAt}`);
      if (result.detail) console.log(result.detail);
    }
    if (result.status === 'blocked' || result.status === 'partial') process.exitCode = 1;
  } catch (error) {
    exitWithError(error);
  }
}

function acquireDecisionLock(ctx: Ctx) {
  const lock = acquireLock(ctx.store.dir);
  if (!lock.ok)
    throw new Error('컨덕터가 상태를 갱신 중이에요. 잠시 뒤 게이트를 다시 확인해 주세요');
  return lock;
}

async function waitForDecisionLock(ctx: Ctx) {
  const deadline = Date.now() + 20_000;
  do {
    const lock = acquireLock(ctx.store.dir);
    if (lock.ok) return lock;
    await delay(100);
  } while (Date.now() < deadline);
  throw new InputError('컨덕터가 상태를 갱신 중이에요. 잠시 뒤 같은 결정을 다시 요청해 주세요');
}

async function closeAndDeliver(
  ctx: Ctx,
  gateId: string,
  decision: 'approved' | 'rejected',
  options: {
    defer: boolean;
    answer?: string;
  },
) {
  const { store } = ctx;
  const closed = resolveGate(store, gateId, decision, options.answer, {
    deliveryPending: options.defer,
  });
  const delivered = await deliverGateDecision(store, closed, launchersFor(ctx, process.env), {
    defer: options.defer,
  });
  if (delivered.outcome) recordGateDelivery(store, gateId, delivered.outcome);
  return { closed, delivered };
}

async function requireBotOperator(ctx: Ctx): Promise<BotOwner> {
  assertConductorSession(ctx, 'bot 게이트');
  const caller = await currentBotOwner();
  if (!caller) throw new Error('Orca 운영 봇 채팅에서 실행해 주세요');
  assertBotOwner(ctx.store.dir, caller);
  return caller;
}

const DELIVERY_LABELS: Record<string, string> = {
  pending: '대기 중(다음 tick이 전해요)',
  delivered: '전달됨',
  failed: '실패',
  'host-action': '호스트 작업으로 넘김',
  'no-worker': '받을 워커 없음',
  unknown: '결과 확인 필요',
  superseded: '새 결정 필요',
};

/** 결정과 워커 전달을 따로 싣는다. 승인했어도 워커가 아직 못 받았을 수 있어서다 */
function botDecisionStatus(gate: Gate) {
  const receipt = gate.receipt;
  const delivery = receipt
    ? (gate.deliveryOutcome ?? 'pending')
    : gate.deliveryPending
      ? 'pending'
      : (gate.deliveryOutcome ?? 'unknown');
  const nextAction = receipt ? approvalNextAction(gate) : undefined;
  const processing = gate.workerReport
    ? 'reported'
    : gate.deliveryOutcome === 'no-worker'
      ? 'no-worker'
      : gate.deliveryOutcome === 'delivered' ||
          gate.deliveryOutcome === 'unknown' ||
          (gate.deliveryOutcome === 'superseded' && gate.hostOfferedAt)
        ? 'unknown'
        : gate.deliveryOutcome === 'superseded'
          ? 'superseded'
          : 'pending';
  const source = gate.decisionSource;
  const decided =
    gate.decision === 'approved' ? '승인' : gate.decision === 'rejected' ? '거절' : gate.decision;
  const approvalLabel = source?.attestation ? 'Orca 증빙' : '서명';
  return {
    gateId: gate.id,
    decision: gate.decision ?? 'open',
    ...(gate.decisionBy ? { signer: gate.decisionBy } : {}),
    ...(source ? { source } : {}),
    delivery,
    ...(receipt
      ? {
          decisionId: receipt.id,
          deliveryId: receipt.deliveryId,
          receivedAt: gate.resolvedAt,
          gateApplication: 'applied',
          appliedAt: gate.resolvedAt,
          target: {
            repo: receipt.repo,
            prRef: receipt.prRef,
            head: receipt.head,
            base: receipt.base,
          },
          deliveryPending: gate.deliveryPending === true,
          processing,
          ...(gate.hostOfferedAt ? { hostOfferedAt: gate.hostOfferedAt } : {}),
          ...(gate.workerReport ? { workerReport: gate.workerReport } : {}),
          nextAction,
        }
      : {}),
    ...(gate.deliveryAttempts
      ? {
          ...(receipt ? { deliveryAttempts: gate.deliveryAttempts } : {}),
          ...(delivery !== 'delivered' ? { failedAttempts: gate.deliveryAttempts } : {}),
        }
      : {}),
    ...(gate.deliveryDetail ? { deliveryDetail: gate.deliveryDetail } : {}),
    ...(gate.decision
      ? {
          itemReport: [
            `판단: ${decided}${gate.decisionBy ? ` (${approvalLabel} ${gate.decisionBy})` : ''}${source ? `, Orca 항목 ${source.item}의 답 ${source.answer}` : ''}`,
            ...(receipt ? [`결정 접수 및 게이트 반영: ${gate.resolvedAt}`] : []),
            `워커 전달: ${DELIVERY_LABELS[delivery] ?? delivery}${gate.deliveryAttempts ? `, 시도 ${gate.deliveryAttempts}번` : ''}`,
            ...(gate.workerReport ? [`워커 처리 보고: ${gate.workerReport.ref}`] : []),
            ...(gate.deliveryDetail ? [gate.deliveryDetail] : []),
            ...(nextAction ? [nextAction] : []),
          ].join('\n'),
        }
      : {}),
  };
}

function approvalNextAction(gate: Gate): string | undefined {
  switch (gate.deliveryOutcome) {
    case 'superseded':
      return '변경된 대상에 대해 새 결정을 접수해 주세요.';
    case 'host-action':
      return gate.hostOfferedAt
        ? '같은 전달 ID로 처리 결과를 대조한 뒤 워커가 결과 참조를 남깁니다.'
        : '호스트가 워커에 전달하고 워커가 전달 ID로 조회합니다.';
    case 'unknown':
      return gate.deliveryPending
        ? '다음 tick이 같은 전달 ID로 Orca의 결과를 확인합니다.'
        : '마지막 전달은 워커의 보고와 대조해 주세요.';
    case 'failed':
      return '다음 tick이 같은 결정으로 다시 시도합니다.';
    case 'delivered':
      return gate.workerReport ? undefined : '워커의 실제 처리 결과는 워커 보고에서 확인해 주세요.';
    case 'no-worker':
      return undefined;
    default:
      return '다음 tick이 전달 대상을 확인합니다.';
  }
}

const GATE_REQUESTS: Partial<Record<Gate['type'], string>> = {
  merge: '머지 승인 또는 거절',
  'file-overlap': '같은 파일을 고치는 주문을 이어서 진행할지',
  'review-manual-switch': '답글만 달린 PR을 다시 리뷰할지',
};

async function botGateEvidence(ctx: Ctx, target: BotGate) {
  return target.ref
    ? readMergeEvidence(target.ref, new GhAccounts(ctx.config.accounts))
    : undefined;
}

/** 서명 문자열에 PR과 HEAD가 들어가는 게이트는 그 값을 못 읽으면 승인 페이지에 원인을 400으로 돌려준다 */
async function touchIdGateEvidence(ctx: Ctx, target: BotGate) {
  const evidence = await botGateEvidence(ctx, target);
  if (!evidence && (target.gate.type === 'merge' || target.gate.type === 'review-manual-switch'))
    throw new InputError('이 게이트는 PR과 HEAD를 읽어야 서명을 확인할 수 있어요');
  return evidence;
}

export async function conductorBotGateCommand(
  gateId: string,
  opts: ConductorCommonOptions,
): Promise<void> {
  try {
    const ctx = open(opts);
    const caller = await requireBotOperator(ctx);
    const resolved = ctx.store.snapshot.gates[gateId];
    if (resolved?.receipt) {
      const { repo, prRef } = resolved.receipt;
      return print({
        ...botDecisionStatus(resolved),
        type: resolved.type,
        repo,
        ...(prRef ? { pr: `https://github.com/${prRef.replace('#', '/pull/')}` } : {}),
        request: GATE_REQUESTS[resolved.type],
        reason: resolved.reason,
        refs: resolved.refs,
      });
    }
    const target = matchBotGate(ctx.store, gateId);
    const { gate } = target;
    const base = {
      ...botDecisionStatus(gate),
      type: gate.type,
      repo: target.repo,
      ...(target.title ? { title: target.title } : {}),
      ...(target.url ? { pr: target.url } : {}),
      request: GATE_REQUESTS[gate.type],
      reason: gate.reason,
      refs: gate.refs,
    };
    if (gate.status === 'resolved') return print(base);
    // 승인자가 없으면 서명을 요구할 이유가 없다. 봇이 터미널 안내로 바로 가게 서명 재료를 싣지 않는다
    const read = peekBotPolicy(ctx.store.dir);
    const policy = 'policy' in read ? read.policy : undefined;
    const gap: ApproverGap | undefined =
      'unreadable' in read ? 'unreadable' : approverStatus(policy, gate.type, target.repo).gap;
    if (gap)
      return print({
        ...base,
        approverReady: false,
        approverGap: gap,
        guidance: approverGuidance(gate, target.repo, gap),
        terminal: {
          approved: terminalResolveCommand(gate.id, 'approved'),
          rejected: terminalResolveCommand(gate.id, 'rejected'),
        },
      });
    const evidence = await botGateEvidence(ctx, target);
    const issuer = await officialOrcaApprovalIssuer(caller);
    const touchId = touchIdLinks(ctx, gate.id, webAuthnApprovers(policy, gate.type, target.repo));
    print({
      ...base,
      approverReady: true,
      ...touchId,
      ...(evidence ? { evidence } : {}),
      messages: {
        approved: gateApprovalMessage(target, evidence?.head, 'approved', evidence?.base),
        rejected: gateApprovalMessage(target, evidence?.head, 'rejected', evidence?.base),
      },
      orcaItem: {
        binding: itemBinding(target, evidence?.head, evidence?.base),
        options: issuer ? ['승인', '거절'] : [],
        buttonApproval: issuer
          ? {
              enabled: true,
              targetHash: orcaApprovalTargetHash(decisionTarget(ctx.store, target), evidence),
            }
          : { enabled: false, diagnostic: ORCA_APPROVAL_UNAVAILABLE },
        answer: '첫 줄에 승인 또는 거절, 둘째 줄에 서명 <승인자-ID> <base64>',
      },
    });
  } catch (error) {
    exitWithError(error);
  }
}

/**
 * 승인자가 Touch ID 키를 등록할 때의 주소로 승인 페이지 링크를 만든다. --port로 등록했으면 그 포트로 띄워야
 * origin이 맞는다. 승인자마다 포트가 다르면 첫 승인자의 주소를 쓴다
 */
function touchIdLinks(
  ctx: Ctx,
  gateId: string,
  approvers: ReturnType<typeof webAuthnApprovers>,
): { touchId?: { links: Record<'approved' | 'rejected', string>; start: string } } {
  const first = approvers[0];
  if (!first) return {};
  const origin = first.credential.origin;
  const port = Number(new URL(origin).port) || APPROVAL_PORT;
  const link = (decision: string) =>
    `${origin}/gate/${encodeURIComponent(gateId)}?decision=${decision}`;
  return {
    touchId: {
      links: { approved: link('approved'), rejected: link('rejected') },
      start: `gestalt conductor approval serve --detach --state-dir ${JSON.stringify(ctx.store.dir)}${port === APPROVAL_PORT ? '' : ` --port ${port}`}`,
    },
  };
}

type WebAuthnDecision = {
  decision: 'approved' | 'rejected';
  webauthn: WebAuthnAssertion;
  /** 승인 서버가 발급한 nonce와 그 서버의 주소. challenge와 origin을 이 값으로 다시 만든다 */
  nonce: string;
  origin: string;
};

type BotDecision =
  | ({ decision: 'approved' | 'rejected' } & (
      | { signer: string; signature: string; source?: Gate['decisionSource'] }
      | { issuer: OrcaApprovalIssuer; proof: unknown; source: NonNullable<Gate['decisionSource']> }
    ))
  | WebAuthnDecision;

/** 운영 봇 결정은 caller가 반드시 있다. caller 없이 오는 건 승인자 본인이 연 Touch ID 페이지뿐이다 */
type DecisionCall =
  | { caller: BotOwner; request: BotDecision }
  | { caller?: undefined; request: WebAuthnDecision };

function verifyBotDecision(
  policy: Record<string, unknown>,
  target: BotGate,
  receiptTarget: string,
  evidence: Awaited<ReturnType<typeof botGateEvidence>>,
  request: BotDecision,
): {
  id: string;
  signer: string;
  source?: Gate['decisionSource'];
  via?: DecisionVia;
  expiresAt?: number;
} {
  if ('webauthn' in request) {
    const { webauthn, decision, nonce, origin } = request;
    const approver = webAuthnApprovers(policy, target.gate.type, target.repo).find(
      (a) => a.credential.credentialId === webauthn.credentialId,
    );
    if (!approver)
      throw new InputError(
        `이 레포의 ${target.gate.type === 'merge' ? '머지' : '게이트'} 승인자로 등록된 Touch ID 키가 아니에요`,
      );
    const { signCount } = verifyWebAuthnAssertion(
      approver.credential,
      {
        challenge: webAuthnChallenge(
          gateApprovalMessage(target, evidence?.head, decision, evidence?.base),
          nonce,
        ),
        origin,
      },
      webauthn,
    );
    return {
      id: decisionId(approver.id, Buffer.from(webauthn.signature, 'base64url').toString('base64')),
      signer: approver.id,
      via: { kind: 'webauthn', credentialId: webauthn.credentialId, signCount },
    };
  }
  if ('issuer' in request) {
    const { issuer, proof, decision, source } = request;
    const targetHash = orcaApprovalTargetHash(receiptTarget, evidence);
    return verifyOrcaApproval(issuer, proof, { source, decision, target, targetHash }, policy);
  }
  verifyGateApproval(
    policy,
    target.gate.type,
    target.repo,
    request.signer,
    gateApprovalMessage(target, evidence?.head, request.decision, evidence?.base),
    request.signature,
  );
  return { ...request, id: decisionId(request.signer, request.signature) };
}

/**
 * 잠금 안에서 게이트와 승인 근거를 확인한다. 머지 결정은 GitHub HEAD까지 다시 읽어 승인 대상과 맞춘다.
 */
async function applyBotDecision(
  ctx: Ctx,
  { caller, request }: DecisionCall,
  gateId: string,
  beforeTarget: string | undefined,
  evidence: Awaited<ReturnType<typeof botGateEvidence>>,
  sameSource?: (gate: Gate) => boolean,
) {
  const lock = await waitForDecisionLock(ctx);
  try {
    // Touch ID 승인은 운영 봇이 아니라 승인자 본인이 연 페이지에서 온다. 승인 근거는 서명이라 봇 운영권을 묻지 않는다
    if (caller || !('webauthn' in request)) assertBotOwner(ctx.store.dir, caller);
    ctx.store.reload();
    const existing = ctx.store.snapshot.gates[gateId];
    if (existing?.status === 'resolved')
      return {
        ...botDecisionStatus(existing),
        alreadyResolved: true,
        ...(existing.receipt && 'signature' in request
          ? {
              sameDecision:
                existing.decision === request.decision &&
                existing.receipt.id === decisionId(request.signer, request.signature),
            }
          : {}),
        ...(sameSource ? { sameAnswer: sameSource(existing) } : {}),
      };
    const current = matchBotGate(ctx.store, gateId);
    const receiptTarget = decisionTarget(ctx.store, current);
    if (receiptTarget !== beforeTarget)
      throw new InputError('게이트나 PR이 바뀌었어요. 다시 확인해 주세요');
    const head = evidence?.head;
    const { decision } = request;
    const approval = verifyBotDecision(
      assertApproverReady(loadBotPolicy(ctx.store.dir), current.gate, current.repo),
      current,
      receiptTarget,
      evidence,
      request,
    );
    let checked: typeof evidence;
    if (current.ref) {
      const now = await botGateEvidence(ctx, current);
      if (!now || !head || now.head !== head)
        throw new InputError('PR HEAD가 바뀌었어요. 새 HEAD로 다시 승인받아 주세요');
      if (evidence?.base !== now.base)
        throw new InputError('PR의 base 브랜치가 바뀌었어요. 다시 확인해 주세요');
      if (
        current.gate.type === 'merge' &&
        decision === 'approved' &&
        (now.state !== 'OPEN' || now.draft)
      )
        throw new InputError('리뷰 준비가 끝난 열린 PR만 머지 승인할 수 있어요');
      checked = now;
    }
    if (approval.expiresAt !== undefined && approval.expiresAt <= Date.now())
      throw new InputError('Orca 승인 증빙의 유효기간을 벗어났어요');
    const answer =
      current.gate.type === 'merge' && checked && decision === 'approved'
        ? `승인된 PR HEAD는 ${checked.head}입니다. 머지는 반드시 --match-head-commit ${checked.head}로 제한하세요. HEAD가 바뀌면 새 승인을 요청하세요.`
        : undefined;
    const closed = resolveGate(ctx.store, gateId, decision, answer, {
      deliveryPending: true,
      decisionBy: approval.signer,
      receipt: decisionReceipt(ctx.store, current, approval.id, checked),
      ...(approval.source ? { decisionSource: approval.source } : {}),
      ...(approval.via ? { decisionVia: approval.via } : {}),
    });
    return { ...botDecisionStatus(closed), errors: [] };
  } finally {
    lock.release();
  }
}

/** 승인 페이지는 승인자가 보는 자리라 깨진 정책 파일도 경로 대신 안내 문구로 돌려준다 */
function touchIdPolicy(dir: string, gate: Gate, repo: string): Record<string, unknown> {
  const read = peekBotPolicy(dir);
  if ('unreadable' in read) throw new InputError(approverGuidance(gate, repo, 'unreadable'));
  return assertApproverReady(read.policy, gate, repo);
}

/**
 * Touch ID 승인 페이지가 서명 전에 보여 줄 게이트 내용과 challenge. 봇 운영권 없이 승인자 본인이 연다.
 * nonce는 승인 서버가 발급해 메모리에 둔 값이다
 */
export async function touchIdGateOptions(
  opts: ConductorCommonOptions,
  gateId: string,
  decision: 'approved' | 'rejected',
  nonce: string,
): Promise<GateOptions> {
  const ctx = open(opts);
  if (!ctx.store.snapshot.gates[gateId]) throw new InputError('게이트를 찾을 수 없어요');
  const target = matchBotGate(ctx.store, gateId);
  if (target.gate.status !== 'open') throw new InputError('이미 닫힌 게이트예요');
  const policy = touchIdPolicy(ctx.store.dir, target.gate, target.repo);
  const approvers = webAuthnApprovers(policy, target.gate.type, target.repo);
  if (!approvers.length)
    throw new InputError(
      `${target.repo} 레포에는 이 게이트를 닫을 Touch ID 승인자가 없어요. gestalt conductor approver enroll로 먼저 등록해 주세요`,
    );
  const evidence = await touchIdGateEvidence(ctx, target);
  return {
    gate: {
      id: target.gate.id,
      type: target.gate.type,
      repo: target.repo,
      reason: target.gate.reason,
      refs: target.gate.refs ?? [],
      ...(target.url ? { pr: target.url } : {}),
    },
    ...(evidence ? { head: evidence.head } : {}),
    decision,
    challenge: webAuthnChallenge(
      gateApprovalMessage(target, evidence?.head, decision, evidence?.base),
      nonce,
    ),
    nonce,
    credentialIds: approvers.map((a) => a.credential.credentialId),
  };
}

/** Touch ID 서명으로 게이트를 닫는다. 서명 확인과 잠금, 기록은 봇 결정과 같은 경로를 탄다 */
export async function touchIdGateDecide(
  opts: ConductorCommonOptions,
  gateId: string,
  decision: 'approved' | 'rejected',
  raw: unknown,
  server: { nonce: string; origin: string },
) {
  const parsed = assertionSchema.safeParse(raw);
  if (!parsed.success) throw new InputError('WebAuthn 응답 형식을 확인하지 못했어요');
  const ctx = open(opts);
  const target = ctx.store.snapshot.gates[gateId]?.receipt
    ? undefined
    : matchBotGate(ctx.store, gateId);
  const beforeTarget = target ? decisionTarget(ctx.store, target) : undefined;
  if (target?.gate.status === 'open') touchIdPolicy(ctx.store.dir, target.gate, target.repo);
  const evidence =
    target?.gate.status === 'open' ? await touchIdGateEvidence(ctx, target) : undefined;
  return applyBotDecision(
    ctx,
    { request: { decision, webauthn: parsed.data, ...server } },
    gateId,
    beforeTarget,
    evidence,
  );
}

export async function conductorBotDecideCommand(
  gateId: string,
  opts: ConductorCommonOptions & { decision: string; signer: string; signature: string },
): Promise<void> {
  try {
    const ctx = open(opts);
    const caller = await requireBotOperator(ctx);
    const decision = oneOf<'approved' | 'rejected'>(
      opts.decision,
      ['approved', 'rejected'],
      '--decision',
    );
    const target = ctx.store.snapshot.gates[gateId]?.receipt
      ? undefined
      : matchBotGate(ctx.store, gateId);
    const beforeTarget = target ? decisionTarget(ctx.store, target) : undefined;
    // 승인자가 없으면 GitHub를 읽기 전에 터미널 안내로 멈춘다. 잠금 안에서 한 번 더 본다
    if (target?.gate.status === 'open')
      assertApproverReady(loadBotPolicy(ctx.store.dir), target.gate, target.repo);
    const evidence =
      target?.gate.status === 'open' ? await botGateEvidence(ctx, target) : undefined;
    print(
      await applyBotDecision(
        ctx,
        { caller, request: { decision, signer: opts.signer, signature: opts.signature } },
        gateId,
        beforeTarget,
        evidence,
      ),
    );
  } catch (error) {
    exitWithError(error);
  }
}

/**
 * Orca가 저장한 항목의 답을 확인하고 승인자 서명이나 공식 증빙으로 게이트를 닫는다.
 */
export async function conductorBotItemDecideCommand(
  gateId: string,
  opts: ConductorCommonOptions & { item: string; question: string; answer: string },
): Promise<void> {
  try {
    const ctx = open(opts);
    const caller = await requireBotOperator(ctx);
    const item = Number(opts.item);
    if (!Number.isSafeInteger(item) || item <= 0) throw new Error('--item은 Orca 항목 번호예요');
    const sameSource = (gate: Gate) =>
      gate.decisionSource?.botId === caller.botId &&
      gate.decisionSource.chatId === caller.chatId &&
      gate.decisionSource.item === item &&
      gate.decisionSource.question === opts.question &&
      gate.decisionSource.answer === opts.answer;
    const resolved = ctx.store.snapshot.gates[gateId];
    const target = resolved?.receipt ? undefined : matchBotGate(ctx.store, gateId);
    if (resolved?.status === 'resolved')
      return print({
        ...botDecisionStatus(resolved),
        alreadyResolved: true,
        sameAnswer: sameSource(resolved),
      });
    if (!target) throw new Error('결정할 게이트를 찾을 수 없어요');
    const beforeTarget = decisionTarget(ctx.store, target);
    assertApproverReady(loadBotPolicy(ctx.store.dir), target.gate, target.repo);
    const evidence = await botGateEvidence(ctx, target);
    const read = readItemDecision({
      show: await readOrcaItem(item),
      owner: caller,
      item,
      question: opts.question,
      answer: opts.answer,
      binding: itemBinding(target, evidence?.head, evidence?.base),
    });
    if (read.kind === 'signed') {
      print(
        await applyBotDecision(
          ctx,
          { caller, request: read },
          gateId,
          beforeTarget,
          evidence,
          sameSource,
        ),
      );
      return;
    }
    const issuer = await officialOrcaApprovalIssuer(caller);
    if (!issuer) throw new OrcaContractError();
    const proof = await issuer.read(read.source);
    print(
      await applyBotDecision(
        ctx,
        { caller, request: { ...read, issuer, proof } },
        gateId,
        beforeTarget,
        evidence,
        sameSource,
      ),
    );
  } catch (error) {
    exitWithError(error);
  }
}

export async function conductorBotGithubCommand(
  link: string,
  opts: ConductorCommonOptions,
): Promise<void> {
  try {
    const ctx = open(opts);
    assertConductorSession(ctx, 'bot github');
    const caller = await currentBotOwner();
    const policy = readBotPolicy(ctx.store.dir);
    if (
      !caller ||
      caller.botId !== policy['githubIntakeBotId'] ||
      caller.botId === readBotOwnership(ctx.store.dir).active?.botId
    )
      throw new Error('등록된 팀 주문 접수 봇 채팅에서 실행해 주세요');
    const request = await readGithubOrder(link, policy, new GhAccounts(ctx.config.accounts));
    print(handleGithubOrder(ctx.store, request));
  } catch (error) {
    exitWithError(error);
  }
}

export async function conductorCheckBotMutation(
  command: string,
  opts: ConductorCommonOptions & Partial<ConductorOrderAddOptions>,
): Promise<void> {
  try {
    const ctx = open(opts);
    const caller = await tickBotCaller(ctx);
    if (!caller) return;
    if (command === 'order add') {
      assertBotOwner(ctx.store.dir, caller);
      if (
        !opts.deploys?.length &&
        (opts.scope === undefined || opts.scope === 'approval') &&
        (opts.skills === undefined || opts.skills === 'solve,ship')
      ) {
        opts.scope = 'approval';
        opts.skills = 'solve,ship';
        return;
      }
    }
    throw new Error('이 변경은 운영자 터미널에서 실행해 주세요');
  } catch (error) {
    exitWithError(error);
  }
}
