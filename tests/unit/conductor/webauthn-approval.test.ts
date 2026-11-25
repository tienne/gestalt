import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  approvalGateHandlers,
  conductorApproverEnrollCommand,
} from '../../../src/cli/commands/conductor-approval.js';
import {
  conductorBotGateCommand,
  touchIdGateDecide,
  touchIdGateOptions,
} from '../../../src/cli/commands/conductor.js';
import {
  approvalServerRunning,
  approvalStoreId,
  HttpError,
  startApprovalServer,
} from '../../../src/conductor/approval-server.js';
import {
  approverStatus,
  BOT_POLICY_FILE,
  gateApprovalMessage,
  matchBotGate,
} from '../../../src/conductor/bot-approval.js';
import { acquireLock } from '../../../src/conductor/engine.js';
import { changeBotOwner } from '../../../src/conductor/bot-owner.js';
import { openOrReuse } from '../../../src/conductor/gates.js';
import { ConductorStore } from '../../../src/conductor/store.js';
import {
  addWebAuthnApprover,
  APPROVAL_PORT,
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
const NONCE = 'nonce-1';
const server = { nonce: NONCE, origin };
const want = (message: string) => ({ challenge: webAuthnChallenge(message, NONCE), origin });

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
  over: { origin?: string; rpId?: string; flags?: number; type?: string; nonce?: string } = {},
) {
  const clientData = Buffer.from(
    JSON.stringify({
      type: over.type ?? 'webauthn.get',
      challenge: webAuthnChallenge(message, over.nonce ?? NONCE),
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

async function fixture(type: 'merge' | 'file-overlap', credential: WebAuthnCredential) {
  const store = ConductorStore.open(tempStateDir());
  const gates = [0, 1].map((i) => {
    const o = order({ repo, prRef: pr, status: 'running' });
    const w = worker(o.id, { kind: 'git-worktree' });
    store.addOrder({ ...o, workerId: w.id });
    store.startWorker(w);
    return openOrReuse(store, { type, orderId: o.id, reason: `사람 확인 ${i}` }).gate;
  });
  await addWebAuthnApprover(
    store.dir,
    type === 'merge' ? 'merge' : 'gate',
    repo,
    'tienne',
    credential,
  );
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
    expect(verifyWebAuthnAssertion(credential, want('msg'), raw)).toEqual({ signCount: 7 });
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
    expect(() => verifyWebAuthnAssertion(credential, want('msg'), raw)).toThrow(error);
  });

  it('P-256이 아닌 공개키는 Touch ID 승인자로 쓰지 않는다', () => {
    const ed = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
    const { privateKey, credential } = p256();
    const raw = assert(privateKey, credential.credentialId, 'msg');
    expect(() =>
      verifyWebAuthnAssertion({ ...credential, publicKey: ed.toString() }, want('msg'), raw),
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

  it('PEM 손편집 없이 공개키를 정책에 넣고 기존 칸은 그대로 둔다', async () => {
    const dir = tempStateDir();
    writeFileSync(join(dir, BOT_POLICY_FILE), JSON.stringify({ githubIntakeBotId: 'team' }));
    const { publicKey } = p256();
    const credential = verifyWebAuthnRegistration(registration(publicKey), 'chal', origin);
    await addWebAuthnApprover(dir, 'gate', 'Acme/App', 'tienne', credential);
    const policy = JSON.parse(readFileSync(join(dir, BOT_POLICY_FILE), 'utf8'));
    expect(policy.githubIntakeBotId).toBe('team');
    expect(policy.gateApprovers[repo].tienne.webauthn).toMatchObject({ origin });
    expect(approverStatus(policy, 'file-overlap', repo)).toMatchObject({ ready: true });
    await expect(addWebAuthnApprover(dir, 'gate', repo, 'tienne', credential)).rejects.toThrow(
      '--replace',
    );
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
    const { store, gate } = await fixture('file-overlap', credential);
    const options = await touchIdGateOptions({ stateDir: store.dir }, gate.id, 'approved', NONCE);
    expect(options.credentialIds).toEqual([credential.credentialId]);
    const message = messageFor(store, gate.id, 'approved');
    expect(options.challenge).toBe(webAuthnChallenge(message, NONCE));
    const result = await touchIdGateDecide(
      { stateDir: store.dir },
      gate.id,
      'approved',
      assert(privateKey, credential.credentialId, message),
      server,
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
    const { store, gate, other } = await fixture('file-overlap', credential);
    const forOther = assert(
      privateKey,
      credential.credentialId,
      messageFor(store, other.id, 'approved'),
    );
    await expect(
      touchIdGateDecide({ stateDir: store.dir }, gate.id, 'approved', forOther, server),
    ).rejects.toThrow('바뀌었어요');
    const forReject = assert(
      privateKey,
      credential.credentialId,
      messageFor(store, gate.id, 'rejected'),
    );
    await expect(
      touchIdGateDecide({ stateDir: store.dir }, gate.id, 'approved', forReject, server),
    ).rejects.toThrow('바뀌었어요');
    store.reload();
    expect(store.snapshot.gates[gate.id]?.status).toBe('open');
  });

  it('머지 게이트는 서명 뒤 PR HEAD가 바뀌면 거절한다', async () => {
    const { privateKey, credential } = p256();
    const { store, gate } = await fixture('merge', credential);
    const signed = assert(
      privateKey,
      credential.credentialId,
      messageFor(store, gate.id, 'approved', sha),
    );
    fakePr('b'.repeat(40));
    await expect(
      touchIdGateDecide({ stateDir: store.dir }, gate.id, 'approved', signed, server),
    ).rejects.toThrow('바뀌었어요');
    fakePr(sha);
    await expect(
      touchIdGateDecide({ stateDir: store.dir }, gate.id, 'approved', signed, server),
    ).resolves.toMatchObject({ decision: 'approved' });
  });

  it('등록되지 않은 키로는 게이트를 닫지 못한다', async () => {
    const { credential } = p256();
    const { store, gate } = await fixture('file-overlap', credential);
    const stranger = p256();
    const message = messageFor(store, gate.id, 'approved');
    await expect(
      touchIdGateDecide(
        { stateDir: store.dir },
        gate.id,
        'approved',
        assert(stranger.privateKey, b64(Buffer.from('cred-2')), message),
        server,
      ),
    ).rejects.toThrow('등록된 Touch ID 키가 아니에요');
  });

  it('머지 칸에만 Touch ID 승인자가 있으면 파일 겹침 게이트는 터미널 안내로 멈춘다', async () => {
    const { credential } = p256();
    const { store } = await fixture('merge', credential);
    const o = order({ repo, prRef: pr, status: 'running' });
    store.addOrder(o);
    const overlap = openOrReuse(store, {
      type: 'file-overlap',
      orderId: o.id,
      reason: '겹침',
    }).gate;
    await expect(
      touchIdGateOptions({ stateDir: store.dir }, overlap.id, 'approved', NONCE),
    ).rejects.toThrow('파일 겹침 게이트를 닫을 승인자가 등록되지 않았어요');
  });

  it('bot gate는 Touch ID 승인자가 있으면 승인과 거절 링크를 싣는다', async () => {
    fakeOrca();
    const { credential } = p256();
    const { store, gate } = await fixture('file-overlap', credential);
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

describe('Touch ID 승인 경계', () => {
  it('승인 서버 주소가 아닌 origin으로 서명했으면 거절한다', () => {
    const { privateKey, credential } = p256();
    const raw = assert(privateKey, credential.credentialId, 'msg');
    expect(() =>
      verifyWebAuthnAssertion(credential, { ...want('msg'), origin: 'http://localhost:1234' }, raw),
    ).toThrow('이 승인 서버에서 연 승인 페이지가 아니에요');
  });

  it('다른 nonce로 받은 서명은 거절한다', () => {
    const { privateKey, credential } = p256();
    const raw = assert(privateKey, credential.credentialId, 'msg', { nonce: 'other' });
    expect(() => verifyWebAuthnAssertion(credential, want('msg'), raw)).toThrow('바뀌었어요');
  });

  it('승인 서버는 자기가 발급한 nonce만 한 번 받는다', async () => {
    const { privateKey, credential } = p256();
    const { store, gate } = await fixture('file-overlap', credential);
    const handlers = approvalGateHandlers({ stateDir: store.dir }, APPROVAL_PORT);
    const options = await handlers.gateOptions(gate.id, 'approved');
    const message = messageFor(store, gate.id, 'approved');
    const signed = assert(privateKey, credential.credentialId, message, { nonce: options.nonce });

    await expect(handlers.decide(gate.id, 'approved', signed, undefined)).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('만료'),
    });
    await expect(handlers.decide(gate.id, 'rejected', signed, options.nonce)).rejects.toMatchObject(
      { status: 400 },
    );
    // 결정이 달라 거절된 nonce는 다시 못 쓴다
    await expect(handlers.decide(gate.id, 'approved', signed, options.nonce)).rejects.toMatchObject(
      { status: 400 },
    );

    const fresh = await handlers.gateOptions(gate.id, 'approved');
    const again = assert(privateKey, credential.credentialId, message, { nonce: fresh.nonce });
    await expect(handlers.decide(gate.id, 'approved', again, fresh.nonce)).resolves.toMatchObject({
      decision: 'approved',
    });
    await expect(handlers.decide(gate.id, 'approved', again, fresh.nonce)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('2분이 지난 nonce는 받지 않는다', async () => {
    const { privateKey, credential } = p256();
    const { store, gate } = await fixture('file-overlap', credential);
    const handlers = approvalGateHandlers({ stateDir: store.dir }, APPROVAL_PORT);
    const options = await handlers.gateOptions(gate.id, 'approved');
    const signed = assert(
      privateKey,
      credential.credentialId,
      messageFor(store, gate.id, 'approved'),
      {
        nonce: options.nonce,
      },
    );
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 2 * 60_000 + 1);
    await expect(handlers.decide(gate.id, 'approved', signed, options.nonce)).rejects.toMatchObject(
      {
        status: 400,
        message: expect.stringContaining('만료'),
      },
    );
  });

  it('없는 게이트를 물으면 400으로 돌려준다', async () => {
    const handlers = approvalGateHandlers({ stateDir: tempStateDir() }, APPROVAL_PORT);
    await expect(handlers.gateOptions('nope', 'approved')).rejects.toMatchObject({ status: 400 });
  });

  it('nonce가 64개를 넘으면 가장 먼저 발급한 것부터 버린다', async () => {
    const { privateKey, credential } = p256();
    const { store, gate } = await fixture('file-overlap', credential);
    const handlers = approvalGateHandlers({ stateDir: store.dir }, APPROVAL_PORT);
    const nonces: string[] = [];
    for (let i = 0; i < 65; i++)
      nonces.push((await handlers.gateOptions(gate.id, 'approved')).nonce);
    const message = messageFor(store, gate.id, 'approved');
    const sign = (nonce: string) => assert(privateKey, credential.credentialId, message, { nonce });

    await expect(
      handlers.decide(gate.id, 'approved', sign(nonces[0]!), nonces[0]),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('만료') });
    await expect(
      handlers.decide(gate.id, 'approved', sign(nonces[1]!), nonces[1]),
    ).resolves.toMatchObject({ decision: 'approved' });
  });

  it('요청 쪽 문제가 아닌 실패는 400으로 바꾸지 않아 서버가 500으로 감춘다', async () => {
    const { credential } = p256();
    const { store, gate } = await fixture('file-overlap', credential);
    writeFileSync(join(store.dir, BOT_POLICY_FILE), '{');
    const handlers = approvalGateHandlers({ stateDir: store.dir }, APPROVAL_PORT);
    const error = await handlers.gateOptions(gate.id, 'approved').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(HttpError);
  });

  it('정책 파일이 깨졌으면 안내 에러를 내고 파일을 건드리지 않는다', async () => {
    const dir = tempStateDir();
    writeFileSync(join(dir, BOT_POLICY_FILE), '{');
    await expect(
      addWebAuthnApprover(dir, 'gate', repo, 'tienne', p256().credential),
    ).rejects.toThrow('JSON으로 읽지 못했어요');
    expect(readFileSync(join(dir, BOT_POLICY_FILE), 'utf8')).toBe('{');
  });

  it('컨덕터가 잠금을 쥐고 있으면 기다리다 안내 에러를 낸다', async () => {
    const dir = tempStateDir();
    const lock = acquireLock(dir);
    expect(lock.ok).toBe(true);
    try {
      await expect(
        addWebAuthnApprover(dir, 'gate', repo, 'tienne', p256().credential, false, 150),
      ).rejects.toThrow('컨덕터가 상태를 갱신 중이에요');
    } finally {
      if (lock.ok) lock.release();
    }
    await addWebAuthnApprover(dir, 'gate', repo, 'tienne', p256().credential, false, 150);
    expect(
      JSON.parse(readFileSync(join(dir, BOT_POLICY_FILE), 'utf8')).gateApprovers[repo],
    ).toHaveProperty('tienne');
  });

  it('잠금을 쥔 쪽이 쓴 승인자를 잠금이 풀린 뒤 등록이 덮지 않는다', async () => {
    const dir = tempStateDir();
    const lock = acquireLock(dir);
    expect(lock.ok).toBe(true);
    const pending = addWebAuthnApprover(dir, 'gate', repo, 'b', p256().credential, false, 5_000);
    await new Promise((r) => setTimeout(r, 150));
    writeFileSync(
      join(dir, BOT_POLICY_FILE),
      JSON.stringify({ gateApprovers: { [repo]: { a: { webauthn: p256().credential } } } }),
    );
    if (lock.ok) lock.release();
    await pending;
    const row = JSON.parse(readFileSync(join(dir, BOT_POLICY_FILE), 'utf8')).gateApprovers[repo];
    expect(Object.keys(row).sort()).toEqual(['a', 'b']);
  });

  it('bot gate는 다른 포트로 등록한 승인자면 그 포트로 링크와 시작 명령을 만든다', async () => {
    fakeOrca();
    const { credential } = p256();
    const custom = { ...credential, origin: approvalOrigin(48000) };
    const { store, gate } = await fixture('file-overlap', custom);
    await conductorBotGateCommand(gate.id, { stateDir: store.dir });
    const out = JSON.parse(lines.at(-1)!);
    expect(out.touchId.links.approved).toBe(
      `${approvalOrigin(48000)}/gate/${gate.id}?decision=approved`,
    );
    expect(out.touchId.start).toContain('--port 48000');
  });
});

/** 비어 있는 포트를 OS에서 받는다. 고정 범위에서 고르면 다른 테스트와 겹칠 수 있다 */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

/** fetch는 Host 헤더를 덮어쓰지 못해서 http.request로 보낸다 */
const call = (
  port: number,
  path: string,
  headers: Record<string, string>,
  body?: string,
  method = body === undefined ? 'GET' : 'POST',
) =>
  new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
    (resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      });
      req.on('error', reject);
      req.end(body);
    },
  );

const gateStub = (id: string) => ({
  gate: { id, type: 'merge', repo, reason: '', refs: [] },
  decision: 'approved' as const,
  challenge: 'c',
  nonce: 'n',
  credentialIds: [],
});

describe('승인 페이지 서버', () => {
  it('고정 주소가 아닌 Host와 다른 출처의 POST를 거른다', async () => {
    const port = await freePort();
    const host = `localhost:${port}`;
    const calls: string[] = [];
    const server = await startApprovalServer({
      port,
      handlers: {
        gateOptions: async (id) => {
          calls.push(id);
          return gateStub(id);
        },
        decide: async () => ({}),
      },
    });
    try {
      expect(await approvalServerRunning(port)).toBe(true);
      const page = await call(port, '/gate/g1?decision=approved', { host });
      expect(page.status).toBe(200);
      expect(String(page.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
      expect(
        (await call(port, '/gate/g1?decision=approved', { host: `evil.example:${port}` })).status,
      ).toBe(421);
      const body = JSON.stringify({ decision: 'approved' });
      const json = { 'content-type': 'application/json', host };
      expect((await call(port, '/api/gate/g1/options', json, body)).status).toBe(403);
      expect(
        (await call(port, '/api/gate/g1/options', { ...json, origin: 'http://evil.example' }, body))
          .status,
      ).toBe(403);
      expect(
        (await call(port, '/api/gate/g1/options', { ...json, origin: approvalOrigin(port) }, body))
          .status,
      ).toBe(200);
      expect(calls).toEqual(['g1']);
    } finally {
      await server.close();
    }
    expect(await approvalServerRunning(port)).toBe(false);
  });

  it('요청 형식과 경로가 틀리면 상태 코드로 거르고 내부 에러 원문은 내보내지 않는다', async () => {
    const port = await freePort();
    const host = `localhost:${port}`;
    const headers = { host, origin: approvalOrigin(port), 'content-type': 'application/json' };
    const server = await startApprovalServer({
      port,
      handlers: {
        gateOptions: async () => {
          throw new Error('secret internal detail');
        },
        decide: async () => ({}),
      },
    });
    try {
      const body = JSON.stringify({ decision: 'approved' });
      expect(
        (
          await call(
            port,
            '/api/gate/g1/options',
            { ...headers, 'content-type': 'text/plain' },
            body,
          )
        ).status,
      ).toBe(415);
      expect(
        (await call(port, '/api/gate/g1/options', headers, 'x'.repeat(64 * 1024 + 1))).status,
      ).toBe(413);
      expect((await call(port, '/api/gate/g1/options', headers, '{')).status).toBe(400);
      expect((await call(port, '/api/gate/g1/options', headers, '[1]')).status).toBe(400);
      expect((await call(port, '/nope', { host })).status).toBe(404);
      expect((await call(port, '/enroll', { host })).status).toBe(404);
      expect((await call(port, '/api/gate/g1/options', headers, body, 'PUT')).status).toBe(405);
      const failed = await call(port, '/api/gate/g1/options', headers, body);
      expect(failed.status).toBe(500);
      expect(failed.body).not.toContain('secret internal detail');
      expect(lines.join('\n')).toContain('secret internal detail');
    } finally {
      await server.close();
    }
  });

  it('등록 경로는 enroll 핸들러가 있을 때만 열고 코드와 등록 응답을 그대로 넘긴다', async () => {
    const port = await freePort();
    const host = `localhost:${port}`;
    const headers = { host, origin: approvalOrigin(port), 'content-type': 'application/json' };
    const finished: unknown[] = [];
    const server = await startApprovalServer({
      port,
      handlers: {
        gateOptions: async (id) => gateStub(id),
        decide: async () => ({}),
        enroll: {
          label: '등록',
          options: () => ({ challenge: 'c', userId: 'u', userName: 'n' }),
          finish: async (registration, code) => {
            finished.push({ registration, code });
            return { message: 'ok' };
          },
        },
      },
    });
    try {
      expect((await call(port, '/enroll', { host })).status).toBe(200);
      const options = await call(port, '/api/enroll/options', headers, '{}');
      expect(JSON.parse(options.body)).toEqual({ challenge: 'c', userId: 'u', userName: 'n' });
      const done = await call(
        port,
        '/api/enroll/finish',
        headers,
        JSON.stringify({ code: '1234-5678', registration: { a: 1 } }),
      );
      expect(done.status).toBe(200);
      expect(finished).toEqual([{ registration: { a: 1 }, code: '1234-5678' }]);
    } finally {
      await server.close();
    }
  });

  it('다른 상태 저장소로 뜬 승인 서버는 재사용하지 않는다', async () => {
    const port = await freePort();
    const store = approvalStoreId(tempStateDir());
    const server = await startApprovalServer({
      port,
      store,
      handlers: { gateOptions: async (id) => gateStub(id), decide: async () => ({}) },
    });
    try {
      expect(await approvalServerRunning(port, store)).toBe(true);
      await expect(approvalServerRunning(port, approvalStoreId(tempStateDir()))).rejects.toThrow(
        '다른 상태 저장소의 승인 서버',
      );
    } finally {
      await server.close();
    }
  });
});

describe('approver enroll 명령', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
  });

  const waitUp = async (port: number) => {
    for (let i = 0; i < 50; i++) {
      if (await approvalServerRunning(port)) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('등록 서버가 안 떴어요');
  };

  const start = async () => {
    const dir = tempStateDir();
    const port = await freePort();
    const run = conductorApproverEnrollCommand({
      stateDir: dir,
      repo,
      type: 'gate',
      id: 'tienne',
      port: String(port),
      open: false,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await waitUp(port);
    const code = /등록 코드 (\d{4}-\d{4})/.exec(lines.join('\n'))![1]!;
    const headers = {
      host: `localhost:${port}`,
      origin: approvalOrigin(port),
      'content-type': 'application/json',
    };
    const registration = async () => {
      const { challenge } = JSON.parse(
        (await call(port, '/api/enroll/options', headers, '{}')).body,
      ) as { challenge: string };
      const { publicKey } = p256();
      return {
        credentialId: b64(Buffer.from('cred-1')),
        clientDataJSON: b64(
          Buffer.from(
            JSON.stringify({ type: 'webauthn.create', challenge, origin: approvalOrigin(port) }),
          ),
        ),
        publicKey: b64(publicKey.export({ type: 'spki', format: 'der' })),
        algorithm: -7,
      };
    };
    const finishWith = (given: string, body: unknown) =>
      call(
        port,
        '/api/enroll/finish',
        headers,
        JSON.stringify({ code: given, registration: body }),
      );
    const finish = async (given: string) => finishWith(given, await registration());
    return { dir, run, code, finish, finishWith, registration };
  };

  it('터미널에 찍힌 등록 코드를 넣어야 승인자를 등록한다', async () => {
    const { dir, run, code, finish } = await start();
    const done = await finish(code);
    expect(done.status).toBe(200);
    expect(await run).toBeUndefined();
    const policy = JSON.parse(readFileSync(join(dir, BOT_POLICY_FILE), 'utf8'));
    expect(policy.gateApprovers[repo].tienne.webauthn).toHaveProperty('credentialId');
    expect(lines.join('\n')).toContain('"enrolled":true');
  });

  it('등록 코드가 틀리면 등록을 중단하고 두 번째 시도는 받지 않는다', async () => {
    const { dir, run, code, finish, finishWith, registration } = await start();
    const wrong = code === '0000-0000' ? '1111-1111' : '0000-0000';
    // 첫 실패 뒤 서버가 닫히기 전에 보내도록 두 번째 등록 응답을 미리 만든다
    const prepared = await registration();
    const first = await finish(wrong);
    expect(first.status).toBe(400);
    expect(first.body).toContain('등록 코드가 맞지 않아');
    const second = await finishWith(code, prepared);
    expect(second.status).toBe(409);
    expect(String(await run)).toContain('exit 1');
    expect(() => readFileSync(join(dir, BOT_POLICY_FILE), 'utf8')).toThrow();
  });
});
