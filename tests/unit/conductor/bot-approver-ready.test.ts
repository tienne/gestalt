import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  conductorBotDecideCommand,
  conductorBotGateCommand,
  conductorStatusCommand,
} from '../../../src/cli/commands/conductor.js';
import {
  approverStatus,
  BOT_POLICY_FILE,
  readBotPolicy,
} from '../../../src/conductor/bot-approval.js';
import { changeBotOwner } from '../../../src/conductor/bot-owner.js';
import { openOrReuse } from '../../../src/conductor/gates.js';
import { ConductorStore } from '../../../src/conductor/store.js';
import { cleanupStateDirs, order, tempStateDir, worker } from './fixtures.js';

const owner = { botId: 'ops-bot', name: 'Conductor', chatId: 'ops-home' };
const repo = 'acme/app';
const pr = `${repo}#42`;
const pem = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
const legacyApprover = {
  webauthn: {
    credentialId: 'legacy-key',
    publicKey: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({
      type: 'spki',
      format: 'pem',
    }),
    origin: 'http://localhost:47219',
  },
};

function executable(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
  chmodSync(path, 0o700);
}

function fakeOrca() {
  const exe = join(tempStateDir(), 'orca');
  const chats = {
    ok: true,
    result: { bot: owner.name, chats: [{ id: owner.chatId, self: true, closed: false }] },
  };
  const roster = {
    ok: true,
    result: { bots: [{ id: owner.botId, name: owner.name, paused: false }] },
  };
  executable(
    exe,
    `
case "$2" in
chats) echo '${JSON.stringify(chats)}' ;;
list) echo '${JSON.stringify(roster)}' ;;
*) exit 1 ;;
esac`,
  );
  vi.stubEnv('ORCA_CLI_COMMAND', exe);
  vi.stubEnv('ORCA_AGENT_SESSION_ID', 'mock-session-id');
}

/** gh가 불리면 테스트가 깨지게 해서 승인자 안내가 GitHub 조회보다 먼저 나오는지 본다 */
function ghMustNotRun() {
  const bin = tempStateDir();
  executable(join(bin, 'gh'), 'echo gh-called >&2; exit 9');
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

function fixture(type: 'merge' | 'file-overlap', policy: Record<string, unknown> | undefined) {
  const store = ConductorStore.open(tempStateDir());
  const o = order({ repo, prRef: pr, status: 'running' });
  const w = worker(o.id, { kind: 'git-worktree' });
  store.addOrder({ ...o, workerId: w.id });
  store.startWorker(w);
  const { gate } = openOrReuse(store, { type, orderId: o.id, reason: '사람 확인' });
  if (policy) writeFileSync(join(store.dir, BOT_POLICY_FILE), JSON.stringify(policy));
  changeBotOwner(store.dir, undefined, owner);
  return { store, gate };
}

const cases = [
  {
    name: '이전 WebAuthn 승인자만 있으면',
    type: 'merge' as const,
    policy: { mergeApprovers: { [repo]: { legacy: legacyApprover } } },
    gap: 'no-repo',
    says: 'acme/app 레포에는 게이트를 닫을 승인자가 등록되지 않았어요',
  },
  {
    name: '정책 파일이 없으면',
    type: 'file-overlap' as const,
    policy: undefined,
    gap: 'no-policy',
    says: '정책 파일(bot-policy.json)이 없어서',
  },
  {
    name: '레포 승인자가 없으면',
    type: 'file-overlap' as const,
    policy: { gateApprovers: { 'acme/other': { 'approver-1': pem } } },
    gap: 'no-repo',
    says: 'acme/app 레포에는 게이트를 닫을 승인자가 등록되지 않았어요',
  },
  {
    name: '머지 승인자만 있고 파일 겹침 승인자가 없으면',
    type: 'file-overlap' as const,
    policy: { mergeApprovers: { [repo]: { 'approver-1': pem } } },
    gap: 'no-type-approvers',
    says: 'acme/app 레포에는 파일 겹침 게이트를 닫을 승인자가 등록되지 않았어요',
  },
  {
    name: '게이트 승인자만 있고 머지 승인자가 없으면',
    type: 'merge' as const,
    policy: { gateApprovers: { [repo]: { 'approver-1': pem } } },
    gap: 'no-type-approvers',
    says: 'acme/app 레포에는 머지 게이트를 닫을 승인자가 등록되지 않았어요',
  },
];

describe('승인자 미등록 안내', () => {
  for (const c of cases) {
    it(`${c.name} bot gate가 approverReady false와 터미널 명령을 준다`, async () => {
      fakeOrca();
      ghMustNotRun();
      const { store, gate } = fixture(c.type, c.policy);
      await conductorBotGateCommand(gate.id, { stateDir: store.dir });
      const out = last();
      expect(out).toMatchObject({
        approverReady: false,
        approverGap: c.gap,
        terminal: {
          approved: `gestalt conductor gate resolve ${gate.id} --approve`,
          rejected: `gestalt conductor gate resolve ${gate.id} --reject`,
        },
      });
      expect(out.guidance).toContain(c.says);
      expect(out).not.toHaveProperty('messages');
      expect(out).not.toHaveProperty('orcaItem');
      expect(out).not.toHaveProperty('touchId');
      expect(out.guidance).not.toContain('approver enroll');
    });

    it(`${c.name} bot decide가 ENOENT나 권한 없는 서명자 대신 안내 에러로 멈추고 게이트를 열어 둔다`, async () => {
      fakeOrca();
      ghMustNotRun();
      const { store, gate } = fixture(c.type, c.policy);
      await expect(
        conductorBotDecideCommand(gate.id, {
          stateDir: store.dir,
          decision: 'approved',
          signer: 'approver-1',
          signature: 'A'.repeat(86) + '==',
        }),
      ).rejects.toThrow('exit 1');
      const message = lines.join('\n');
      expect(message).toContain(c.says);
      expect(message).toContain(`gestalt conductor gate resolve ${gate.id} --approve`);
      expect(message).not.toContain('ENOENT');
      expect(message).not.toContain('권한이 없는 서명자');
      store.reload();
      expect(store.snapshot.gates[gate.id]?.status).toBe('open');
    });
  }

  it('승인자가 있으면 approverReady true와 서명 재료를 그대로 싣는다', async () => {
    fakeOrca();
    const { store, gate } = fixture('file-overlap', {
      gateApprovers: { [repo]: { 'approver-1': pem } },
    });
    await conductorBotGateCommand(gate.id, { stateDir: store.dir });
    expect(last()).toMatchObject({ approverReady: true, messages: expect.any(Object) });
    expect(last()).not.toHaveProperty('guidance');
  });

  it('등록된 승인자가 아닌 서명자는 기존처럼 권한 없는 서명자로 거절한다', async () => {
    fakeOrca();
    const { store, gate } = fixture('file-overlap', {
      gateApprovers: { [repo]: { 'approver-1': pem } },
    });
    await expect(
      conductorBotDecideCommand(gate.id, {
        stateDir: store.dir,
        decision: 'approved',
        signer: 'someone-else',
        signature: 'A'.repeat(86) + '==',
      }),
    ).rejects.toThrow('exit 1');
    expect(lines.join('\n')).toContain('권한이 없는 서명자');
  });

  it('approverStatus는 레포 이름 대소문자를 가리지 않고 승인자 수를 센다', () => {
    const policy = { mergeApprovers: { [repo]: { a: pem, b: pem } } };
    expect(approverStatus(policy, 'merge', 'Acme/App')).toEqual({ ready: true, count: 2 });
    expect(approverStatus(policy, 'file-overlap', repo)).toMatchObject({
      ready: false,
      gap: 'no-type-approvers',
    });
    expect(approverStatus({ mergeApprovers: { [repo]: {} } }, 'merge', repo)).toMatchObject({
      ready: false,
      gap: 'no-repo',
    });
  });

  it('쓸 수 없는 승인자 값만 있으면 approverStatus는 준비되지 않았다고 본다', () => {
    const broken = { gateApprovers: { [repo]: { pem: 'not a key', web: { webauthn: { x: 1 } } } } };
    expect(approverStatus(broken, 'file-overlap', repo)).toMatchObject({
      ready: false,
      gap: 'no-repo',
    });
    const mixed = { gateApprovers: { [repo]: { pem: 'not a key', ok: pem } } };
    expect(approverStatus(mixed, 'file-overlap', repo)).toEqual({ ready: true, count: 1 });
  });

  it('이전 WebAuthn이 섞여 있어도 다른 승인자와 게이트 정책은 유지한다', async () => {
    fakeOrca();
    const policy = {
      mergeApprovers: { [repo]: { legacy: legacyApprover, current: pem } },
      gateApprovers: { [repo]: { legacy: legacyApprover, current: pem } },
    };
    expect(approverStatus(policy, 'merge', repo)).toEqual({ ready: true, count: 1 });
    const { store, gate } = fixture('file-overlap', policy);
    await conductorBotGateCommand(gate.id, { stateDir: store.dir });
    expect(last()).toMatchObject({ approverReady: true, messages: expect.any(Object) });
    expect(last()).not.toHaveProperty('touchId');
    expect(readBotPolicy(store.dir)).toEqual(policy);
  });

  it('정책 파일이 깨졌으면 bot gate가 unreadable 안내를 주고 gh를 부르지 않는다', async () => {
    fakeOrca();
    ghMustNotRun();
    const { store, gate } = fixture('file-overlap', undefined);
    writeFileSync(join(store.dir, BOT_POLICY_FILE), '{');
    await conductorBotGateCommand(gate.id, { stateDir: store.dir });
    expect(last()).toMatchObject({ approverReady: false, approverGap: 'unreadable' });
    expect(last().guidance).toContain('승인자 정책 파일');
  });

  it('readBotPolicy는 파일이 없을 때 ENOENT 대신 만들 곳을 알려준다', () => {
    const dir = tempStateDir();
    expect(() => readBotPolicy(dir)).toThrow(
      '봇 정책 파일(bot-policy.json)이 상태 저장소에 없어요',
    );
  });
});

describe('conductor status 승인자 등록 상태', () => {
  it('JSON에 레포별 머지와 게이트 승인자 수를 싣는다', () => {
    const { store } = fixture('merge', { mergeApprovers: { [repo]: { 'approver-1': pem } } });
    conductorStatusCommand({ stateDir: store.dir, json: true });
    expect(last().approvers).toEqual({
      policy: 'present',
      repos: [{ repo, merge: 1, gate: 0 }],
    });
  });

  it('정책 파일이 없으면 텍스트 출력에 봇에서 못 닫는다고 적는다', () => {
    const { store } = fixture('merge', undefined);
    conductorStatusCommand({ stateDir: store.dir });
    expect(lines.join('\n')).toContain('승인자: 봇 정책 파일이 없어요');
  });

  it('정책 파일이 깨져도 status는 멈추지 않는다', () => {
    const { store } = fixture('merge', undefined);
    writeFileSync(join(store.dir, BOT_POLICY_FILE), '{');
    conductorStatusCommand({ stateDir: store.dir, json: true });
    expect(last().approvers).toEqual({ policy: 'unreadable', repos: [] });
  });
});
