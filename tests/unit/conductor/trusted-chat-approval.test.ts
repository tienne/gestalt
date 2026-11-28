import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  conductorBotChatDecideCommand,
  conductorBotChatOfferCommand,
  conductorBotGateCommand,
  conductorBotApprovalPolicyCommand,
  conductorStatusCommand,
} from '../../../src/cli/commands/conductor.js';
import { BOT_POLICY_FILE } from '../../../src/conductor/bot-approval.js';
import { changeBotOwner } from '../../../src/conductor/bot-owner.js';
import { openOrReuse, resolveGate } from '../../../src/conductor/gates.js';
import { foldEvents } from '../../../src/conductor/fold.js';
import * as trustedChat from '../../../src/conductor/trusted-chat-approval.js';
import { ConductorStore } from '../../../src/conductor/store.js';
import {
  chatApprovalId,
  approvalPolicy,
  defaultApprovalPolicy,
} from '../../../src/conductor/trusted-chat-approval.js';
import { cleanupStateDirs, order, tempStateDir, worker } from './fixtures.js';

const owner = { botId: 'ops-bot', name: 'Conductor', chatId: 'ops-home' };
const repo = 'acme/app';
const head = 'a'.repeat(40);
let lines: string[];

function executable(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
  chmodSync(path, 0o700);
}

function fakeOrca(caller = owner, itemOwner = caller, itemUid = 'item-42', itemNumber = 42) {
  const exe = join(tempStateDir(), 'orca');
  const chats = {
    ok: true,
    result: { bot: caller.name, chats: [{ id: caller.chatId, self: true, closed: false }] },
  };
  const roster = {
    ok: true,
    result: { bots: [{ id: caller.botId, name: caller.name, paused: false }] },
  };
  const item = {
    ok: true,
    result: {
      item: {
        uid: itemUid,
        number: itemNumber,
        owner: { botId: itemOwner.botId },
        chat: { id: itemOwner.chatId },
      },
      events: [],
    },
  };
  executable(
    exe,
    `case "$2" in
chats) echo '${JSON.stringify(chats)}' ;;
list) echo '${JSON.stringify(roster)}' ;;
item) echo '${JSON.stringify(item)}' ;;
*) exit 1 ;;
esac`,
  );
  vi.stubEnv('ORCA_CLI_COMMAND', exe);
  vi.stubEnv('ORCA_AGENT_SESSION_ID', 'mock-session-id');
}

function fakePr(sha = head, base = 'main') {
  const bin = tempStateDir();
  executable(
    join(bin, 'gh'),
    `echo '${JSON.stringify({ headRefOid: sha, baseRefName: base, state: 'OPEN', isDraft: false, statusCheckRollup: [] })}'`,
  );
  vi.stubEnv('PATH', `${bin}:${process.env['PATH'] ?? ''}`);
}

function fixture() {
  const store = ConductorStore.open(tempStateDir());
  const o = order({ repo, prRef: `${repo}#42`, status: 'running' });
  const w = worker(o.id, { kind: 'git-worktree', handle: 'ctx_1' });
  store.addOrder({ ...o, workerId: w.id });
  store.startWorker(w);
  const { gate } = openOrReuse(store, { type: 'merge', orderId: o.id, reason: '머지 승인' });
  changeBotOwner(store.dir, undefined, owner);
  return { store, gate, opts: { stateDir: store.dir }, w };
}

const last = () => JSON.parse(lines.at(-1)!);
beforeEach(() => {
  lines = [];
  vi.stubEnv('GESTALT_CONDUCTOR_WORKER_ID', undefined);
  vi.spyOn(console, 'log').mockImplementation((v: unknown) => void lines.push(String(v)));
  vi.spyOn(console, 'error').mockImplementation((v: unknown) => void lines.push(String(v)));
  vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
  fakeOrca();
  fakePr();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  cleanupStateDirs();
});

async function enable(opts: { stateDir: string }) {
  await conductorBotApprovalPolicyCommand(repo, { ...opts, mode: 'trusted-chat' });
}

describe('운영 채팅 문구를 신뢰하는 승인', () => {
  it('정확한 한 줄만 받고 인용, 개행, 장문, 여러 명령을 거절한다', () => {
    expect(chatApprovalId('42 승인해줘')).toBe('42');
    for (const text of [
      '42 승인해줘\n',
      '> 42 승인해줘',
      '"42 승인해줘"',
      '앞말 42 승인해줘',
      '42 승인해줘 뒤말',
      '42 승인해줘\n43 승인해줘',
      ' 42 승인해줘',
    ])
      expect(() => chatApprovalId(text)).toThrow();
  });

  it('정책 파일이 기본값을 안 정하면 채팅 승인이다', () => {
    expect(approvalPolicy(undefined, repo)).toBe('trusted-chat');
    expect(approvalPolicy({ gateApprovers: {} }, repo)).toBe('trusted-chat');
    expect(defaultApprovalPolicy({ defaultApprovalPolicy: 'signed' })).toBe('signed');
    expect(approvalPolicy({ defaultApprovalPolicy: 'signed' }, repo)).toBe('signed');
    expect(() => defaultApprovalPolicy({ defaultApprovalPolicy: 'chat' })).toThrow();
  });

  it('레포 값이 기본값보다 앞서고 새 칸이 예전 mergeApprovalPolicy 칸보다 앞선다', () => {
    const upper = repo.toUpperCase();
    expect(
      approvalPolicy(
        { defaultApprovalPolicy: 'signed', mergeApprovalPolicy: { [repo]: 'trusted-chat' } },
        upper,
      ),
    ).toBe('trusted-chat');
    expect(
      approvalPolicy(
        {
          mergeApprovalPolicy: { [repo]: 'trusted-chat' },
          approvalPolicy: { [repo]: 'signed' },
        },
        repo,
      ),
    ).toBe('signed');
    expect(approvalPolicy({ approvalPolicy: { [repo]: 'signed' } }, 'other/repo')).toBe(
      'trusted-chat',
    );
    for (const field of ['approvalPolicy', 'mergeApprovalPolicy'])
      expect(() => approvalPolicy({ [field]: { [repo]: 'unknown' } }, repo)).toThrow();
  });

  it('서명 기본값에서 레포를 켜면 새 칸에 쓰고 다른 정책은 보존한다', async () => {
    const { store, gate, opts } = fixture();
    const policy = {
      defaultApprovalPolicy: 'signed',
      githubRepositories: { [repo]: [100] },
      gateApprovers: { [repo]: { old: 'keep' } },
      mergeApprovalPolicy: { [repo]: 'signed', 'acme/other': 'trusted-chat' },
    };
    writeFileSync(join(store.dir, BOT_POLICY_FILE), JSON.stringify(policy));
    await expect(conductorBotChatOfferCommand(gate.id, opts)).rejects.toThrow('exit 1');
    await enable(opts);
    expect(last()).toMatchObject({
      repo,
      previous: 'signed',
      mode: 'trusted-chat',
      changedBy: `${owner.botId}:${owner.chatId}`,
    });
    expect(JSON.parse(readFileSync(join(store.dir, BOT_POLICY_FILE), 'utf8'))).toEqual({
      ...policy,
      mergeApprovalPolicy: { 'acme/other': 'trusted-chat' },
      approvalPolicy: { [repo]: 'trusted-chat' },
    });
  });

  it('--default로 기본값을 바꾸고 레포와 함께 주면 거절한다', async () => {
    const { store, opts } = fixture();
    await conductorBotApprovalPolicyCommand(undefined, { ...opts, mode: 'signed', default: true });
    expect(last()).toMatchObject({ default: true, previous: 'trusted-chat', mode: 'signed' });
    expect(JSON.parse(readFileSync(join(store.dir, BOT_POLICY_FILE), 'utf8'))).toEqual({
      defaultApprovalPolicy: 'signed',
    });
    await expect(
      conductorBotApprovalPolicyCommand(repo, { ...opts, mode: 'signed', default: true }),
    ).rejects.toThrow('exit 1');
    await expect(
      conductorBotApprovalPolicyCommand(undefined, { ...opts, mode: 'signed' }),
    ).rejects.toThrow('exit 1');
  });

  for (const kind of ['gate', 'order', 'item'] as const) {
    it(`${kind} ID로 승인하고 재시작과 중복 요청에도 결정은 한 번만 기록한다`, async () => {
      const { store, gate, opts } = fixture();
      await enable(opts);
      await conductorBotChatOfferCommand(gate.id, { ...opts, item: '42' });
      const offered = last();
      store.reload();
      expect(store.snapshot.gates[gate.id]?.chatApprovalOffer?.head).toBe(head);
      const id = kind === 'gate' ? gate.id : kind === 'order' ? gate.orderId! : '42';
      await conductorBotChatDecideCommand({ ...opts, message: `${id} 승인해줘` });
      const receipt = last();
      expect(receipt).toMatchObject({
        decision: 'approved',
        deliveryPending: true,
        target: { head },
        signer: `trusted-chat:${owner.botId}:${owner.chatId}`,
      });
      store.reload();
      expect(store.snapshot.gates[gate.id]?.decisionVia).toMatchObject({
        kind: 'trusted-chat',
        offerId: offered.offerId,
      });
      await conductorBotChatDecideCommand({ ...opts, message: `${id} 승인해줘` });
      expect(last()).toMatchObject({
        alreadyResolved: true,
        decisionId: receipt.decisionId,
        deliveryId: receipt.deliveryId,
      });
    });
  }

  it('서명 승인자가 없어도 gate와 status는 운영 채팅 경로를 안내하고 조회는 offer를 바꾸지 않는다', async () => {
    const { store, gate, opts } = fixture();
    await enable(opts);
    await conductorBotChatOfferCommand(gate.id, opts);
    const offered = last();
    await conductorBotGateCommand(gate.id, opts);
    expect(last()).toMatchObject({ approverReady: false, approvalPolicy: 'trusted-chat' });
    expect(last()).not.toHaveProperty('terminal');
    expect(last()).not.toHaveProperty('messages');
    conductorStatusCommand({ ...opts, json: true });
    expect(last().approvers.repos).toContainEqual({
      repo,
      merge: 0,
      gate: 0,
      approvalPolicy: 'trusted-chat',
    });
    fakePr('b'.repeat(40));
    await conductorBotChatOfferCommand(gate.id, opts);
    expect(last()).toMatchObject({ reused: true, offerId: offered.offerId, head });
    store.reload();
    expect(store.snapshot.gates[gate.id]?.chatApprovalOffer?.head).toBe(head);
  });

  for (const change of ['head', 'base', 'pr', 'worker', 'policy', 'owner'] as const) {
    it(`${change} 변경 뒤에는 기존 안내로 승인하지 않는다`, async () => {
      const { store, gate, opts, w } = fixture();
      await enable(opts);
      await conductorBotChatOfferCommand(gate.id, opts);
      if (change === 'head') fakePr('b'.repeat(40));
      if (change === 'base') fakePr(head, 'release');
      if (change === 'pr') store.updateOrder(gate.orderId!, { prRef: `${repo}#43` });
      if (change === 'worker') store.updateWorker(w.id, { handle: 'ctx_changed' });
      if (change === 'policy')
        await conductorBotApprovalPolicyCommand(repo, { ...opts, mode: 'signed' });
      if (change === 'owner') {
        const next = { ...owner, chatId: 'next-home' };
        changeBotOwner(store.dir, owner.chatId, next);
        fakeOrca(next);
      }
      await expect(
        conductorBotChatDecideCommand({ ...opts, message: `${gate.id} 승인해줘` }),
      ).rejects.toThrow('exit 1');
      if (change === 'pr' || change === 'worker' || change === 'owner')
        expect(lines.at(-1)).toContain('chat-offer --refresh');
      store.reload();
      expect(store.snapshot.gates[gate.id]?.status).toBe('open');
    });
  }

  it('HEAD가 바뀌면 명시적으로 재안내한 뒤 새 승인으로만 처리한다', async () => {
    const { gate, opts } = fixture();
    await enable(opts);
    await conductorBotChatOfferCommand(gate.id, opts);
    const first = last();
    fakePr('b'.repeat(40));
    await conductorBotChatOfferCommand(gate.id, { ...opts, refresh: true });
    expect(last().offerId).not.toBe(first.offerId);
    await conductorBotChatDecideCommand({ ...opts, message: `${gate.id} 승인해줘` });
    expect(last().target.head).toBe('b'.repeat(40));
  });

  it('재안내에서 항목 번호를 생략해도 연결을 유지하고 항목 변경은 거절한다', async () => {
    const { gate, opts } = fixture();
    await enable(opts);
    await conductorBotChatOfferCommand(gate.id, { ...opts, item: '42' });
    fakePr('b'.repeat(40));
    await conductorBotChatOfferCommand(gate.id, { ...opts, refresh: true });
    expect(last().commands).toContain('42 승인해줘');
    fakeOrca(owner, owner, 'item-42', 43);
    await expect(
      conductorBotChatDecideCommand({ ...opts, message: '42 승인해줘' }),
    ).rejects.toThrow('exit 1');
    fakeOrca(owner, owner, 'replaced-item');
    await expect(conductorBotChatOfferCommand(gate.id, { ...opts, refresh: true })).rejects.toThrow(
      'exit 1',
    );
    await expect(
      conductorBotChatDecideCommand({ ...opts, message: '42 승인해줘' }),
    ).rejects.toThrow('exit 1');
  });

  it('운영 채팅을 넘긴 뒤 재안내는 옛 채팅의 항목 연결을 이어받지 않는다', async () => {
    const { store, gate, opts } = fixture();
    await enable(opts);
    await conductorBotChatOfferCommand(gate.id, { ...opts, item: '42' });
    const next = { ...owner, chatId: 'next-home' };
    changeBotOwner(store.dir, owner.chatId, next);
    fakeOrca(next, owner);
    await conductorBotChatOfferCommand(gate.id, { ...opts, refresh: true });
    expect(last().commands).not.toContain('42 승인해줘');
    store.reload();
    expect(store.snapshot.gates[gate.id]?.chatApprovalOffer?.item).toBeUndefined();
    await conductorBotChatDecideCommand({ ...opts, message: `${gate.id} 승인해줘` });
    expect(last()).toMatchObject({ decision: 'approved' });
  });

  it('로그를 접은 뒤에도 안내가 복원되고 동시 요청은 결정 한 건으로 남는다', async () => {
    const { store, gate, opts } = fixture();
    await enable(opts);
    await conductorBotChatOfferCommand(gate.id, opts);
    const offered = last();
    await foldEvents(store.dir, { settleMs: 0 });
    const before = ConductorStore.open(store.dir);
    expect(before.snapshot.gates[gate.id]?.chatApprovalOffer?.id).toBe(offered.offerId);
    await Promise.all([
      conductorBotChatDecideCommand({ ...opts, message: `${gate.id} 승인해줘` }),
      conductorBotChatDecideCommand({ ...opts, message: `${gate.id} 승인해줘` }),
    ]);
    const after = ConductorStore.open(store.dir);
    expect(after.snapshot.eventCount).toBe(before.snapshot.eventCount + 1);
    expect(after.snapshot.gates[gate.id]).toMatchObject({
      status: 'resolved',
      deliveryPending: true,
    });
  });

  it.each(['offer', 'policy', 'owner'] as const)(
    '잠금을 기다리는 동안 %s가 바뀌면 이전 요청을 거절한다',
    async (change) => {
      const { store, gate, opts } = fixture();
      await enable(opts);
      await conductorBotChatOfferCommand(gate.id, opts);
      const check = trustedChat.chatOfferProblem;
      vi.spyOn(trustedChat, 'chatOfferProblem').mockImplementationOnce((offer, caller, target) => {
        const problem = check(offer, caller, target);
        const checked = offer!;
        store.reload();
        if (change === 'offer')
          store.append({
            type: 'gate-chat-offered',
            gateId: gate.id,
            at: store.timestamp(),
            offer: { ...checked, id: 'replacement-offer' },
          });
        if (change === 'policy')
          writeFileSync(
            join(store.dir, BOT_POLICY_FILE),
            JSON.stringify({ mergeApprovalPolicy: { [repo]: 'signed' } }),
          );
        if (change === 'owner')
          changeBotOwner(store.dir, owner.chatId, { ...owner, chatId: 'new-owner' });
        return problem;
      });
      await expect(
        conductorBotChatDecideCommand({ ...opts, message: `${gate.id} 승인해줘` }),
      ).rejects.toThrow('exit 1');
      store.reload();
      expect(store.snapshot.gates[gate.id]?.status).toBe('open');
    },
  );

  it('접두어와 봇이 닫지 않는 게이트 ID로는 승인하지 않는다', async () => {
    const { store, gate, opts } = fixture();
    await conductorBotChatOfferCommand(gate.id, opts);
    const other = openOrReuse(store, {
      type: 'interview',
      orderId: gate.orderId,
      reason: '질문',
    }).gate;
    for (const id of [gate.id.slice(0, -1), other.id]) {
      await conductorBotChatDecideCommand({ ...opts, message: `${id} 승인해줘` });
      expect(last().status).toBe('not-found');
    }
    await expect(conductorBotChatOfferCommand(other.id, opts)).rejects.toThrow('exit 1');
    store.reload();
    expect(store.openGates()).toHaveLength(2);
  });

  it('정책 파일 없이도 파일 중첩 게이트를 PR 없이 안내하고 채팅 문구로 승인한다', async () => {
    const { store, gate, opts } = fixture();
    const overlap = openOrReuse(store, {
      type: 'file-overlap',
      orderId: gate.orderId,
      reason: '파일 중첩',
    }).gate;
    await conductorBotChatOfferCommand(overlap.id, opts);
    const offered = last();
    expect(offered).toMatchObject({ gateId: overlap.id, type: 'file-overlap' });
    expect(offered).not.toHaveProperty('pr');
    expect(offered).not.toHaveProperty('head');
    await conductorBotChatDecideCommand({ ...opts, message: `${overlap.id} 승인해줘` });
    expect(last()).toMatchObject({
      decision: 'approved',
      signer: `trusted-chat:${owner.botId}:${owner.chatId}`,
    });
    store.reload();
    expect(store.snapshot.gates[overlap.id]?.decisionVia).toMatchObject({
      kind: 'trusted-chat',
      offerId: offered.offerId,
    });
    expect(store.snapshot.gates[gate.id]?.status).toBe('open');
  });

  it('재리뷰 전환 게이트는 PR HEAD를 고정해 안내하고 HEAD가 바뀌면 승인하지 않는다', async () => {
    const { store, gate, opts } = fixture();
    const review = openOrReuse(store, {
      type: 'review-manual-switch',
      orderId: gate.orderId,
      reason: '재리뷰 전환',
    }).gate;
    await conductorBotChatOfferCommand(review.id, opts);
    expect(last()).toMatchObject({ type: 'review-manual-switch', head });
    fakePr('b'.repeat(40));
    await expect(
      conductorBotChatDecideCommand({ ...opts, message: `${review.id} 승인해줘` }),
    ).rejects.toThrow('exit 1');
    fakePr();
    await conductorBotChatDecideCommand({ ...opts, message: `${review.id} 승인해줘` });
    expect(last()).toMatchObject({ decision: 'approved', target: { head } });
  });

  it('서명 정책 레포는 머지 외 게이트도 채팅으로 안내하지 않는다', async () => {
    const { store, gate, opts } = fixture();
    await conductorBotApprovalPolicyCommand(repo, { ...opts, mode: 'signed' });
    const overlap = openOrReuse(store, {
      type: 'file-overlap',
      orderId: gate.orderId,
      reason: '파일 중첩',
    }).gate;
    await expect(conductorBotChatOfferCommand(overlap.id, opts)).rejects.toThrow('exit 1');
    expect(lines.join('\n')).toContain('서명 승인을 쓰도록 설정돼 있어요');
  });

  it('offer 없는 승인과 다른 채팅 소유의 항목 연결을 거절한다', async () => {
    const { gate, opts } = fixture();
    await enable(opts);
    await expect(
      conductorBotChatDecideCommand({ ...opts, message: `${gate.id} 승인해줘` }),
    ).rejects.toThrow('exit 1');
    fakeOrca(owner, { ...owner, chatId: 'other' });
    await expect(conductorBotChatOfferCommand(gate.id, { ...opts, item: '42' })).rejects.toThrow(
      'exit 1',
    );
  });

  it('없는 ID와 여러 게이트에 연결한 항목은 상태를 안내하고 승인하지 않는다', async () => {
    const { store, gate, opts } = fixture();
    await enable(opts);
    await conductorBotChatOfferCommand(gate.id, { ...opts, item: '42' });
    const other = order({ repo, prRef: `${repo}#43`, status: 'running' });
    store.addOrder(other);
    const second = openOrReuse(store, {
      type: 'merge',
      orderId: other.id,
      reason: '다른 머지',
    }).gate;
    await conductorBotChatOfferCommand(second.id, { ...opts, item: '42' });
    expect(last().commands).toEqual([`${second.id} 승인해줘`, `${other.id} 승인해줘`]);
    await conductorBotChatDecideCommand({ ...opts, message: '42 승인해줘' });
    expect(last()).toMatchObject({ status: 'ambiguous', candidates: expect.any(Array) });
    expect(last().candidates).toHaveLength(2);
    expect(last().candidates).toContainEqual(
      expect.objectContaining({ gateId: second.id, command: `${second.id} 승인해줘` }),
    );
    await conductorBotChatDecideCommand({ ...opts, message: 'missing 승인해줘' });
    expect(last().status).toBe('not-found');
    store.reload();
    expect(store.openGates()).toHaveLength(2);
    await conductorBotChatDecideCommand({ ...opts, message: `${gate.id} 승인해줘` });
    await conductorBotChatDecideCommand({ ...opts, message: '42 승인해줘' });
    expect(last()).toMatchObject({ status: 'ambiguous' });
    expect(
      last()
        .candidates.map((candidate: { status: string }) => candidate.status)
        .sort(),
    ).toEqual(['open', 'resolved']);
  });

  it('서명 승인자가 있는 trusted-chat 레포는 gate가 서명 재료도 함께 준다', async () => {
    const { store, gate, opts } = fixture();
    const pem = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
    writeFileSync(
      join(store.dir, BOT_POLICY_FILE),
      JSON.stringify({ mergeApprovers: { [repo]: { 'approver-1': pem } } }),
    );
    await enable(opts);
    await conductorBotGateCommand(gate.id, opts);
    expect(last()).toMatchObject({
      approverReady: true,
      approvalPolicy: 'trusted-chat',
      messages: { approved: expect.any(String), rejected: expect.any(String) },
      orcaItem: expect.any(Object),
    });
  });

  it('거절로 닫힌 머지 게이트 뒤 새 게이트는 주문 ID를 빼고 게이트 ID로 승인한다', async () => {
    const { store, gate, opts } = fixture();
    await enable(opts);
    resolveGate(store, gate.id, 'rejected');
    const next = openOrReuse(store, {
      type: 'merge',
      orderId: gate.orderId!,
      reason: '다시 머지',
    }).gate;
    expect(next.id).not.toBe(gate.id);
    await conductorBotChatOfferCommand(next.id, opts);
    expect(last().commands).toEqual([`${next.id} 승인해줘`]);
    await conductorBotChatDecideCommand({ ...opts, message: `${gate.orderId} 승인해줘` });
    expect(last()).toMatchObject({ status: 'ambiguous' });
    expect(last().candidates).toContainEqual(
      expect.objectContaining({ gateId: next.id, command: `${next.id} 승인해줘` }),
    );
    await conductorBotChatDecideCommand({ ...opts, message: `${next.id} 승인해줘` });
    expect(last()).toMatchObject({ decision: 'approved' });
  });

  it('닫힌 후보만 남으면 command 없이 닫혔다고 안내한다', async () => {
    const { store, gate, opts } = fixture();
    await enable(opts);
    resolveGate(store, gate.id, 'rejected');
    const next = openOrReuse(store, {
      type: 'merge',
      orderId: gate.orderId!,
      reason: '다시 머지',
    }).gate;
    resolveGate(store, next.id, 'rejected');
    await conductorBotChatDecideCommand({ ...opts, message: `${gate.orderId} 승인해줘` });
    expect(last()).toMatchObject({ status: 'ambiguous' });
    expect(last().guidance).toContain('닫힌 게이트만');
    expect(last().candidates.some((c: { command?: string }) => c.command)).toBe(false);
  });

  it('열린 후보를 이 채팅에서 안내하지 않았으면 먼저 안내하라고 한다', async () => {
    const { store, gate, opts } = fixture();
    await enable(opts);
    resolveGate(store, gate.id, 'rejected');
    openOrReuse(store, { type: 'merge', orderId: gate.orderId!, reason: '다시 머지' });
    await conductorBotChatDecideCommand({ ...opts, message: `${gate.orderId} 승인해줘` });
    expect(last()).toMatchObject({ status: 'ambiguous' });
    expect(last().guidance).toContain('chat-offer');
    expect(last().guidance).not.toContain('--refresh');
    expect(last().candidates.some((c: { command?: string }) => c.command)).toBe(false);
    expect(last().candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ gateId: gate.id, reason: 'closed' }),
        expect.objectContaining({
          status: 'open',
          reason: 'no-offer',
          pr: `https://github.com/${repo}/pull/42`,
        }),
      ]),
    );
  });

  it('열린 후보가 모두 낡은 안내만 가졌으면 --refresh로 다시 안내하라고 한다', async () => {
    const { store, gate, opts } = fixture();
    await enable(opts);
    await conductorBotChatOfferCommand(gate.id, { ...opts, item: '42' });
    const other = order({ repo, prRef: `${repo}#43`, status: 'running' });
    store.addOrder(other);
    const second = openOrReuse(store, {
      type: 'merge',
      orderId: other.id,
      reason: '다른 머지',
    }).gate;
    await conductorBotChatOfferCommand(second.id, { ...opts, item: '42' });
    store.updateOrder(gate.orderId!, { prRef: `${repo}#45` });
    store.updateOrder(other.id, { prRef: `${repo}#44` });
    await conductorBotChatDecideCommand({ ...opts, message: '42 승인해줘' });
    expect(last()).toMatchObject({ status: 'ambiguous' });
    expect(last().guidance).toContain('chat-offer --refresh');
    expect(last().candidates.some((c: { command?: string }) => c.command)).toBe(false);
    expect(last().candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gateId: gate.id,
          reason: 'stale',
          pr: `https://github.com/${repo}/pull/45`,
          offeredPr: `https://github.com/${repo}/pull/42`,
        }),
        expect.objectContaining({
          gateId: second.id,
          reason: 'stale',
          pr: `https://github.com/${repo}/pull/44`,
          offeredPr: `https://github.com/${repo}/pull/43`,
        }),
      ]),
    );
  });

  it('채팅 문구 승인이 꺼진 뒤 후보는 서명 경로를 안내하고 정책을 켜라고 하지 않는다', async () => {
    const { store, gate, opts } = fixture();
    await enable(opts);
    await conductorBotChatOfferCommand(gate.id, { ...opts, item: '42' });
    const other = order({ repo, prRef: `${repo}#43`, status: 'running' });
    store.addOrder(other);
    const second = openOrReuse(store, {
      type: 'merge',
      orderId: other.id,
      reason: '다른 머지',
    }).gate;
    await conductorBotChatOfferCommand(second.id, { ...opts, item: '42' });
    await conductorBotApprovalPolicyCommand(repo, { ...opts, mode: 'signed' });
    await conductorBotChatDecideCommand({ ...opts, message: '42 승인해줘' });
    expect(last()).toMatchObject({ status: 'ambiguous' });
    expect(last().guidance).toContain('서명 승인');
    expect(last().guidance).not.toMatch(/merge-policy|trusted-chat|chat-offer/);
    expect(
      last().candidates.map((c: { reason?: string; command?: string }) => [c.reason, c.command]),
    ).toEqual([
      ['policy-off', undefined],
      ['policy-off', undefined],
    ]);
    store.reload();
    expect(store.openGates()).toHaveLength(2);
  });

  it('운영 채팅을 넘기기 전에 안내한 후보는 다른 채팅 이유로 다시 안내하라고 한다', async () => {
    const { store, gate, opts } = fixture();
    await enable(opts);
    resolveGate(store, gate.id, 'rejected');
    const next = openOrReuse(store, {
      type: 'merge',
      orderId: gate.orderId!,
      reason: '다시 머지',
    }).gate;
    await conductorBotChatOfferCommand(next.id, opts);
    const moved = { ...owner, chatId: 'next-home' };
    changeBotOwner(store.dir, owner.chatId, moved);
    fakeOrca(moved);
    await conductorBotChatDecideCommand({ ...opts, message: `${gate.orderId} 승인해줘` });
    expect(last()).toMatchObject({ status: 'ambiguous' });
    expect(last().guidance).toContain('chat-offer --refresh');
    expect(last().candidates).toContainEqual(
      expect.objectContaining({ gateId: next.id, reason: 'other-chat' }),
    );
    expect(last().candidates.some((c: { command?: string }) => c.command)).toBe(false);
    store.reload();
    expect(store.snapshot.gates[next.id]?.status).toBe('open');
  });

  it('다른 채팅에서 안내한 후보에는 그 안내의 PR을 싣지 않는다', async () => {
    const { store, gate, opts } = fixture();
    await enable(opts);
    resolveGate(store, gate.id, 'rejected');
    const next = openOrReuse(store, {
      type: 'merge',
      orderId: gate.orderId!,
      reason: '다시 머지',
    }).gate;
    await conductorBotChatOfferCommand(next.id, opts);
    store.updateOrder(gate.orderId!, { prRef: `${repo}#43` });
    const moved = { ...owner, chatId: 'next-home' };
    changeBotOwner(store.dir, owner.chatId, moved);
    fakeOrca(moved);
    await conductorBotChatDecideCommand({ ...opts, message: `${gate.orderId} 승인해줘` });
    const candidate = last().candidates.find((c: { gateId: string }) => c.gateId === next.id);
    expect(candidate).toMatchObject({ reason: 'other-chat' });
    expect(candidate.pr).toContain('/pull/43');
    expect(candidate).not.toHaveProperty('offeredPr');
  });

  it('PR이 주문 레포와 다른 후보는 unavailable로 돌리고 승인 문구를 붙이지 않는다', async () => {
    const { store, gate, opts } = fixture();
    await enable(opts);
    resolveGate(store, gate.id, 'rejected');
    const next = openOrReuse(store, {
      type: 'merge',
      orderId: gate.orderId!,
      reason: '다시 머지',
    }).gate;
    await conductorBotChatOfferCommand(next.id, opts);
    store.updateOrder(gate.orderId!, { prRef: 'acme/other#9' });
    await conductorBotChatDecideCommand({ ...opts, message: `${gate.orderId} 승인해줘` });
    expect(last()).toMatchObject({ status: 'ambiguous' });
    expect(last().guidance).toContain('주문의 레포와 PR 연결');
    const candidate = last().candidates.find((c: { gateId: string }) => c.gateId === next.id);
    expect(candidate).toMatchObject({ reason: 'unavailable' });
    expect(candidate).not.toHaveProperty('command');
    expect(candidate).not.toHaveProperty('pr');
    expect(candidate.offeredPr).toContain('/pull/42');
    store.reload();
    expect(store.snapshot.gates[next.id]?.status).toBe('open');
  });

  it('후보가 여럿이어도 정책 파일 오류는 이유로 바꾸지 않고 그대로 던진다', async () => {
    const { store, gate, opts } = fixture();
    await enable(opts);
    resolveGate(store, gate.id, 'rejected');
    const next = openOrReuse(store, {
      type: 'merge',
      orderId: gate.orderId!,
      reason: '다시 머지',
    }).gate;
    await conductorBotChatOfferCommand(next.id, opts);
    writeFileSync(join(store.dir, BOT_POLICY_FILE), '{');
    lines = [];
    await expect(
      conductorBotChatDecideCommand({ ...opts, message: `${gate.orderId} 승인해줘` }),
    ).rejects.toThrow('exit 1');
    expect(lines.join('\n')).toContain('봇 정책 파일');
    expect(lines.some((line) => line.includes('"ambiguous"'))).toBe(false);
    store.reload();
    expect(store.snapshot.gates[next.id]?.status).toBe('open');
  });

  it('후보마다 막힌 이유가 다르면 하나의 안내로 뭉치지 않고 reason을 보게 한다', async () => {
    const { store, gate, opts } = fixture();
    const web = 'acme/web';
    await enable(opts);
    await conductorBotApprovalPolicyCommand(web, { ...opts, mode: 'trusted-chat' });
    await conductorBotChatOfferCommand(gate.id, { ...opts, item: '42' });
    const other = order({ repo: web, prRef: `${web}#43`, status: 'running' });
    store.addOrder(other);
    const second = openOrReuse(store, {
      type: 'merge',
      orderId: other.id,
      reason: '다른 머지',
    }).gate;
    await conductorBotChatOfferCommand(second.id, { ...opts, item: '42' });
    store.updateOrder(gate.orderId!, { prRef: `${repo}#45` });
    await conductorBotApprovalPolicyCommand(web, { ...opts, mode: 'signed' });
    await conductorBotChatDecideCommand({ ...opts, message: '42 승인해줘' });
    expect(last()).toMatchObject({ status: 'ambiguous' });
    expect(last().guidance).toContain('reason');
    expect(last().guidance).not.toContain('--refresh');
    expect(last().candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ gateId: gate.id, reason: 'stale' }),
        expect.objectContaining({ gateId: second.id, reason: 'policy-off' }),
      ]),
    );
    store.reload();
    expect(store.openGates()).toHaveLength(2);
  });

  it('안내 뒤 대상이 바뀐 열린 후보에는 command를 싣지 않는다', async () => {
    const { store, gate, opts } = fixture();
    await enable(opts);
    await conductorBotChatOfferCommand(gate.id, { ...opts, item: '42' });
    const other = order({ repo, prRef: `${repo}#43`, status: 'running' });
    store.addOrder(other);
    const second = openOrReuse(store, {
      type: 'merge',
      orderId: other.id,
      reason: '다른 머지',
    }).gate;
    await conductorBotChatOfferCommand(second.id, { ...opts, item: '42' });
    store.updateOrder(other.id, { prRef: `${repo}#44` });
    await conductorBotChatDecideCommand({ ...opts, message: '42 승인해줘' });
    expect(last()).toMatchObject({ status: 'ambiguous' });
    expect(last().guidance).toContain('여러 게이트가 걸려요');
    const commands = last()
      .candidates.filter((c: { command?: string }) => c.command)
      .map((c: { gateId: string }) => c.gateId);
    expect(commands).toEqual([gate.id]);
  });
});
