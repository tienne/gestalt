import { promisify } from 'node:util';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCli } from '../../../src/cli/index.js';
import { changeBotOwner } from '../../../src/conductor/bot-owner.js';
import { buildWorkerPrompt, chooseWorkerKind } from '../../../src/conductor/launcher.js';
import { prepareOrderPlan, preparedPlanSourceRef } from '../../../src/conductor/prepared-plan.js';
import { EventType } from '../../../src/events/types.js';
import { ConductorStore } from '../../../src/conductor/store.js';
import { EventStore } from '../../../src/events/store.js';
import { PassthroughExecuteEngine } from '../../../src/execute/passthrough-engine.js';
import { handleExecutePassthrough } from '../../../src/mcp/tools/execute-passthrough.js';
import { executeInputSchema } from '../../../src/mcp/schemas.js';
import { ExecuteSessionManager } from '../../../src/execute/session.js';
import type { Order } from '../../../src/conductor/types.js';
import { createExecuteFixture, type ExecuteFixture } from '../../helpers/execute-fixture.js';
import { cleanupStateDirs, order as fixtureOrder, tempStateDir, worker } from './fixtures.js';

const owner = { botId: 'ops', name: 'Conductor', chatId: 'ops-home' };
const outside = { botId: 'other', name: 'Other', chatId: 'other-home' };
vi.mock('../../../src/conductor/launcher.js', async (original) => ({
  ...(await original<typeof import('../../../src/conductor/launcher.js')>()),
  detectOrca: () => 'test-orca',
  execRunner: vi.fn(),
}));

import { execRunner } from '../../../src/conductor/launcher.js';

describe('공식 실행 계획의 컨덕터 접수', () => {
  let fx: ExecuteFixture;
  let stateDir: string;
  let dir: string;
  let cwd: string;
  let lines: string[];
  let acceptMail: boolean;
  let failDelivery: boolean;
  let orcaWorktree: string;
  const cli = async (...args: string[]) => createCli().parseAsync(args, { from: 'user' });
  const last = () => JSON.parse(lines.at(-1)!) as Record<string, unknown>;
  const orders = () => ConductorStore.open(stateDir).orders();
  const submit = (sessionId: string, ...opts: string[]) =>
    cli('conductor', 'plan', 'submit', sessionId, '--state-dir', stateDir, '--json', ...opts);

  beforeEach(() => {
    cwd = process.cwd();
    dir = resolve(tempStateDir());
    stateDir = resolve(tempStateDir());
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/app.git'], {
      cwd: dir,
    });
    process.chdir(dir);
    fx = createExecuteFixture('prepared-plan');
    vi.stubEnv('GESTALT_HOME', dir);
    vi.stubEnv('GESTALT_DB_PATH', resolve(fx.dbPath));
    vi.stubEnv('GESTALT_CONDUCTOR_WORKER_ID', undefined);
    vi.stubEnv('ORCA_AGENT_SESSION_ID', undefined);
    vi.stubEnv('ORCA_AGENT_SESSION_TOOL_TOKEN', undefined);
    vi.mocked(execRunner).mockClear();
    lines = [];
    acceptMail = true;
    failDelivery = false;
    orcaWorktree = dir;
    vi.spyOn(console, 'log').mockImplementation((value: unknown) => lines.push(String(value)));
    vi.spyOn(console, 'error').mockImplementation((value: unknown) => lines.push(String(value)));
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    vi.mocked(execRunner).mockImplementation(async (_command, args) => {
      const ok = (result: unknown) => ({
        code: 0,
        stderr: '',
        stdout: JSON.stringify({ ok: true, result }),
      });
      if (args[0] === 'bot' && args[1] === 'list')
        return ok({
          bots: [owner, outside].map((bot) => ({ id: bot.botId, name: bot.name, paused: false })),
        });
      if (args[0] === 'bot' && args[1] === 'chats') {
        const caller = args.includes('--bot')
          ? owner
          : process.env['ORCA_AGENT_SESSION_ID'] === owner.chatId
            ? owner
            : outside;
        return ok({
          bot: caller.name,
          chats: [{ id: caller.chatId, closed: false, self: !args.includes('--bot') }],
        });
      }

      if (args[0] === 'orchestration' && args[1] === 'worker-show') {
        expect(args[2]).toBe('--dispatch=test-dispatch');
        return ok({ workspace: `repo::${orcaWorktree}` });
      }
      expect(args.slice(0, 8)).toEqual([
        'orchestration',
        'send',
        '--environment',
        'local',
        '--to',
        'bot:ops',
        '--chat',
        'ops-home',
      ]);
      if (failDelivery) return { code: 1, stdout: '', stderr: 'transport unavailable' };
      const body = args[args.indexOf('--body') + 1]!;
      const planId = body.match(/order add --prepared-plan ([\da-f-]+)/)?.[1];
      expect(planId).toBeTruthy();
      if (acceptMail) {
        vi.stubEnv('ORCA_AGENT_SESSION_ID', owner.chatId);
        try {
          await cli(
            'conductor',
            'order',
            'add',
            '--prepared-plan',
            planId!,
            '--state-dir',
            stateDir,
            '--json',
          );
        } finally {
          vi.stubEnv('ORCA_AGENT_SESSION_ID', undefined);
        }
      }
      return ok({ delivered: true });
    });
  });

  afterEach(() => {
    process.exitCode = 0;
    process.chdir(dir);
    fx.close();
    process.chdir(cwd);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cleanupStateDirs();
  });

  it('등록된 운영 채팅이 승인 범위 주문을 받고 배정된 워크트리에 원본 계획을 복원한다', async () => {
    changeBotOwner(stateDir, undefined, owner);
    const { sessionId, spec } = fx.plannedSession(undefined, undefined, dir);
    const plan = fx.engine.getSession(sessionId).executionPlan!;
    await submit(sessionId, '--repo', 'acme/app');
    const [order] = orders() as [Order];
    expect(last()).toMatchObject({
      status: 'accepted',
      orderId: order.id,
      scope: 'approval',
      planId: plan.planId,
    });
    expect(order).toMatchObject({
      repo: 'acme/app',
      title: spec.goal,
      scope: 'approval',
      skillChain: ['execute', 'ship'],
      preparedPlan: { sessionId, spec, plan },
    });
    expect(chooseWorkerKind(order, { orcaAvailable: true })).toBe('orca-worktree');
    expect(chooseWorkerKind(order, { orcaAvailable: false })).toBe('git-worktree');
    expect(fx.engine.getSession(sessionId).status).toBe('plan_complete');

    const worktree = join(dir, 'assigned-worktree');
    mkdirSync(worktree);
    execFileSync('git', ['init', '-q', worktree]);
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/app.git'], {
      cwd: worktree,
    });
    const assigned = worker(order.id, { kind: 'git-worktree', handle: worktree });
    const store = ConductorStore.open(stateDir);
    store.startWorker(assigned);
    store.updateOrder(order.id, { workerId: assigned.id, status: 'running' });
    expect(buildWorkerPrompt(order, assigned, undefined, { stateDir })).toContain(
      `plan load ${order.id}`,
    );
    expect(buildWorkerPrompt(order, assigned)).toContain('머지는 별도 승인 게이트');
    await expect(
      cli('conductor', 'plan', 'load', order.id, '--state-dir', stateDir),
    ).rejects.toThrow('exit 1');

    process.chdir(worktree);
    const newDb = join(worktree, 'worker.db');
    vi.stubEnv('GESTALT_DB_PATH', newDb);
    await cli('conductor', 'plan', 'load', order.id, '--state-dir', stateDir);
    const executionId = last()['sessionId'] as string;
    expect(last()).toMatchObject({ cwd: process.cwd(), planId: plan.planId });
    await cli('conductor', 'plan', 'load', order.id, '--state-dir', stateDir);
    expect(last()['sessionId']).toBe(executionId);
    const events = new EventStore(newDb);
    try {
      const restored = new ExecuteSessionManager(events).get(executionId);
      const workerEngine = new PassthroughExecuteEngine(events);
      const call = async (action: 'execute_start' | 'evaluate', workdir?: string) =>
        JSON.parse(
          await handleExecutePassthrough(
            workerEngine,
            executeInputSchema.parse({ action, sessionId: executionId, cwd: workdir }),
          ),
        );
      await expect(call('execute_start', dir)).resolves.toMatchObject({
        error: expect.stringContaining('배정된 워크트리'),
      });
      await expect(call('execute_start')).resolves.toMatchObject({
        status: 'executing',
        artifactCheck: { repoRoot: worktree },
      });
      await expect(call('evaluate', dir)).resolves.toMatchObject({
        error: expect.stringContaining('배정된 워크트리'),
      });
      execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/acme/other.git'], {
        cwd: worktree,
      });
      await expect(call('evaluate')).resolves.toMatchObject({
        error: expect.stringContaining('acme/other'),
      });
      expect(new ExecuteSessionManager(events).get(executionId).planBoundaryError).toContain(
        'acme/other',
      );

      expect(restored).toMatchObject({
        executionPlan: plan,
        spec,
        codeGraphRepoRoot: process.cwd(),
        status: 'plan_complete',
      });
    } finally {
      events.close();
    }
    process.chdir(dir);
  });

  it('Orca가 실제 배정한 위치만 워커 계획 복원을 허용한다', async () => {
    changeBotOwner(stateDir, undefined, owner);
    const { sessionId } = fx.plannedSession(undefined, undefined, dir);
    await submit(sessionId, '--repo', 'acme/app');
    const [order] = orders() as [Order];
    const worktree = join(dir, `${order.id}-1`);
    execFileSync('git', [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-qm',
      'base',
    ]);
    execFileSync('git', ['worktree', 'add', '-qb', 'fixture-worker', worktree]);
    const assigned = worker(order.id, { kind: 'orca-worktree', handle: 'test-dispatch' });
    const store = ConductorStore.open(stateDir);
    store.startWorker(assigned);
    store.updateOrder(order.id, { workerId: assigned.id, status: 'running' });
    process.chdir(worktree);
    const load = () => cli('conductor', 'plan', 'load', order.id, '--state-dir', stateDir);
    await expect(load()).rejects.toThrow('exit 1');
    orcaWorktree = worktree;
    await load();
    expect(last()).toMatchObject({ cwd: process.cwd(), sessionId: `conductor-${assigned.id}` });
  });

  it('플랜 검증 실패, 운영권 부재, 워커 호출, 미확인 전달에서는 주문을 만들지 않는다', async () => {
    const incomplete = fx.startedSession();
    await expect(submit(incomplete.sessionId, '--repo', 'acme/app')).rejects.toThrow('exit 1');
    expect(vi.mocked(execRunner)).not.toHaveBeenCalled();
    const { sessionId } = fx.plannedSession(undefined, undefined, dir);
    const planId = fx.engine.getSession(sessionId).executionPlan!.planId;
    await submit(sessionId, '--repo', 'acme/app');
    expect(last()).toMatchObject({ status: 'unconfirmed', planId, sessionId });
    expect(orders()).toHaveLength(0);
    changeBotOwner(stateDir, undefined, owner);
    vi.stubEnv('GESTALT_CONDUCTOR_WORKER_ID', 'wrk-blocked');
    await submit(sessionId, '--repo', 'acme/app');
    expect(last()).toMatchObject({ status: 'unconfirmed', planId });
    expect(orders()).toHaveLength(0);
    vi.stubEnv('GESTALT_CONDUCTOR_WORKER_ID', undefined);
    failDelivery = true;
    await submit(sessionId, '--repo', 'acme/app');
    expect(last()).toMatchObject({ status: 'unconfirmed', planId });
    expect(orders()).toHaveLength(0);
    await submit(sessionId, '--repo', 'acme/app', '--check');
    expect(last()).toMatchObject({ status: 'unconfirmed' });
    failDelivery = false;
    await submit(sessionId, '--repo', 'acme/app');
    expect(last()).toMatchObject({ status: 'accepted', planId });
    expect(orders()).toHaveLength(1);
  });

  it('동시 도착과 재시도는 한 주문이고 다른 채팅에서는 접수할 수 없다', async () => {
    changeBotOwner(stateDir, undefined, owner);
    const { sessionId } = fx.plannedSession(undefined, undefined, dir);
    const planId = fx.engine.getSession(sessionId).executionPlan!.planId;
    failDelivery = true;
    await submit(sessionId, '--repo', 'acme/app');
    const accept = () =>
      cli('conductor', 'order', 'add', '--prepared-plan', planId, '--state-dir', stateDir);
    await expect(accept()).rejects.toThrow('exit 1');
    vi.stubEnv('ORCA_AGENT_SESSION_ID', outside.chatId);
    await expect(accept()).rejects.toThrow('exit 1');
    expect(orders()).toHaveLength(0);
    vi.stubEnv('ORCA_AGENT_SESSION_ID', owner.chatId);
    await Promise.all([accept(), accept()]);
    expect(orders()).toHaveLength(1);
    const orderId = orders()[0]!.id;
    expect(last()).toMatchObject({ status: 'accepted', orderId });
    await submit(sessionId, '--repo', 'acme/app', '--check');
    expect(last()).toMatchObject({ status: 'accepted', orderId });
  });

  it('전달 뒤 로컬 실행을 시작했으면 새 운영 접수 프로세스도 주문을 만들지 못한다', async () => {
    changeBotOwner(stateDir, undefined, owner);
    const { sessionId } = fx.plannedSession(undefined, undefined, dir);
    const planId = fx.engine.getSession(sessionId).executionPlan!.planId;
    failDelivery = true;
    await submit(sessionId, '--repo', 'acme/app');
    expect(fx.engine.startExecution(sessionId).ok).toBe(true);
    vi.stubEnv('ORCA_AGENT_SESSION_ID', owner.chatId);
    await expect(
      cli('conductor', 'order', 'add', '--prepared-plan', planId, '--state-dir', stateDir),
    ).rejects.toThrow('exit 1');
    expect(orders()).toHaveLength(0);
  });

  it('먼저 접수한 계획은 저장소를 다시 열어도 원본 로컬 실행을 시작할 수 없다', async () => {
    changeBotOwner(stateDir, undefined, owner);
    const { sessionId } = fx.plannedSession(undefined, undefined, dir);
    await submit(sessionId, '--repo', 'acme/app');
    expect(orders()).toHaveLength(1);
    const events = new EventStore(fx.dbPath);
    try {
      const engine = new PassthroughExecuteEngine(events);
      const result = engine.startExecution(sessionId);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('다른 컨덕터 접수');
      expect(engine.getSession(sessionId).status).toBe('plan_complete');
    } finally {
      events.close();
    }
  });

  it.each(['accept', 'check'])(
    '이미 기록된 주문을 %s로 확인하면 로컬 착수 방지 기록을 복구한다',
    async (route) => {
      changeBotOwner(stateDir, undefined, owner);
      const { sessionId } = fx.plannedSession(undefined, undefined, dir);
      const prepared = prepareOrderPlan(fx.engine.getSession(sessionId), 'acme/app');
      failDelivery = true;
      await submit(sessionId, '--repo', 'acme/app');
      const prior = fixtureOrder({
        sourceRef: preparedPlanSourceRef(prepared.plan.planId),
        scope: 'approval',
        preparedPlan: prepared,
      });
      ConductorStore.open(stateDir).addOrder(prior);
      if (route === 'accept') {
        vi.stubEnv('ORCA_AGENT_SESSION_ID', owner.chatId);
        await cli(
          'conductor',
          'order',
          'add',
          '--prepared-plan',
          prepared.plan.planId,
          '--state-dir',
          stateDir,
        );
      } else {
        await submit(sessionId, '--repo', 'acme/app', '--check');
      }
      expect(last()).toMatchObject({ status: 'accepted', orderId: prior.id });
      expect(orders()).toHaveLength(1);
      const restarted = new PassthroughExecuteEngine(fx.store);
      expect(restarted.startExecution(sessionId).ok).toBe(false);
    },
  );

  it.each(['start-first', 'concurrent'])(
    '기존 주문이 %s로 복구 조회보다 먼저 성립했으면 새 로컬 실행을 막는다',
    async (timing) => {
      changeBotOwner(stateDir, undefined, owner);
      const { sessionId } = fx.plannedSession(undefined, undefined, dir);
      const prepared = prepareOrderPlan(fx.engine.getSession(sessionId), 'acme/app');
      failDelivery = true;
      await submit(sessionId, '--repo', 'acme/app');
      const prior = fixtureOrder({
        sourceRef: preparedPlanSourceRef(prepared.plan.planId),
        scope: 'approval',
        preparedPlan: prepared,
      });
      ConductorStore.open(stateDir).addOrder(prior);
      const moduleUrl = new URL('../../../src/execute/passthrough-engine.ts', import.meta.url).href;
      const storeUrl = new URL('../../../src/events/store.ts', import.meta.url).href;
      const runLocal = () =>
        promisify(execFile)(
          process.execPath,
          [
            '--import',
            'tsx',
            '--input-type=module',
            '-e',
            `import { PassthroughExecuteEngine } from ${JSON.stringify(moduleUrl)};
              import { EventStore } from ${JSON.stringify(storeUrl)};
              const store = new EventStore(process.env.GESTALT_DB_PATH);
              try {
                const result = new PassthroughExecuteEngine(store).startExecution(${JSON.stringify(sessionId)});
                console.log(JSON.stringify({ started: result.ok, error: result.error?.message }));
              } finally { store.close(); }`,
          ],
          { cwd },
        ).then(({ stdout }) => JSON.parse(stdout.trim()));
      const check = () => submit(sessionId, '--repo', 'acme/app', '--check');
      const start =
        timing === 'concurrent' ? (await Promise.all([runLocal(), check()]))[0] : await runLocal();
      if (timing === 'start-first') await check();
      expect(start).toMatchObject({
        started: false,
        error: expect.stringContaining('다른 컨덕터 접수'),
      });
      expect(last()).toMatchObject({ status: 'accepted', orderId: prior.id });
      expect(fx.engine.getSession(sessionId).status).toBe('plan_complete');
      expect(orders()).toHaveLength(1);
    },
  );

  it('재시작했을 때 설정된 저장소의 기존 주문을 제출 기록 없이도 찾는다', () => {
    vi.stubEnv('GESTALT_CONDUCTOR_STATE_DIR', stateDir);
    const { sessionId } = fx.plannedSession(undefined, undefined, dir);
    const prepared = prepareOrderPlan(fx.engine.getSession(sessionId), 'acme/app');
    ConductorStore.open(stateDir).addOrder(
      fixtureOrder({
        sourceRef: preparedPlanSourceRef(prepared.plan.planId),
        scope: 'approval',
        preparedPlan: prepared,
      }),
    );
    const result = new PassthroughExecuteEngine(fx.store).startExecution(sessionId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('다른 컨덕터 접수');
    expect(orders()).toHaveLength(1);
  });

  it.each(['changed', 'missing'])(
    '원본 계획의 레포가 %s이면 새 접수와 로컬 실행을 거절하고 상태에 남긴다',
    async (change) => {
      changeBotOwner(stateDir, undefined, owner);
      const { sessionId } = fx.plannedSession(undefined, undefined, dir);
      const planId = fx.engine.getSession(sessionId).executionPlan!.planId;
      failDelivery = true;
      await submit(sessionId, '--repo', 'acme/app');
      const args =
        change === 'changed'
          ? ['set-url', 'origin', 'https://github.com/acme/other.git']
          : ['remove', 'origin'];
      execFileSync('git', ['remote', ...args], { cwd: dir });
      vi.stubEnv('ORCA_AGENT_SESSION_ID', owner.chatId);
      await expect(
        cli('conductor', 'order', 'add', '--prepared-plan', planId, '--state-dir', stateDir),
      ).rejects.toThrow('exit 1');
      expect(orders()).toHaveLength(0);
      const reopened = new PassthroughExecuteEngine(fx.store);
      expect(reopened.startExecution(sessionId).ok).toBe(false);
      const status = await fx.call({ action: 'status', sessionId });
      const reason = change === 'changed' ? 'acme/other' : '확인할 수 없어요';
      expect(status).toMatchObject({
        session: {
          targetRepository: 'acme/app',
          planBoundaryError: expect.stringContaining(reason),
        },
      });
    },
  );

  it('이전 버전에서 다른 레포에 복원한 세션으로는 실행과 평가를 시작하지 못한다', async () => {
    const { sessionId, spec } = fx.plannedSession(undefined, undefined, dir);
    const plan = fx.engine.getSession(sessionId).executionPlan!;
    const workerSessionId = 'conductor-legacy-worker';
    const other = join(dir, 'other-repo');
    execFileSync('git', ['init', '-q', other]);
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/other.git'], {
      cwd: other,
    });
    fx.store.append('execute', workerSessionId, EventType.EXECUTE_SESSION_STARTED, {
      specId: spec.metadata.specId,
      spec,
      preparedPlan: plan,
      codeGraphRepoRoot: other,
    });
    for (const action of ['execute_start', 'evaluate'] as const) {
      const res = await fx.call({ action, sessionId: workerSessionId, cwd: other });
      expect(res['error']).toContain('기준 레포가 기록되지 않았어요');
    }
    expect(fx.engine.getSession(workerSessionId).status).toBe('plan_complete');
  });

  it('별도 프로세스에서 착수와 접수가 동시에 목적지를 잡아도 하나만 성공한다', async () => {
    const { sessionId } = fx.plannedSession(undefined, undefined, dir);
    const planId = fx.engine.getSession(sessionId).executionPlan!.planId;
    const moduleUrl = new URL('../../../src/execute/plan-destination.ts', import.meta.url).href;
    const choose = (destination: { kind: 'local' } | { kind: 'conductor'; stateDir: string }) =>
      promisify(execFile)(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          `import { claimPlanDestination } from ${JSON.stringify(moduleUrl)}; claimPlanDestination(${JSON.stringify(planId)}, ${JSON.stringify(destination)});`,
        ],
        { cwd },
      );
    const outcomes = await Promise.allSettled([
      choose({ kind: 'local' }),
      choose({ kind: 'conductor', stateDir }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected?.reason.stderr).toContain('이미 로컬 실행 또는 다른 컨덕터 접수');
  });

  it('메일 전달 성공 뒤 접수 기록이 생기기 전에는 주문 ID를 만들지 않는다', async () => {
    changeBotOwner(stateDir, undefined, owner);
    const { sessionId } = fx.plannedSession(undefined, undefined, dir);
    const planId = fx.engine.getSession(sessionId).executionPlan!.planId;
    acceptMail = false;
    const delivery = submit(sessionId, '--repo', 'acme/app');
    await vi.waitFor(() =>
      expect(vi.mocked(execRunner)).toHaveBeenCalledWith(
        'test-orca',
        expect.arrayContaining(['send']),
        expect.anything(),
      ),
    );
    expect(orders()).toHaveLength(0);
    await submit(sessionId, '--repo', 'acme/app', '--check');
    expect(last()).toMatchObject({ status: 'unconfirmed' });
    const staged = JSON.parse(
      readFileSync(join(dir, '.gestalt', 'prepared-plans', `${planId}.json`), 'utf8'),
    );
    expect(staged).toMatchObject({ prepared: { sessionId, plan: { planId } } });
    vi.stubEnv('ORCA_AGENT_SESSION_ID', owner.chatId);
    await cli('conductor', 'order', 'add', '--prepared-plan', planId, '--state-dir', stateDir);
    await delivery;
    expect(last()).toMatchObject({ status: 'accepted', orderId: orders()[0]!.id });
  });
});
