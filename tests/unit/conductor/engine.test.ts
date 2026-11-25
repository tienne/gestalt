import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireLock,
  deliverGateDecision,
  FAILED_REPORTS_DIR,
  inboxDirOf,
  MAX_SPAWN_PER_ORDER,
  resolveWorkerAgent,
  staleTickWarning,
  tick,
  tickGapWarning,
  UNRECORDED_REPORTS_DIR,
  writeReport,
  type EngineDeps,
} from '../../../src/conductor/engine.js';
import { readWorkerInfo } from '../../../src/conductor/activity.js';
import { GhAccounts } from '../../../src/conductor/adapters.js';
import {
  approveDeployment,
  readDeploymentEvidence,
} from '../../../src/conductor/deployment-evidence.js';
import { openOrReuse, resolveGate } from '../../../src/conductor/gates.js';
import { saveSkillCheckpoint } from '../../../src/conductor/resume.js';
import {
  confirmSlackDelivery,
  draftSlack,
  pendingSlackDelivery,
} from '../../../src/conductor/slack.js';
import {
  SLACK_HOST_HANDOFF,
  SUPERSEDED_PREFIX,
  slackDeliveryId,
} from '../../../src/conductor/slack-state.js';
import { foldEvents } from '../../../src/conductor/fold.js';
import type { DeploySignal, JiraClient } from '../../../src/conductor/jira.js';
import { repoContextPath } from '../../../src/conductor/context.js';
import {
  OrcaLauncher,
  OrcaReleaseLiveError,
  SubagentLauncher,
  type CommandRunner,
  type HostAction,
  type Launcher,
  type LaunchSpec,
  type ReleaseOptions,
} from '../../../src/conductor/launcher.js';
import type { PrStateSource } from '../../../src/conductor/ownership.js';
import type { ConductorConfig } from '../../../src/conductor/scheduler.js';
import {
  BASE_FILE,
  ConductorStore,
  EVENTS_FILE,
  replay,
  type BaseFile,
} from '../../../src/conductor/store.js';
import { readLastSuccessfulTick } from '../../../src/conductor/successful-tick.js';
import type { Worker, WorkerKind } from '../../../src/conductor/types.js';
import {
  cleanupStateDirs,
  clockedStore,
  order,
  slackSuccess,
  tempStateDir,
  worker,
} from './fixtures.js';

afterEach(cleanupStateDirs);

const config: ConductorConfig = {
  maxConcurrentWorkers: 2,
  pollIntervalSec: 60,
  maxResumeAttempts: 3,
  staleAfterSec: 900,
  rateLimitEscalateAfterSec: 21600,
  waitingEscalateAfterSec: 21600,
  deployWaitMaxSec: 86400,
  orcaReleaseRetryMaxSec: 7200,
  defaultScope: 'approval',
  resultMaxChars: 2000,
  accounts: {},
  repoPaths: {},
  defaultAgent: 'claude',
  repoAgents: {},
  humanOwnedPollSec: 900,
  humanOwnedParkAfterSec: 86400,
};

function fakeLauncher(kind: WorkerKind) {
  const started: LaunchSpec[] = [];
  const sent: { workerId: string; message: string }[] = [];
  const released: string[] = [];
  const releaseOpts: ReleaseOptions[] = [];
  const launcher: Launcher = {
    kind,
    start: async (spec) => {
      started.push(spec);
      return { handle: spec.previousHandle ?? `h-${spec.worker.id}` };
    },
    send: async (w: Worker, message: string): Promise<HostAction | undefined> => {
      sent.push({ workerId: w.id, message });
      return undefined;
    },
    release: async (w, opts = {}) => {
      released.push(w.id);
      releaseOpts.push(opts);
    },
  };
  return { launcher, started, sent, released, releaseOpts };
}

function fakeJira() {
  const moves: { key: string; to: string }[] = [];
  const client: JiraClient = {
    transition: async (key, to) => {
      moves.push({ key, to });
    },
  };
  return { client, moves };
}

const openPrState: PrStateSource = { state: async () => ({ state: 'OPEN' }) };

function deps(over: Partial<EngineDeps> = {}) {
  const git = fakeLauncher('git-worktree');
  const base: EngineDeps = {
    config,
    launchers: { 'git-worktree': git.launcher },
    orcaAvailable: false,
    env: {},
    // 기본 gh 소스가 진짜 GitHub를 조회하지 않게 막는다
    prState: openPrState,
    ...over,
  };
  return { deps: base, git };
}

function report(store: ConductorStore, d: EngineDeps, raw: Record<string, unknown>) {
  writeReport(
    inboxDirOf(store, d),
    { summary: '진행 중이에요', refs: [], ...raw },
    config.resultMaxChars,
  );
}

describe('이미 끝난 배포와 워커의 게이트 증빙 대조', () => {
  const repo = 'example/customer-frontend';
  const sha = 'a'.repeat(40);
  const ref = 'customer-stage-v.260101.2';
  const environment = 'customer-stage';
  const scope = { runId: 21, attempt: 2, deploymentId: 32, environment };
  const workflowPath = '.github/workflows/customer-stage.yml';
  const workflowRoute = `contents/${workflowPath}?ref=${sha}`;
  const workflow = (yaml: string) => ({
    content: Buffer.from(yaml).toString('base64'),
    encoding: 'base64',
  });
  const run = {
    id: 21,
    run_attempt: 2,
    head_sha: sha,
    event: 'push',
    head_branch: ref,
    path: `${workflowPath}@${ref}`,
    repository: { full_name: repo },
    status: 'completed',
    conclusion: 'success',
  };
  const deployment = { id: 32, sha, ref, environment };
  const status = {
    id: 43,
    environment,
    state: 'success',
    log_url: `https://github.com/${repo}/actions/runs/21/job/54`,
  };
  const jobs = {
    jobs: [{ id: 54, run_id: 21, head_sha: sha, status: 'completed', conclusion: 'success' }],
  };
  const json = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });

  function deploymentGate(store: ConductorStore) {
    store.addOrder(order({ id: 'ord-stage', repo, status: 'done', scope: 'approval' }));
    return openOrReuse(store, {
      type: 'no-procedure',
      orderId: 'ord-stage',
      reason: `ship ⓐⓑⓒ 단계로 확인되지 않은 단순 승인이라 사람에게 올려요: ${repo}의 커밋 ${sha}에 ${ref} 태그를 붙여 origin에 push하면 customer stage 배포가 시작됩니다.`,
    }).gate;
  }

  function workerGate(store: ConductorStore, handle = 'ctx_0123abcd') {
    store.addOrder(order({ id: 'ord-worker', repo, status: 'done' }));
    store.startWorker(
      worker('ord-worker', {
        id: 'wrk-previous',
        handle,
        kind: 'orca-worktree',
        status: 'finished',
      }),
    );
    return openOrReuse(store, {
      type: 'no-procedure',
      reason:
        'wrk-previous 정리에 실패했어요(liveness live). `orca orchestration worker-stop --dispatch=ctx_0123abcd`로 앞 워커를 멈춘 뒤 승인해 주세요',
      payload: { kind: 'cleanup-failed', workerId: 'wrk-previous', orderId: 'ord-worker' },
    }).gate;
  }

  function githubResponses() {
    return new Map<string, unknown>([
      [`repos/${repo}/actions/runs/21`, run],
      [`repos/${repo}/deployments/32`, deployment],
      [`repos/${repo}/deployments/32/statuses?per_page=1`, [status]],
      [
        `repos/${repo}/${workflowRoute}`,
        workflow("on:\n  push:\n    tags: ['customer-stage-*']\n"),
      ],
      [`repos/${repo}/actions/runs/21/attempts/2/jobs?per_page=100`, jobs],
    ]);
  }

  const ended = {
    dispatchId: 'ctx_0123abcd',
    runId: 'run-fixture',
    state: 'stopped',
    stage: 'process_stopped',
    liveness: 'exited',
    terminalState: 'released',
    waitingOnHuman: 'unknown',
  };

  it('다른 저장소에서 GitHub 조회 사이에 게이트 요청을 바꾸면 예전 증빙을 쓰지 않는다', async () => {
    const { store } = clockedStore();
    const gate = deploymentGate(store);
    resolveGate(store, gate.id, 'approved', undefined, {
      approvedDeployment: approveDeployment(gate, repo, JSON.stringify(scope)),
    });
    const { deps: d } = deps({
      deploymentEvidence: async () => {
        ConductorStore.open(store.dir).append({
          type: 'gate-updated',
          at: store.timestamp(),
          gateId: gate.id,
          reason: gate.reason.replace(ref, 'customer-stage-v.260101.3'),
          refs: [],
        });
        return { statusId: 43, jobId: 54 };
      },
    });
    expect((await tick(store, d, { force: true })).warnings).toEqual([
      expect.stringContaining('조회 중 게이트나 주문 상태가 바뀌었어요'),
    ]);
    expect(store.snapshot.gates[gate.id]?.completion).toBeUndefined();
  });

  it('사람이 승인한 두 실제 사례의 치환 fixture를 다시 열어도 완료를 한 번씩만 기록한다', async () => {
    const { store } = clockedStore();
    const stage = deploymentGate(store);
    const cleanup = workerGate(store);
    const calls: string[][] = [];
    const responses = githubResponses();
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args]);
      if (command === 'orca') {
        expect(args).toEqual(['orchestration', 'worker-show', '--dispatch=ctx_0123abcd', '--json']);
        return json({ ok: true, result: ended });
      }
      expect(args.slice(0, 3)).toEqual(['api', '--method', 'GET']);
      expect(responses.has(args[3]!)).toBe(true);
      return json(responses.get(args[3]!));
    };
    const { deps: d } = deps({
      launchers: {
        'orca-worktree': new OrcaLauncher({
          orcaCommand: 'orca',
          promptDir: tempStateDir(),
          runner,
        }),
      },
      deploymentEvidence: (target) => readDeploymentEvidence(target, new GhAccounts(), runner),
    });
    const before = await tick(store, d, { force: true });
    expect(before.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${stage.id} 배포 완료 보류`),
        expect.stringContaining(`${cleanup.id} 워커 정리 보류`),
      ]),
    );
    expect(calls).toEqual([]);
    expect(store.openGates().map((g) => g.id)).toEqual([stage.id, cleanup.id]);

    resolveGate(store, stage.id, 'approved', undefined, {
      approvedDeployment: approveDeployment(stage, repo, JSON.stringify(scope)),
    });
    resolveGate(store, cleanup.id, 'approved');
    const done = await tick(store, d, { force: true });
    expect(done.errors).toEqual([]);
    expect(done.hostActions).toEqual([]);
    expect(calls).toHaveLength(6);
    expect(store.snapshot.gates[stage.id]?.completion?.evidence).toMatchObject({
      kind: 'github-deployment',
      statusId: 43,
      jobId: 54,
      target: { sha, ...scope },
    });
    expect(store.snapshot.gates[cleanup.id]?.completion?.evidence).toMatchObject({
      kind: 'orca-worker',
      dispatchId: ended.dispatchId,
      runId: ended.runId,
      workerId: 'wrk-previous',
      liveness: 'exited',
      terminalState: 'released',
    });
    expect(store.worker('wrk-previous')?.status).toBe('released');
    await tick(store, d, { force: true });
    const reopened = ConductorStore.open(store.dir);
    expect((await tick(reopened, d, { force: true })).errors).toEqual([]);
    expect(calls).toHaveLength(6);
    const events = readFileSync(join(store.dir, EVENTS_FILE), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; gateId?: string });
    expect(events.filter((event) => event.type === 'gate-resolved').map((e) => e.gateId)).toEqual([
      stage.id,
      cleanup.id,
    ]);
    expect(events.filter((event) => event.type === 'gate-completed').map((e) => e.gateId)).toEqual([
      stage.id,
      cleanup.id,
    ]);
    expect(reopened.worker('wrk-previous')?.status).toBe('released');
  });

  it.each([
    ['실행 실패', 'actions/runs/21', { ...run, conclusion: 'failure' }, /실행의 성공/],
    ['시도 불일치', 'actions/runs/21', { ...run, run_attempt: 3 }, /승인과 달라/],
    ['커밋 불일치', 'actions/runs/21', { ...run, head_sha: 'b'.repeat(40) }, /승인과 달라/],
    ['환경 불일치', 'deployments/32', { ...deployment, environment: 'production' }, /승인과 달라/],
    [
      '이름과 SHA가 같은 브랜치 실행',
      workflowRoute,
      workflow(`on:\n  push:\n    branches: ['${ref}']\n    tags: ['${ref}']\n`),
      /태그 푸시에서 시작됐다는 근거가 없어/,
    ],
    [
      '실행 경로에 명시된 브랜치 ref',
      'actions/runs/21',
      { ...run, path: `${workflowPath}@refs/heads/${ref}` },
      /태그 푸시에서 시작됐다는 근거가 없어/,
    ],
    [
      '워크플로 증빙 누락',
      workflowRoute,
      { encoding: 'none', content: '' },
      /태그 푸시에서 시작됐다는 근거가 없어/,
    ],
    [
      '최신 배포 실패',
      'deployments/32/statuses?per_page=1',
      [{ ...status, state: 'failure' }],
      /성공이 아니/,
    ],
    [
      '실행 연결 불일치',
      'deployments/32/statuses?per_page=1',
      [{ ...status, log_url: status.log_url.replace('/21/', '/22/') }],
      /가리키지 않아/,
    ],
    ['조회 실패', 'actions/runs/21', undefined, /조회하거나 기록하지 못/],
  ] as const)('%s면 배포 완료를 보류한다', async (_name, route, value, reason) => {
    const { store } = clockedStore();
    const gate = deploymentGate(store);
    resolveGate(store, gate.id, 'approved', undefined, {
      approvedDeployment: approveDeployment(gate, repo, JSON.stringify(scope)),
    });
    const responses = githubResponses();
    responses.set(`repos/${repo}/${route}`, value);
    const runner: CommandRunner = async (_cmd, args) =>
      responses.get(args[3]!) === undefined
        ? { code: 1, stdout: '', stderr: '' }
        : json(responses.get(args[3]!));
    const { deps: d } = deps({
      deploymentEvidence: (target) => readDeploymentEvidence(target, new GhAccounts(), runner),
    });
    expect((await tick(store, d, { force: true })).warnings).toEqual([
      expect.stringMatching(reason),
    ]);
    expect(store.snapshot.gates[gate.id]?.completion).toBeUndefined();
  });

  it.each([
    [
      '다른 dispatch',
      'ctx_0123abcd',
      { ...ended, dispatchId: 'ctx_abcd0123' },
      false,
      /식별자가 맞지 않아/,
    ],
    ['다른 승인 대상', 'ctx_abcd0123', ended, false, /현재 워커 실행이 달라/],
    ['워크트리 정리 대기', 'ctx_0123abcd', ended, true, /워크트리 정리 증빙/],
    [
      '터미널 정리 대기',
      'ctx_0123abcd',
      { ...ended, terminalState: 'retained' },
      false,
      /터미널 정리/,
    ],
    ['출력 불명', 'ctx_0123abcd', { ...ended, liveness: 'unverifiable' }, false, /종료됐다는 근거/],
    ['조회 실패', 'ctx_0123abcd', undefined, false, /종료 증빙을 조회/],
  ] as const)('%s면 워커 완료를 보류한다', async (_name, handle, observed, removeDone, reason) => {
    const { store } = clockedStore();
    const gate = workerGate(store, handle);
    resolveGate(store, gate.id, 'approved');
    const launcher = fakeLauncher('orca-worktree');
    launcher.launcher.completion = async () => {
      if (!observed) throw new Error('조회 실패');
      return observed;
    };
    const { deps: d } = deps({
      launchers: { 'orca-worktree': launcher.launcher },
      config: { ...config, removeDoneOrcaWorktrees: removeDone },
    });
    expect((await tick(store, d, { force: true })).warnings).toEqual([
      expect.stringMatching(reason),
    ]);
    expect(launcher.released).toEqual([]);
    expect(store.worker('wrk-previous')?.status).toBe('finished');
    expect(store.snapshot.gates[gate.id]?.completion).toBeUndefined();
  });

  it('ORCA가 종료됐더라도 하위 주문이 남아 있으면 조회와 정리를 보류한다', async () => {
    const { store } = clockedStore();
    const gate = workerGate(store);
    store.addOrder(
      order({ id: 'ord-follow-up', parentOrderId: 'ord-worker', status: 'escalated' }),
    );
    resolveGate(store, gate.id, 'approved');
    const launcher = fakeLauncher('orca-worktree');
    launcher.launcher.completion = async () => {
      throw new Error('후속 주문이 남아 있으면 호출하지 않아요');
    };
    const { deps: d } = deps({ launchers: { 'orca-worktree': launcher.launcher } });
    expect((await tick(store, d, { force: true })).warnings).toEqual([
      expect.stringContaining('남은 후속 작업'),
    ]);
    expect(launcher.released).toEqual([]);
    expect(store.snapshot.gates[gate.id]?.completion).toBeUndefined();
  });

  it('Slack 게시에 실패하면 보류하고 게시 증빙이 생긴 뒤 워커 완료를 기록한다', async () => {
    const { store } = clockedStore();
    const cleanup = workerGate(store);
    const { gate: slack } = draftSlack(
      store,
      { orderId: 'ord-worker', channel: 'C123', text: '공유 완료' },
      tempStateDir(),
    );
    resolveGate(store, cleanup.id, 'approved');
    resolveGate(store, slack.id, 'approved');
    const orca = fakeLauncher('orca-worktree');
    let checks = 0;
    orca.launcher.completion = async () => {
      checks++;
      return ended;
    };
    let posted = false;
    const { deps: d } = deps({
      launchers: { 'orca-worktree': orca.launcher },
      slack: {
        post: async (message, delivery) => {
          if (!posted) throw new Error('게시 실패');
          return slackSuccess(message, delivery);
        },
      },
    });
    expect((await tick(store, d, { force: true })).warnings).toEqual([
      expect.stringContaining('Slack 게시가 남아'),
    ]);
    expect(store.worker('wrk-previous')?.status).toBe('finished');
    expect(store.snapshot.gates[cleanup.id]?.completion).toBeUndefined();
    expect(checks).toBe(0);

    posted = true;
    expect((await tick(store, d, { force: true })).slackPosted).toEqual([slack.id]);
    expect(store.snapshot.gates[cleanup.id]?.completion?.evidence.kind).toBe('orca-worker');
    expect(store.worker('wrk-previous')?.status).toBe('released');
    expect(checks).toBe(1);
    expect(orca.released).toEqual([]);
  });

  it('Slack 호스트에 요청만 넘긴 상태는 게시 완료로 보지 않는다', async () => {
    const { store } = clockedStore();
    const cleanup = workerGate(store);
    const { gate: slack } = draftSlack(
      store,
      { orderId: 'ord-worker', channel: 'C123', text: '공유 완료' },
      tempStateDir(),
    );
    resolveGate(store, cleanup.id, 'approved');
    resolveGate(store, slack.id, 'approved');
    const orca = fakeLauncher('orca-worktree');
    orca.launcher.completion = async () => ended;
    const { deps: d } = deps({
      launchers: { 'orca-worktree': orca.launcher },
      slack: { post: async () => ({ enqueue: () => undefined }) },
    });
    for (let i = 0; i < 2; i++) {
      expect((await tick(store, d, { force: true })).warnings).toEqual([
        expect.stringContaining('Slack 게시가 남아'),
      ]);
    }
    expect(store.snapshot.slackPosted[slack.id]).toBe(SLACK_HOST_HANDOFF);
    expect(store.snapshot.gates[cleanup.id]?.completion).toBeUndefined();
    expect(store.worker('wrk-previous')?.status).toBe('finished');
    expect(orca.released).toEqual([]);
  });

  it.each(['slack', 'dispatch'] as const)(
    'Orca 조회 중 다른 저장소가 %s 상태를 갱신하면 증빙을 보류한다',
    async (change) => {
      const { store } = clockedStore();
      const gate = workerGate(store);
      resolveGate(store, gate.id, 'approved');
      const orca = fakeLauncher('orca-worktree');
      orca.launcher.completion = async () => {
        const other = ConductorStore.open(store.dir);
        if (change === 'slack')
          draftSlack(
            other,
            { orderId: 'ord-worker', channel: 'C-fixture', text: '보고' },
            tempStateDir(),
          );
        else other.updateWorker('wrk-previous', { handle: 'ctx_ffff0000' });
        return ended;
      };
      const { deps: d } = deps({ launchers: { 'orca-worktree': orca.launcher } });
      const result = await tick(store, d, { force: true });
      expect(result.warnings).toEqual([
        expect.stringContaining('조회 중 게이트나 워커 상태가 바뀌었어요'),
      ]);
      const restarted = ConductorStore.open(store.dir);
      expect(restarted.snapshot.gates[gate.id]?.completion).toBeUndefined();
      expect(restarted.worker('wrk-previous')?.status).toBe('finished');
      expect(orca.released).toEqual([]);
    },
  );

  it('재생 중 완료 증빙이 다른 dispatch이면 게이트 완료와 워커 해제를 모두 건너뛴다', () => {
    const { store } = clockedStore();
    const gate = workerGate(store);
    resolveGate(store, gate.id, 'approved');
    store.updateWorker('wrk-previous', { handle: 'ctx_ffff0000' });
    appendFileSync(
      join(store.dir, EVENTS_FILE),
      JSON.stringify({
        type: 'gate-completed',
        gateId: gate.id,
        at: store.timestamp(),
        evidence: { kind: 'orca-worker', workerId: 'wrk-previous', ...ended },
      }) + '\n',
    );
    const restarted = ConductorStore.open(store.dir);
    expect(restarted.snapshot.gates[gate.id]?.completion).toBeUndefined();
    expect(restarted.worker('wrk-previous')?.status).toBe('finished');
  });

  it.each([
    '12345.000001',
    'https://example.slack.com/archives/C999/p12345000001',
    'https://example.slack.com/archives/C123/p12345000001',
  ])('이전 Slack 기록 %s를 재생하면 대기하고 확인된 뒤에만 워커를 해제한다', async (legacyRef) => {
    const { store, now } = clockedStore();
    store.addOrder(order({ id: 'ord-normal', status: 'done' }));
    store.startWorker(
      worker('ord-normal', {
        id: 'wrk-normal',
        kind: 'orca-worktree',
        status: 'finished',
        handle: 'ctx_0123abcd',
      }),
    );
    const { gate } = draftSlack(
      store,
      { orderId: 'ord-normal', channel: 'C123', text: '보고', threadTs: '12344.000001' },
      tempStateDir(),
    );
    resolveGate(store, gate.id, 'approved');
    const orca = fakeLauncher('orca-worktree');
    const { deps: d } = deps({ launchers: { 'orca-worktree': orca.launcher } });
    expect((await tick(store, d, { force: true })).warnings).toEqual([
      expect.stringContaining('Slack 게시가 남아'),
    ]);
    expect(orca.released).toEqual([]);
    expect(store.worker('wrk-normal')?.status).toBe('finished');
    store.append({
      type: 'slack-posted',
      at: store.timestamp(),
      gateId: gate.id,
      ref: SLACK_HOST_HANDOFF,
    });
    store.append({
      type: 'slack-posted',
      at: store.timestamp(),
      gateId: gate.id,
      ref: legacyRef,
    });
    await foldEvents(store.dir, { settleMs: 0 });
    const restarted = ConductorStore.open(store.dir, { now });
    expect((await tick(restarted, d, { force: true })).warnings).toEqual([
      expect.stringContaining('이전 Slack 게시 기록에'),
    ]);
    expect(orca.released).toEqual([]);
    const pending = pendingSlackDelivery(restarted, gate.id);
    confirmSlackDelivery(restarted, gate.id, slackSuccess(pending, pending));
    await foldEvents(store.dir, { settleMs: 0 });
    await tick(ConductorStore.open(store.dir, { now }), d, { force: true });
    expect(orca.released).toEqual(['wrk-normal']);
    expect(ConductorStore.open(store.dir).worker('wrk-normal')?.status).toBe('released');
  });

  it.each(['link', 'channel', 'thread', 'delivery'] as const)(
    '직접 Slack 응답의 %s 증빙이 부족하면 다시 열어도 게시 대기에서 멈춘다',
    async (invalid) => {
      const { store, now } = clockedStore();
      const cleanup = workerGate(store);
      const { gate } = draftSlack(
        store,
        {
          orderId: 'ord-worker',
          channel: 'C123',
          text: '공유 완료',
          threadTs: '12344.000001',
        },
        tempStateDir(),
      );
      resolveGate(store, cleanup.id, 'approved');
      resolveGate(store, gate.id, 'approved');
      const orca = fakeLauncher('orca-worktree');
      let checks = 0;
      orca.launcher.completion = async () => {
        checks++;
        return ended;
      };
      let calls = 0;
      const { deps: d } = deps({
        launchers: { 'orca-worktree': orca.launcher },
        slack: {
          post: async (message, delivery) => {
            calls++;
            const result = slackSuccess(message, delivery);
            if (invalid === 'link') return 'https://example.slack.com/archives/C999/p12345000001';
            if (invalid === 'channel') return { ...result, channel: 'C999' };
            if (invalid === 'thread')
              return { ...result, message: { ...result.message, thread_ts: '99999.000001' } };
            return slackSuccess(message, {
              ...delivery,
              metadata: { ...delivery.metadata, event_payload: { delivery_id: 'different' } },
            });
          },
        },
      });
      const first = await tick(store, d, { force: true });
      expect(first.errors).toEqual([expect.stringContaining('게시 실패')]);
      expect(first.slackPosted).toEqual([]);
      const restarted = ConductorStore.open(store.dir, { now });
      const replayed = await tick(restarted, d, { force: true });
      expect(replayed.warnings).toEqual([
        expect.stringContaining('직접 게시 응답에서 승인 범위를 확인하지 못했어요'),
      ]);
      expect(restarted.snapshot.gates[cleanup.id]?.completion).toBeUndefined();
      expect(restarted.worker('wrk-previous')?.status).toBe('finished');
      expect(calls).toBe(1);
      expect(checks).toBe(0);
      expect(orca.released).toEqual([]);
    },
  );

  function replacementWorker(store: ConductorStore) {
    const id = 'ord-superseded';
    store.addOrder(order({ id, status: 'done' }));
    store.startWorker(
      worker(id, { id: 'wrk-superseded', kind: 'orca-worktree', status: 'finished' }),
    );
    return id;
  }

  it.each(['new', 'existing'] as const)(
    '정상 단일 Slack 초안 %s를 교체한 뒤 한 번만 해제한다',
    async (source) => {
      const { store, now } = clockedStore();
      const orderId = replacementWorker(store);
      const { gate } = draftSlack(
        store,
        { orderId, channel: 'C123', text: '이전 본문', threadTs: '12344.000001' },
        tempStateDir(),
      );
      resolveGate(store, gate.id, 'approved');
      const candidate =
        source === 'existing'
          ? draftSlack(
              store,
              {
                orderId,
                channel: 'C123',
                text: '새 본문',
                threadTs: '12344.000001',
              },
              tempStateDir(),
            ).gate
          : undefined;
      writeFileSync(gate.payload!.draftFile!, '새 본문');
      const orca = fakeLauncher('orca-worktree');
      const { deps: d } = deps({
        launchers: { 'orca-worktree': orca.launcher },
        slack: {
          post: async () => {
            throw new Error('승인하지 않은 게시를 호출했어요');
          },
        },
      });
      await tick(store, d, { force: true });
      const replacement = store.snapshot.slackDraftReplacements[gate.id];
      expect(replacement).toMatchObject({
        approvedDeliveryId: slackDeliveryId(store.snapshot.gates[gate.id]!),
      });
      if (candidate) expect(replacement?.replacementGateId).toBe(candidate.id);
      expect(orca.released).toEqual([]);
      await foldEvents(store.dir, { settleMs: 0 });
      const reopened = ConductorStore.open(store.dir, { now });
      expect(reopened.snapshot.slackDraftReplacements[gate.id]).toEqual(replacement);
      expect((await tick(reopened, d, { force: true })).warnings).toEqual([
        expect.stringContaining('초안 승인을 기다리고'),
      ]);
      resolveGate(reopened, replacement!.replacementGateId, 'rejected');
      await foldEvents(store.dir, { settleMs: 0 });
      for (let i = 0; i < 2; i++)
        await tick(ConductorStore.open(store.dir, { now }), d, { force: true });
      expect(orca.released).toEqual(['wrk-superseded']);
    },
  );

  it.each(['unrelated', 'missing', 'mismatch', 'field'] as const)(
    'Slack 초안 교체 증빙 %s는 이벤트 재생과 압축 뒤에도 게시 의무를 유지한다',
    async (variant) => {
      const { store, now } = clockedStore();
      const orderId = replacementWorker(store);
      const draft = { orderId, channel: 'C123', text: '이전 본문', threadTs: '12344.000001' };
      const { gate } = draftSlack(store, draft, tempStateDir());
      const { gate: other } = draftSlack(
        store,
        {
          ...draft,
          channel: variant === 'unrelated' ? 'C999' : draft.channel,
          text: '새 본문',
        },
        tempStateDir(),
      );
      const proof = {
        replacementGateId: other.id,
        approvedDeliveryId: slackDeliveryId({ ...gate, resolvedAt: store.timestamp() }),
        previousDigest: gate.payload?.digest,
        replacementDigest: other.payload?.digest,
      };
      if (variant === 'field') {
        appendFileSync(
          join(store.dir, EVENTS_FILE),
          JSON.stringify({
            type: 'gate-opened',
            at: store.timestamp(),
            gate: { ...gate, slackReplacement: proof },
          }) + '\n',
        );
        store.reload();
      }
      resolveGate(store, gate.id, 'approved');
      if (variant === 'mismatch') {
        appendFileSync(
          join(store.dir, EVENTS_FILE),
          JSON.stringify({
            type: 'slack-draft-replaced',
            at: store.timestamp(),
            gateId: gate.id,
            replacement: {
              ...proof,
              replacementDigest: 'unrelated-digest',
            },
          }) + '\n',
        );
        store.reload();
      }
      resolveGate(store, other.id, 'rejected');
      store.append({
        type: 'slack-posted',
        at: store.timestamp(),
        gateId: gate.id,
        ref: `${SUPERSEDED_PREFIX}${other.id}`,
      });
      const orca = fakeLauncher('orca-worktree');
      const { deps: d } = deps({ launchers: { 'orca-worktree': orca.launcher } });
      for (let i = 0; i < 2; i++) {
        const reopened = ConductorStore.open(store.dir, { now });
        expect((await tick(reopened, d, { force: true })).warnings).toEqual([
          expect.stringContaining('초안 교체 증빙을 확인하지 못했어요'),
        ]);
        expect(reopened.snapshot.slackDraftReplacements[gate.id]).toBeUndefined();
        expect(reopened.worker('wrk-superseded')?.status).toBe('finished');
        expect(orca.released).toEqual([]);
        await foldEvents(store.dir, { settleMs: 0 });
        if (variant === 'field' && i === 0) {
          const file = join(store.dir, BASE_FILE);
          const base = JSON.parse(readFileSync(file, 'utf8')) as BaseFile;
          Object.assign(base.state.gates[gate.id]!, { slackReplacement: proof });
          Reflect.deleteProperty(base.state, 'slackDraftReplacements');
          writeFileSync(file, JSON.stringify(base));
        }
      }
      const reopened = ConductorStore.open(store.dir, { now });
      const pending = pendingSlackDelivery(reopened, gate.id);
      confirmSlackDelivery(reopened, gate.id, slackSuccess(pending, pending));
      await tick(reopened, d, { force: true });
      expect(orca.released).toEqual(['wrk-superseded']);
    },
  );

  it.each(['tick', 'replay'] as const)(
    '복수 Slack 초안 후보를 %s에서 발견하면 두 후보가 닫힌 뒤에도 교체를 보류한다',
    async (source) => {
      const { store, now } = clockedStore();
      const orderId = replacementWorker(store);
      const draft = { orderId, channel: 'C123', text: '이전 본문', threadTs: '12344.000001' };
      const { gate } = draftSlack(store, draft, tempStateDir());
      const approved = resolveGate(store, gate.id, 'approved');
      const { gate: candidate } = draftSlack(store, { ...draft, text: '새 본문' }, tempStateDir());
      const duplicate = {
        ...candidate,
        id: 'gate-duplicate',
        payload: { ...candidate.payload, draftFile: join(tempStateDir(), 'duplicate.md') },
      };
      writeFileSync(duplicate.payload.draftFile, '새 본문');
      store.openGate(duplicate);
      writeFileSync(gate.payload!.draftFile!, '새 본문');
      const orca = fakeLauncher('orca-worktree');
      let posts = 0;
      const { deps: d } = deps({
        launchers: { 'orca-worktree': orca.launcher },
        slack: {
          post: async () => {
            posts++;
            throw new Error('게시를 호출했어요');
          },
        },
      });
      if (source === 'tick') {
        expect((await tick(store, d, { force: true })).errors).toEqual([
          expect.stringContaining('교체 후보가 여러 개'),
        ]);
      } else {
        appendFileSync(
          join(store.dir, EVENTS_FILE),
          JSON.stringify({
            type: 'slack-draft-replaced',
            at: store.timestamp(),
            gateId: gate.id,
            replacement: {
              replacementGateId: candidate.id,
              approvedDeliveryId: slackDeliveryId(approved),
              previousDigest: gate.payload?.digest,
              replacementDigest: candidate.payload?.digest,
            },
          }) + '\n',
        );
        store.reload();
      }
      resolveGate(store, candidate.id, 'rejected');
      resolveGate(store, duplicate.id, 'rejected');
      await foldEvents(store.dir, { settleMs: 0 });
      const reopened = ConductorStore.open(store.dir, { now });
      expect((await tick(reopened, d, { force: true })).warnings).toEqual([
        expect.stringContaining('교체 후보가 여러 개'),
      ]);
      expect(reopened.snapshot.slackDraftReplacements[gate.id]).toBeUndefined();
      expect(reopened.worker('wrk-superseded')?.status).toBe('finished');
      expect(reopened.openGates()).toEqual([]);
      expect(orca.released).toEqual([]);
      expect(posts).toBe(0);
    },
  );

  it('Slack 게시 의무가 없는 워커는 저장소를 다시 열어도 한 번만 해제한다', async () => {
    const { store, now } = clockedStore();
    replacementWorker(store);
    const orca = fakeLauncher('orca-worktree');
    const { deps: d } = deps({ launchers: { 'orca-worktree': orca.launcher } });
    await tick(store, d, { force: true });
    await foldEvents(store.dir, { settleMs: 0 });
    await tick(ConductorStore.open(store.dir, { now }), d, { force: true });
    expect(orca.released).toEqual(['wrk-superseded']);
  });

  it('워크트리까지 정리해야 한다면 같은 워크트리가 없어졌는지 읽기 요청으로 확인한다', async () => {
    const { store } = clockedStore();
    const gate = workerGate(store);
    resolveGate(store, gate.id, 'approved');
    const workspace = 'repo-fixture::/tmp/orca-fixture/ord-worker-1';
    const calls: string[][] = [];
    const runner: CommandRunner = async (_cmd, args) => {
      calls.push(args);
      if (args[0] === 'orchestration') return json({ ok: true, result: { ...ended, workspace } });
      return { ...json({ ok: false, error: { code: 'selector_not_found' } }), code: 1 };
    };
    const { deps: d } = deps({
      launchers: {
        'orca-worktree': new OrcaLauncher({
          orcaCommand: 'orca',
          promptDir: tempStateDir(),
          runner,
        }),
      },
      config: { ...config, removeDoneOrcaWorktrees: true },
    });
    expect((await tick(store, d, { force: true })).warnings).toEqual([]);
    expect(calls).toEqual([
      ['orchestration', 'worker-show', '--dispatch=ctx_0123abcd', '--json'],
      ['worktree', 'show', '--worktree', `id:${workspace}`, '--json'],
    ]);
    expect(store.snapshot.gates[gate.id]?.completion?.evidence).toMatchObject({
      removedWorkspace: workspace,
    });
  });
});

describe('컨덕터 tick', () => {
  it('동시 상한을 넘는 주문은 큐에 남았다가 자리가 나면 뜬다', async () => {
    const { store } = clockedStore();
    for (let i = 0; i < 3; i++) store.addOrder(order({ id: `ord-${i}` }));
    const { deps: d, git } = deps();

    const first = await tick(store, d, { force: true });
    expect(first.launched.map((l) => l.orderId)).toEqual(['ord-0', 'ord-1']);
    expect(first.counts).toMatchObject({ queued: 1, running: 2, activeWorkers: 2 });

    report(store, d, { workerId: store.order('ord-0')!.workerId!, status: 'done', merged: true });
    const second = await tick(store, d, { force: true });
    expect(second.launched.map((l) => l.orderId)).toEqual(['ord-2']);
    expect(store.order('ord-0')!.status).toBe('done');
    expect(git.released).toEqual([store.order('ord-0')!.workerId]);
    expect(store.worker(store.order('ord-0')!.workerId!)!.status).toBe('released');
  });

  it('상태가 안 바뀐 tick을 idleTicks로 이어 세고 변화가 생기면 0으로 돌린다', async () => {
    const { store, dir } = clockedStore();
    store.addOrder(order({ id: 'ord-0' }));
    const { deps: d } = deps();

    expect((await tick(store, d, { force: true })).idleTicks).toBe(0);
    expect((await tick(store, d, { force: true })).idleTicks).toBe(1);
    expect((await tick(store, d, { force: true })).idleTicks).toBe(2);
    expect((await tick(store, d)).skipped).toBe(true);
    expect((await tick(store, d)).idleTicks).toBe(2);
    expect(ConductorStore.open(dir).snapshot.idleTicks).toBe(2);

    // tick 사이에 워커 보고 같은 이벤트가 쌓였으면 그 뒤 tick은 변화가 있었던 tick이다
    store.saveCheckpoint({
      orderId: 'ord-0',
      workerId: store.order('ord-0')!.workerId!,
      skill: 'solve',
      next: '구현',
      completedSkills: [],
      refs: [],
      savedAt: store.timestamp(),
    });
    expect((await tick(store, d, { force: true })).idleTicks).toBe(0);
    expect((await tick(store, d, { force: true })).idleTicks).toBe(1);

    store.addOrder(order({ id: 'ord-1' }));
    const r = await tick(store, d, { force: true });
    expect(r.launched.map((l) => l.orderId)).toEqual(['ord-1']);
    expect(r.idleTicks).toBe(0);
  });

  it('사람이 넘겨받은 주문의 PR을 확인만 하고 바뀐 게 없는 tick은 idle로 센다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-0', status: 'human-owned', prRef: 'acme/app#7' }));
    store.updateOrder('ord-0', { humanOwnedAt: store.timestamp() });
    let checks = 0;
    const { deps: d } = deps({
      config: { ...config, humanOwnedPollSec: 0 },
      prState: {
        state: async () => {
          checks += 1;
          return { state: 'OPEN' };
        },
      },
    });

    expect((await tick(store, d, { force: true })).idleTicks).toBe(0);
    expect((await tick(store, d, { force: true })).idleTicks).toBe(1);
    expect((await tick(store, d, { force: true })).idleTicks).toBe(2);
    expect(checks).toBe(3);
  });

  it('보고를 적용한 tick은 idle이 아니고 다시 열어도 같은 값이다', async () => {
    const { store, dir } = clockedStore();
    store.addOrder(order({ id: 'ord-0' }));
    const { deps: d } = deps();
    await tick(store, d, { force: true });
    await tick(store, d, { force: true });
    expect((await tick(store, d, { force: true })).idleTicks).toBe(2);

    report(store, d, { workerId: store.order('ord-0')!.workerId!, status: 'progress' });
    const applied = await tick(store, d, { force: true });
    expect(applied.idleTicks).toBe(0);
    expect(ConductorStore.open(dir).snapshot.idleTicks).toBe(0);
    expect((await tick(store, d, { force: true })).idleTicks).toBe(1);
    expect(ConductorStore.open(dir).snapshot.idleTicks).toBe(1);
  });

  it('오류만 반복되는 tick은 idle로 세지 않는다', async () => {
    const { store } = clockedStore();
    const { deps: d } = deps({
      queue: {
        receive: async () => {
          throw new Error('큐에 못 붙어요');
        },
        ack: async () => {},
      },
    });
    for (let i = 0; i < 3; i++) {
      const r = await tick(store, d, { force: true });
      expect(r.errors).toContain('큐에 못 붙어요');
      expect(r.idleTicks).toBe(0);
    }
  });

  it('잠금에 막혀 건너뛴 tick도 마지막 idleTicks를 싣는다', async () => {
    const { store, dir } = clockedStore();
    const { deps: d } = deps();
    await tick(store, d, { force: true });
    expect((await tick(store, d, { force: true })).idleTicks).toBe(1);
    writeFileSync(join(dir, 'tick.lock'), `${process.pid}:${Date.now()}:${hostname()}:x`);
    const r = await tick(store, d, { force: true });
    expect(r.skipped).toBe(true);
    expect(r.idleTicks).toBe(1);
  });

  it('런처가 남긴 경고를 tick 보고에 싣는다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-0', parentWorktree: '/w/feat' }));
    const { deps: d, git } = deps();
    git.launcher.start = async (spec) => ({
      handle: `h-${spec.worker.id}`,
      warnings: ['부모 워크트리를 무시했어요'],
    });
    const r = await tick(store, d, { force: true });
    expect(r.warnings).toEqual(['부모 워크트리를 무시했어요']);
  });

  it('주문 범위대로 머지 승인을 넘기거나 사람에게 올린다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-auto', scope: 'merge-through' }));
    store.addOrder(order({ id: 'ord-ask', scope: 'approval' }));
    const { deps: d, git } = deps();
    await tick(store, d, { force: true });

    for (const id of ['ord-auto', 'ord-ask']) {
      report(store, d, {
        workerId: store.order(id)!.workerId!,
        status: 'needs',
        need: { kind: 'merge-approval', detail: '머지해도 될까요' },
      });
    }
    const r = await tick(store, d, { force: true });
    expect(r.errors).toEqual([]);
    expect(git.sent.map((s) => s.workerId)).toEqual([store.order('ord-auto')!.workerId]);
    expect(git.sent[0]!.message).toContain('이어서 진행하세요');

    const gates = store.openGates('ord-ask');
    expect(gates.map((g) => g.type)).toEqual(['merge']);
    expect(store.order('ord-ask')!.status).toBe('waiting-gate');

    const closed = resolveGate(store, gates[0]!.id, 'approved');
    await deliverGateDecision(store, closed, d);
    expect(git.sent.at(-1)!.workerId).toBe(store.order('ord-ask')!.workerId);
  });

  it('사람 확인 자리가 아닌 요청은 기본 절차로 넘기고 절차가 없을 때만 올린다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-app', repo: 'acme/app' }));
    store.addOrder(order({ id: 'ord-etc', repo: 'acme/etc' }));
    const switched: string[] = [];
    const { deps: d, git } = deps({
      config: { ...config, accounts: { 'acme/app': 'work' } },
      accounts: {
        current: async () => 'work',
        switchTo: async (repo, a) => void switched.push(`${repo}:${a}`),
      },
    });
    await tick(store, d, { force: true });

    const ask = (id: string, kind: string, step?: string) =>
      report(store, d, {
        workerId: store.order(id)!.workerId!,
        status: 'needs',
        need: { kind, detail: '부탁해요', ...(step ? { step } : {}) },
      });
    ask('ord-app', 'simple-approval', 'ship-draft');
    await tick(store, d, { force: true });
    ask('ord-app', 'account-switch');
    ask('ord-etc', 'auth');
    await tick(store, d, { force: true });

    expect(git.sent.map((s) => s.workerId)).toEqual([
      store.order('ord-app')!.workerId,
      store.order('ord-app')!.workerId,
    ]);
    expect(switched).toEqual(['acme/app:work']);
    expect(store.openGates('ord-app')).toEqual([]);
    expect(store.openGates('ord-etc').map((g) => g.type)).toEqual(['no-procedure']);
  });

  it('PR 없는 레포 스킬 체인은 태그 푸시 전에 사람을 거치고 done 보고로 끝난다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-rel', scope: 'merge-through', skillChain: ['repo:release'] }));
    const { deps: d, git } = deps();
    await tick(store, d, { force: true });
    const workerId = store.order('ord-rel')!.workerId!;
    expect(store.worker(workerId)!.kind).not.toBe('subagent');

    report(store, d, {
      workerId,
      status: 'needs',
      need: { kind: 'simple-approval', detail: 'v1.2.0 태그 푸시', step: 'ship-ready' },
    });
    await tick(store, d, { force: true });
    expect(git.sent).toEqual([]);
    const gates = store.openGates('ord-rel');
    expect(gates.map((g) => g.type)).toEqual(['no-procedure']);
    expect(store.order('ord-rel')!.status).toBe('waiting-gate');
    expect(store.snapshot.bypasses).toEqual([]);

    const closed = resolveGate(store, gates[0]!.id, 'approved');
    await deliverGateDecision(store, closed, d);
    expect(git.sent.at(-1)!.workerId).toBe(workerId);

    report(store, d, { workerId, status: 'done', summary: 'v1.2.0 배포' });
    await tick(store, d, { force: true });
    expect(store.order('ord-rel')).toMatchObject({ status: 'done' });
    expect(store.order('ord-rel')!.mergedAt).toBeUndefined();
  });

  it('주문 설명과 레포 공통 맥락 경로가 prompts/의 워커 지시 파일에 들어간다', async () => {
    const { store } = clockedStore();
    const description = ['## 배경', '긴 대화에서 나온 요구사항', '- 참고: docs/a.md'].join('\n');
    store.addOrder(order({ id: 'ord-ctx', description, skillChain: ['review'] }));
    store.addOrder(order({ id: 'ord-none', repo: 'acme/other', skillChain: ['review'] }));
    const contextFile = repoContextPath(resolve(store.dir), 'acme/app');
    mkdirSync(join(store.dir, 'context', 'acme'), { recursive: true });
    writeFileSync(contextFile, '배포는 태그 푸시로 한다\n');
    const sub = new SubagentLauncher({ promptDir: join(store.dir, 'prompts') });
    const { deps: d } = deps({ launchers: { subagent: sub } });

    const r = await tick(store, d, { force: true });
    const files = r.hostActions.flatMap((a) => (a.type === 'spawn-subagent' ? [a] : []));
    const promptOf = (orderId: string) => {
      const a = files.find((f) => f.workerId === store.order(orderId)!.workerId)!;
      expect(a.promptFile.startsWith(join(store.dir, 'prompts'))).toBe(true);
      return readFileSync(a.promptFile, 'utf-8');
    };
    const withContext = promptOf('ord-ctx');
    expect(withContext).toContain(description);
    expect(withContext).toContain(`- 레포 공통 맥락: ${contextFile}`);
    expect(promptOf('ord-none')).not.toContain('레포 공통 맥락');
  });

  it('런처가 쓴 브랜치를 워커 기록에 남기고 재개 때 앞 브랜치로 넘긴다', async () => {
    const { store, advance } = clockedStore();
    store.addOrder(order({ id: 'ord-1', issueKey: 'PROJ-1' }));
    const g = fakeLauncher('git-worktree');
    const start = g.launcher.start;
    g.launcher.start = async (spec) => ({
      ...(await start(spec)),
      branch: spec.previousBranch ?? 'feat/PROJ-1-2',
    });
    const { deps: d } = deps({ launchers: { 'git-worktree': g.launcher } });
    await tick(store, d, { force: true });
    const first = store.order('ord-1')!.workerId!;
    expect(store.worker(first)!.branch).toBe('feat/PROJ-1-2');
    expect(g.started[0]!.previousBranch).toBeUndefined();
    expect(g.started[0]!.previousWorker).toBeUndefined();

    advance(16 * 60 * 1000);
    await tick(store, d, { force: true });
    const second = store.order('ord-1')!.workerId!;
    expect(second).not.toBe(first);
    expect(g.started.at(-1)!.previousBranch).toBe('feat/PROJ-1-2');
    expect(g.started.at(-1)!.previousWorker).toEqual({
      orderId: g.started[0]!.worker.orderId,
      attempt: 1,
    });
    expect(store.worker(second)!.branch).toBe('feat/PROJ-1-2');
    // 로그를 처음부터 재생해도 같은 브랜치가 나온다
    expect(replay(join(store.dir, EVENTS_FILE)).workers[second]!.branch).toBe('feat/PROJ-1-2');
  });

  it('런처가 브랜치를 못 돌려주면 재개한 워커 기록에 앞 브랜치를 채우지 않는다', async () => {
    const { store, advance } = clockedStore();
    store.addOrder(order({ id: 'ord-1', issueKey: 'PROJ-1' }));
    const g = fakeLauncher('git-worktree');
    const start = g.launcher.start;
    g.launcher.start = async (spec) => {
      const r = await start(spec);
      return spec.previousBranch === undefined ? { ...r, branch: 'feat/PROJ-1' } : r;
    };
    const { deps: d } = deps({ launchers: { 'git-worktree': g.launcher } });
    await tick(store, d, { force: true });
    advance(16 * 60 * 1000);
    await tick(store, d, { force: true });
    const second = store.order('ord-1')!.workerId!;
    expect(g.started.at(-1)!.previousBranch).toBe('feat/PROJ-1');
    expect(store.worker(second)!.branch).toBeUndefined();
    expect(replay(join(store.dir, EVENTS_FILE)).workers[second]!.branch).toBeUndefined();
  });

  it('소식이 끊긴 워커는 체크포인트부터 같은 워커 식별자로 다시 띄운다', async () => {
    const { store, advance } = clockedStore();
    store.addOrder(order({ id: 'ord-1' }));
    const { deps: d, git } = deps();
    await tick(store, d, { force: true });
    const first = store.order('ord-1')!.workerId!;

    advance(16 * 60 * 1000);
    const r = await tick(store, d, { force: true });
    expect(store.worker(first)!.status).toBe('stopped');
    expect(r.launched).toEqual([expect.objectContaining({ orderId: 'ord-1', resumed: true })]);
    expect(git.started.at(-1)!.previousHandle).toBe(`h-${first}`);
    expect(git.started.at(-1)!.prompt).toContain('남은 체인');

    // 앞 워커가 늦게 보낸 결과는 주문을 건드리지 않는다
    report(store, d, { workerId: first, status: 'done', merged: true });
    const late = await tick(store, d, { force: true });
    expect(late.errors.join()).toContain('앞 워커');
    expect(store.order('ord-1')!.status).toBe('running');
  });

  it('지라 주문은 단계마다 옮기고 배포가 성공해야 In-QA로 끝낸다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-bug', issueKey: 'APP-1', issueType: 'bug' }));
    const jira = fakeJira();
    let deploy: DeploySignal = { status: 'pending' };
    const { deps: d } = deps({ jira: jira.client, deploy: { status: async () => deploy } });

    await tick(store, d, { force: true });
    const wid = store.order('ord-bug')!.workerId!;
    report(store, d, { workerId: wid, status: 'progress', prRef: 'acme/app#5' });
    await tick(store, d, { force: true });
    report(store, d, { workerId: wid, status: 'done', merged: true });
    await tick(store, d, { force: true });
    expect(store.order('ord-bug')!.status).toBe('merged');

    deploy = { status: 'success', ref: 'deploy-7' };
    await tick(store, d, { force: true });
    expect(store.order('ord-bug')!.status).toBe('done');
    expect(jira.moves.map((m) => m.to)).toEqual(['TODO', 'In Progress', 'PR', 'In-QA']);
  });

  it.each([true, false])(
    '배포 대기 기한이 지나면 지라 이동 없이 끝낸다 (mergedAt: %s)',
    async (hasMergedAt) => {
      const { store, advance } = clockedStore();
      const jira = fakeJira();
      const { deps: d } = deps({
        config: { ...config, deployWaitMaxSec: 120 },
        jira: jira.client,
        deploy: { status: async () => ({ status: 'pending' }) },
      });
      const anchor = store.timestamp();
      if (hasMergedAt) advance(30_000);
      store.addOrder(
        order({
          id: 'ord-bug',
          issueKey: 'APP-1',
          issueType: 'bug',
          status: 'merged',
          updatedAt: store.timestamp(),
          ...(hasMergedAt ? { mergedAt: anchor } : {}),
        }),
      );

      expect((await tick(store, d, { force: true })).warnings).toEqual([]);
      expect(store.order('ord-bug')?.status).toBe('merged');
      advance(hasMergedAt ? 90_000 : 120_000);
      const expired = await tick(store, d, { force: true });
      expect(store.order('ord-bug')).toMatchObject({ status: 'done' });
      expect(store.order('ord-bug')?.deployedAt).toBeUndefined();
      expect(expired.warnings).toEqual([expect.stringContaining('ord-bug: 배포 신호')]);
      expect(expired.escalated).toEqual([]);
      expect(jira.moves).toEqual([]);
    },
  );

  it('지라 담당 티켓이 페이지 상한에 닿으면 tick 결과에 남긴다', async () => {
    const { store } = clockedStore();
    const { deps: d } = deps({
      jiraSource: { fetchAssigned: async () => ({ tickets: [], truncated: true }) },
    });
    const r = await tick(store, d, { force: true });
    expect(r.errors.some((e) => e.includes('페이지 상한'))).toBe(true);
  });

  it('배포가 실패하면 그 주문만 사람에게 올린다', async () => {
    const { store } = clockedStore();
    store.addOrder(
      order({ id: 'ord-bug', issueKey: 'APP-2', issueType: 'task', status: 'merged' }),
    );
    const { deps: d } = deps({
      deploy: { status: async () => ({ status: 'failed', ref: 'run-9' }) },
    });
    const r = await tick(store, d, { force: true });
    expect(store.order('ord-bug')!.status).toBe('escalated');
    expect(store.snapshot.gates[r.escalated[0]!]!.refs).toEqual(['run-9']);
  });

  it('워커가 하위 워커를 원하면 컨덕터가 새 주문으로 받는다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-1' }));
    const { deps: d } = deps();
    await tick(store, d, { force: true });
    report(store, d, {
      workerId: store.order('ord-1')!.workerId!,
      status: 'progress',
      spawnRequest: { title: '마이그레이션 분리', detail: '스키마 변경만 따로 PR로' },
    });
    const r = await tick(store, d, { force: true });
    expect(r.created).toHaveLength(1);
    expect(r.launched.map((l) => l.orderId)).toEqual(r.created);
  });

  it('지운 하위 주문도 상한에 세고 같은 요청으로 다시 만들지 않는다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-1' }));
    const { deps: d } = deps({ config: { ...config, maxConcurrentWorkers: 1 } });
    await tick(store, d, { force: true });
    const wid = store.order('ord-1')!.workerId!;
    const ask = (title: string) =>
      report(store, d, {
        workerId: wid,
        status: 'progress',
        spawnRequest: { title, detail: '따로' },
      });
    ask('하위 0');
    const [first] = (await tick(store, d, { force: true })).created;
    store.updateOrder(first!, { status: 'cancelled' });
    store.removeOrder(first!);

    for (let i = 0; i < MAX_SPAWN_PER_ORDER; i++) ask(`하위 ${i}`);
    const r = await tick(store, d, { force: true });
    expect(r.created.map((id) => store.order(id)!.title).sort()).toEqual(
      Array.from({ length: MAX_SPAWN_PER_ORDER - 1 }, (_, i) => `하위 ${i + 1}`),
    );
  });

  it('런처가 없거나 실패하면 그 주문만 올리고 나머지는 띄운다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-orca', workerKind: 'subagent' }));
    store.addOrder(order({ id: 'ord-git' }));
    const { deps: d } = deps();
    const r = await tick(store, d, { force: true });
    expect(r.launched.map((l) => l.orderId)).toEqual(['ord-git']);
    expect(r.escalated).toHaveLength(1);
    expect(store.snapshot.gates[r.escalated[0]!]!.reason).toContain('subagent');
  });

  it('merge-through 주문의 하위 주문은 approval로 낮추고 주문당 상한을 넘으면 워커에 거절을 알린다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-1', scope: 'merge-through' }));
    const { deps: d, git } = deps({ config: { ...config, maxConcurrentWorkers: 1 } });
    await tick(store, d, { force: true });
    const wid = store.order('ord-1')!.workerId!;
    for (let i = 0; i <= MAX_SPAWN_PER_ORDER; i++) {
      report(store, d, {
        workerId: wid,
        status: 'progress',
        spawnRequest: { title: `하위 ${i}`, detail: '따로 PR로' },
      });
    }
    const r = await tick(store, d, { force: true });
    expect(r.created).toHaveLength(MAX_SPAWN_PER_ORDER);
    expect(r.created.map((id) => store.order(id)!.scope)).toEqual(
      Array(MAX_SPAWN_PER_ORDER).fill('approval'),
    );
    expect(r.created.map((id) => store.order(id)!.parentOrderId)).toEqual(
      Array(MAX_SPAWN_PER_ORDER).fill('ord-1'),
    );
    expect(r.escalated).toEqual([]);
    expect(r.errors.join()).toContain('거절');
    expect(git.sent.filter((m) => m.workerId === wid).at(-1)?.message).toContain(
      '하위 주문을 만들지 않았어요',
    );
  });

  it('하위 주문의 워커는 하위 주문을 더 만들지 못한다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-child', parentOrderId: 'ord-1' }));
    const { deps: d, git } = deps();
    await tick(store, d, { force: true });
    const wid = store.order('ord-child')!.workerId!;
    report(store, d, {
      workerId: wid,
      status: 'progress',
      spawnRequest: { title: '손자', detail: 'x' },
    });
    const r = await tick(store, d, { force: true });
    expect(r.created).toEqual([]);
    expect(git.sent.at(-1)?.message).toContain('하위 주문을 만들지 않았어요');
  });

  // root는 권한과 무관하게 지울 수 있어 지우기 실패를 흉내낼 수 없다
  it.skipIf(process.getuid?.() === 0)(
    '한 번 적용한 보고 파일은 지우지 못해 남아 있어도 다시 적용하지 않고 지운 뒤에는 기록에서 뺀다',
    async () => {
      const { store } = clockedStore();
      store.addOrder(order({ id: 'ord-1' }));
      const { deps: d, git } = deps();
      await tick(store, d, { force: true });
      const wid = store.order('ord-1')!.workerId!;
      report(store, d, {
        workerId: wid,
        status: 'needs',
        need: { kind: 'simple-approval', detail: '부탁해요', step: 'ship-draft' },
        spawnRequest: { title: '하위', detail: 'x' },
      });
      const inbox = inboxDirOf(store, d);
      const name = readdirSync(inbox).find((f) => f.endsWith('.json'))!;

      chmodSync(inbox, 0o555);
      try {
        const first = await tick(store, d, { force: true });
        expect(first.errors.some((e) => e.includes('못 지웠어요'))).toBe(true);
        expect(store.snapshot.appliedReports[name]).toBeDefined();
        const orders = store.orders().length;
        const sent = git.sent.length;

        await tick(store, d, { force: true });
        expect(store.orders()).toHaveLength(orders);
        expect(git.sent).toHaveLength(sent);
        expect(store.snapshot.appliedReports[name]).toBeDefined();
      } finally {
        chmodSync(inbox, 0o755);
      }

      const orders = store.orders().length;
      const r = await tick(store, d, { force: true });
      expect(r.errors).toEqual([]);
      expect(store.orders()).toHaveLength(orders);
      expect(existsSync(join(inbox, name))).toBe(false);
      expect(store.snapshot.appliedReports[name]).toBeUndefined();
      // 다시 연 저장소도 이벤트를 다시 읽어 같은 기록을 얻는다
      expect(ConductorStore.open(store.dir).snapshot.appliedReports[name]).toBeUndefined();
    },
  );

  it('need가 없는 needs 보고는 적용하지 않고 원문을 failed로 옮긴다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-1' }));
    const { deps: d, git } = deps();
    await tick(store, d, { force: true });
    const inbox = inboxDirOf(store, d);
    // writeReport는 need 없는 needs를 받지 않아 파일을 직접 쓴다
    mkdirSync(inbox, { recursive: true });
    writeFileSync(
      join(inbox, 'manual.json'),
      JSON.stringify({
        workerId: store.order('ord-1')!.workerId,
        status: 'needs',
        summary: '부탁해요',
        refs: [],
      }),
    );
    const r = await tick(store, d, { force: true });
    expect(r.errors.some((e) => e.includes('manual.json'))).toBe(true);
    expect(git.sent).toEqual([]);
    expect(store.snapshot.appliedReports['manual.json']).toBeUndefined();
    expect(existsSync(join(inbox, 'failed', 'manual.json'))).toBe(true);
  });

  it('같은 tick에 온 워커 보고의 PR은 PR 감시가 새 주문으로 받지 않는다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-1', repo: 'acme/app' }));
    const prSource = {
      authored: async () => [
        {
          repo: 'acme/app',
          title: '배너',
          headSha: 'b',
          ref: 'acme/app#5',
          latestOtherCommentId: 'c1',
        },
      ],
      reviewing: async () => [],
    };
    const { deps: d } = deps();
    await tick(store, d, { force: true });
    report(store, d, {
      workerId: store.order('ord-1')!.workerId!,
      status: 'progress',
      prRef: 'acme/app#5',
    });
    const r = await tick(store, { ...d, prSource }, { force: true });
    expect(r.created).toEqual([]);
    expect(store.orders()).toHaveLength(1);
    expect(store.order('ord-1')!.prRef).toBe('acme/app#5');
  });

  describe('머지된 주문의 오르카 워크트리 정리', () => {
    function orcaRelease(fail?: (w: Worker) => boolean) {
      const calls: { id: string; opts?: ReleaseOptions }[] = [];
      const launcher: Launcher = {
        kind: 'orca-worktree',
        start: async (spec) => ({ handle: `h-${spec.worker.id}` }),
        send: async () => undefined,
        release: async (w, opts) => {
          if (fail?.(w)) throw new Error('커밋 안 한 변경이 있어요');
          calls.push({ id: w.id, ...(opts ? { opts } : {}) });
        },
      };
      return { launcher, calls };
    }

    function addWorker(store: ConductorStore, over: Partial<Worker>) {
      store.startWorker({
        ...worker(over.orderId ?? 'ord-1'),
        kind: 'orca-worktree',
        handle: 'ctx',
        ...over,
      });
    }

    it('옵션을 켜면 머지된 주문의 모든 회차 워크트리를 지우고 부모 워크트리를 넘긴다', async () => {
      const { store } = clockedStore();
      store.addOrder(
        order({
          id: 'ord-1',
          status: 'done',
          mergedAt: '2026-01-01T00:00:00.000Z',
          parentWorktree: '/ws/feat',
          workerId: 'wrk-2',
        }),
      );
      addWorker(store, { id: 'wrk-1', attempt: 1, status: 'stopped', stopReason: 'disconnected' });
      addWorker(store, { id: 'wrk-2', attempt: 2, status: 'finished' });
      const orca = orcaRelease();
      const { deps: d } = deps({
        config: { ...config, removeMergedOrcaWorktrees: true },
        launchers: { 'orca-worktree': orca.launcher },
      });
      await tick(store, d, { force: true });
      expect(orca.calls.map((c) => c.id).sort()).toEqual(['wrk-1', 'wrk-2']);
      for (const c of orca.calls)
        expect(c.opts).toEqual({ removeWorktree: true, parentWorktree: '/ws/feat' });
      expect(store.worker('wrk-1')!.status).toBe('released');
      expect(store.worker('wrk-2')!.status).toBe('released');
    });

    it('옵션이 꺼져 있으면 멈춘 앞 회차까지 터미널만 거두고 워크트리는 남긴다', async () => {
      const { store } = clockedStore();
      store.addOrder(order({ id: 'ord-1', status: 'done', mergedAt: '2026-01-01T00:00:00.000Z' }));
      addWorker(store, { id: 'wrk-1', attempt: 1, status: 'stopped' });
      addWorker(store, { id: 'wrk-2', attempt: 2, status: 'finished' });
      const orca = orcaRelease();
      const { deps: d } = deps({ launchers: { 'orca-worktree': orca.launcher } });
      await tick(store, d, { force: true });
      expect(orca.calls.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: 'wrk-1', opts: {} },
        { id: 'wrk-2', opts: {} },
      ]);
      expect(store.worker('wrk-1')!.status).toBe('released');
    });

    it('removeDoneOrcaWorktrees를 켜면 머지 없이 done인 주문은 브랜치를 남기고 워크트리를 지운다', async () => {
      const { store } = clockedStore();
      store.addOrder(order({ id: 'ord-1', status: 'done', workerId: 'wrk-2' }));
      store.addOrder(order({ id: 'ord-2', status: 'failed' }));
      store.addOrder(order({ id: 'ord-3', status: 'cancelled' }));
      addWorker(store, { id: 'wrk-1', attempt: 1, status: 'stopped' });
      addWorker(store, { id: 'wrk-2', attempt: 2, status: 'finished' });
      addWorker(store, { id: 'wrk-3', orderId: 'ord-2', status: 'failed' });
      addWorker(store, { id: 'wrk-4', orderId: 'ord-3', status: 'stopped' });
      const orca = orcaRelease();
      const { deps: d } = deps({
        config: { ...config, removeDoneOrcaWorktrees: true },
        launchers: { 'orca-worktree': orca.launcher },
      });
      await tick(store, d, { force: true });
      expect(orca.calls.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: 'wrk-1', opts: { removeWorktree: true, keepBranch: true } },
        { id: 'wrk-2', opts: { removeWorktree: true, keepBranch: true } },
        { id: 'wrk-3', opts: {} },
        { id: 'wrk-4', opts: {} },
      ]);
    });

    it('removeDoneOrcaWorktrees만 켜면 머지된 주문의 워크트리는 남긴다', async () => {
      const { store } = clockedStore();
      store.addOrder(order({ id: 'ord-1', status: 'done', mergedAt: '2026-01-01T00:00:00.000Z' }));
      addWorker(store, { id: 'wrk-1', status: 'finished' });
      const orca = orcaRelease();
      const { deps: d } = deps({
        config: { ...config, removeDoneOrcaWorktrees: true },
        launchers: { 'orca-worktree': orca.launcher },
      });
      await tick(store, d, { force: true });
      expect(orca.calls).toEqual([{ id: 'wrk-1', opts: {} }]);
    });

    it('머지 안 된 주문은 옵션을 켜도 워크트리를 남긴다', async () => {
      const { store } = clockedStore();
      store.addOrder(order({ id: 'ord-1', status: 'failed' }));
      store.addOrder(order({ id: 'ord-2', status: 'cancelled' }));
      addWorker(store, { id: 'wrk-1', orderId: 'ord-1', status: 'failed' });
      addWorker(store, { id: 'wrk-2', orderId: 'ord-2', status: 'stopped' });
      const orca = orcaRelease();
      const { deps: d } = deps({
        config: { ...config, removeMergedOrcaWorktrees: true },
        launchers: { 'orca-worktree': orca.launcher },
      });
      await tick(store, d, { force: true });
      expect(orca.calls.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: 'wrk-1', opts: {} },
        { id: 'wrk-2', opts: {} },
      ]);
      expect(store.worker('wrk-2')!.status).toBe('released');
    });

    it('같은 레포의 워크트리 삭제는 차례로, 다른 레포끼리는 함께 돌린다', async () => {
      const { store } = clockedStore();
      const merged = '2026-01-01T00:00:00.000Z';
      store.addOrder(order({ id: 'ord-a', repo: 'acme/a', status: 'done', mergedAt: merged }));
      store.addOrder(order({ id: 'ord-b', repo: 'acme/b', status: 'done', mergedAt: merged }));
      addWorker(store, { id: 'wrk-a1', orderId: 'ord-a', attempt: 1, status: 'stopped' });
      addWorker(store, { id: 'wrk-a2', orderId: 'ord-a', attempt: 2, status: 'finished' });
      addWorker(store, { id: 'wrk-b1', orderId: 'ord-b', attempt: 1, status: 'finished' });
      const active = new Map<string, number>();
      const peak = new Map<string, number>();
      let overall = 0;
      let overallPeak = 0;
      const launcher: Launcher = {
        kind: 'orca-worktree',
        start: async (spec) => ({ handle: `h-${spec.worker.id}` }),
        send: async () => undefined,
        release: async (w) => {
          const repo = store.order(w.orderId)!.repo;
          active.set(repo, (active.get(repo) ?? 0) + 1);
          peak.set(repo, Math.max(peak.get(repo) ?? 0, active.get(repo)!));
          overallPeak = Math.max(overallPeak, ++overall);
          await new Promise((r) => setTimeout(r, 5));
          active.set(repo, active.get(repo)! - 1);
          overall--;
        },
      };
      const { deps: d } = deps({
        config: { ...config, removeMergedOrcaWorktrees: true },
        launchers: { 'orca-worktree': launcher },
      });
      await tick(store, d, { force: true });
      expect(peak.get('acme/a')).toBe(1);
      expect(overallPeak).toBe(2);
      for (const id of ['wrk-a1', 'wrk-a2', 'wrk-b1'])
        expect(store.worker(id)!.status).toBe('released');
    });

    it('git 워커는 옵션과 상관없이 같은 레포끼리 차례로 지운다', async () => {
      const { store } = clockedStore();
      store.addOrder(order({ id: 'ord-a', repo: 'acme/a', status: 'cancelled' }));
      store.addOrder(order({ id: 'ord-b', repo: 'acme/a', status: 'failed' }));
      addWorker(store, { id: 'wrk-a', orderId: 'ord-a', kind: 'git-worktree', status: 'stopped' });
      addWorker(store, { id: 'wrk-b', orderId: 'ord-b', kind: 'git-worktree', status: 'finished' });
      let active = 0;
      let peak = 0;
      const launcher: Launcher = {
        kind: 'git-worktree',
        start: async (spec) => ({ handle: `h-${spec.worker.id}` }),
        send: async () => undefined,
        release: async () => {
          peak = Math.max(peak, ++active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        },
      };
      const { deps: d } = deps({ launchers: { 'git-worktree': launcher } });
      await tick(store, d, { force: true });
      expect(peak).toBe(1);
      for (const id of ['wrk-a', 'wrk-b']) expect(store.worker(id)!.status).toBe('released');
    });

    it('지우기가 실패하면 정리 실패 게이트를 타고 승인되면 released로 둔다', async () => {
      const { store } = clockedStore();
      store.addOrder(order({ id: 'ord-1', status: 'done', mergedAt: '2026-01-01T00:00:00.000Z' }));
      addWorker(store, { id: 'wrk-1', status: 'finished' });
      let dirty = true;
      const orca = orcaRelease(() => dirty);
      const { deps: d } = deps({
        config: { ...config, removeMergedOrcaWorktrees: true },
        launchers: { 'orca-worktree': orca.launcher },
      });
      const r = await tick(store, d, { force: true });
      expect(r.escalated).toHaveLength(1);
      const gate = store.snapshot.gates[r.escalated[0]!]!;
      expect(gate.payload).toMatchObject({ kind: 'cleanup-failed', workerId: 'wrk-1' });
      expect(gate.reason).toContain('커밋 안 한 변경');
      expect(store.worker('wrk-1')!.status).toBe('finished');

      // 게이트가 열린 동안은 다시 지우지 않는다
      dirty = false;
      await tick(store, d, { force: true });
      expect(orca.calls).toEqual([]);
      resolveGate(store, gate.id, 'rejected');
      await tick(store, d, { force: true });
      expect(orca.calls.map((c) => c.id)).toEqual(['wrk-1']);
      expect(store.worker('wrk-1')!.status).toBe('released');
    });
  });

  describe('끝난 주문에 남은 멈춘 워커 정리', () => {
    const merged = '2026-01-01T00:00:00.000Z';

    it.each([
      ['cancelled', {}],
      ['failed', {}],
      ['머지된 done', { mergedAt: merged }],
      ['머지 안 된 done', {}],
    ] as const)(
      '%s 주문의 멈춘 워커를 종류별로 거두고 order remove가 통과한다',
      async (label, over) => {
        const status = label.endsWith('done') ? 'done' : label;
        const { store } = clockedStore();
        store.addOrder(order({ id: 'ord-1', status, ...over }));
        const kinds: WorkerKind[] = ['orca-worktree', 'git-worktree', 'subagent'];
        kinds.forEach((kind, i) =>
          store.startWorker({
            ...worker('ord-1'),
            id: `wrk-${i}`,
            kind,
            attempt: i + 1,
            handle: `h-${i}`,
            status: 'stopped',
            stopReason: 'disconnected',
          }),
        );
        const orca = fakeLauncher('orca-worktree');
        const git = fakeLauncher('git-worktree');
        const sub = fakeLauncher('subagent');
        const { deps: d } = deps({
          launchers: {
            'orca-worktree': orca.launcher,
            'git-worktree': git.launcher,
            subagent: sub.launcher,
          },
        });
        await tick(store, d, { force: true });
        expect(orca.released).toEqual(['wrk-0']);
        expect(git.released).toEqual(['wrk-1']);
        expect(sub.released).toEqual(['wrk-2']);
        for (const l of [orca, git, sub]) expect(l.releaseOpts).toEqual([{}]);
        for (const i of [0, 1, 2]) expect(store.worker(`wrk-${i}`)!.status).toBe('released');
        store.removeOrder('ord-1');
        expect(store.order('ord-1')).toBeUndefined();
      },
    );

    it.each(['running', 'waiting-gate', 'escalated', 'human-owned', 'parked'] as const)(
      '%s 주문의 멈춘 워커는 재개나 사람 몫이라 남긴다',
      async (status) => {
        const { store } = clockedStore();
        store.addOrder(order({ id: 'ord-1', status }));
        store.startWorker({
          ...worker('ord-1'),
          id: 'wrk-1',
          kind: 'orca-worktree',
          handle: 'h-1',
          status: 'stopped',
        });
        const orca = fakeLauncher('orca-worktree');
        const { deps: d } = deps({ launchers: { 'orca-worktree': orca.launcher } });
        await tick(store, d, { force: true });
        expect(orca.released).toEqual([]);
        expect(store.worker('wrk-1')!.status).toBe('stopped');
      },
    );

    it.each(['dispatch_inactive', 'retained'])(
      '오르카 release %s는 살아 있는 동안 재시도하다가 기한에 게이트를 연다',
      async (refusal) => {
        const { store, advance } = clockedStore();
        store.addOrder(order({ id: 'ord-1', status: 'cancelled' }));
        store.startWorker(
          worker('ord-1', {
            id: 'wrk-1',
            kind: 'orca-worktree',
            handle: 'ctx_9',
            status: 'stopped',
          }),
        );
        const calls: string[] = [];
        const runner: CommandRunner = async (_cmd, args) => {
          calls.push(args[1]!);
          if (args[1] === 'worker-release') {
            return refusal === 'dispatch_inactive'
              ? { code: 1, stdout: '{"ok":false,"error":{"code":"dispatch_inactive"}}', stderr: '' }
              : { code: 0, stdout: '{"ok":true,"result":{"state":"retained"}}', stderr: '' };
          }
          return {
            code: 0,
            stdout: '{"ok":true,"result":{"state":"ready","liveness":"live"}}',
            stderr: '',
          };
        };
        const launcher = new OrcaLauncher({
          orcaCommand: 'orca',
          promptDir: tempStateDir(),
          runner,
        });
        const { deps: d } = deps({ launchers: { 'orca-worktree': launcher } });
        const first = await tick(store, d, { force: true });
        expect(first.escalated).toEqual([]);
        expect(store.worker('wrk-1')?.releaseRefusedAt).toBe(first.at);
        const eventCount = store.snapshot.eventCount;

        advance(7_199_000);
        expect((await tick(store, d, { force: true })).escalated).toEqual([]);
        expect(store.worker('wrk-1')?.releaseRefusedAt).toBe(first.at);
        expect(store.snapshot.eventCount).toBe(eventCount + 1);

        advance(1000);
        const expired = await tick(store, d, { force: true });
        expect(calls).toEqual(
          Array.from({ length: 3 }, () => ['worker-release', 'worker-show']).flat(),
        );
        expect(expired.escalated).toHaveLength(1);
        const gate = store.snapshot.gates[expired.escalated[0]!]!;
        expect(gate.payload).toMatchObject({ kind: 'cleanup-failed', workerId: 'wrk-1' });
        expect(gate.reason).toContain('liveness live');
        expect(store.worker('wrk-1')?.status).toBe('stopped');
      },
    );

    it('재시도 중 liveness를 알 수 없으면 바로 게이트를 연다', async () => {
      const { store } = clockedStore();
      store.addOrder(order({ id: 'ord-1', status: 'cancelled' }));
      store.startWorker(
        worker('ord-1', { id: 'wrk-1', kind: 'orca-worktree', handle: 'ctx_9', status: 'stopped' }),
      );
      let liveness = 'live';
      const runner: CommandRunner = async (_cmd, args) => ({
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          result: args[1] === 'worker-release' ? { state: 'retained' } : { liveness },
        }),
        stderr: '',
      });
      const launcher = new OrcaLauncher({ orcaCommand: 'orca', promptDir: tempStateDir(), runner });
      const { deps: d } = deps({ launchers: { 'orca-worktree': launcher } });
      expect((await tick(store, d, { force: true })).escalated).toEqual([]);

      liveness = 'unverifiable';
      const failed = await tick(store, d, { force: true });
      expect(failed.escalated).toHaveLength(1);
      expect(store.snapshot.gates[failed.escalated[0]!]!.reason).toContain('liveness unverifiable');
      expect(store.worker('wrk-1')?.releaseRefusedAt).toBeUndefined();
    });
  });

  it.each(['released', 'live'])(
    '재개는 앞 워커 release를 재시도한 뒤 결과에 따라 재개하거나 게이트를 연다 (%s)',
    async (outcome) => {
      const { store, advance } = clockedStore();
      store.addOrder(order({ id: 'ord-1', status: 'running', workerId: 'wrk-1' }));
      store.startWorker(
        worker('ord-1', {
          id: 'wrk-1',
          kind: 'orca-worktree',
          handle: 'ctx_9',
          status: 'stopped',
          stopReason: 'disconnected',
        }),
      );
      const orca = fakeLauncher('orca-worktree');
      let live = true;
      orca.launcher.release = async () => {
        if (live) throw new OrcaReleaseLiveError('liveness live');
      };
      const { deps: d } = deps({
        config: { ...config, orcaReleaseRetryMaxSec: 2 },
        launchers: { 'orca-worktree': orca.launcher },
        orcaAvailable: true,
      });

      const deferred = await tick(store, d, { force: true });
      expect(deferred.launched).toEqual([]);
      expect(deferred.escalated).toEqual([]);
      expect(store.order('ord-1')?.status).toBe('queued');
      expect(store.worker('wrk-1')?.releaseRefusedAt).toBe(deferred.at);

      advance(1000);
      expect((await tick(store, d, { force: true })).escalated).toEqual([]);
      advance(1000);
      live = outcome === 'live';
      const retried = await tick(store, d, { force: true });
      if (live) {
        expect(retried.launched).toEqual([]);
        expect(retried.escalated).toHaveLength(1);
        expect(store.order('ord-1')?.status).toBe('escalated');
        expect(store.snapshot.gates[retried.escalated[0]!]!.reason).toContain('liveness live');
      } else {
        expect(retried.escalated).toEqual([]);
        expect(retried.launched).toEqual([
          expect.objectContaining({ orderId: 'ord-1', resumed: true }),
        ]);
        expect(store.worker('wrk-1')?.releaseRefusedAt).toBeUndefined();
      }
    },
  );

  it('다른 워커가 슬롯을 모두 써도 앞 워커의 release 재시도와 기한 판정은 계속한다', async () => {
    const { store, advance } = clockedStore();
    store.addOrder(order({ id: 'ord-1', status: 'queued', workerId: 'wrk-1' }));
    store.addOrder(order({ id: 'ord-2', createdAt: '2026-11-01T00:00:01.000Z' }));
    store.startWorker(worker('ord-1', { id: 'wrk-1', kind: 'orca-worktree', status: 'stopped' }));
    const orca = fakeLauncher('orca-worktree');
    let attempts = 0;
    orca.launcher.release = async () => {
      attempts++;
      throw new OrcaReleaseLiveError('liveness live');
    };
    const { deps: d } = deps({
      config: { ...config, maxConcurrentWorkers: 1, orcaReleaseRetryMaxSec: 2 },
      launchers: { 'orca-worktree': orca.launcher },
      orcaAvailable: true,
    });

    const first = await tick(store, d, { force: true });
    expect(first.launched).toEqual([expect.objectContaining({ orderId: 'ord-2' })]);
    advance(1000);
    expect((await tick(store, d, { force: true })).escalated).toEqual([]);
    expect(attempts).toBe(2);
    advance(1000);
    const expired = await tick(store, d, { force: true });
    expect(attempts).toBe(3);
    expect(expired.escalated).toHaveLength(1);
    expect(expired.launched).toEqual([]);
    expect(store.order('ord-1')?.status).toBe('escalated');
  });

  it('앞 워커의 release만 대기하는 주문은 다른 주문의 배정을 막지 않는다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-1', status: 'queued', workerId: 'wrk-1' }));
    store.addOrder(order({ id: 'ord-2', createdAt: '2026-11-01T00:00:01.000Z' }));
    store.startWorker(worker('ord-1', { id: 'wrk-1', kind: 'orca-worktree', status: 'stopped' }));
    const orca = fakeLauncher('orca-worktree');
    orca.launcher.release = async () => {
      throw new OrcaReleaseLiveError('liveness live');
    };
    const { deps: d } = deps({
      config: { ...config, maxConcurrentWorkers: 1 },
      launchers: { 'orca-worktree': orca.launcher },
      orcaAvailable: true,
    });

    const r = await tick(store, d, { force: true });
    expect(r.launched).toEqual([expect.objectContaining({ orderId: 'ord-2', resumed: false })]);
    expect(r.escalated).toEqual([]);
    expect(store.order('ord-1')?.status).toBe('queued');
  });

  it('워커 정리가 실패하면 주문에 안 묶인 게이트를 열고 주문은 그대로 정산한다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-1', status: 'merged', mergedAt: '2026-01-01T00:00:00.000Z' }));
    store.startWorker({
      id: 'wrk-1',
      orderId: 'ord-1',
      kind: 'git-worktree',
      spawnedBy: 'conductor',
      attempt: 1,
      status: 'finished',
      startedAt: '2026-01-01T00:00:00.000Z',
      lastSeenAt: '2026-01-01T00:00:00.000Z',
    });
    const { deps: d, git } = deps();
    git.launcher.release = async () => {
      throw new Error('워크트리가 잠겨 있어요');
    };
    const r = await tick(store, d, { force: true });
    expect(r.escalated).toHaveLength(1);
    const gate = store.snapshot.gates[r.escalated[0]!]!;
    expect(gate.orderId).toBeUndefined();
    expect(gate.payload).toMatchObject({ kind: 'cleanup-failed', workerId: 'wrk-1' });
    expect(store.order('ord-1')!.status).toBe('done');

    // 게이트가 열려 있는 동안은 다시 시도하지 않고 승인되면 정리된 것으로 본다
    const again = await tick(store, d, { force: true });
    expect(again.escalated).toEqual([]);
    resolveGate(store, gate.id, 'approved');
    await tick(store, d, { force: true });
    expect(store.worker('wrk-1')!.status).toBe('released');
  });

  it('적용하다 실패한 결과는 지우지 않고 failed로 옮겨 원문을 남긴다', async () => {
    const { store } = clockedStore();
    const { deps: d } = deps();
    report(store, d, { workerId: 'wrk-ghost', status: 'done' });
    const r = await tick(store, d, { force: true });
    expect(r.errors.join()).toContain('모르는 워커');
    const inbox = inboxDirOf(store, d);
    expect(readdirSync(inbox).filter((f) => f.endsWith('.json'))).toEqual([]);
    expect(readdirSync(join(inbox, FAILED_REPORTS_DIR))).toHaveLength(1);
  });

  it('한 주문의 정산이 던져도 뒤의 머지된 주문은 끝낸다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-a', issueKey: 'APP-1', issueType: 'bug', status: 'merged' }));
    store.addOrder(order({ id: 'ord-b', issueKey: 'APP-2', issueType: 'bug', status: 'merged' }));
    const { deps: d } = deps({
      deploy: {
        status: async (o) => {
          if (o.id === 'ord-a') throw new Error('배포 결과 파일이 깨졌어요');
          return { status: 'success' };
        },
      },
    });
    const r = await tick(store, d, { force: true });
    expect(r.errors.join()).toContain('ord-a 정산 실패');
    expect(store.order('ord-a')!.status).toBe('merged');
    expect(store.order('ord-b')!.status).toBe('done');
  });

  it('배포 실패 게이트를 승인하면 체인을 다시 돌리지 않고 정산을 다시 한다', async () => {
    const { store } = clockedStore();
    store.addOrder(
      order({
        id: 'ord-bug',
        issueKey: 'APP-3',
        issueType: 'bug',
        status: 'merged',
        mergedAt: '2026-11-01T00:00:00.000Z',
      }),
    );
    let deploy: DeploySignal = { status: 'failed' };
    const { deps: d, git } = deps({ deploy: { status: async () => deploy } });
    const r = await tick(store, d, { force: true });
    expect(store.order('ord-bug')!.status).toBe('escalated');

    resolveGate(store, r.escalated[0]!, 'approved');
    expect(store.order('ord-bug')!.status).toBe('merged');
    deploy = { status: 'success' };
    await tick(store, d, { force: true });
    expect(store.order('ord-bug')!.status).toBe('done');
    expect(git.started).toEqual([]);
  });

  it('대기를 알린 워커는 끊김 기준을 넘어 조용해도 재개하지 않고 다음 보고에서 대기를 푼다', async () => {
    const { store, advance } = clockedStore();
    store.addOrder(order({ id: 'ord-1' }));
    const { deps: d, git } = deps();
    await tick(store, d, { force: true });
    const wid = store.order('ord-1')!.workerId!;
    report(store, d, { workerId: wid, status: 'waiting', wait: { reason: 'CI 결과' } });
    await tick(store, d, { force: true });
    expect(store.worker(wid)!.waiting).toMatchObject({ reason: 'CI 결과' });

    advance(60 * 60 * 1000);
    const r = await tick(store, d, { force: true });
    expect(store.worker(wid)!.status).toBe('running');
    expect(r.escalated).toEqual([]);
    expect(git.started).toHaveLength(1);

    report(store, d, { workerId: wid, status: 'progress' });
    await tick(store, d, { force: true });
    expect(store.worker(wid)!.waiting).toBeUndefined();
    advance(16 * 60 * 1000);
    await tick(store, d, { force: true });
    expect(store.worker(wid)!.status).toBe('stopped');
  });

  it('대기가 상한을 넘으면 끊김 대신 게이트로 한 번 올리고 대기 표시를 지운다', async () => {
    const { store, advance } = clockedStore();
    store.addOrder(order({ id: 'ord-1' }));
    const { deps: d, git } = deps();
    await tick(store, d, { force: true });
    const wid = store.order('ord-1')!.workerId!;
    report(store, d, { workerId: wid, status: 'waiting', wait: { reason: '사람의 답' } });
    await tick(store, d, { force: true });

    advance(config.waitingEscalateAfterSec * 1000);
    const r = await tick(store, d, { force: true });
    const gates = store.openGates('ord-1');
    expect(gates).toHaveLength(1);
    expect(gates[0]!.reason).toContain('사람의 답');
    expect(r.escalated).toEqual([gates[0]!.id]);
    expect(store.worker(wid)!.status).toBe('running');
    expect(store.worker(wid)!.waiting).toBeUndefined();
    expect(store.order('ord-1')!.status).toBe('waiting-gate');
    expect(git.started).toHaveLength(1);
  });

  it('적어 둔 대기 기한이 지나고 끊김 기준만큼 소식이 없으면 상한 전이라도 올린다', async () => {
    const { store, advance } = clockedStore();
    store.addOrder(order({ id: 'ord-1' }));
    const { deps: d } = deps();
    await tick(store, d, { force: true });
    const wid = store.order('ord-1')!.workerId!;
    const until = new Date(Date.parse(store.timestamp()) + 10 * 60 * 1000).toISOString();
    report(store, d, { workerId: wid, status: 'waiting', wait: { reason: '리뷰', until } });
    await tick(store, d, { force: true });

    advance(20 * 60 * 1000);
    await tick(store, d, { force: true });
    expect(store.openGates('ord-1')).toEqual([]);
    advance(10 * 60 * 1000);
    await tick(store, d, { force: true });
    expect(store.openGates('ord-1')[0]!.reason).toContain('기한');
  });

  it('대기로 올린 게이트를 승인한 뒤에는 같은 대기로 다시 올리지 않는다', async () => {
    const { store, advance } = clockedStore();
    store.addOrder(order({ id: 'ord-1' }));
    const { deps: d } = deps();
    await tick(store, d, { force: true });
    const wid = store.order('ord-1')!.workerId!;
    report(store, d, { workerId: wid, status: 'waiting', wait: { reason: '사람의 답' } });
    await tick(store, d, { force: true });
    advance(config.waitingEscalateAfterSec * 1000);
    await tick(store, d, { force: true });
    const gateId = store.openGates('ord-1')[0]!.id;

    resolveGate(store, gateId, 'approved');
    await tick(store, d, { force: true });
    advance(config.waitingEscalateAfterSec * 1000);
    report(store, d, { workerId: wid, status: 'progress' });
    await tick(store, d, { force: true });
    expect(store.openGates('ord-1')).toEqual([]);
    expect(Object.values(store.snapshot.gates).filter((g) => g.orderId === 'ord-1')).toHaveLength(
      1,
    );
  });

  it('대기를 알린 워커의 확인 게이트를 상한 뒤에 닫아도 다음 tick에 게이트를 새로 열지 않는다', async () => {
    const { store, advance } = clockedStore();
    store.addOrder(order({ id: 'ord-1', scope: 'approval' }));
    const { deps: d } = deps();
    await tick(store, d, { force: true });
    const wid = store.order('ord-1')!.workerId!;
    report(store, d, {
      workerId: wid,
      status: 'needs',
      need: { kind: 'merge-approval', detail: '머지해도 될까요' },
    });
    await tick(store, d, { force: true });
    report(store, d, { workerId: wid, status: 'waiting', wait: { reason: 'CI 결과' } });
    await tick(store, d, { force: true });
    const gateId = store.openGates('ord-1')[0]!.id;

    advance(config.waitingEscalateAfterSec * 1000 + 1);
    expect(store.worker(wid)!.waiting).toBeDefined();
    resolveGate(store, gateId, 'approved');
    expect(store.worker(wid)!.waiting).toBeUndefined();
    await tick(store, d, { force: true });
    expect(store.openGates('ord-1')).toEqual([]);
  });

  it('대기 중에 체크포인트를 남기면 대기가 풀린다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-1' }));
    const { deps: d } = deps();
    await tick(store, d, { force: true });
    const wid = store.order('ord-1')!.workerId!;
    report(store, d, { workerId: wid, status: 'waiting', wait: { reason: 'CI 결과' } });
    await tick(store, d, { force: true });
    expect(store.worker(wid)!.waiting).toBeDefined();

    saveSkillCheckpoint(store, { workerId: wid, skill: 'solve', next: '다음 단계' });
    expect(store.worker(wid)!.waiting).toBeUndefined();
  });

  it('ship 단계 값이 없는 simple-approval은 bypass하지 않고 게이트로 올린다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-1' }));
    const { deps: d, git } = deps();
    await tick(store, d, { force: true });
    const wid = store.order('ord-1')!.workerId!;
    report(store, d, {
      workerId: wid,
      status: 'needs',
      need: { kind: 'simple-approval', detail: '프로덕션 DB 마이그레이션 돌려도 될까요' },
    });
    await tick(store, d, { force: true });
    expect(store.snapshot.bypasses).toEqual([]);
    expect(store.openGates('ord-1').map((g) => g.type)).toEqual(['no-procedure']);
    expect(git.sent).toEqual([]);

    report(store, d, {
      workerId: wid,
      status: 'needs',
      need: { kind: 'simple-approval', detail: 'ship ⓒ ready 전환', step: 'ship-ready' },
    });
    await tick(store, d, { force: true });
    expect(store.snapshot.bypasses.map((b) => b.need)).toEqual(['simple-approval']);
  });

  it('사람 확인을 오래 기다린 워커도 끊긴 것으로 보지 않고 승인을 그 워커에 전한다', async () => {
    const { store, advance } = clockedStore();
    store.addOrder(order({ id: 'ord-1', scope: 'approval' }));
    const { deps: d, git } = deps();
    await tick(store, d, { force: true });
    const wid = store.order('ord-1')!.workerId!;
    report(store, d, {
      workerId: wid,
      status: 'needs',
      need: { kind: 'merge-approval', detail: '머지해도 될까요' },
    });
    await tick(store, d, { force: true });
    expect(store.order('ord-1')!.status).toBe('waiting-gate');

    advance(60 * 60 * 1000);
    await tick(store, d, { force: true });
    expect(store.worker(wid)!.status).toBe('running');

    const closed = resolveGate(store, store.openGates('ord-1')[0]!.id, 'approved');
    await deliverGateDecision(store, closed, d);
    expect(store.order('ord-1')!.status).toBe('running');
    expect(git.sent.at(-1)!.workerId).toBe(wid);

    // 승인 직후 tick이 기다린 시간을 끊김으로 세지 않는다
    await tick(store, d, { force: true });
    expect(store.worker(wid)!.status).toBe('running');
    expect(git.started).toHaveLength(1);
  });

  async function waitingOnGate() {
    const { store, advance } = clockedStore();
    store.addOrder(order({ id: 'ord-1', scope: 'approval' }));
    const made = deps();
    await tick(store, made.deps, { force: true });
    const wid = store.order('ord-1')!.workerId!;
    report(store, made.deps, {
      workerId: wid,
      status: 'needs',
      need: { kind: 'merge-approval', detail: '머지해도 될까요' },
    });
    await tick(store, made.deps, { force: true });
    return { store, advance, wid, ...made, gateId: store.openGates('ord-1')[0]!.id };
  }

  it('hostActions를 못 돌리는 쪽이 종료한 게이트의 결정은 다음 tick이 한 번만 내보낸다', async () => {
    const { store, deps: d, git, wid, gateId } = await waitingOnGate();
    git.launcher.send = async (w, message) => ({ type: 'send', workerId: w.id, message });

    const closed = resolveGate(store, gateId, 'approved');
    const r = await deliverGateDecision(store, closed, d, { defer: true });
    expect(r).toEqual({ hostActions: [], errors: [], deferred: true, retry: false });
    expect(store.snapshot.gates[gateId]!.deliveryPending).toBe(true);

    const next = await tick(store, d, { force: true });
    expect(next.hostActions).toContainEqual(
      expect.objectContaining({ type: 'send', workerId: wid }),
    );
    expect(store.snapshot.gates[gateId]!.deliveryPending).toBeUndefined();

    const after = await tick(store, d, { force: true });
    expect(after.hostActions.filter((a) => a.type === 'send')).toEqual([]);
  });

  it('직접 전하는 런처면 미루라고 해도 그 자리에서 전하고 대기로 남기지 않는다', async () => {
    const { store, deps: d, git, wid, gateId } = await waitingOnGate();
    const closed = resolveGate(store, gateId, 'rejected');
    const r = await deliverGateDecision(store, closed, d, { defer: true });
    expect(r.deferred).toBe(false);
    expect(git.sent.at(-1)!.workerId).toBe(wid);
    expect(store.snapshot.gates[gateId]!.deliveryPending).toBeUndefined();
  });

  it('전달을 기다리던 워커가 그새 끝났으면 tick은 결정을 버리고 대기만 걷는다', async () => {
    const { store, deps: d, git, wid, gateId } = await waitingOnGate();
    git.launcher.send = async (w, message) => ({ type: 'send', workerId: w.id, message });
    const closed = resolveGate(store, gateId, 'approved');
    await deliverGateDecision(store, closed, d, { defer: true });
    report(store, d, { workerId: wid, status: 'failed', summary: '중단했어요' });

    const next = await tick(store, d, { force: true });
    expect(next.hostActions.filter((a) => a.type === 'send' && a.workerId === wid)).toEqual([]);
    expect(store.snapshot.gates[gateId]!.deliveryPending).toBeUndefined();
  });

  it('대기 중인 결정을 보내다 send가 던지면 대기를 남기고 다음 tick에 다시 전한다', async () => {
    const { store, deps: d, git, wid, gateId } = await waitingOnGate();
    git.launcher.send = async (w, message) => ({ type: 'send', workerId: w.id, message });
    await deliverGateDecision(store, resolveGate(store, gateId, 'approved'), d, { defer: true });

    git.launcher.send = async () => {
      throw new Error('시간 초과');
    };
    const failed = await tick(store, d, { force: true });
    expect(failed.errors.some((e) => e.includes('시간 초과'))).toBe(true);
    expect(store.snapshot.gates[gateId]).toMatchObject({
      deliveryPending: true,
      deliveryAttempts: 1,
    });

    git.launcher.send = async (w, message) => ({ type: 'send', workerId: w.id, message });
    const next = await tick(store, d, { force: true });
    expect(next.hostActions).toContainEqual(
      expect.objectContaining({ type: 'send', workerId: wid }),
    );
    expect(store.snapshot.gates[gateId]).not.toHaveProperty('deliveryPending');
    expect(store.snapshot.gates[gateId]).not.toHaveProperty('deliveryAttempts');
    expect(store.snapshot.gates[gateId]!.deliveryOutcome).toBe('host-action');
  });

  it('send가 세 번 연속 던지면 대기를 걷고 직접 전해 달라고 남긴다', async () => {
    const { store, deps: d, git, gateId } = await waitingOnGate();
    git.launcher.send = async (w, message) => ({ type: 'send', workerId: w.id, message });
    await deliverGateDecision(store, resolveGate(store, gateId, 'approved'), d, { defer: true });
    git.launcher.send = async () => {
      throw new Error('시간 초과');
    };

    await tick(store, d, { force: true });
    await tick(store, d, { force: true });
    expect(store.snapshot.gates[gateId]!.deliveryAttempts).toBe(2);
    const last = await tick(store, d, { force: true });
    expect(last.errors).toContain(
      `${gateId} 결정을 3번 못 전해서 그만뒀어요. 워커에 직접 전해 주세요`,
    );
    expect(store.snapshot.gates[gateId]).not.toHaveProperty('deliveryPending');
    expect(store.snapshot.gates[gateId]).not.toHaveProperty('deliveryAttempts');
    expect(store.snapshot.gates[gateId]!.deliveryOutcome).toBe('failed');
  });

  it('미뤄 달라고 한 첫 전달에서 send가 던지면 대기와 시도 1회를 남기고 다음 tick이 다시 전한다', async () => {
    const { store, deps: d, git, wid, gateId } = await waitingOnGate();
    git.launcher.send = async () => {
      throw new Error('시간 초과');
    };
    const r = await deliverGateDecision(store, resolveGate(store, gateId, 'approved'), d, {
      defer: true,
    });
    expect(r.deferred).toBe(true);
    expect(r.retry).toBe(false);
    expect(r.errors.some((e) => e.includes('시간 초과'))).toBe(true);
    expect(store.snapshot.gates[gateId]).toMatchObject({
      deliveryPending: true,
      deliveryAttempts: 1,
    });

    git.launcher.send = async (w, message) => ({ type: 'send', workerId: w.id, message });
    const next = await tick(store, d, { force: true });
    expect(next.hostActions).toContainEqual(
      expect.objectContaining({ type: 'send', workerId: wid }),
    );
    expect(store.snapshot.gates[gateId]).not.toHaveProperty('deliveryPending');
  });

  it('미뤄 달라고 한 쪽에 그 워커의 런처가 없으면 오류 없이 대기로 남기고 tick이 전한다', async () => {
    const { store, deps: d, git, wid, gateId } = await waitingOnGate();
    const r = await deliverGateDecision(
      store,
      resolveGate(store, gateId, 'approved'),
      { launchers: {} },
      { defer: true },
    );
    expect(r).toEqual({ hostActions: [], errors: [], deferred: true, retry: false });
    expect(store.snapshot.gates[gateId]!.deliveryPending).toBe(true);
    expect(store.snapshot.gates[gateId]).not.toHaveProperty('deliveryAttempts');

    await tick(store, d, { force: true });
    expect(git.sent.at(-1)!.workerId).toBe(wid);
    expect(store.snapshot.gates[gateId]).not.toHaveProperty('deliveryPending');
  });

  const lockOf = (pid: number, startedAt: number) => `${pid}:${startedAt}:${hostname()}:x`;

  it('살아 있는 프로세스의 잠금은 한 시간이 지나도 걷어내지 않는다', async () => {
    const { store, dir } = clockedStore();
    const { deps: d } = deps();
    const lock = join(dir, 'tick.lock');
    writeFileSync(lock, lockOf(process.pid, Date.now() - 60 * 60 * 1000));
    const r = await tick(store, d, { force: true });
    expect(r.skipped).toBe(true);
    expect(r.errors[0]).toContain(`pid ${process.pid}`);
    expect(existsSync(lock)).toBe(true);
  });

  it('살아 있는 프로세스의 잠금이라도 6시간이 지나면 걷어낸다', async () => {
    const { store, dir } = clockedStore();
    const { deps: d } = deps();
    writeFileSync(join(dir, 'tick.lock'), lockOf(process.pid, Date.now() - 7 * 60 * 60 * 1000));
    const r = await tick(store, d, { force: true });
    expect(r.skipped).toBeUndefined();
  });

  it('죽은 프로세스의 잠금은 걷어내고 돌며 끝나면 자기 잠금만 푼다', async () => {
    const { store, dir } = clockedStore();
    const { deps: d } = deps();
    const lock = join(dir, 'tick.lock');
    writeFileSync(lock, lockOf(2147483646, Date.now()));
    const r = await tick(store, d, { force: true });
    expect(r.skipped).toBeUndefined();
    expect(existsSync(lock)).toBe(false);
    expect(readdirSync(dir).filter((f) => f.includes('tick.lock'))).toEqual([]);
  });

  it('못 읽는 옛 꼴 잠금은 10분이 지나야 걷어낸다', async () => {
    const { store, dir } = clockedStore();
    const { deps: d } = deps();
    const lock = join(dir, 'tick.lock');
    writeFileSync(lock, `${process.pid}:other`);
    expect((await tick(store, d, { force: true })).skipped).toBe(true);
    const old = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(lock, old, old);
    expect((await tick(store, d, { force: true })).skipped).toBeUndefined();
  });

  it('다른 호스트의 잠금은 pid를 안 보고 6시간 상한만 본다', async () => {
    const { store, dir } = clockedStore();
    const { deps: d } = deps();
    const lock = join(dir, 'tick.lock');
    writeFileSync(lock, `2147483646:${Date.now() - 60 * 60 * 1000}:other-host:x`);
    expect((await tick(store, d, { force: true })).skipped).toBe(true);
    writeFileSync(lock, `2147483646:${Date.now() - 7 * 60 * 60 * 1000}:other-host:x`);
    expect((await tick(store, d, { force: true })).skipped).toBeUndefined();
  });

  it("호스트 이름에 ':'가 있어도 잠금을 읽어 옛 꼴로 걷지 않는다", async () => {
    const { store, dir } = clockedStore();
    const { deps: d } = deps();
    const lock = join(dir, 'tick.lock');
    writeFileSync(lock, `2147483646:${Date.now()}:fe80::1:x`);
    const old = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(lock, old, old);
    const r = await tick(store, d, { force: true });
    expect(r.skipped).toBe(true);
    expect(r.errors[0]).toContain('pid 2147483646');
  });

  it('다른 프로세스가 걷는 중이면 건너뛰고 걷다 죽은 steal은 치운 뒤 다음 tick이 잡는다', async () => {
    const { store, dir } = clockedStore();
    const { deps: d } = deps();
    const lock = join(dir, 'tick.lock');
    const steal = `${lock}.steal`;
    writeFileSync(lock, lockOf(2147483646, Date.now()));

    writeFileSync(steal, lockOf(process.pid, Date.now()));
    expect((await tick(store, d, { force: true })).skipped).toBe(true);
    expect(existsSync(steal)).toBe(true);

    writeFileSync(steal, lockOf(2147483646, Date.now()));
    expect((await tick(store, d, { force: true })).skipped).toBe(true);
    expect(existsSync(steal)).toBe(false);
    expect((await tick(store, d, { force: true })).skipped).toBeUndefined();
    expect(readdirSync(dir).filter((f) => f.includes('tick.lock'))).toEqual([]);
  });

  // 줄이 끝내 안 비는 경로라 RELEASE_RETRIES x RELEASE_RETRY_MS(약 1초)를 실제로 다 기다린다.
  // 재시도 값을 옵션으로 열면 0을 넘겨 steal 줄을 건너뛰는 길이 생겨서 열지 않았다
  it('잠금을 풀 때 steal 줄에 서고 줄이 안 비어도 끝내 자기 잠금은 지운다', async () => {
    const { store, dir } = clockedStore();
    store.addOrder(order({ id: 'ord-1' }));
    const lock = join(dir, 'tick.lock');
    const steal = `${lock}.steal`;
    const other = lockOf(process.pid, Date.now());
    const { deps: base, git } = deps();
    // tick이 도는 사이에 다른 프로세스가 걷는 중인 것처럼 steal을 만든다
    const d: EngineDeps = {
      ...base,
      launchers: {
        'git-worktree': {
          ...git.launcher,
          start: async (spec) => {
            writeFileSync(steal, other);
            return git.launcher.start(spec);
          },
        },
      },
    };
    const r = await tick(store, d, { force: true });
    expect(r.skipped).toBeUndefined();
    expect(existsSync(lock)).toBe(false);
    expect(readFileSync(steal, 'utf-8')).toBe(other);
  });

  it('잠금을 풀 때 걷다 죽은 steal을 치우고 그 줄에 서서 푼다', async () => {
    const { store, dir } = clockedStore();
    store.addOrder(order({ id: 'ord-1' }));
    const lock = join(dir, 'tick.lock');
    const steal = `${lock}.steal`;
    const { deps: base, git } = deps();
    const d: EngineDeps = {
      ...base,
      launchers: {
        'git-worktree': {
          ...git.launcher,
          start: async (spec) => {
            writeFileSync(steal, lockOf(2147483646, Date.now()));
            return git.launcher.start(spec);
          },
        },
      },
    };
    expect((await tick(store, d, { force: true })).skipped).toBeUndefined();
    expect(readdirSync(dir).filter((f) => f.includes('tick.lock'))).toEqual([]);
  });

  it('같은 저장소를 연 두 컨덕터가 차례로 tick해도 같은 주문을 두 번 띄우지 않는다', async () => {
    const { store, dir, now } = clockedStore();
    store.addOrder(order({ id: 'ord-1' }));
    const other = ConductorStore.open(dir, { now });
    const { deps: d, git } = deps();
    await tick(store, d, { force: true });
    await tick(other, d, { force: true });
    expect(git.started).toHaveLength(1);
    expect(other.order('ord-1')!.workerId).toBe(store.order('ord-1')!.workerId);
  });

  it('앞 tick과 끊김 기준보다 멀리 떨어진 tick은 공백을 경고에 남긴다', async () => {
    const { store, advance } = clockedStore();
    const { deps: d } = deps();
    await tick(store, d);
    advance(10 * 60 * 1000);
    expect((await tick(store, d)).warnings.some((w) => w.includes('tick이 없었어요'))).toBe(false);
    advance(6 * 60 * 60 * 1000);
    const gapped = await tick(store, d, { force: true });
    expect(gapped.warnings).toContainEqual(expect.stringContaining('6시간 동안 tick이 없었어요'));
  });

  it('공백 경고는 첫 tick과 기준 안의 간격에는 붙지 않는다', () => {
    const at = '2026-11-13T10:50:00.000Z';
    expect(tickGapWarning(undefined, at, 1_800_000)).toBeUndefined();
    expect(tickGapWarning('2026-11-13T10:30:00.000Z', at, 1_800_000)).toBeUndefined();
    expect(tickGapWarning('2026-11-13T04:55:26.428Z', at, 1_800_000)).toContain('5시간 55분');
    expect(tickGapWarning('2026-11-13T10:24:00.000Z', at, 60_000)).toContain('26분 동안');
    expect(tickGapWarning('2026-11-13T08:50:00.000Z', at, 1_800_000)).toContain('2시간 동안');
  });

  it('공백 경고는 기준과 같은 간격까지는 붙지 않고 거꾸로 간 시계와 못 읽는 시각은 넘긴다', () => {
    const last = '2026-11-13T10:00:00.000Z';
    const threshold = 1_800_000;
    const at = (ms: number) => new Date(Date.parse(last) + ms).toISOString();
    expect(tickGapWarning(last, at(threshold), threshold)).toBeUndefined();
    expect(tickGapWarning(last, at(threshold + 1), threshold)).toContain('30분 동안');
    expect(tickGapWarning(last, at(-60_000), threshold)).toBeUndefined();
    expect(tickGapWarning('garbage', at(threshold * 10), threshold)).toBeUndefined();
  });

  it('status 경고는 tick 사이 공백이 아니라 마지막 tick 뒤로 지난 시간으로 말한다', () => {
    const at = '2026-11-13T10:50:00.000Z';
    expect(staleTickWarning('2026-11-13T10:30:00.000Z', at, 1_800_000)).toBeUndefined();
    const stale = staleTickWarning('2026-11-13T04:55:26.428Z', at, 1_800_000);
    expect(stale).toContain('5시간 55분 지났어요');
    expect(stale).not.toContain('동안 tick이 없었어요');
    expect(staleTickWarning('2026-11-13T10:20:00.000Z', at, 1_800_000)).toBeUndefined();
    expect(staleTickWarning('garbage', at, 1_800_000)).toBeUndefined();
  });

  it('간격 안의 tick과 겹친 tick은 건너뛴다', async () => {
    const { store, dir } = clockedStore();
    const { deps: d } = deps();
    expect((await tick(store, d)).skipped).toBeUndefined();
    expect((await tick(store, d)).skipped).toBe(true);

    writeFileSync(join(dir, 'tick.lock'), '');
    const locked = await tick(store, d, { force: true });
    expect(locked.skipped).toBe(true);
    expect(locked.errors[0]).toContain('다른 tick');
  });

  it('워커 안에서는 tick을 거절한다', async () => {
    const { store } = clockedStore();
    const { deps: d } = deps({ env: { GESTALT_CONDUCTOR_WORKER_ID: 'wrk-1' } });
    await expect(tick(store, d, { force: true })).rejects.toThrow();
  });
});

describe('워커 에이전트와 보고 보존', () => {
  it.each([
    { agent: 'opencode', repoAgent: 'codex', defaultAgent: 'cursor', expected: 'opencode' },
    { agent: undefined, repoAgent: 'codex', defaultAgent: 'cursor', expected: 'codex' },
    { agent: undefined, repoAgent: undefined, defaultAgent: 'cursor', expected: 'cursor' },
    { agent: undefined, repoAgent: undefined, defaultAgent: 'claude', expected: 'claude' },
  ])('주문 > 레포 > 기본 > claude 우선순위: $expected', async (row) => {
    const { store, now } = clockedStore();
    store.addOrder(order({ agent: row.agent }));
    const orca = fakeLauncher('orca-worktree');
    const { deps: d } = deps({
      config: {
        ...config,
        defaultAgent: row.defaultAgent,
        repoAgents: row.repoAgent ? { 'acme/app': row.repoAgent } : {},
      },
      orcaAvailable: true,
      launchers: { 'orca-worktree': orca.launcher },
    });
    await tick(store, d, { now: now(), force: true });
    expect(orca.started[0]!.worker.agent).toBe(row.expected);
    expect(ConductorStore.open(store.dir).workers()[0]!.agent).toBe(row.expected);
  });

  it('재개는 설정 변경 후에도 앞 워커의 에이전트를 유지한다', async () => {
    const { store, now } = clockedStore();
    const o = order();
    store.addOrder(o);
    const orca = fakeLauncher('orca-worktree');
    const { deps: d } = deps({
      config: { ...config, defaultAgent: 'codex' },
      orcaAvailable: true,
      launchers: { 'orca-worktree': orca.launcher },
    });
    await tick(store, d, { now: now(), force: true });
    const first = orca.started[0]!.worker;
    report(store, d, { workerId: first.id, status: 'stopped', stopReason: 'disconnected' });
    const reopened = ConductorStore.open(store.dir);
    await tick(
      reopened,
      { ...d, config: { ...config, defaultAgent: 'cursor' } },
      { now: now(), force: true },
    );
    expect(orca.started[1]!.worker.agent).toBe('codex');
  });

  it('재개는 레포 설정이 있어도 앞 워커의 에이전트를 유지한다', async () => {
    const { store, now } = clockedStore();
    const o = order();
    store.addOrder(o);
    const prev = worker(o.id, { kind: 'orca-worktree', agent: 'cursor', status: 'stopped' });
    store.startWorker(prev);
    store.updateOrder(o.id, { workerId: prev.id, status: 'running' });
    const orca = fakeLauncher('orca-worktree');
    const { deps: d } = deps({
      config: { ...config, repoAgents: { 'acme/app': 'codex' } },
      orcaAvailable: true,
      launchers: { 'orca-worktree': orca.launcher },
    });
    await tick(store, d, { now: now(), force: true });
    expect(orca.started[0]!.worker.agent).toBe('cursor');
  });

  it('주문에 에이전트가 있으면 재개도 주문 값을 쓴다', async () => {
    const { store, now } = clockedStore();
    const o = order({ agent: 'opencode' });
    store.addOrder(o);
    const prev = worker(o.id, { kind: 'orca-worktree', agent: 'cursor', status: 'stopped' });
    store.startWorker(prev);
    store.updateOrder(o.id, { workerId: prev.id, status: 'running' });
    const orca = fakeLauncher('orca-worktree');
    const { deps: d } = deps({
      config: { ...config, repoAgents: { 'acme/app': 'codex' } },
      orcaAvailable: true,
      launchers: { 'orca-worktree': orca.launcher },
    });
    await tick(store, d, { now: now(), force: true });
    expect(orca.started[0]!.worker.agent).toBe('opencode');
  });

  it('중간에 git 워크트리로 돌았어도 마지막 오르카 워커의 에이전트로 재개한다', () => {
    const workers = [
      { kind: 'orca-worktree' as const, agent: 'codex' },
      { kind: 'git-worktree' as const },
    ];
    const cfg = { repoAgents: { 'acme/app': 'cursor' }, defaultAgent: 'claude' };
    expect(resolveWorkerAgent({ repo: 'acme/app' }, workers, cfg)).toBe('codex');
    expect(resolveWorkerAgent({ repo: 'acme/app' }, [], cfg)).toBe('cursor');
    expect(resolveWorkerAgent({ repo: 'acme/web' }, [], cfg)).toBe('claude');
    expect(
      resolveWorkerAgent({ repo: 'acme/app' }, [{ kind: 'orca-worktree' as const }], cfg),
    ).toBe('claude');
  });

  it('에이전트 기록 없는 옛 오르카 워커는 claude로 재개한다', async () => {
    const { store, now } = clockedStore();
    const o = order();
    store.addOrder(o);
    const legacy = worker(o.id, { kind: 'orca-worktree', status: 'stopped' });
    store.startWorker(legacy);
    store.updateOrder(o.id, { workerId: legacy.id, status: 'running' });
    const orca = fakeLauncher('orca-worktree');
    const { deps: d } = deps({
      config: { ...config, defaultAgent: 'codex' },
      orcaAvailable: true,
      launchers: { 'orca-worktree': orca.launcher },
    });
    await tick(ConductorStore.open(store.dir), d, { now: now(), force: true });
    expect(orca.started[0]!.worker.agent).toBe('claude');
  });

  it('호스트가 띄우는 워커에는 에이전트를 붙이지 않는다', async () => {
    const { store, now } = clockedStore();
    store.addOrder(order({ agent: 'codex' }));
    const { deps: d, git } = deps();
    await tick(store, d, { now: now(), force: true });
    expect(git.started[0]!.worker.agent).toBeUndefined();
  });

  it('진행과 완료 보고의 모든 결과 필드를 inbox 삭제 뒤에도 복원한다', async () => {
    const { store, now } = clockedStore();
    const o = order();
    store.addOrder(o);
    const { deps: d, git } = deps();
    await tick(store, d, { now: now(), force: true });
    const workerId = git.started[0]!.worker.id;
    const progress = {
      workerId,
      status: 'progress',
      summary: '검증 진행',
      refs: ['reports/check.md'],
      skill: 'ship',
      prRef: 'acme/app#123',
      merged: false,
      stopReason: 'unknown',
      need: { kind: 'cleanup', detail: '임시 파일 정리' },
    };
    // 하위 주문 요청은 주문으로 옮겨지므로 이력에는 안 남는다
    report(store, d, { ...progress, spawnRequest: { title: '하위', detail: 'x' } });
    await tick(store, d, { now: now(), force: true });
    report(store, d, {
      workerId,
      status: 'done',
      summary: '검증 완료',
      refs: ['reports/result.md'],
    });
    await tick(store, d, { now: now(), force: true });
    expect(readdirSync(inboxDirOf(store, d))).toEqual([]);
    const reopened = ConductorStore.open(store.dir);
    expect(reopened.snapshot.reports[o.id]).toEqual([
      { ...progress, at: now().toISOString() },
      {
        workerId,
        status: 'done',
        summary: '검증 완료',
        refs: ['reports/result.md'],
        at: now().toISOString(),
      },
    ]);
    expect(JSON.stringify(reopened.snapshot.reports)).not.toContain('spawnRequest');
  });

  it('보고 refs의 저장소 밖 텍스트 파일을 복사하고 refs는 워커가 보낸 값 그대로 둔다', async () => {
    const { store, now } = clockedStore();
    const o = order();
    store.addOrder(o);
    const { deps: d, git } = deps();
    await tick(store, d, { now: now(), force: true });
    const workerId = git.started[0]!.worker.id;
    const work = resolve(tempStateDir());
    const md = join(work, 'review.md');
    writeFileSync(md, '# 결과');
    const refs = [md, join(work, 'gone.md'), 'https://example.com/x'];
    report(store, d, { workerId, status: 'done', summary: '끝', refs });
    await tick(store, d, { now: now(), force: true });

    const [stored] = ConductorStore.open(store.dir).snapshot.reports[o.id]!;
    expect(stored!.refs).toEqual(refs);
    expect(stored!.refCopies).toHaveLength(1);
    const copy = stored!.refCopies![0]!;
    expect(copy.ref).toBe(md);
    expect(copy.path).toMatch(new RegExp(`^refs/${o.id}/[0-9a-f]{8}-review\\.md$`));
    expect(readFileSync(join(store.dir, copy.path!), 'utf-8')).toBe('# 결과');
    expect(store.order(o.id)!.status).toBe('done');
  });

  it('refs 복사가 실패해도 보고는 그대로 적용하고 기록한다', async () => {
    const { store, now } = clockedStore();
    const o = order();
    store.addOrder(o);
    const { deps: d, git } = deps();
    await tick(store, d, { now: now(), force: true });
    const workerId = git.started[0]!.worker.id;
    const work = resolve(tempStateDir());
    const md = join(work, 'review.md');
    writeFileSync(md, '# 결과');
    // refs 자리에 파일이 있어 디렉토리를 못 만든다
    writeFileSync(join(store.dir, 'refs'), '');
    report(store, d, { workerId, status: 'done', summary: '끝', refs: [md] });
    const r = await tick(store, d, { now: now(), force: true });

    expect(r.errors).toEqual([]);
    expect(store.order(o.id)!.status).toBe('done');
    const [stored] = store.snapshot.reports[o.id]!;
    expect(stored!.refCopies).toEqual([{ ref: md, skipped: 'error', reason: expect.any(String) }]);
    expect(readdirSync(inboxDirOf(store, d))).toEqual([]);
  });

  it('적용 뒤 이력 기록만 실패한 보고는 다시 적용하지 않고 다음 tick에 기록만 남긴다', async () => {
    const { store, now } = clockedStore();
    const o = order();
    store.addOrder(o);
    const { deps: d, git } = deps();
    await tick(store, d, { now: now(), force: true });
    const workerId = git.started[0]!.worker.id;
    report(store, d, {
      workerId,
      status: 'needs',
      summary: '승인 부탁',
      need: { kind: 'simple-approval', detail: '부탁해요', step: 'ship-draft' },
      spawnRequest: { title: '하위', detail: 'x' },
    });
    const append = store.append.bind(store);
    store.append = (e) => {
      if (e.type === 'report-applied') throw new Error('디스크가 찼어요');
      append(e);
    };
    const first = await tick(store, d, { now: now(), force: true });
    expect(first.errors.some((e) => e.includes('이력 기록만 실패'))).toBe(true);
    const inbox = inboxDirOf(store, d);
    expect(readdirSync(join(inbox, UNRECORDED_REPORTS_DIR))).toHaveLength(1);
    expect(existsSync(join(inbox, FAILED_REPORTS_DIR))).toBe(false);
    const bypasses = store.snapshot.bypasses.length;
    const sent = git.sent.length;
    const orders = store.orders().length;
    expect(bypasses).toBe(1);

    store.append = append;
    const second = await tick(store, d, { now: now(), force: true });
    expect(second.errors).toEqual([]);
    expect(store.snapshot.bypasses).toHaveLength(bypasses);
    expect(git.sent).toHaveLength(sent);
    expect(store.orders()).toHaveLength(orders);
    expect(readdirSync(join(inbox, UNRECORDED_REPORTS_DIR))).toEqual([]);
    expect(ConductorStore.open(store.dir).snapshot.reports[o.id]).toMatchObject([
      { workerId, status: 'needs', summary: '승인 부탁' },
    ]);
  });

  it('기록만 실패한 보고를 다음 tick에 기록할 때도 refs 사본을 남기고 사본은 하나다', async () => {
    const { store, now } = clockedStore();
    const o = order();
    store.addOrder(o);
    const { deps: d, git } = deps();
    await tick(store, d, { now: now(), force: true });
    const workerId = git.started[0]!.worker.id;
    const work = resolve(tempStateDir());
    const md = join(work, 'review.md');
    writeFileSync(md, '# 결과');
    report(store, d, { workerId, status: 'done', summary: '끝', refs: [md] });
    const append = store.append.bind(store);
    store.append = (e) => {
      if (e.type === 'report-applied') throw new Error('디스크가 찼어요');
      append(e);
    };
    await tick(store, d, { now: now(), force: true });
    store.append = append;
    const second = await tick(store, d, { now: now(), force: true });

    expect(second.errors).toEqual([]);
    const [stored] = ConductorStore.open(store.dir).snapshot.reports[o.id]!;
    expect(stored!.refCopies).toHaveLength(1);
    expect(readFileSync(join(store.dir, stored!.refCopies![0]!.path!), 'utf-8')).toBe('# 결과');
    expect(readdirSync(join(store.dir, 'refs', o.id))).toHaveLength(1);
  });
});

describe('백그라운드 gate 멈춤', () => {
  it('gate를 백그라운드로 띄우고 턴을 끝낸 워커에 포그라운드 재실행을 한 번만 보낸다', async () => {
    const { store, advance } = clockedStore();
    const wt = resolve(tempStateDir());
    const roots = [resolve(tempStateDir(), 'projects')];
    const dir = join(roots[0]!, wt.replace(/[^A-Za-z0-9-]/g, '-'));
    mkdirSync(dir, { recursive: true });
    const rows = [
      {
        type: 'user',
        timestamp: '2026-11-01T00:00:01.000Z',
        message: { role: 'user', content: '시작' },
      },
      {
        type: 'assistant',
        timestamp: '2026-11-01T00:00:02.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'g1',
              name: 'Bash',
              input: { command: 'pnpm gate', run_in_background: true },
            },
          ],
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-11-01T00:00:03.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '기다려요' }],
          stop_reason: 'end_turn',
        },
      },
    ];
    writeFileSync(join(dir, 's.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    store.addOrder(order({ id: 'ord-g', status: 'running', workerId: 'wrk-g' }));
    store.startWorker(
      worker('ord-g', {
        id: 'wrk-g',
        kind: 'git-worktree',
        handle: wt,
        startedAt: '2026-11-01T00:00:00.000Z',
        lastSeenAt: '2026-11-01T00:00:00.000Z',
      }),
    );
    const noGit: CommandRunner = async () => ({ code: 1, stdout: '', stderr: '' });
    const { deps: d, git } = deps({ transcriptRoots: roots, gitRunner: noGit });
    advance(10 * 60_000);
    await tick(store, d, { force: true });
    expect(git.sent).toHaveLength(0);
    advance(10 * 60_000);
    await tick(store, d, { force: true });
    advance(60_000);
    await tick(store, d, { force: true });
    expect(git.sent.filter((s) => s.message.includes('포그라운드'))).toHaveLength(1);
  });
});

describe('파일 겹침', () => {
  function overlapSetup(...lists: string[][]) {
    const { store, advance } = clockedStore();
    const files: Record<string, string[]> = {};
    const runner: CommandRunner = async (_cmd, args, opts) => {
      if (args[0] === 'merge-base') return { code: 0, stdout: 'abcdef1\n', stderr: '' };
      if (args[0] === 'diff')
        return { code: 0, stdout: (files[opts?.cwd ?? ''] ?? []).join('\n'), stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    for (const [i, list] of lists.entries()) {
      const id = String.fromCharCode(97 + i);
      const handle = resolve(tempStateDir());
      files[handle] = list;
      const at = new Date(Date.parse('2026-11-01T00:00:00.000Z') + i * 300_000).toISOString();
      store.addOrder(order({ id: `ord-${id}`, status: 'running', workerId: `wrk-${id}` }));
      store.startWorker(
        worker(`ord-${id}`, {
          id: `wrk-${id}`,
          kind: 'git-worktree',
          handle,
          startedAt: at,
          lastSeenAt: at,
        }),
      );
    }
    const { deps: d } = deps({ gitRunner: runner, transcriptRoots: [] });
    return { store, advance, d };
  }

  it('겹치면 경고 한 줄과 겹친 파일을 남기고 기준 이하면 게이트는 안 연다', async () => {
    const { store, d } = overlapSetup(['a.ts', 'b.ts', 'c.ts'], ['b.ts', 'c.ts', 'd.ts']);
    const r = await tick(store, d, { force: true });
    expect(r.warnings.filter((w) => w.includes('같은 파일'))).toEqual([
      'ord-a와 ord-b가 같은 파일 2개를 고치고 있어요',
    ]);
    expect(store.openGates()).toHaveLength(0);
    expect(readWorkerInfo(store.dir, 'wrk-b').overlaps).toEqual([
      { orderId: 'ord-a', files: ['b.ts', 'c.ts'] },
    ]);
  });

  it('기준을 넘으면 뒤에 뜬 주문에 게이트를 한 번만 연다', async () => {
    const many = ['1', '2', '3', '4', '5', '6'].map((n) => `f${n}.ts`);
    const { store, d } = overlapSetup(many, many);
    await tick(store, d, { force: true });
    const gates = store.openGates();
    expect(gates.map((g) => [g.orderId, g.type])).toEqual([['ord-b', 'file-overlap']]);
    expect(store.order('ord-b')!.status).toBe('waiting-gate');
    resolveGate(store, gates[0]!.id, 'approved');
    await tick(store, d, { force: true });
    expect(store.openGates()).toHaveLength(0);
  });

  it('앞 주문 둘과 겹치면 한 상대씩 묻고 답을 받은 뒤 다음 상대를 묻는다', async () => {
    const many = ['1', '2', '3', '4', '5', '6'].map((n) => `f${n}.ts`);
    const { store, d } = overlapSetup(many, many, many);
    await tick(store, d, { force: true });
    const first = store.openGates('ord-c');
    expect(first).toHaveLength(1);
    const partner = first[0]!.payload?.['overlapWith'];
    const reason = first[0]!.reason;
    await tick(store, d, { force: true });
    expect(store.openGates('ord-c').map((g) => [g.payload?.['overlapWith'], g.reason])).toEqual([
      [partner, reason],
    ]);
    resolveGate(store, first[0]!.id, 'approved');
    await tick(store, d, { force: true });
    const second = store.openGates('ord-c');
    expect(second).toHaveLength(1);
    expect(second[0]!.payload?.['overlapWith']).not.toBe(partner);
    resolveGate(store, second[0]!.id, 'approved');
    await tick(store, d, { force: true });
    expect(store.openGates('ord-c')).toHaveLength(0);
  });

  it('뒤 주문 워커가 재개돼 id가 바뀌어도 같은 상대로 게이트를 다시 열지 않는다', async () => {
    const many = ['1', '2', '3', '4', '5', '6'].map((n) => `f${n}.ts`);
    const { store, d } = overlapSetup(many, many);
    await tick(store, d, { force: true });
    resolveGate(store, store.openGates()[0]!.id, 'approved');
    const prev = store.worker('wrk-b')!;
    store.updateWorker('wrk-b', { status: 'stopped' });
    store.startWorker({ ...prev, id: 'wrk-b2', attempt: prev.attempt + 1 });
    store.updateOrder('ord-b', { status: 'running', workerId: 'wrk-b2' });
    await tick(store, d, { force: true });
    expect(store.openGates()).toHaveLength(0);
  });
});

describe('tick 끝의 보관', () => {
  function barrier() {
    let open!: () => void;
    const wait = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { open, wait };
  }

  it('보관에서 돌아온 정상 tick은 후속 실패 tick이 잠금을 쥐고 있어도 성공 근거를 남긴다', async () => {
    const { store, dir, now } = clockedStore();
    const next = clockedStore(dir, now().getTime() + 1_500_000);
    const archiving = barrier();
    const archiveDone = barrier();
    const reading = barrier();
    const queueFailed = barrier();
    const { deps: firstDeps } = deps({
      archive: async () => {
        archiving.open();
        await archiveDone.wait;
        return undefined;
      },
    });
    const { deps: nextDeps } = deps({
      queue: {
        receive: async () => {
          reading.open();
          await queueFailed.wait;
          throw new Error('큐 읽기 실패 fixture');
        },
        ack: async () => {},
      },
    });
    const firstTick = tick(store, firstDeps);
    await archiving.wait;
    const nextTick = tick(next.store, nextDeps);
    await reading.wait;
    archiveDone.open();
    const success = await firstTick;
    const proofWhileLocked = readLastSuccessfulTick(dir);
    queueFailed.open();
    const failed = await nextTick;

    expect(success.errors).toEqual([]);
    expect(proofWhileLocked).toBe(success.at);
    expect(failed.errors).toEqual(['큐 읽기 실패 fixture']);
    expect(ConductorStore.open(dir).snapshot.lastTickAt).toBe(failed.at);
    expect(readLastSuccessfulTick(dir)).toBe(success.at);
  });

  it('오래된 tick의 보관이 늦게 끝나도 더 최근의 성공 시각을 유지한다', async () => {
    const { store, dir, now } = clockedStore();
    const archiveStarted = barrier();
    const archiveDone = barrier();
    const { deps: earlier } = deps({
      archive: async () => {
        archiveStarted.open();
        await archiveDone.wait;
        return undefined;
      },
    });
    const { deps: later } = deps();
    const firstTick = tick(store, earlier);
    await archiveStarted.wait;
    const newer = await tick(clockedStore(dir, now().getTime() + 1_500_000).store, later);
    archiveDone.open();
    const older = await firstTick;

    expect(older.errors).toEqual([]);
    expect(newer.errors).toEqual([]);
    expect(older.at < newer.at).toBe(true);
    expect(readLastSuccessfulTick(dir)).toBe(newer.at);
  });

  it('잠금을 놓은 뒤 보관을 부르고 결과를 보고에 싣는다', async () => {
    const { store } = clockedStore();
    let lockFree = false;
    const { deps: d } = deps({
      archive: async () => {
        const lock = acquireLock(store.dir);
        lockFree = lock.ok;
        if (lock.ok) lock.release();
        return {
          orders: ['ord-a'],
          removed: [],
          gates: 0,
          blocked: [{ id: 'ord-b', reason: 'ord-b: 열린 게이트가 있어요' }],
          compressed: [],
          swept: { prompts: 0, activity: 0, handoffs: 0 },
          warnings: ['빈 events.jsonl'],
        };
      },
    });

    const r = await tick(store, d);

    expect(lockFree).toBe(true);
    expect(r.archive?.orders).toEqual(['ord-a']);
    expect(r.warnings).toContain('보관: 빈 events.jsonl');
    expect(r.warnings.some((w) => w.includes('못 옮긴 주문 1개: ord-b'))).toBe(true);
    expect(readLastSuccessfulTick(store.dir)).toBe(r.at);
  });

  it('보관이 실패해도 tick 결과는 그대로 두고 오류만 남긴다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-1' }));
    const { deps: d } = deps({
      archive: () => Promise.reject(new Error('디스크가 찼어요')),
    });

    const r = await tick(store, d);

    expect(r.launched).toHaveLength(1);
    expect(r.errors).toContain('보관 실패: 디스크가 찼어요');
    expect(r.archive).toBeUndefined();
    expect(store.snapshot.lastTickAt).toBe(r.at);
    expect(readLastSuccessfulTick(store.dir)).toBeNull();
  });

  it('보관이 상태를 바꾸고 던져도 store를 다시 읽는다', async () => {
    const { store } = clockedStore();
    const { deps: d } = deps({
      archive: () => {
        ConductorStore.open(store.dir).addOrder(order({ id: 'ord-late' }));
        return Promise.reject(new Error('중간에 멈췄어요'));
      },
    });

    const r = await tick(store, d);

    expect(r.errors).toContain('보관 실패: 중간에 멈췄어요');
    expect(store.order('ord-late')).toBeDefined();
  });

  it('감시 간격 안이라 건너뛴 tick은 보관을 안 부른다', async () => {
    const { store } = clockedStore();
    let calls = 0;
    const { deps: d } = deps({
      archive: async () => {
        calls++;
        return undefined;
      },
    });
    await tick(store, d);
    const skipped = await tick(store, d);

    expect(skipped.skipped).toBe(true);
    expect(calls).toBe(1);
  });
});

describe('배포 주문의 대상 주문 배포 기록', () => {
  function memoryDeploy() {
    const signals = new Map<string, DeploySignal>();
    return {
      signals,
      source: {
        status: async (o: { id: string }) => signals.get(o.id) ?? { status: 'pending' as const },
        record: (id: string, s: DeploySignal) => {
          signals.set(id, s);
        },
      },
    };
  }

  function seed(store: ConductorStore) {
    store.addOrder(
      order({ id: 'ord-a', issueKey: 'APP-1', issueType: 'sub-bug', status: 'merged' }),
    );
    store.addOrder(order({ id: 'ord-b', issueKey: 'APP-2', issueType: 'bug', status: 'merged' }));
    store.addOrder(order({ id: 'ord-done', issueKey: 'APP-3', issueType: 'bug', status: 'done' }));
    store.addOrder(
      order({ id: 'ord-story', issueKey: 'APP-4', issueType: 'story', status: 'merged' }),
    );
    store.addOrder(
      order({ id: 'ord-open', issueKey: 'APP-5', issueType: 'bug', status: 'running' }),
    );
    store.addOrder(
      order({
        id: 'ord-deploy',
        title: 'dev, stage 배포',
        deploys: ['ord-a', 'ord-b', 'ord-done', 'ord-story', 'ord-open'],
      }),
    );
  }

  async function launchDeploy(store: ConductorStore, d: EngineDeps): Promise<string> {
    await tick(store, d, { force: true });
    return store.order('ord-deploy')!.workerId!;
  }

  it('배포 워커가 done이면 머지된 대상에 성공 신호를 남기고 같은 tick에 In-QA로 끝낸다', async () => {
    const { store } = clockedStore();
    seed(store);
    const jira = fakeJira();
    const mem = memoryDeploy();
    const { deps: d } = deps({
      config: { ...config, maxConcurrentWorkers: 5 },
      jira: jira.client,
      deploy: mem.source,
    });
    const wid = await launchDeploy(store, d);
    report(store, d, {
      workerId: wid,
      status: 'done',
      summary: '배포했어요',
      deployRef: 'https://github.com/acme/app/actions/runs/1',
    });

    const r = await tick(store, d, { force: true });
    const ref = 'https://github.com/acme/app/actions/runs/1';
    expect(mem.signals.get('ord-a')).toEqual({ status: 'success', ref });
    expect(mem.signals.get('ord-b')).toEqual({ status: 'success', ref });
    expect(mem.signals.has('ord-done')).toBe(false);
    expect(mem.signals.has('ord-story')).toBe(false);
    expect(mem.signals.has('ord-open')).toBe(false);
    expect(store.order('ord-a')).toMatchObject({ status: 'done', deployedAt: r.at });
    expect(store.order('ord-b')).toMatchObject({ status: 'done', deployedAt: r.at });
    expect(jira.moves).toEqual(
      expect.arrayContaining([
        { key: 'APP-1', to: 'In-QA' },
        { key: 'APP-2', to: 'In-QA' },
      ]),
    );
    expect(r.deployTargets).toEqual([
      { deployOrderId: 'ord-deploy', orderId: 'ord-a', outcome: 'recorded' },
      { deployOrderId: 'ord-deploy', orderId: 'ord-b', outcome: 'recorded' },
      expect.objectContaining({ orderId: 'ord-done', outcome: 'skipped' }),
      expect.objectContaining({ orderId: 'ord-story', outcome: 'skipped' }),
    ]);
    expect(r.warnings).toEqual([
      expect.stringContaining('ord-open가 머지된 상태가 아니라(running)'),
    ]);
    expect(store.order('ord-deploy')).toMatchObject({
      status: 'done',
      deployResult: { ref },
      deploysRecordedAt: r.at,
    });

    // 한 번 남긴 배포 주문은 다음 tick에 다시 돌지 않는다
    const again = await tick(store, d, { force: true });
    expect(again.deployTargets).toEqual([]);
    expect(again.warnings).toEqual([]);
  });

  it('배포 주소를 안 실으면 배포 주문 id를 ref로 남긴다', async () => {
    const { store } = clockedStore();
    store.addOrder(
      order({ id: 'ord-a', issueKey: 'APP-1', issueType: 'sub-bug', status: 'merged' }),
    );
    store.addOrder(order({ id: 'ord-deploy', deploys: ['ord-a'] }));
    const mem = memoryDeploy();
    const { deps: d } = deps({ deploy: mem.source });
    const wid = await launchDeploy(store, d);
    report(store, d, { workerId: wid, status: 'done' });
    await tick(store, d, { force: true });
    expect(mem.signals.get('ord-a')).toEqual({ status: 'success', ref: 'ord-deploy' });
    expect(store.order('ord-a')!.status).toBe('done');
  });

  it('배포 워커가 실패하면 대상에 아무것도 안 남긴다', async () => {
    const { store } = clockedStore();
    seed(store);
    const mem = memoryDeploy();
    const { deps: d } = deps({
      config: { ...config, maxConcurrentWorkers: 5 },
      deploy: mem.source,
    });
    const wid = await launchDeploy(store, d);
    report(store, d, { workerId: wid, status: 'failed', deployRef: 'https://x/run/2' });
    const r = await tick(store, d, { force: true });
    expect(mem.signals.size).toBe(0);
    expect(r.deployTargets).toEqual([]);
    expect(store.order('ord-a')!.status).toBe('merged');
    expect(store.order('ord-deploy')!.deployResult).toBeUndefined();
  });

  it('배포 주문이 취소되면 늦은 done 보고가 와도 대상에 아무것도 안 남긴다', async () => {
    const { store } = clockedStore();
    seed(store);
    const mem = memoryDeploy();
    const { deps: d } = deps({
      config: { ...config, maxConcurrentWorkers: 5 },
      deploy: mem.source,
    });
    const wid = await launchDeploy(store, d);
    store.updateOrder('ord-deploy', { status: 'cancelled' });
    report(store, d, { workerId: wid, status: 'done' });
    await tick(store, d, { force: true });
    expect(mem.signals.size).toBe(0);
    expect(store.order('ord-a')!.status).toBe('merged');
  });

  it('이미 배포 실패 신호가 있는 대상은 성공으로 덮지 않는다', async () => {
    const { store } = clockedStore();
    store.addOrder(
      order({ id: 'ord-a', issueKey: 'APP-1', issueType: 'sub-bug', status: 'merged' }),
    );
    store.addOrder(
      order({ id: 'ord-deploy', status: 'done', deploys: ['ord-a'], deployResult: { at: 'x' } }),
    );
    const mem = memoryDeploy();
    mem.signals.set('ord-a', { status: 'failed', ref: 'https://x/run/9' });
    const { deps: d } = deps({ deploy: mem.source });
    const r = await tick(store, d, { force: true });
    expect(mem.signals.get('ord-a')).toEqual({ status: 'failed', ref: 'https://x/run/9' });
    expect(r.deployTargets).toEqual([
      expect.objectContaining({ orderId: 'ord-a', outcome: 'skipped' }),
    ]);
    expect(store.order('ord-a')!.status).toBe('escalated');
  });

  it('대상 하나만 기록에 실패하면 다음 tick에 그 대상만 다시 남긴다', async () => {
    const { store } = clockedStore();
    store.addOrder(
      order({ id: 'ord-a', issueKey: 'APP-1', issueType: 'sub-bug', status: 'merged' }),
    );
    store.addOrder(order({ id: 'ord-b', issueKey: 'APP-2', issueType: 'bug', status: 'merged' }));
    store.addOrder(
      order({
        id: 'ord-deploy',
        status: 'done',
        deploys: ['ord-a', 'ord-b'],
        deployResult: { at: 'x' },
      }),
    );
    const mem = memoryDeploy();
    let broken = true;
    const source = {
      status: mem.source.status,
      record: (id: string, s: DeploySignal) => {
        if (id === 'ord-b' && broken) throw new Error('disk full');
        mem.source.record(id, s);
      },
    };
    const { deps: d } = deps({ deploy: source });
    const first = await tick(store, d, { force: true });
    expect(first.errors).toEqual([expect.stringContaining('ord-b에 배포 성공을 못 남겼어요')]);
    expect(store.order('ord-a')!.status).toBe('done');
    expect(store.order('ord-deploy')!.deploysRecordedAt).toBeUndefined();

    broken = false;
    const second = await tick(store, d, { force: true });
    expect(second.deployTargets).toEqual([
      expect.objectContaining({ orderId: 'ord-a', outcome: 'skipped' }),
      { deployOrderId: 'ord-deploy', orderId: 'ord-b', outcome: 'recorded' },
    ]);
    expect(store.order('ord-b')!.status).toBe('done');
    expect(store.order('ord-deploy')!.deploysRecordedAt).toBe(second.at);
  });

  it('대상의 배포 신호를 못 읽으면 성공을 안 남기고 다음 tick에 다시 시도한다', async () => {
    const { store } = clockedStore();
    store.addOrder(
      order({ id: 'ord-a', issueKey: 'APP-1', issueType: 'sub-bug', status: 'merged' }),
    );
    store.addOrder(
      order({ id: 'ord-deploy', status: 'done', deploys: ['ord-a'], deployResult: { at: 'x' } }),
    );
    const recorded: string[] = [];
    const source = {
      status: async (): Promise<never> => {
        throw new Error('EACCES');
      },
      record: (id: string) => {
        recorded.push(id);
      },
    };
    const { deps: d } = deps({ deploy: source });
    const r = await tick(store, d, { force: true });
    expect(r.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('ord-a의 배포 신호를 못 읽었어요')]),
    );
    expect(recorded).toEqual([]);
    expect(store.order('ord-deploy')!.deploysRecordedAt).toBeUndefined();
  });

  it('신호를 남길 자리가 없으면 오류로 알리고 다음 tick에 다시 시도한다', async () => {
    const { store } = clockedStore();
    store.addOrder(
      order({ id: 'ord-a', issueKey: 'APP-1', issueType: 'sub-bug', status: 'merged' }),
    );
    store.addOrder(
      order({ id: 'ord-deploy', status: 'done', deploys: ['ord-a'], deployResult: { at: 'x' } }),
    );
    const { deps: d } = deps({ deploy: { status: async () => ({ status: 'pending' }) } });
    const r = await tick(store, d, { force: true });
    expect(r.errors).toEqual([expect.stringContaining('ord-deploy: 배포 신호를 남길 자리가 없어')]);
    expect(store.order('ord-deploy')!.deploysRecordedAt).toBeUndefined();
  });
});
