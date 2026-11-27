import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  conductorBotChatDecideCommand,
  conductorBotChatOfferCommand,
  conductorBotGateCommand,
  conductorBotMergePolicyCommand,
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
  mergeApprovalPolicy,
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
  await conductorBotMergePolicyCommand(repo, { ...opts, mode: 'trusted-chat' });
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

  it('기본은 서명 정책이고 잘못된 설정은 거절하며 다른 정책은 보존한다', async () => {
    const { store, gate, opts } = fixture();
    expect(mergeApprovalPolicy(undefined, repo)).toBe('signed');
    await expect(conductorBotChatOfferCommand(gate.id, opts)).rejects.toThrow('exit 1');
    const policy = {
      githubRepositories: { [repo]: [100] },
      gateApprovers: { [repo]: { old: 'keep' } },
    };
    writeFileSync(join(store.dir, BOT_POLICY_FILE), JSON.stringify(policy));
    await enable(opts);
    expect(last()).toMatchObject({
      previous: 'signed',
      mode: 'trusted-chat',
      changedBy: `${owner.botId}:${owner.chatId}`,
    });
    expect(JSON.parse(readFileSync(join(store.dir, BOT_POLICY_FILE), 'utf8'))).toEqual({
      ...policy,
      mergeApprovalPolicy: { [repo]: 'trusted-chat' },
    });
    expect(() =>
      mergeApprovalPolicy({ mergeApprovalPolicy: { [repo]: 'unknown' } }, repo),
    ).toThrow();
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
    expect(last()).toMatchObject({ approverReady: false, mergeApprovalPolicy: 'trusted-chat' });
    expect(last()).not.toHaveProperty('terminal');
    expect(last()).not.toHaveProperty('messages');
    conductorStatusCommand({ ...opts, json: true });
    expect(last().approvers.repos).toContainEqual({
      repo,
      merge: 0,
      gate: 0,
      mergeApprovalPolicy: 'trusted-chat',
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
        await conductorBotMergePolicyCommand(repo, { ...opts, mode: 'signed' });
      if (change === 'owner') {
        const next = { ...owner, chatId: 'next-home' };
        changeBotOwner(store.dir, owner.chatId, next);
        fakeOrca(next);
      }
      await expect(
        conductorBotChatDecideCommand({ ...opts, message: `${gate.id} 승인해줘` }),
      ).rejects.toThrow('exit 1');
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
      const verify = trustedChat.verifyChatOffer;
      vi.spyOn(trustedChat, 'verifyChatOffer').mockImplementationOnce((offer, caller, target) => {
        const checked = verify(offer, caller, target);
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
        return checked;
      });
      await expect(
        conductorBotChatDecideCommand({ ...opts, message: `${gate.id} 승인해줘` }),
      ).rejects.toThrow('exit 1');
      store.reload();
      expect(store.snapshot.gates[gate.id]?.status).toBe('open');
    },
  );

  it('접두어와 머지 외 게이트 ID로는 승인하지 않는다', async () => {
    const { store, gate, opts } = fixture();
    await enable(opts);
    await conductorBotChatOfferCommand(gate.id, opts);
    const other = openOrReuse(store, {
      type: 'file-overlap',
      orderId: gate.orderId,
      reason: '파일 중첩',
    }).gate;
    for (const id of [gate.id.slice(0, -1), other.id]) {
      await conductorBotChatDecideCommand({ ...opts, message: `${id} 승인해줘` });
      expect(last().status).toBe('not-found');
    }
    await expect(conductorBotChatOfferCommand(other.id, opts)).rejects.toThrow('exit 1');
    store.reload();
    expect(store.openGates()).toHaveLength(2);
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
      mergeApprovalPolicy: 'trusted-chat',
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
});
