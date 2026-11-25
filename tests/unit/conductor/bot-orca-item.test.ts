import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  conductorBotDecideCommand,
  conductorBotGateCommand,
  conductorBotItemDecideCommand,
  conductorGateResolveCommand,
} from '../../../src/cli/commands/conductor.js';
import {
  approvalMessage,
  BOT_POLICY_FILE,
  gateApprovalMessage,
  matchBotGate,
} from '../../../src/conductor/bot-approval.js';
import { changeBotOwner } from '../../../src/conductor/bot-owner.js';
import { openOrReuse } from '../../../src/conductor/gates.js';
import {
  itemBinding,
  OrcaContractError,
  parseItemShow,
  readItemDecision,
} from '../../../src/conductor/orca-item-approval.js';
import { ConductorStore } from '../../../src/conductor/store.js';
import type { Gate } from '../../../src/conductor/types.js';
import { cleanupStateDirs, order, tempStateDir, worker } from './fixtures.js';

// 가상 레포, 봇, 승인자만 쓴다
const owner = { botId: 'ops-bot', name: 'Conductor', chatId: 'ops-home' };
const other = { botId: 'other-bot', name: 'Other', chatId: 'other-home' };
const repo = 'acme/app';
const pr = `${repo}#42`;
const sha = 'a'.repeat(40);

function executable(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
  chmodSync(path, 0o700);
}

/** 운영 봇 채팅에서 도는 Orca CLI. item show는 itemFile을 그대로 돌려준다 */
function fakeOrca(caller: typeof owner) {
  const dir = tempStateDir();
  const exe = join(dir, 'orca');
  const itemFile = join(dir, 'item.json');
  const chats = {
    ok: true,
    result: { bot: caller.name, chats: [{ id: caller.chatId, self: true, closed: false }] },
  };
  const roster = {
    ok: true,
    result: {
      bots: [owner, other].map((b) => ({ id: b.botId, name: b.name, paused: false })),
    },
  };
  executable(
    exe,
    `
case "$2" in
chats) echo '${JSON.stringify(chats)}' ;;
list) echo '${JSON.stringify(roster)}' ;;
item) cat '${itemFile}' ;;
*) exit 1 ;;
esac`,
  );
  vi.stubEnv('ORCA_CLI_COMMAND', exe);
  vi.stubEnv('ORCA_AGENT_SESSION_ID', 'mock-session-id');
  return (show: unknown) => writeFileSync(itemFile, JSON.stringify({ ok: true, result: show }));
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
  vi.stubEnv('ORCA_AGENT_SESSION_TOOL_TOKEN', undefined);
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

function fixture(type: 'merge' | 'file-overlap' | 'review-manual-switch' = 'merge') {
  const store = ConductorStore.open(tempStateDir());
  const o = order({ repo, prRef: pr, status: 'running' });
  const w = worker(o.id, { kind: 'git-worktree' });
  store.addOrder({ ...o, workerId: w.id });
  store.startWorker(w);
  const { gate } = openOrReuse(store, {
    type,
    orderId: o.id,
    reason: '사람 확인',
    refs: ['src/a.ts'],
  });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const approvers = { [repo]: { 'approver-1': pem } };
  writeFileSync(
    join(store.dir, BOT_POLICY_FILE),
    JSON.stringify({ mergeApprovers: approvers, gateApprovers: approvers }),
  );
  changeBotOwner(store.dir, undefined, owner);
  return { store, gate, privateKey };
}

function signFor(
  store: ConductorStore,
  gate: Gate,
  key: KeyObject,
  decision: 'approved' | 'rejected',
  head = sha,
) {
  const target = matchBotGate(store, gate.id);
  return sign(
    null,
    Buffer.from(
      gateApprovalMessage(
        target,
        gate.type === 'file-overlap' ? undefined : head,
        decision,
        'main',
      ),
    ),
    key,
  ).toString('base64');
}

function show(
  store: ConductorStore,
  gate: Gate,
  answerText: string,
  over: { head?: string; chat?: string; answerActor?: object; extra?: object[] } = {},
): { item: unknown; events: { id: string; kind: string; actor: object; data: object }[] } {
  const binding = itemBinding(matchBotGate(store, gate.id), over.head ?? sha, 'main');
  const bot = { kind: 'bot', botId: owner.botId, chatId: owner.chatId };
  return {
    item: {
      uid: 'uid-7',
      number: 7,
      owner: { botId: owner.botId, name: owner.name },
      chat: { id: over.chat ?? owner.chatId, kind: 'home', title: null },
    },
    events: [
      { id: 'e10', kind: 'made', actor: bot, data: {} },
      {
        id: 'e11',
        kind: 'commented',
        actor: bot,
        data: { text: `${gate.reason}\n${binding}`, questions: [{ prompt: '진행할까요?' }] },
      },
      ...(over.extra ?? []),
      {
        id: 'e12',
        kind: 'commented',
        actor: over.answerActor ?? { kind: 'owner' },
        data: { text: answerText },
      },
    ],
  };
}

const itemOpts = (store: ConductorStore) => ({
  stateDir: store.dir,
  item: '7',
  question: 'e11',
  answer: 'e12',
});

describe('Orca 항목 답으로 게이트 종료', () => {
  it('서명이 붙은 사람 답을 Orca에서 읽어 한 번만 결정하고 결정과 전달을 나눠 보인다', async () => {
    const item = fakeOrca(owner);
    fakePr();
    const { store, gate, privateKey } = fixture('merge');
    await conductorBotGateCommand(gate.id, { stateDir: store.dir });
    const listed = last();
    expect(listed.orcaItem.binding).toBe(itemBinding(matchBotGate(store, gate.id), sha));
    expect(listed.type).toBe('merge');

    const sig = signFor(store, gate, privateKey, 'approved');
    item(show(store, gate, `승인\n서명 approver-1 ${sig}`));
    await conductorBotItemDecideCommand(gate.id, itemOpts(store));
    expect(last()).toMatchObject({
      decision: 'approved',
      signer: 'approver-1',
      delivery: 'pending',
      source: { kind: 'orca-item', item: 7, question: 'e11', answer: 'e12', botId: owner.botId },
    });
    expect(last().itemReport).toContain('판단: 승인 (서명 approver-1), Orca 항목 7의 답 e12');
    expect(last().itemReport).toContain('결정 접수 및 게이트 반영:');
    expect(last().itemReport).toContain('워커 전달: 대기 중(다음 tick이 전해요)');
    store.reload();
    expect(store.snapshot.gates[gate.id]?.answer).toContain(`--match-head-commit ${sha}`);

    // 같은 이벤트가 다시 와도 결정을 새로 쓰지 않는다
    const events = store.snapshot.eventCount;
    await conductorBotItemDecideCommand(gate.id, itemOpts(store));
    expect(last()).toMatchObject({ alreadyResolved: true, sameAnswer: true });
    store.reload();
    expect(store.snapshot.eventCount).toBe(events);

    // 워커 전달이 실패해 다시 시도하는 중이면 그 상태를 따로 보인다
    store.append({
      type: 'gate-delivery',
      at: store.timestamp(),
      gateId: gate.id,
      pending: true,
      attempts: 2,
    });
    await conductorBotItemDecideCommand(gate.id, { ...itemOpts(store), answer: 'e99' });
    expect(last()).toMatchObject({ alreadyResolved: true, sameAnswer: false, failedAttempts: 2 });
    expect(last().itemReport).toContain('시도 2번');
  });

  it('파일 중첩과 리뷰 수동 전환 게이트도 gateApprovers 서명으로 닫는다', async () => {
    for (const type of ['file-overlap', 'review-manual-switch'] as const) {
      const item = fakeOrca(owner);
      if (type === 'review-manual-switch') fakePr();
      const { store, gate, privateKey } = fixture(type);
      const sig = signFor(store, gate, privateKey, 'rejected');
      item(show(store, gate, `거절\napprover-1 ${sig}`));
      await conductorBotItemDecideCommand(gate.id, itemOpts(store));
      expect(last()).toMatchObject({ decision: 'rejected', delivery: 'pending' });
    }
  });

  it('재리뷰 Orca 질문의 base가 바뀌면 이전 질문의 답을 접수하지 않는다', async () => {
    const item = fakeOrca(owner);
    fakePr();
    const { store, gate, privateKey } = fixture('review-manual-switch');
    await conductorBotGateCommand(gate.id, { stateDir: store.dir });
    const before = last();
    expect(JSON.parse(before.orcaItem.binding)).toEqual(expect.arrayContaining([pr, sha, 'main']));
    const sig = signFor(store, gate, privateKey, 'approved');
    item(show(store, gate, `승인\n서명 approver-1 ${sig}`));
    fakePr(sha, 'release');
    await conductorBotGateCommand(gate.id, { stateDir: store.dir });
    expect(last().orcaItem.binding).not.toBe(before.orcaItem.binding);
    await expect(conductorBotItemDecideCommand(gate.id, itemOpts(store))).rejects.toThrow('exit 1');
    store.reload();
    expect(store.snapshot.gates[gate.id]?.status).toBe('open');
  });

  it('머지 서명 문자열에 한 서명을 파일 중첩 게이트에 옮겨 쓸 수 없다', async () => {
    fakeOrca(owner);
    const { store, gate, privateKey } = fixture('file-overlap');
    const sig = sign(
      null,
      Buffer.from(approvalMessage(gate, pr, sha, 'approved')),
      privateKey,
    ).toString('base64');
    await expect(
      conductorBotDecideCommand(gate.id, {
        stateDir: store.dir,
        decision: 'approved',
        signer: 'approver-1',
        signature: sig,
      }),
    ).rejects.toThrow('exit 1');
    expect(lines.at(-1)).toContain('서명을 확인하지');
    store.reload();
    expect(store.snapshot.gates[gate.id]?.status).toBe('open');
  });

  it('서명 없는 클릭 답은 실패를 표시하고 필요한 Orca 계약을 알린다', async () => {
    const item = fakeOrca(owner);
    fakePr();
    const { store, gate } = fixture('merge');
    item(show(store, gate, '승인'));
    await expect(conductorBotItemDecideCommand(gate.id, itemOpts(store))).rejects.toThrow('exit 1');
    expect(lines.at(-1)).toContain('승인자 서명이 없어');
    expect(lines.at(-1)).toContain('레포별 승인 권한');
    store.reload();
    expect(store.snapshot.gates[gate.id]?.status).toBe('open');
  });

  it('PR HEAD가 바뀌었으면 서명된 답이어도 게이트를 그대로 둔다', async () => {
    const item = fakeOrca(owner);
    fakePr('b'.repeat(40));
    const { store, gate, privateKey } = fixture('merge');
    const sig = signFor(store, gate, privateKey, 'approved');
    item(show(store, gate, `승인\n서명 approver-1 ${sig}`, { head: sha }));
    await expect(conductorBotItemDecideCommand(gate.id, itemOpts(store))).rejects.toThrow('exit 1');
    expect(lines.at(-1)).toContain('질문이 아니에요');
    store.reload();
    expect(store.snapshot.gates[gate.id]?.status).toBe('open');
  });

  it('패널이 먼저 닫은 게이트는 늦게 온 Orca 답이 바꾸지 않는다', async () => {
    const item = fakeOrca(owner);
    fakePr();
    const { store, gate, privateKey } = fixture('merge');
    vi.stubEnv('ORCA_AGENT_SESSION_ID', undefined);
    await conductorGateResolveCommand(gate.id, {
      stateDir: store.dir,
      reject: true,
      deferDelivery: true,
    });
    vi.stubEnv('ORCA_AGENT_SESSION_ID', 'mock-session-id');
    item(
      show(store, gate, `승인\n서명 approver-1 ${signFor(store, gate, privateKey, 'approved')}`),
    );
    await conductorBotItemDecideCommand(gate.id, itemOpts(store));
    expect(last()).toMatchObject({
      decision: 'rejected',
      alreadyResolved: true,
      sameAnswer: false,
    });
  });

  it('동시에 같은 답을 두 번 처리해도 결정은 하나만 남는다', async () => {
    const item = fakeOrca(owner);
    fakePr();
    const { store, gate, privateKey } = fixture('merge');
    item(
      show(store, gate, `승인\n서명 approver-1 ${signFor(store, gate, privateKey, 'approved')}`),
    );
    const runs = await Promise.allSettled([
      conductorBotItemDecideCommand(gate.id, itemOpts(store)),
      conductorBotItemDecideCommand(gate.id, itemOpts(store)),
    ]);
    store.reload();
    const resolved = store.snapshot.gates[gate.id]!;
    expect(resolved.decision).toBe('approved');
    expect(resolved.decisionSource?.answer).toBe('e12');
    // 하나는 닫고 하나는 이미 닫힌 게이트를 보거나 잠금에 막힌다
    expect(runs.every((r) => r.status === 'fulfilled' || /exit 1/.test(String(r.reason)))).toBe(
      true,
    );
  });
});

describe('Orca 항목 답 판독', () => {
  const store = () => fixture('file-overlap');
  const read = (s: unknown, gate: Gate, st: ConductorStore, over = {}) =>
    readItemDecision({
      show: parseItemShow(s),
      owner,
      item: 7,
      question: 'e11',
      answer: 'e12',
      binding: itemBinding(matchBotGate(st, gate.id), undefined),
      ...over,
    });
  const sig = 'A'.repeat(86) + '==';

  it('다른 채팅, 다른 봇의 질문, 사람이 아닌 답, 임의 본문, 오래된 질문을 받지 않는다', () => {
    const { store: st, gate } = store();
    expect(() => read(show(st, gate, `승인\n서명 x ${sig}`, { chat: 'other' }), gate, st)).toThrow(
      '운영 봇 채팅이 만든',
    );
    expect(() =>
      read(
        show(st, gate, `승인\n서명 x ${sig}`, { answerActor: { kind: 'bot', botId: owner.botId } }),
        gate,
        st,
      ),
    ).toThrow('사람이 Orca 화면에서');
    expect(() => read(show(st, gate, '좋아요 진행해 주세요'), gate, st)).toThrow(
      '승인이나 거절로 읽을 수 없는',
    );
    expect(() => read(show(st, gate, `constructor\n서명 x ${sig}`), gate, st)).toThrow(
      '승인이나 거절로 읽을 수 없는',
    );
    expect(() => read(show(st, gate, '승인'), gate, st)).toThrow(OrcaContractError);
    const newer = {
      id: 'e115',
      kind: 'commented',
      actor: { kind: 'bot', botId: owner.botId, chatId: owner.chatId },
      data: { text: `다시 묻습니다\n${itemBinding(matchBotGate(st, gate.id), undefined)}` },
    };
    expect(() => read(show(st, gate, `승인\n서명 x ${sig}`, { extra: [newer] }), gate, st)).toThrow(
      '더 새 질문',
    );
    const forged = show(st, gate, `승인\n서명 x ${sig}`);
    forged.events[1]!.actor = { kind: 'bot', botId: other.botId, chatId: other.chatId };
    expect(() => read(forged, gate, st)).toThrow('운영 봇의 질문이 아니에요');
    expect(() => read(show(st, gate, `승인\n서명 x ${sig}`), gate, st, { answer: 'e10' })).toThrow(
      '먼저 남은 답',
    );
    expect(read(show(st, gate, `승인\n서명 approver-9 ${sig}`), gate, st)).toMatchObject({
      decision: 'approved',
      signer: 'approver-9',
    });
  });
});
