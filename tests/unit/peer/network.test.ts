import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import type { ClientRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PeerDaemon } from '../../../src/peer/daemon.js';
import { request } from '../../../src/peer/client.js';
import { loadMachineKey, machineKeyPath } from '../../../src/peer/keys.js';
import { RelayServer } from '../../../src/peer/relay.js';
import { nextRoster, parseShareLink, signRoster } from '../../../src/peer/roster.js';
import { RelayTransport } from '../../../src/peer/transport.js';
import { PeerState } from '../../../src/peer/state.js';
import type {
  DaemonStatus,
  MemberInfo,
  PeerRequest,
  ShareInfo,
  WatchResult,
} from '../../../src/peer/protocol.js';
import { FAKE_HOME, FAKE_SECRETS, fixtureText } from '../../fixtures/peer/transcript.js';

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('조건을 기다리다 시간이 다 됐어요');
}

/** SSE를 열어 두고 받은 글자를 계속 모은다 */
function openSse(url: string): { body: () => string; ended: () => boolean; req: ClientRequest } {
  let body = '';
  let ended = false;
  const u = new URL(url);
  const req = httpGet(`${u.origin}${u.pathname}/events?t=${u.searchParams.get('t')}`, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => (body += chunk));
    res.on('end', () => (ended = true));
  });
  req.on('error', () => (ended = true));
  return { body: () => body, ended: () => ended, req };
}

interface Node {
  root: string;
  dbPath: string;
  daemon: PeerDaemon;
  call<T>(req: PeerRequest, timeoutMs?: number): Promise<T>;
  status(): Promise<DaemonStatus>;
}

async function startNode(): Promise<Node> {
  const root = mkdtempSync(join(tmpdir(), 'peer-net-'));
  const dbPath = resolve('.gestalt-test', `peer-${randomUUID()}.db`);
  const daemon = new PeerDaemon({
    root,
    dbPath,
    pollMs: 20,
    home: FAKE_HOME,
    network: { minBackoffMs: 50, maxBackoffMs: 200 },
  });
  await daemon.start();
  const call = async <T>(req: PeerRequest, timeoutMs = 5_000): Promise<T> => {
    const res = await request<T>(daemon.socketPath, req, timeoutMs);
    if (!res.ok) throw new Error(res.error);
    return res.result;
  };
  return { root, dbPath, daemon, call, status: () => call<DaemonStatus>({ op: 'status' }) };
}

describe('peer 원격 공유 (데몬 둘 + 릴레이)', () => {
  let owner: Node;
  let watcher: Node;
  let relay: RelayServer;
  let relayDir: string;
  let relayUrl: string;
  /** 릴레이를 지난 프레임 전부 */
  const tap: string[] = [];

  beforeEach(async () => {
    tap.length = 0;
    owner = await startNode();
    watcher = await startNode();
    const team = (await owner.status()).machineKey;
    relayDir = mkdtempSync(join(tmpdir(), 'peer-relay-'));
    relay = new RelayServer({
      team,
      host: '127.0.0.1',
      port: 0,
      rosterFile: join(relayDir, 'roster.json'),
      onFrame: (_dir, text) => tap.push(text),
    });
    const port = await relay.start();
    relayUrl = `ws://127.0.0.1:${port}`;

    await owner.call({ op: 'init', person: 'tienne', relay: relayUrl });
    await until(async () => (await owner.status()).team?.connection === 'online');
    const { code } = await owner.call<{ code: string }>({ op: 'invite', person: 'alice' });
    await watcher.call({ op: 'join', code, timeoutMs: 10_000 }, 15_000);
    await until(async () => (await watcher.status()).team?.connection === 'online');
  });

  afterEach(async () => {
    for (const n of [owner, watcher]) {
      await n.daemon.stop();
      rmSync(n.root, { recursive: true, force: true });
      rmSync(n.dbPath, { force: true });
    }
    await relay.stop();
    rmSync(relayDir, { recursive: true, force: true });
  });

  async function openShare(): Promise<{ info: ShareInfo; transcript: string }> {
    const transcript = join(owner.root, 'fixture.jsonl');
    writeFileSync(transcript, fixtureText());
    const info = await owner.call<ShareInfo>({ op: 'share', transcriptPath: transcript });
    return { info, transcript };
  }

  it('초대와 join으로 명단에 오르고 판이 올라간다', async () => {
    const a = await owner.status();
    const b = await watcher.status();
    expect(a.team).toMatchObject({ epoch: 2, role: 'admin', person: 'tienne' });
    expect(b.team).toMatchObject({ epoch: 2, role: 'member', person: 'alice', team: a.machineKey });
    const members = await watcher.call<MemberInfo[]>({ op: 'members' });
    expect(members.map((m) => [m.person, m.role])).toEqual([
      ['tienne', 'admin'],
      ['alice', 'member'],
    ]);
    expect(relay.epoch).toBe(2);
  });

  it('팀원 머신에서 링크로 공유를 보고 새 줄도 실시간으로 받는다', async () => {
    const { info, transcript } = await openShare();
    expect(info.link).toMatch(/^gestalt:\/\/peer\/127\.0\.0\.1:\d+\/[\w-]+#[\w-]{43}$/);

    const watch = await watcher.call<WatchResult>({ op: 'watch', link: info.link! }, 15_000);
    expect(watch).toMatchObject({ share: info.id, owner: 'tienne' });
    expect(watch.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/[\w-]+\?t=[\w-]+$/);

    const sse = openSse(watch.url);
    try {
      await until(() => sse.body().includes('안녕하세요'));
      appendFileSync(
        transcript,
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: '실시간으로 붙은 줄' }] },
        }) + '\n',
      );
      await until(() => sse.body().includes('실시간으로 붙은 줄'));
      const body = sse.body();
      expect(body).not.toContain('LEAK_');
      expect(body).not.toContain(FAKE_SECRETS.apiKeyValue);
      expect((await owner.call<ShareInfo[]>({ op: 'shares' }))[0]!.viewers).toBe(1);
    } finally {
      sse.req.destroy();
    }
  });

  it('릴레이에는 평문 대화와 공유 키가 안 가고 암호문과 라우팅 정보만 간다', async () => {
    const { info, transcript } = await openShare();
    const watch = await watcher.call<WatchResult>({ op: 'watch', link: info.link! }, 15_000);
    const sse = openSse(watch.url);
    try {
      await until(() => sse.body().includes('안녕하세요'));
      appendFileSync(
        transcript,
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'PLAIN_MARKER_77' }] },
        }) + '\n',
      );
      await until(() => sse.body().includes('PLAIN_MARKER_77'));
    } finally {
      sse.req.destroy();
    }

    const all = tap.join('\n');
    expect(all).not.toContain('안녕하세요');
    expect(all).not.toContain('PLAIN_MARKER_77');
    expect(all).not.toContain('"kind"');
    expect(all).not.toContain(parseShareLink(info.link!).shareKey);
    // 데이터 프레임의 data는 base64url 한 덩어리고 열어 봐도 봉투 안 내용은 암호문이다
    const recv = tap
      .map((t) => JSON.parse(t) as Record<string, unknown>)
      .filter((f) => f.t === 'recv');
    expect(recv.length).toBeGreaterThan(0);
    for (const f of recv) {
      expect(Object.keys(f).sort()).toEqual(['data', 'from', 't']);
      const env = JSON.parse(Buffer.from(String(f.data), 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >;
      expect(['box', 's']).toContain(env.k);
      const decoded = JSON.stringify(env);
      expect(decoded).not.toContain('안녕하세요');
      expect(decoded).not.toContain('PLAIN_MARKER_77');
    }
  });

  it('명단에서 빼면 열린 공유에서 바로 끊기고 다시 못 붙는다', async () => {
    const { info } = await openShare();
    const watch = await watcher.call<WatchResult>({ op: 'watch', link: info.link! }, 15_000);
    const sse = openSse(watch.url);
    try {
      await until(() => sse.body().includes('안녕하세요'));
      const removed = await owner.call<{ removed: number; epoch: number }>({
        op: 'remove',
        person: 'alice',
      });
      expect(removed).toEqual({ removed: 1, epoch: 3 });

      await until(() => sse.body().includes('event: closed'));
      expect(sse.body()).toMatch(/event: closed\ndata: \{"reason":"removed"/);
      await until(async () => (await watcher.status()).team?.connection === 'removed');
      await until(async () => (await owner.call<ShareInfo[]>({ op: 'shares' }))[0]!.viewers === 0);
      const bKey = (await watcher.status()).machineKey;
      expect(relay.onlineKeys).not.toContain(bKey);
    } finally {
      sse.req.destroy();
    }

    // 빠진 기기 키로 다시 붙으면 릴레이가 거절한다
    const key = loadMachineKey(machineKeyPath(watcher.root));
    const t = new RelayTransport({
      url: relayUrl,
      team: (await owner.status()).machineKey,
      key,
      reconnect: false,
    });
    await expect(t.connect(null)).rejects.toThrow('명단에 없는');
    await t.close();
  });

  it('관리자가 아닌 기기가 서명한 명단과 판이 낮은 명단은 릴레이와 데몬이 버린다', async () => {
    const team = (await owner.status()).machineKey;
    const key = loadMachineKey(machineKeyPath(watcher.root));
    // 같은 키로 붙으면 릴레이가 앞 연결을 닫아서 데몬과 접속을 뺏고 뺏긴다. 데몬을 먼저 멈춘다
    await watcher.daemon.stop();
    // 지금 명단을 꺼내 alice가 스스로 관리자로 올린 판을 만든다
    const state = new PeerState(watcher.dbPath);
    const current = state.getRoster()!;
    state.close();
    const forgedMembers = current.roster.members.map((m) => ({ ...m, role: 'admin' as const }));
    const forged = signRoster(nextRoster(current.roster, forgedMembers, key.id), key);

    const t = new RelayTransport({ url: relayUrl, team, key, reconnect: false });
    const errors: string[] = [];
    t.on('relay-error', (_code: string, message: string) => errors.push(message));
    await t.connect(current);
    t.publishRoster(forged);
    await until(() => errors.length > 0);
    expect(errors[0]).toContain('관리자가 서명하지 않았어요');
    expect(relay.epoch).toBe(2);

    // 판이 낮은 옛 명단(판 1)을 다시 내밀어도 안 받는다
    const ownerState = new PeerState(owner.dbPath);
    const auditBefore = ownerState.auditLog().length;
    ownerState.close();
    t.publishRoster({ ...current, roster: { ...current.roster, epoch: 1 } });
    await until(() => errors.length > 1);
    expect(errors[1]).toMatch(/서명이 맞지 않아요|판이 낮거나/);
    expect(relay.epoch).toBe(2);
    expect((await owner.status()).team?.epoch).toBe(2);
    const after = new PeerState(owner.dbPath);
    expect(after.auditLog().length).toBe(auditBefore);
    after.close();
    await t.close();
  });

  it('링크의 공유 키가 틀리면 주인 데몬이 거절한다', async () => {
    const { info } = await openShare();
    const wrong = info.link!.replace(/#.*$/, `#${'A'.repeat(43)}`);
    await expect(watcher.call({ op: 'watch', link: wrong }, 15_000)).rejects.toThrow('bad_proof');
  });

  it('공유를 닫으면 보는 쪽 뷰어도 종료된다', async () => {
    const { info } = await openShare();
    const watch = await watcher.call<WatchResult>({ op: 'watch', link: info.link! }, 15_000);
    const sse = openSse(watch.url);
    try {
      await until(() => sse.body().includes('안녕하세요'));
      await owner.call({ op: 'unshare', id: info.id });
      await until(() => sse.body().includes('event: closed'));
      expect(sse.body()).toMatch(/"reason":"unshare"/);
    } finally {
      sse.req.destroy();
    }
  });
});
