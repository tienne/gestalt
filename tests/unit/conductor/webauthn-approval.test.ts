import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  conductorBotGateCommand,
  touchIdGateDecide,
  touchIdGateOptions,
} from '../../../src/cli/commands/conductor.js';
import {
  approvalServerRunning,
  startApprovalServer,
} from '../../../src/conductor/approval-server.js';
import {
  approverStatus,
  BOT_POLICY_FILE,
  gateApprovalMessage,
  matchBotGate,
} from '../../../src/conductor/bot-approval.js';
import { changeBotOwner } from '../../../src/conductor/bot-owner.js';
import { openOrReuse } from '../../../src/conductor/gates.js';
import { ConductorStore } from '../../../src/conductor/store.js';
import {
  addWebAuthnApprover,
  approvalOrigin,
  verifyWebAuthnAssertion,
  verifyWebAuthnRegistration,
  webAuthnChallenge,
  type WebAuthnCredential,
} from '../../../src/conductor/webauthn-approval.js';
import { cleanupStateDirs, order, tempStateDir, worker } from './fixtures.js';

const owner = { botId: 'ops-bot', name: 'Conductor', chatId: 'ops-home' };
const repo = 'acme/app';
const pr = `${repo}#42`;
const origin = approvalOrigin();
const sha = 'a'.repeat(40);

const b64 = (buf: Buffer) => buf.toString('base64url');
const sha256 = (v: Buffer | string) => createHash('sha256').update(v).digest();

function p256() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const credential: WebAuthnCredential = {
    credentialId: b64(Buffer.from('cred-1')),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    origin,
  };
  return { privateKey, publicKey, credential };
}

/** 브라우저와 Touch ID가 하는 일을 흉내 내 서명한다 */
function assert(
  key: KeyObject,
  credentialId: string,
  message: string,
  over: { origin?: string; rpId?: string; flags?: number; type?: string } = {},
) {
  const clientData = Buffer.from(
    JSON.stringify({
      type: over.type ?? 'webauthn.get',
      challenge: webAuthnChallenge(message),
      origin: over.origin ?? origin,
      crossOrigin: false,
    }),
  );
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(7);
  const auth = Buffer.concat([
    sha256(over.rpId ?? 'localhost'),
    Buffer.from([over.flags ?? 0x05]),
    counter,
  ]);
  const signature = sign('sha256', Buffer.concat([auth, sha256(clientData)]), key);
  return {
    credentialId,
    clientDataJSON: b64(clientData),
    authenticatorData: b64(auth),
    signature: b64(signature),
  };
}

function executable(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
  chmodSync(path, 0o700);
}

function fakePr(head = sha) {
  const bin = tempStateDir();
  const evidence = {
    headRefOid: head,
    baseRefName: 'main',
    state: 'OPEN',
    isDraft: false,
    statusCheckRollup: [],
  };
  executable(join(bin, 'gh'), `echo '${JSON.stringify(evidence)}'`);
  vi.stubEnv('PATH', `${bin}:${process.env['PATH'] ?? ''}`);
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

let lines: string[];
beforeEach(() => {
  lines = [];
  vi.stubEnv('GESTALT_CONDUCTOR_WORKER_ID', undefined);
  vi.spyOn(console, 'log').mockImplementation((v: unknown) => void lines.push(String(v)));
  vi.spyOn(console, 'error').mockImplementation((v: unknown) => void lines.push(String(v)));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  cleanupStateDirs();
});

function fixture(type: 'merge' | 'file-overlap', credential: WebAuthnCredential) {
  const store = ConductorStore.open(tempStateDir());
  const gates = [0, 1].map((i) => {
    const o = order({ repo, prRef: pr, status: 'running' });
    const w = worker(o.id, { kind: 'git-worktree' });
    store.addOrder({ ...o, workerId: w.id });
    store.startWorker(w);
    return openOrReuse(store, { type, orderId: o.id, reason: `사람 확인 ${i}` }).gate;
  });
  addWebAuthnApprover(store.dir, type === 'merge' ? 'merge' : 'gate', repo, 'tienne', credential);
  changeBotOwner(store.dir, undefined, owner);
  return { store, gate: gates[0]!, other: gates[1]! };
}

const messageFor = (
  store: ConductorStore,
  gateId: string,
  decision: 'approved' | 'rejected',
  head?: string,
) => gateApprovalMessage(matchBotGate(store, gateId), head, decision, head ? 'main' : undefined);

describe('WebAuthn P-256 서명 검증', () => {
  it('Touch ID 서명을 받아들이고 서명 카운터를 돌려준다', () => {
    const { privateKey, credential } = p256();
    const raw = assert(privateKey, credential.credentialId, 'msg');
    expect(verifyWebAuthnAssertion(credential, 'msg', raw)).toEqual({ signCount: 7 });
  });

  it.each([
    ['다른 키로 서명', { key: 'other' }, 'Touch ID 서명을 확인하지 못했어요'],
    ['다른 문자열에 서명', { message: 'other' }, '게이트 내용이나 PR HEAD가 바뀌었어요'],
    ['다른 origin', { origin: 'http://localhost:1234' }, '승인 페이지 주소가 등록할 때와 달라요'],
    ['다른 RP ID', { rpId: 'evil.example' }, 'RP ID가 localhost가 아니에요'],
    ['본인 확인 없음', { flags: 0x01 }, 'Touch ID 본인 확인을 거치지 않은 서명'],
    ['등록 응답을 승인에 재사용', { type: 'webauthn.create' }, '승인이 아니에요'],
  ] as const)('%s이면 거절한다', (_name, over, error) => {
    const { privateKey, credential } = p256();
    const key = 'key' in over ? p256().privateKey : privateKey;
    const raw = assert(key, credential.credentialId, 'message' in over ? over.message : 'msg', {
      ...('origin' in over ? { origin: over.origin } : {}),
      ...('rpId' in over ? { rpId: over.rpId } : {}),
      ...('flags' in over ? { flags: over.flags } : {}),
      ...('type' in over ? { type: over.type } : {}),
    });
    expect(() => verifyWebAuthnAssertion(credential, 'msg', raw)).toThrow(error);
  });

  it('P-256이 아닌 공개키는 Touch ID 승인자로 쓰지 않는다', () => {
    const ed = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
    const { privateKey, credential } = p256();
    const raw = assert(privateKey, credential.credentialId, 'msg');
    expect(() =>
      verifyWebAuthnAssertion({ ...credential, publicKey: ed.toString() }, 'msg', raw),
    ).toThrow('P-256이 아니에요');
  });
});

describe('Touch ID 승인자 등록', () => {
  const registration = (publicKey: KeyObject, algorithm = -7, challenge = 'chal') => ({
    credentialId: b64(Buffer.from('cred-1')),
    clientDataJSON: b64(
      Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin })),
    ),
    publicKey: b64(publicKey.export({ type: 'spki', format: 'der' })),
    algorithm,
  });

  it('PEM 손편집 없이 공개키를 정책에 넣고 기존 칸은 그대로 둔다', () => {
    const dir = tempStateDir();
    writeFileSync(join(dir, BOT_POLICY_FILE), JSON.stringify({ githubIntakeBotId: 'team' }));
    const { publicKey } = p256();
    const credential = verifyWebAuthnRegistration(registration(publicKey), 'chal', origin);
    addWebAuthnApprover(dir, 'gate', 'Acme/App', 'tienne', credential);
    const policy = JSON.parse(readFileSync(join(dir, BOT_POLICY_FILE), 'utf8'));
    expect(policy.githubIntakeBotId).toBe('team');
    expect(policy.gateApprovers[repo].tienne.webauthn).toMatchObject({ origin });
    expect(approverStatus(policy, 'file-overlap', repo)).toMatchObject({ ready: true });
    expect(() => addWebAuthnApprover(dir, 'gate', repo, 'tienne', credential)).toThrow('--replace');
  });

  it('ES256이 아니거나 challenge가 다르면 등록하지 않는다', () => {
    const { publicKey } = p256();
    expect(() => verifyWebAuthnRegistration(registration(publicKey, -257), 'chal', origin)).toThrow(
      'ES256',
    );
    expect(() => verifyWebAuthnRegistration(registration(publicKey), 'other', origin)).toThrow(
      '등록 요청이 바뀌었어요',
    );
    const ed = generateKeyPairSync('ed25519').publicKey;
    expect(() => verifyWebAuthnRegistration(registration(ed), 'chal', origin)).toThrow('P-256');
  });
});

describe('Touch ID로 게이트 닫기', () => {
  it('파일 겹침 게이트를 닫고 승인 경로를 WebAuthn으로 남긴다', async () => {
    const { privateKey, credential } = p256();
    const { store, gate } = fixture('file-overlap', credential);
    const options = await touchIdGateOptions({ stateDir: store.dir }, gate.id, 'approved');
    expect(options.credentialIds).toEqual([credential.credentialId]);
    const message = messageFor(store, gate.id, 'approved');
    expect(options.challenge).toBe(webAuthnChallenge(message));
    const result = await touchIdGateDecide(
      { stateDir: store.dir },
      gate.id,
      'approved',
      assert(privateKey, credential.credentialId, message),
    );
    expect(result).toMatchObject({ decision: 'approved', signer: 'tienne' });
    store.reload();
    expect(store.snapshot.gates[gate.id]).toMatchObject({
      status: 'resolved',
      decisionBy: 'tienne',
      decisionVia: { kind: 'webauthn', credentialId: credential.credentialId, signCount: 7 },
    });
  });

  it('다른 게이트에 한 서명이나 다른 결정에 한 서명은 거절하고 게이트를 열어 둔다', async () => {
    const { privateKey, credential } = p256();
    const { store, gate, other } = fixture('file-overlap', credential);
    const forOther = assert(
      privateKey,
      credential.credentialId,
      messageFor(store, other.id, 'approved'),
    );
    await expect(
      touchIdGateDecide({ stateDir: store.dir }, gate.id, 'approved', forOther),
    ).rejects.toThrow('바뀌었어요');
    const forReject = assert(
      privateKey,
      credential.credentialId,
      messageFor(store, gate.id, 'rejected'),
    );
    await expect(
      touchIdGateDecide({ stateDir: store.dir }, gate.id, 'approved', forReject),
    ).rejects.toThrow('바뀌었어요');
    store.reload();
    expect(store.snapshot.gates[gate.id]?.status).toBe('open');
  });

  it('머지 게이트는 서명 뒤 PR HEAD가 바뀌면 거절한다', async () => {
    const { privateKey, credential } = p256();
    const { store, gate } = fixture('merge', credential);
    const signed = assert(
      privateKey,
      credential.credentialId,
      messageFor(store, gate.id, 'approved', sha),
    );
    fakePr('b'.repeat(40));
    await expect(
      touchIdGateDecide({ stateDir: store.dir }, gate.id, 'approved', signed),
    ).rejects.toThrow('바뀌었어요');
    fakePr(sha);
    await expect(
      touchIdGateDecide({ stateDir: store.dir }, gate.id, 'approved', signed),
    ).resolves.toMatchObject({ decision: 'approved' });
  });

  it('등록되지 않은 키로는 게이트를 닫지 못한다', async () => {
    const { credential } = p256();
    const { store, gate } = fixture('file-overlap', credential);
    const stranger = p256();
    const message = messageFor(store, gate.id, 'approved');
    await expect(
      touchIdGateDecide(
        { stateDir: store.dir },
        gate.id,
        'approved',
        assert(stranger.privateKey, b64(Buffer.from('cred-2')), message),
      ),
    ).rejects.toThrow('등록된 Touch ID 키가 아니에요');
  });

  it('머지 칸에만 Touch ID 승인자가 있으면 파일 겹침 게이트는 터미널 안내로 멈춘다', async () => {
    const { credential } = p256();
    const { store } = fixture('merge', credential);
    const o = order({ repo, prRef: pr, status: 'running' });
    store.addOrder(o);
    const overlap = openOrReuse(store, {
      type: 'file-overlap',
      orderId: o.id,
      reason: '겹침',
    }).gate;
    await expect(
      touchIdGateOptions({ stateDir: store.dir }, overlap.id, 'approved'),
    ).rejects.toThrow('파일 겹침 승인자가 등록되지 않았어요');
  });

  it('bot gate는 Touch ID 승인자가 있으면 승인과 거절 링크를 싣는다', async () => {
    fakeOrca();
    const { credential } = p256();
    const { store, gate } = fixture('file-overlap', credential);
    await conductorBotGateCommand(gate.id, { stateDir: store.dir });
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({
      approverReady: true,
      touchId: {
        links: {
          approved: `${origin}/gate/${gate.id}?decision=approved`,
          rejected: `${origin}/gate/${gate.id}?decision=rejected`,
        },
      },
    });
  });
});

describe('승인 페이지 서버', () => {
  const port = 47300 + Math.floor(Math.random() * 500);
  const host = `localhost:${port}`;

  /** fetch는 Host 헤더를 덮어쓰지 못해서 http.request로 보낸다 */
  const call = (path: string, headers: Record<string, string>, body?: string) =>
    new Promise<{ status: number; headers: Record<string, unknown> }>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path, method: body ? 'POST' : 'GET', headers },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers }));
        },
      );
      req.on('error', reject);
      req.end(body);
    });

  it('고정 주소가 아닌 Host와 다른 출처의 POST를 거른다', async () => {
    const calls: string[] = [];
    const server = await startApprovalServer({
      port,
      handlers: {
        gateOptions: async (id) => {
          calls.push(id);
          return {
            gate: { id, type: 'merge', repo, reason: '', refs: [] },
            decision: 'approved',
            challenge: 'c',
            credentialIds: [],
          };
        },
        decide: async () => ({}),
      },
    });
    try {
      expect(await approvalServerRunning(port)).toBe(true);
      const page = await call('/gate/g1?decision=approved', { host });
      expect(page.status).toBe(200);
      expect(String(page.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
      expect(
        (await call('/gate/g1?decision=approved', { host: `evil.example:${port}` })).status,
      ).toBe(421);
      const body = JSON.stringify({ decision: 'approved' });
      const json = { 'content-type': 'application/json', host };
      expect((await call('/api/gate/g1/options', json, body)).status).toBe(403);
      expect(
        (await call('/api/gate/g1/options', { ...json, origin: 'http://evil.example' }, body))
          .status,
      ).toBe(403);
      expect(
        (await call('/api/gate/g1/options', { ...json, origin: approvalOrigin(port) }, body))
          .status,
      ).toBe(200);
      expect(calls).toEqual(['g1']);
    } finally {
      await server.close();
    }
    expect(await approvalServerRunning(port)).toBe(false);
  });
});
