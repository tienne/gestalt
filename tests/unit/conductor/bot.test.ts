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
import { pollQueue } from '../../../src/conductor/intake.js';
import { loadConfig } from '../../../src/core/config.js';
import { ConductorStore } from '../../../src/conductor/store.js';
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

function fakePr(head = sha) {
  const bin = tempStateDir();
  const evidence = {
    headRefOid: head,
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

function gateFixture() {
  const store = ConductorStore.open(tempStateDir());
  const issueOrder = order({ repo, prRef: pr, status: 'running' });
  const w = worker(issueOrder.id, { kind: 'git-worktree' });
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
  return { store, gate, opts };
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
    await pollQueue(store, fileQueue(join(store.dir, 'queue')), { defaultScope: 'merge-through' });
    expect(store.orders()).toHaveLength(1);
    expect(store.orders()[0]).toMatchObject({ scope: 'approval', skillChain: ['solve', 'ship'] });
    expect(handleGithubOrder(store, request)).toMatchObject({ orderId: store.orders()[0]?.id });
    const status = await readGithubOrder(
      `${issue}#issuecomment-304`,
      policy,
      new GhAccounts(),
      github('gestalt status', 304),
    );
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
  });
});
