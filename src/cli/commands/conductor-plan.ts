import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../../core/config.js';
import { gestaltPath } from '../../core/home.js';
import { isPlainObject } from '../../core/json-file.js';
import { EventStore } from '../../events/store.js';
import { claimPlanDestination, rememberPlanStore } from '../../execute/plan-destination.js';
import { ExecuteSessionManager } from '../../execute/session.js';
import { githubRepositoryName } from '../../harness-review/related-repos.js';
import { readBotOwnership, targetBotOwner, type BotOwner } from '../../conductor/bot-owner.js';
import { acquireLock } from '../../conductor/engine.js';
import { intakeOrder } from '../../conductor/intake.js';
import { detectOrca, execRunner, OrcaLauncher, workerAt } from '../../conductor/launcher.js';
import {
  prepareOrderPlan,
  preparedPlanSourceRef,
  readPreparedPlan,
  type PreparedPlan,
} from '../../conductor/prepared-plan.js';
import { resolveStateDir } from '../../conductor/state-dir.js';
import { real } from '../../conductor/parent-worktree.js';
import { ConductorStore } from '../../conductor/store.js';
import { ACTIVE_WORKER_STATUSES } from '../../conductor/types.js';
import {
  assertConductorSession,
  exitWithError,
  open,
  print,
  tickBotCaller,
  type ConductorCommonOptions,
  type Ctx,
} from './conductor.js';

const PLAN_ID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

function stagedPath(planId: string): string {
  if (!PLAN_ID.test(planId)) throw new Error('실행 계획 ID를 UUID로 주세요');
  return gestaltPath('prepared-plans', `${planId}.json`);
}

interface StagedPlan {
  prepared: PreparedPlan;
  dbPath: string;
}

function stage(staged: StagedPlan): void {
  const { prepared } = staged;
  const file = stagedPath(prepared.plan.planId);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(staged), { mode: 0o600, flag: 'wx' });
    linkSync(temp, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = readStagedPlan(prepared.plan.planId);
    if (!isDeepStrictEqual(existing, staged))
      throw new Error('같은 계획 ID로 다른 내용이나 레포를 보낼 수 없어요', { cause: error });
  } finally {
    rmSync(temp, { force: true });
  }
}

function readStagedPlan(planId: string): StagedPlan {
  const stored: unknown = JSON.parse(readFileSync(stagedPath(planId), 'utf8'));
  if (
    !isPlainObject(stored) ||
    typeof stored['dbPath'] !== 'string' ||
    !isAbsolute(stored['dbPath'])
  )
    throw new Error('원본 실행 세션 저장소를 찾지 못했어요. 같은 계획을 다시 제출해 주세요');
  const prepared = readPreparedPlan(stored['prepared']);
  if (prepared.plan.planId !== planId) throw new Error('저장된 실행 계획의 ID가 달라요');
  return { prepared, dbPath: stored['dbPath'] };
}

function claimForConductor(dir: string, planId: string): void {
  claimPlanDestination(planId, { kind: 'conductor', stateDir: real(dir) });
}

function verifySource({ prepared, dbPath }: StagedPlan, cwd?: string): void {
  const events = new EventStore(dbPath);
  try {
    const sessions = new ExecuteSessionManager(events);
    const current = prepareOrderPlan(sessions.get(prepared.sessionId), prepared.repo);
    if (!isDeepStrictEqual(current, prepared))
      throw new Error('원본 실행 계획이 바뀌었어요. 현재 계획을 다시 제출해 주세요');
    sessions.selectConductorPlan(prepared.sessionId, cwd, prepared.repo);
  } finally {
    events.close();
  }
}

function receipt(dir: string, prepared: PreparedPlan) {
  const store = ConductorStore.open(dir);
  const ref = preparedPlanSourceRef(prepared.plan.planId);
  const order = store.findOrderBySourceRef(ref);
  if (order) {
    if (!isDeepStrictEqual(order.preparedPlan, prepared))
      throw new Error('같은 계획 ID가 다른 주문에 이미 연결돼 있어요');
    // 이전 주문의 접수 기록을 되읽을 때도 원본 계획의 실행 목적지를 복구한다.
    claimForConductor(dir, prepared.plan.planId);
    return { status: 'accepted', orderId: order.id, scope: order.scope };
  }
  if (store.removedAtOf(ref) || store.archivedAtOf(ref)) {
    claimForConductor(dir, prepared.plan.planId);
    return { status: 'retired' };
  }
  return undefined;
}

async function accept(ctx: Ctx, caller: BotOwner | undefined, { prepared, dbPath }: StagedPlan) {
  if (!caller) throw new Error('등록된 Orca 운영 채팅에서 계획을 접수해 주세요');
  let lock = acquireLock(ctx.store.dir);
  for (let retry = 0; !lock.ok && retry < 10; retry++) {
    await delay(100);
    lock = acquireLock(ctx.store.dir);
  }
  if (!lock.ok) throw new Error('컨덕터가 처리 중이에요. 같은 계획으로 접수를 다시 시도해 주세요');
  try {
    const active = readBotOwnership(ctx.store.dir).active;
    if (caller.botId !== active?.botId || caller.chatId !== active.chatId)
      throw new Error('계획을 접수할 운영권이 이 채팅에 없어요');
    rememberPlanStore(prepared.plan.planId, ctx.store.dir);
    const existing = receipt(ctx.store.dir, prepared);
    if (existing) return existing;
    verifySource({ prepared, dbPath });
    claimForConductor(ctx.store.dir, prepared.plan.planId);
    const out = intakeOrder(
      ConductorStore.open(ctx.store.dir),
      {
        source: 'spoken',
        repo: prepared.repo,
        title: prepared.spec.goal,
        description:
          '확정된 Spec과 계획으로 구현하고 수용 기준을 검증한다. PR 리뷰와 CI를 마친 뒤 머지 승인을 받는다.',
        preparedPlan: prepared,
      },
      ctx.config,
      { trusted: true },
    );
    return 'order' in out
      ? { status: 'accepted', orderId: out.order.id, scope: out.order.scope }
      : { status: 'retired' };
  } finally {
    lock.release();
  }
}

export async function conductorAcceptPreparedPlan(
  planId: string,
  opts: ConductorCommonOptions,
): Promise<void> {
  try {
    const ctx = open(opts);
    assertConductorSession(ctx, 'order add --prepared-plan');
    const caller = await tickBotCaller(ctx);
    print(await accept(ctx, caller, readStagedPlan(planId)));
  } catch (error) {
    exitWithError(error);
  }
}

interface SubmitOptions extends ConductorCommonOptions {
  repo?: string;
  check?: boolean;
}

export async function conductorPlanSubmitCommand(
  sessionId: string,
  opts: SubmitOptions,
): Promise<void> {
  let prepared: PreparedPlan | undefined;
  try {
    const config = loadConfig();
    const stateDir = resolveStateDir(opts.stateDir, config.conductor);
    const origin = githubRepositoryName(process.cwd());
    const dbPath = resolve(config.dbPath);
    const events = new EventStore(dbPath);
    try {
      const session = new ExecuteSessionManager(events).get(sessionId);
      const repo = opts.repo?.toLowerCase() ?? session.targetRepository?.name ?? origin;
      if (!repo) throw new Error('계획의 대상 레포를 확인하지 못했어요');
      prepared = prepareOrderPlan(session, repo);
    } finally {
      events.close();
    }

    const staged = { prepared, dbPath };
    const ids = {
      sessionId,
      specId: prepared.plan.specId,
      planId: prepared.plan.planId,
      repo: prepared.repo,
    };
    if (!existsSync(stateDir)) throw new Error('등록된 Orca 컨덕터 운영 채팅이 없어요');
    const ctx: Ctx = { store: ConductorStore.open(stateDir), config: config.conductor };
    assertConductorSession(ctx, 'plan submit');
    rememberPlanStore(prepared.plan.planId, stateDir);
    const existing = receipt(stateDir, prepared);
    if (existing) return print({ ...ids, ...existing });
    verifySource(staged, origin || !opts.repo ? process.cwd() : undefined);
    if (opts.check) return print({ ...ids, status: 'unconfirmed' });

    const owner = readBotOwnership(stateDir).active;
    if (!owner) throw new Error('등록된 Orca 컨덕터 운영 채팅이 없어요');
    const caller = await tickBotCaller(ctx);
    if (caller && readBotOwnership(stateDir).retired.includes(caller.chatId))
      throw new Error('이미 운영권을 인계한 봇 채팅이에요');
    if (caller?.botId === owner.botId && caller.chatId === owner.chatId)
      return print({ ...ids, ...(await accept(ctx, caller, staged)) });

    const orca = detectOrca();
    if (!orca) throw new Error('Orca CLI로 등록된 운영 채팅을 확인해야 해요');
    const target = await targetBotOwner(owner.name, owner.chatId);
    if (target.botId !== owner.botId) throw new Error('등록된 Orca 봇과 조회한 봇이 달라요');

    stage(staged);
    const command = `gestalt conductor order add --prepared-plan ${ids.planId} --state-dir ${quote(stateDir)} --json`;
    const sent = await execRunner(
      orca,
      [
        'orchestration',
        'send',
        '--environment',
        'local',
        '--to',
        `bot:${owner.botId}`,
        '--chat',
        owner.chatId,
        '--type',
        'handoff',
        '--subject',
        '확정된 Gestalt 계획 주문 접수',
        '--body',
        `이 채팅의 운영권을 확인하고 일반 승인 주문 경로로 접수해 주세요.\n\n${command}\n\n주문 ID와 접수 결과를 보고해 주세요. 기존 정기 점검은 그대로 둡니다.`,
        '--json',
      ],
      { timeoutMs: 10000 },
    );
    const envelope: unknown = sent.stdout ? JSON.parse(sent.stdout) : undefined;
    if (sent.code !== 0 || !isPlainObject(envelope) || envelope['ok'] !== true) {
      const confirmed = receipt(stateDir, prepared);
      if (confirmed) return print({ ...ids, ...confirmed });
      throw new Error('Orca가 운영 채팅으로의 전달을 확인하지 못했어요');
    }

    for (let attempt = 0; attempt < 12; attempt++) {
      const confirmed = receipt(stateDir, prepared);
      if (confirmed) return print({ ...ids, ...confirmed });
      await delay(1000);
    }
    print({
      ...ids,
      status: 'unconfirmed',
      message: '운영 채팅으로 전달했어요. 주문 ID 확인에는 같은 명령에 --check를 붙여 주세요',
    });
  } catch (error) {
    if (!prepared) exitWithError(error);
    print({
      status: 'unconfirmed',
      sessionId,
      specId: prepared.plan.specId,
      planId: prepared.plan.planId,
      repo: prepared.repo,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function conductorPlanLoadCommand(
  orderId: string,
  opts: ConductorCommonOptions,
): Promise<void> {
  try {
    const ctx = open(opts);
    const order = ctx.store.order(orderId);
    if (!order?.preparedPlan) throw new Error('이 주문에는 확정된 실행 계획이 없어요');
    const cwd = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const worker = workerAt(cwd, ctx.store.workers());
    if (!worker || worker.id !== order.workerId || !ACTIVE_WORKER_STATUSES.has(worker.status))
      throw new Error('이 주문에 배정된 워커의 워크트리에서 계획을 복원해 주세요');
    if (worker.kind === 'orca-worktree') {
      const orca = detectOrca();
      const assigned = orca
        ? await new OrcaLauncher({
            orcaCommand: orca,
            promptDir: ctx.store.dir,
            runner: execRunner,
          }).worktreePath(worker)
        : undefined;
      if (!assigned || real(assigned) !== real(cwd))
        throw new Error('Orca에서 이 주문의 워크트리 배정을 확인하지 못했어요');
    }
    const prepared = readPreparedPlan(order.preparedPlan);
    if (prepared.repo !== order.repo) throw new Error('보관된 계획의 레포가 주문과 달라요');
    claimForConductor(ctx.store.dir, prepared.plan.planId);
    const events = new EventStore(loadConfig().dbPath);
    try {
      const session = new ExecuteSessionManager(events).restorePreparedPlan(
        `conductor-${worker.id}`,
        prepared.spec,
        prepared.plan,
        cwd,
        order.repo,
      );
      print({
        sessionId: session.sessionId,
        status: session.status,
        cwd,
        specId: session.specId,
        planId: prepared.plan.planId,
      });
    } finally {
      events.close();
    }
  } catch (error) {
    exitWithError(error);
  }
}
