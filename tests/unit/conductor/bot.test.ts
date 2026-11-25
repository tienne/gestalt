import { generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  conductorBotDecideCommand,
  conductorBotGateCommand,
  conductorBotGithubCommand,
  conductorCheckBotMutation,
  conductorGateResolveCommand,
  conductorWorkerDecisionCommand,
} from '../../../src/cli/commands/conductor.js';
import { GhAccounts, fileQueue } from '../../../src/conductor/adapters.js';
import { approvalMessage, BOT_POLICY_FILE } from '../../../src/conductor/bot-approval.js';
import { readGithubOrder, handleGithubOrder } from '../../../src/conductor/bot-github.js';
import {
  assertBotOwner,
  changeBotOwner,
  readBotOwnership,
} from '../../../src/conductor/bot-owner.js';
import { acquireLock, tick } from '../../../src/conductor/engine.js';
import { openOrReuse } from '../../../src/conductor/gates.js';
import { GitWorktreeLauncher, OrcaLauncher } from '../../../src/conductor/launcher.js';
import { pollQueue } from '../../../src/conductor/intake.js';
import { loadConfig } from '../../../src/core/config.js';
import { ConductorStore } from '../../../src/conductor/store.js';
import type { Worker } from '../../../src/conductor/types.js';
import { cleanupStateDirs, order, tempStateDir, worker } from './fixtures.js';

const owner = { botId: 'ops-bot', name: 'Conductor', chatId: 'ops-home' };
const delegate = { ...owner, chatId: 'ops-delegate' };
const team = { botId: 'team-bot', name: 'Team', chatId: 'team-thread' };
const repo = 'acme/app';
const pr = `${repo}#42`;
const sha = 'a'.repeat(40);
const issue = `https://github.com/${repo}/issues/17`;
const comment = `${issue}#issuecomment-303`;
const policy = { githubIntakeBotId: team.botId, githubRepositories: { [repo]: [100] } };

function executable(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
  chmodSync(path, 0o700);
}

function fakeOrca(caller: typeof owner | undefined) {
  const exe = join(tempStateDir(), 'orca');
  const chats = caller
    ? {
        ok: true,
        result: { bot: caller.name, chats: [{ id: caller.chatId, self: true, closed: false }] },
      }
    : {
        ok: false,
        error: {
          code: 'invalid_argument',
          message: 'Name the bot with --bot, or run this from the bot’s chat.',
        },
      };
  const roster = {
    ok: true,
    result: {
      bots: [owner, team].map((bot) => ({ id: bot.botId, name: bot.name, paused: false })),
    },
  };
  executable(
    exe,
    `
case "$2" in
chats) echo '${JSON.stringify(chats)}'; exit ${caller ? 0 : 1} ;;
list) echo '${JSON.stringify(roster)}' ;;
*) exit 1 ;;
esac`,
  );
  vi.stubEnv('ORCA_CLI_COMMAND', exe);
  vi.stubEnv('ORCA_AGENT_SESSION_ID', 'mock-session-id');
}

function fakePr(head = sha, base = 'main') {
  const bin = tempStateDir();
  const evidence = {
    headRefOid: head,
    baseRefName: base,
    state: 'OPEN',
    isDraft: false,
    statusCheckRollup: [{ name: 'CI', conclusion: 'SUCCESS' }],
  };
  executable(join(bin, 'gh'), `echo '${JSON.stringify(evidence)}'`);
  vi.stubEnv('PATH', `${bin}:${process.env['PATH'] ?? ''}`);
}

let lines: string[];
beforeEach(() => {
  lines = [];
  vi.stubEnv('GESTALT_CONDUCTOR_WORKER_ID', undefined);
  vi.spyOn(console, 'log').mockImplementation((v: unknown) => void lines.push(String(v)));
  vi.spyOn(console, 'error').mockImplementation((v: unknown) => void lines.push(String(v)));
  vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  cleanupStateDirs();
});

const last = () => JSON.parse(lines.at(-1)!);

describe('Orca 봇 운영권', () => {
  it('tick 잠금을 잡은 동안 인계가 실패하면 앞 채팅이 계속 운영하고 이전 성공 뒤에는 앞 채팅을 차단한다', async () => {
    const store = ConductorStore.open(tempStateDir());
    expect(() => assertBotOwner(store.dir, undefined)).not.toThrow();
    changeBotOwner(store.dir, undefined, owner);
    expect(() => assertBotOwner(store.dir, undefined)).toThrow('운영권');
    const lock = acquireLock(store.dir);
    if (!lock.ok) throw new Error('fixture lock');
    try {
      expect(() => changeBotOwner(store.dir, owner.chatId, delegate)).toThrow('tick');
      expect(readBotOwnership(store.dir).active).toEqual(owner);
    } finally {
      lock.release();
    }
    changeBotOwner(store.dir, owner.chatId, delegate);
    expect(() => changeBotOwner(store.dir, owner.chatId, team)).toThrow('바뀌었어요');
    expect(() => changeBotOwner(store.dir, delegate.chatId, owner)).toThrow('다시 등록');

    const deps = { config: loadConfig().conductor, env: {}, launchers: {}, orcaAvailable: false };
    await expect(
      tick(store, deps, { force: true, admit: () => assertBotOwner(store.dir, owner) }),
    ).rejects.toThrow('인계한');
    expect(store.snapshot.lastTickAt).toBeUndefined();
    await expect(
      tick(store, deps, { force: true, admit: () => assertBotOwner(store.dir, delegate) }),
    ).resolves.not.toHaveProperty('skipped', true);
    changeBotOwner(store.dir, delegate.chatId);
    expect(() => assertBotOwner(store.dir, undefined)).not.toThrow();
    expect(() => assertBotOwner(store.dir, owner)).toThrow('인계한');
  });
});

function gateFixture(kind: Worker['kind'] = 'git-worktree') {
  const store = ConductorStore.open(tempStateDir());
  const issueOrder = order({ repo, prRef: pr, status: 'running' });
  const w = worker(issueOrder.id, { kind, handle: 'ctx_1' });
  store.addOrder({ ...issueOrder, workerId: w.id });
  store.startWorker(w);
  const { gate } = openOrReuse(store, {
    type: 'merge',
    orderId: issueOrder.id,
    reason: '머지 승인',
  });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  writeFileSync(
    join(store.dir, BOT_POLICY_FILE),
    JSON.stringify({
      ...policy,
      mergeApprovers: {
        [repo]: { 'approver-1': publicKey.export({ type: 'spki', format: 'pem' }) },
      },
      gateApprovers: {
        [repo]: { 'approver-1': publicKey.export({ type: 'spki', format: 'pem' }) },
      },
    }),
  );
  changeBotOwner(store.dir, undefined, owner);
  const signed = sign(
    null,
    Buffer.from(approvalMessage(gate, pr, sha, 'approved')),
    privateKey,
  ).toString('base64');
  const opts = {
    stateDir: store.dir,
    decision: 'approved',
    signer: 'approver-1',
    signature: signed,
  };
  return { store, gate, opts, w, privateKey };
}

const prEvidence = { head: sha, base: 'main', state: 'OPEN', draft: false };
const tickDeps = () => ({
  config: loadConfig().conductor,
  env: {},
  launchers: {},
  orcaAvailable: true,
  readApprovalEvidence: async () => prEvidence,
});

function watchedReviewFixture() {
  const { store, opts, privateKey, w } = gateFixture();
  store.updateOrder(w.orderId, { prRef: `${repo}#99` });
  const { gate } = openOrReuse(store, {
    type: 'review-manual-switch',
    reason: '답글 재리뷰',
    refs: [pr],
    payload: { prRef: pr, sourceRef: `pr-watch:replies:${pr}@${sha}:1` },
  });
  return { store, gate, opts, privateKey };
}

describe('Orca 채팅 머지 승인', () => {
  it('검증 결과를 표시하고 서명된 결정을 한 번만 기록한 뒤 전달 대기를 보여 준다', async () => {
    fakeOrca(owner);
    fakePr();
    const { store, gate, opts } = gateFixture();
    await conductorBotGateCommand(gate.id, opts);
    expect(last()).toMatchObject({
      gateId: gate.id,
      pr: `https://github.com/${repo}/pull/42`,
      evidence: { checks: [{ name: 'CI', result: 'SUCCESS' }] },
    });
    await conductorBotDecideCommand(gate.id, opts);
    expect(last()).toMatchObject({
      decision: 'approved',
      delivery: 'pending',
      signer: opts.signer,
    });
    await conductorBotDecideCommand(gate.id, opts);
    expect(last()).toMatchObject({
      decision: 'approved',
      alreadyResolved: true,
      delivery: 'pending',
    });
    store.reload();
    expect(store.snapshot.gates[gate.id]?.answer).toContain(`--match-head-commit ${sha}`);
  });

  it('같은 서명을 동시에 받아도 게이트와 주문 반영이 이벤트 한 줄로 복구된다', async () => {
    fakeOrca(owner);
    fakePr();
    const { store, gate, opts, w } = gateFixture();
    store.updateWorker(w.id, { waiting: { reason: '머지 승인', since: store.timestamp() } });
    const eventsBefore = store.snapshot.eventCount;

    await Promise.all([
      conductorBotDecideCommand(gate.id, opts),
      conductorBotDecideCommand(gate.id, opts),
    ]);

    const reopened = ConductorStore.open(store.dir);
    const applied = reopened.snapshot.gates[gate.id]!;
    expect(reopened.snapshot.eventCount).toBe(eventsBefore + 1);
    expect(reopened.order(w.orderId)?.status).toBe('running');
    expect(reopened.worker(w.id)?.waiting).toBeUndefined();
    expect(reopened.worker(w.id)?.lastSeenAt).toBe(applied.resolvedAt);
    const replies = lines.map((line) => JSON.parse(line));
    expect(replies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ decisionId: applied.receipt?.id, gateApplication: 'applied' }),
        expect.objectContaining({ sameDecision: true, deliveryId: applied.receipt?.deliveryId }),
      ]),
    );
  });

  it('전송 성공 직후 기록이 끊겨도 재시작한 tick은 같은 Orca 요청을 재사용한다', async () => {
    fakeOrca(owner);
    fakePr();
    const { store, gate, opts } = gateFixture('orca-worktree');
    await conductorBotDecideCommand(gate.id, opts);
    const { deliveryId, decisionId } = last();
    store.reload();
    expect(
      openOrReuse(store, { type: 'merge', orderId: gate.orderId!, reason: gate.reason }),
    ).toMatchObject({ gate: { id: gate.id, status: 'resolved' }, reused: true });
    const requests: string[] = [];
    const accepted = new Set<string>();
    const launcher = new OrcaLauncher({
      orcaCommand: 'fixture-orca',
      promptDir: tempStateDir(),
      repoPaths: {},
      runner: async (_command, args) => {
        expect(args.slice(0, 4)).toEqual(['orchestration', 'send', '--to', 'dispatch:ctx_1']);
        const request = args[args.indexOf('--retry-request') + 1]!;
        expect(args[args.indexOf('--body') + 1]).toContain(`전달 ID: ${request}`);
        requests.push(request);
        accepted.add(request);
        return { code: 0, stdout: 'Sent msg-fixture', stderr: '' };
      },
    });
    const deps = { ...tickDeps(), launchers: { 'orca-worktree': launcher } };
    const append = store.append.bind(store);
    vi.spyOn(store, 'append').mockImplementation((event) => {
      if (event.type === 'gate-delivery' && event.outcome === 'delivered')
        throw new Error('전송 직후 기록 중단');
      append(event);
    });
    await Promise.all([
      tick(store, deps, { force: true }),
      tick(ConductorStore.open(store.dir), deps, { force: true }),
    ]);
    await conductorBotGateCommand(gate.id, opts);
    expect(last()).toMatchObject({
      decisionId,
      deliveryId,
      delivery: 'unknown',
      deliveryPending: true,
    });

    const reopened = ConductorStore.open(store.dir);
    await tick(reopened, deps, { force: true });
    await tick(ConductorStore.open(store.dir), deps, { force: true });
    expect(requests).toEqual([deliveryId, deliveryId]);
    expect(accepted.size).toBe(1);
    await conductorBotGateCommand(gate.id, opts);
    expect(last()).toMatchObject({
      decisionId,
      deliveryId,
      delivery: 'delivered',
      deliveryPending: false,
      deliveryAttempts: 2,
      processing: 'unknown',
    });
  });

  it('전달이 대기 중이면 끝난 워커의 일반 정리도 보류한다', async () => {
    fakeOrca(owner);
    fakePr();
    const { store, gate, opts, w } = gateFixture('orca-worktree');
    await conductorBotDecideCommand(gate.id, opts);
    store.reload();
    store.append({
      type: 'gate-delivery',
      at: store.timestamp(),
      gateId: gate.id,
      pending: true,
      outcome: 'unknown',
      attempts: 1,
    });
    store.updateWorker(w.id, { status: 'finished' });
    store.updateOrder(w.orderId, { status: 'done' });
    const release = vi.fn();
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error('GitHub 장애'))
      .mockResolvedValue(prEvidence);
    const deps = {
      ...tickDeps(),
      readApprovalEvidence: read,
      launchers: {
        'orca-worktree': { kind: 'orca-worktree' as const, release, send: vi.fn(), start: vi.fn() },
      },
    };
    const reopened = ConductorStore.open(store.dir);
    const pending = await tick(reopened, deps, { force: true });
    expect(release).not.toHaveBeenCalled();
    expect(pending.warnings).toContainEqual(
      expect.stringContaining('승인 결정 전달 결과를 확인 중'),
    );
    expect(reopened.snapshot.gates[gate.id]).toMatchObject({
      deliveryPending: true,
      deliveryOutcome: 'unknown',
    });
    await tick(reopened, deps, { force: true });
    expect(release).toHaveBeenCalledTimes(1);
    expect(reopened.snapshot.gates[gate.id]?.deliveryPending).toBeUndefined();
  });

  const changedReviewScope = [
    [{ ...prEvidence, head: 'b'.repeat(40) }, 'HEAD'],
    [{ ...prEvidence, base: 'release' }, 'base 브랜치'],
  ] as const;

  it.each(changedReviewScope)(
    '발급 뒤 재리뷰 범위가 바뀌면 예전 서명으로 접수하지 않는다',
    async (current) => {
      fakeOrca(owner);
      fakePr();
      const { store, gate, opts, privateKey } = watchedReviewFixture();
      await conductorBotGateCommand(gate.id, opts);
      const initial = last();
      expect(JSON.parse(initial.messages.approved)).toEqual(
        expect.arrayContaining([pr, sha, 'main']),
      );
      const signature = sign(null, Buffer.from(initial.messages.approved), privateKey).toString(
        'base64',
      );

      fakePr(current.head, current.base);
      await conductorBotGateCommand(gate.id, opts);
      expect(last().messages.approved).not.toBe(initial.messages.approved);
      expect(last().orcaItem.binding).not.toBe(initial.orcaItem.binding);
      await expect(conductorBotDecideCommand(gate.id, { ...opts, signature })).rejects.toThrow(
        'exit 1',
      );
      expect(lines.at(-1)).toContain('서명을 확인하지 못했어요');
      expect(ConductorStore.open(store.dir).snapshot.gates[gate.id]?.status).toBe('open');
    },
  );

  it.each([
    ['HEAD 변경 유지', ...changedReviewScope[0], false],
    ['base 변경 유지', ...changedReviewScope[1], false],
    ['base 원복', ...changedReviewScope[1], true],
  ] as const)(
    '교체 게이트 저장 직후 중단에서 복구해 재리뷰 주문을 한 번만 만든다 (%s)',
    async (_name, current, reason, revert) => {
      fakeOrca(owner);
      fakePr();
      const { store, gate, opts, privateKey } = watchedReviewFixture();
      await conductorBotGateCommand(gate.id, opts);
      const signature = sign(null, Buffer.from(last().messages.approved), privateKey).toString(
        'base64',
      );
      await conductorBotDecideCommand(gate.id, { ...opts, signature });
      expect(last()).toMatchObject({ target: { base: 'main', head: sha }, delivery: 'pending' });
      let observed = current;
      const deps = {
        ...tickDeps(),
        readApprovalEvidence: async () => observed,
        prSource: {
          authored: async () => [],
          reviewing: async () => [
            {
              ref: pr,
              repo,
              title: '재리뷰 PR',
              headSha: observed.head,
              reviewedHeadSha: sha,
              repliesSinceReview: 1,
            },
          ],
        },
      };
      const reopened = ConductorStore.open(store.dir);
      const append = reopened.append.bind(reopened);
      vi.spyOn(reopened, 'append').mockImplementation((event) => {
        append(event);
        if (event.type === 'gate-opened' && event.gate.payload?.reapprovalOf === gate.id)
          throw new Error('새 게이트 생성 직후 기록 중단');
      });
      const result = await tick(reopened, deps, { force: true });
      expect(result.errors).toContainEqual(
        expect.stringContaining('새 게이트 생성 직후 기록 중단'),
      );
      expect(result.created).toHaveLength(0);
      const [replacement] = reopened.openGates().filter((g) => g.type === 'review-manual-switch');
      expect(replacement).toMatchObject({
        reason: expect.stringContaining(current.base),
        payload: { prRef: pr, approvalBase: current.base, reapprovalOf: gate.id },
      });
      expect(replacement?.reason).toContain(current.head);
      if (revert) observed = prEvidence;
      const retry = ConductorStore.open(store.dir);
      expect(retry.snapshot.gates[gate.id]).toMatchObject({
        deliveryOutcome: 'superseded',
        deliveryDetail: expect.stringContaining(reason),
      });
      expect(retry.snapshot.gates[gate.id]?.deliveryPending).toBeUndefined();
      expect((await tick(retry, deps, { force: true })).created).toHaveLength(0);
      expect(
        retry
          .openGates()
          .filter((g) => g.type === 'review-manual-switch')
          .map((g) => g.id),
      ).toEqual([replacement!.id]);
      fakePr(observed.head, observed.base);
      await conductorBotGateCommand(replacement!.id, opts);
      const newSignature = sign(null, Buffer.from(last().messages.approved), privateKey).toString(
        'base64',
      );
      await conductorBotDecideCommand(replacement!.id, { ...opts, signature: newSignature });
      expect(last()).toMatchObject({ target: { base: observed.base, head: observed.head } });
      expect((await tick(retry, deps, { force: true })).created).toHaveLength(1);
      for (let i = 0; i < 2; i++) {
        const restart = ConductorStore.open(store.dir);
        expect((await tick(restart, deps, { force: true })).created).toHaveLength(0);
        expect(restart.orders().filter((o) => o.prRef === pr)).toHaveLength(1);
      }
    },
  );

  it.each([
    [{ ...prEvidence, head: 'b'.repeat(40) }, 'HEAD'],
    [{ ...prEvidence, base: 'release' }, 'base 브랜치'],
  ] as const)(
    '전달할 PR 범위가 달라지면 새 게이트만 열고 이전 결정을 보내지 않는다',
    async (current, reason) => {
      fakeOrca(owner);
      fakePr();
      const { store, gate, opts, w } = gateFixture('orca-worktree');
      await conductorBotDecideCommand(gate.id, opts);
      const deliveryId = last().deliveryId;
      const send = vi.fn();
      const deps = {
        ...tickDeps(),
        readApprovalEvidence: async () => current,
        launchers: {
          'orca-worktree': {
            kind: 'orca-worktree' as const,
            send,
            start: vi.fn(),
            release: vi.fn(),
          },
        },
      };
      await tick(store, deps, { force: true });
      expect(send).not.toHaveBeenCalled();
      expect(store.openGates(w.orderId)).toHaveLength(1);
      expect(store.order(w.orderId)?.status).toBe('waiting-gate');
      await conductorBotGateCommand(gate.id, opts);
      expect(last()).toMatchObject({
        deliveryId,
        delivery: 'superseded',
        deliveryDetail: expect.stringContaining(reason),
      });
    },
  );

  it('GitHub 조회 장애는 대기로 남고 복구되면 호스트 워커가 같은 결정의 수신 결과를 조회한다', async () => {
    fakeOrca(owner);
    fakePr();
    const { store, gate, opts, w } = gateFixture();
    await conductorBotDecideCommand(gate.id, opts);
    const deliveryId = last().deliveryId;
    const readApprovalEvidence = vi
      .fn()
      .mockRejectedValueOnce(new Error('GitHub 장애'))
      .mockResolvedValue(prEvidence);
    const deps = {
      ...tickDeps(),
      readApprovalEvidence,
      launchers: {
        'git-worktree': new GitWorktreeLauncher({
          promptDir: tempStateDir(),
          worktreeRoot: tempStateDir(),
          repoPaths: {},
        }),
      },
    };
    await tick(store, deps, { force: true });
    await conductorBotGateCommand(gate.id, opts);
    expect(last()).toMatchObject({
      deliveryId,
      delivery: 'failed',
      deliveryPending: true,
      deliveryDetail: 'GitHub 장애',
    });
    const report = await tick(ConductorStore.open(store.dir), deps, { force: true });
    expect(report.hostActions).toContainEqual({
      type: 'send',
      workerId: w.id,
      message: expect.stringContaining(`--delivery ${deliveryId}`),
    });
    const claim = { stateDir: store.dir, worker: w.id, delivery: deliveryId };
    await conductorWorkerDecisionCommand(claim);
    const received = last();
    expect(received).toMatchObject({
      deliveryId,
      alreadyReceived: false,
      processing: 'pending',
      message: expect.stringContaining(sha),
    });
    lines.length = 0;
    await conductorWorkerDecisionCommand(claim);
    expect(last()).toEqual({ ...received, alreadyReceived: true });
    await conductorBotGateCommand(gate.id, opts);
    expect(last()).toMatchObject({
      deliveryId,
      delivery: 'host-action',
      processing: 'pending',
      deliveryPending: true,
    });
    await conductorWorkerDecisionCommand({
      ...claim,
      report: 'https://github.com/acme/app/pull/42',
    });
    const processing = last();
    expect(processing).toMatchObject({
      deliveryId,
      processing: 'reported',
      workerReport: { workerId: w.id },
    });
    expect(processing).not.toHaveProperty('message');
    await conductorWorkerDecisionCommand(claim);
    expect(last()).toEqual(processing);
    await conductorBotGateCommand(gate.id, opts);
    expect(last()).toMatchObject({
      deliveryId,
      delivery: 'delivered',
      processing: 'reported',
      deliveryPending: false,
    });
  });

  it('패널이 먼저 거절한 뒤 늦게 온 채팅 승인은 기존 결정을 바꾸지 않는다', async () => {
    fakeOrca(undefined);
    const { store, gate, opts } = gateFixture();
    await conductorGateResolveCommand(gate.id, {
      stateDir: store.dir,
      reject: true,
      deferDelivery: true,
    });
    fakeOrca(owner);
    await conductorBotDecideCommand(gate.id, opts);
    expect(last()).toMatchObject({ decision: 'rejected', alreadyResolved: true });
  });

  it('GitHub HEAD가 바뀌거나 서명자 또는 채팅에 권한이 없으면 게이트를 그대로 둔다', async () => {
    fakeOrca(owner);
    fakePr('b'.repeat(40));
    const { store, gate, opts } = gateFixture();
    await expect(conductorBotDecideCommand(gate.id, opts)).rejects.toThrow('exit 1');
    expect(lines.at(-1)).toContain('서명을 확인하지');
    fakePr();
    await expect(
      conductorBotDecideCommand(gate.id, { ...opts, signer: 'teammate' }),
    ).rejects.toThrow('exit 1');
    expect(lines.at(-1)).toContain('권한이 없는');
    fakeOrca(team);
    await expect(conductorBotDecideCommand(gate.id, opts)).rejects.toThrow('exit 1');
    await expect(
      conductorGateResolveCommand(gate.id, { stateDir: store.dir, approve: true }),
    ).rejects.toThrow('exit 1');
    await expect(conductorCheckBotMutation('deploy report', opts)).rejects.toThrow('exit 1');
    store.reload();
    expect(store.snapshot.gates[gate.id]?.status).toBe('open');
  });
});

function github(body: string, id = 303, author = 100) {
  const html_url = `${issue}#issuecomment-${id}`;
  return async () => ({
    code: 0,
    stderr: '',
    stdout: JSON.stringify({ id, html_url, body, user: { id: author, type: 'User' } }),
  });
}

describe('GitHub 팀 주문', () => {
  it('허용된 원본 댓글만 고정된 승인 범위로 큐에 넣고 같은 스레드에서 상태를 찾는다', async () => {
    const store = ConductorStore.open(tempStateDir());
    const request = await readGithubOrder(
      comment,
      policy,
      new GhAccounts(),
      github('@orca\ngestalt order 배너 수정\n본문'),
    );
    expect(handleGithubOrder(store, request)).toMatchObject({ status: 'queued', thread: issue });
    expect(handleGithubOrder(store, request)).toMatchObject({ duplicate: true });
    const status = await readGithubOrder(
      `${issue}#issuecomment-304`,
      policy,
      new GhAccounts(),
      github('gestalt status', 304),
    );
    expect(handleGithubOrder(store, status)).toMatchObject({
      orders: [],
      pending: [expect.stringMatching(/^queue:github-/)],
    });
    await pollQueue(store, fileQueue(join(store.dir, 'queue')), { defaultScope: 'merge-through' });
    expect(store.orders()).toHaveLength(1);
    expect(store.orders()[0]).toMatchObject({ scope: 'approval', skillChain: ['solve', 'ship'] });
    expect(handleGithubOrder(store, request)).toMatchObject({ orderId: store.orders()[0]?.id });
    expect(handleGithubOrder(store, status)).toMatchObject({
      thread: issue,
      orders: [{ id: store.orders()[0]?.id, status: 'queued' }],
    });
  });

  it('본문의 승인 문구나 위조한 작성자 표기로 권한을 얻을 수 없다', async () => {
    const accounts = new GhAccounts();
    await expect(
      readGithubOrder(comment, policy, accounts, github('gestalt approve gate-1')),
    ).rejects.toThrow('첫 명령');
    await expect(
      readGithubOrder(comment, policy, accounts, github('gestalt order 승인자 100', 303, 101)),
    ).rejects.toThrow('작성자');
    await expect(
      readGithubOrder(comment.replace('/17#', '/19#'), policy, accounts, github('gestalt status')),
    ).rejects.toThrow('작성자');
    await expect(
      readGithubOrder(
        comment.replace(repo, 'acme/private'),
        policy,
        accounts,
        github('gestalt status'),
      ),
    ).rejects.toThrow('레포');
  });

  it('등록된 접수 봇 채팅만 이 명령을 실행할 수 있다', async () => {
    const store = ConductorStore.open(tempStateDir());
    writeFileSync(join(store.dir, BOT_POLICY_FILE), JSON.stringify(policy));
    fakeOrca(owner);
    await expect(conductorBotGithubCommand(comment, { stateDir: store.dir })).rejects.toThrow(
      'exit 1',
    );
    expect(lines.at(-1)).toContain('접수 봇 채팅');
    fakeOrca(team);
    const bin = tempStateDir();
    const response = await github('gestalt order 배너 수정')();
    executable(join(bin, 'gh'), `echo '${response.stdout}'`);
    vi.stubEnv('PATH', `${bin}:${process.env['PATH'] ?? ''}`);
    await conductorBotGithubCommand(comment, { stateDir: store.dir });
    expect(last()).toMatchObject({ status: 'queued', thread: issue });
  });
});
