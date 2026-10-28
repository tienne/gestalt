import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMachineKey, loadOrCreateMachineKey, machineKeyPath } from '../../../src/peer/keys.js';
import { aeadOpen, aeadSeal, canonical, openBox, sealBox } from '../../../src/peer/seal.js';
import { acceptUpgrade, connectWs } from '../../../src/peer/ws.js';
import type { WsConnection } from '../../../src/peer/ws.js';
import { acquireDaemonLock, lockPath, releaseDaemonLock } from '../../../src/peer/lock.js';

let dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'peer-crypto-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('기기 키', () => {
  it('처음 만들 때부터 0600이고 다시 읽으면 같은 키다', () => {
    const root = tmp();
    const a = loadOrCreateMachineKey(root);
    expect(statSync(machineKeyPath(root)).mode & 0o777).toBe(0o600);
    const b = loadOrCreateMachineKey(root);
    expect(b.id).toBe(a.id);
    expect(b.boxKey).toBe(a.boxKey);
    expect(a.id).toMatch(/^[\w-]{43}$/);
  });

  it('권한이 넓거나 심링크면 읽지 않는다', () => {
    const root = tmp();
    loadOrCreateMachineKey(root);
    chmodSync(machineKeyPath(root), 0o644);
    expect(() => loadOrCreateMachineKey(root)).toThrow('권한이 넓어요');
    chmodSync(machineKeyPath(root), 0o600);
    const other = tmp();
    symlinkSync(machineKeyPath(root), machineKeyPath(other));
    expect(() => loadMachineKey(machineKeyPath(other))).toThrow('심링크');
  });
});

describe('봉인', () => {
  it('받는 기기만 열고 바꾸거나 보낸 기기가 다르면 못 연다', () => {
    const alice = loadOrCreateMachineKey(tmp());
    const bob = loadOrCreateMachineKey(tmp());
    const eve = loadOrCreateMachineKey(tmp());
    const box = sealBox(alice, bob.id, bob.boxKey, '비밀 메시지');
    expect(JSON.stringify(box)).not.toContain('비밀');
    expect(openBox(bob, alice.id, box)).toBe('비밀 메시지');
    expect(openBox(eve, alice.id, box)).toBeNull();
    expect(openBox(bob, eve.id, box)).toBeNull();
    const flipped = { ...box, c: box.c.slice(0, -2) + (box.c.endsWith('A') ? 'BA' : 'AA') };
    expect(openBox(bob, alice.id, flipped)).toBeNull();
    expect(openBox(bob, alice.id, { k: 'box' })).toBeNull();
  });

  it('aead는 같은 키와 aad로만 열린다', () => {
    const key = randomBytes(32);
    const sealed = aeadSeal(key, Buffer.from('hello'), 'ctx');
    expect(aeadOpen(key, sealed, 'ctx')?.toString()).toBe('hello');
    expect(aeadOpen(key, sealed, 'other')).toBeNull();
    expect(aeadOpen(randomBytes(32), sealed, 'ctx')).toBeNull();
    expect(aeadOpen(key, 'short', 'ctx')).toBeNull();
  });

  it('canonical은 키 순서와 상관없이 같은 글자를 만든다', () => {
    expect(canonical({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(canonical({ a: [{ c: 3, d: 2 }], b: 1 }));
  });
});

describe('WebSocket', () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = null;
  });

  async function echoServer(maxMessageBytes?: number): Promise<number> {
    server = createServer();
    server.on('upgrade', (req, socket, head) => {
      const ws = acceptUpgrade(req, socket, head, { maxMessageBytes });
      ws?.on('message', (text: string) => ws.send(`echo:${text}`));
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    return typeof addr === 'object' && addr ? addr.port : 0;
  }

  const next = (ws: WsConnection): Promise<string> =>
    new Promise((r) => ws.once('message', (t: string) => r(t)));

  it('작은 글자, 64KB 넘는 글자, 한글을 그대로 주고받는다', async () => {
    const port = await echoServer();
    const ws = await connectWs(`ws://127.0.0.1:${port}`);
    for (const text of ['hi', '가'.repeat(30_000), 'x'.repeat(200_000)]) {
      const got = next(ws);
      ws.send(text);
      expect(await got).toBe(`echo:${text}`);
    }
    ws.close();
  });

  it('상한을 넘는 메시지는 1009로 닫는다', async () => {
    const port = await echoServer(1024);
    const ws = await connectWs(`ws://127.0.0.1:${port}`);
    const closed = new Promise<number>((r) => ws.once('close', (code: number) => r(code)));
    ws.send('x'.repeat(2048));
    expect(await closed).toBe(1009);
  });

  it('ws:// 아닌 주소는 거절하고 키가 없는 핸드셰이크는 400으로 닫는다', async () => {
    const port = await echoServer();
    await expect(connectWs(`http://127.0.0.1:${port}`)).rejects.toThrow('ws://');
    const status = await new Promise<number>((r) => {
      const req = httpRequest({
        port,
        host: '127.0.0.1',
        headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
      });
      req.on('response', (res) => r(res.statusCode ?? 0));
      req.on('error', () => r(-1));
      req.end();
    });
    expect(status).toBe(400);
  });
});

describe('데몬 잠금', () => {
  it('살아 있는 데몬의 잠금이면 거절하고 놓으면 다시 잡힌다', async () => {
    const root = tmp();
    const lock = await acquireDaemonLock(root, join(root, 'peer.sock'));
    await expect(acquireDaemonLock(root, join(root, 'peer.sock'))).rejects.toThrow(
      '이미 떠 있어요',
    );
    releaseDaemonLock(lock);
    expect(existsSync(lockPath(root))).toBe(false);
    releaseDaemonLock(await acquireDaemonLock(root, join(root, 'peer.sock')));
  });

  it('죽은 pid의 잠금은 치우고 잡는다', async () => {
    const root = tmp();
    // pid 2^22 근처는 거의 안 쓰인다. 쓰여 있으면 이 테스트는 건너뛴 셈이 된다
    writeFileSync(lockPath(root), `4194000\n${Date.now()}\n`, { mode: 0o600 });
    const lock = await acquireDaemonLock(root, join(root, 'peer.sock'));
    expect(readFileSync(lockPath(root), 'utf8').split('\n')[0]).toBe(String(process.pid));
    releaseDaemonLock(lock);
  });

  it('pid가 살아 있어도 오래됐고 소켓이 답하지 않으면 남은 잠금으로 본다', async () => {
    const root = tmp();
    writeFileSync(lockPath(root), `${process.pid}\n${Date.now() - 60_000}\n`, { mode: 0o600 });
    const lock = await acquireDaemonLock(root, join(root, 'peer.sock'));
    releaseDaemonLock(lock);
  });

  it('놓을 때 그 자리가 다른 데몬의 잠금으로 바뀌었으면 안 지운다', async () => {
    const root = tmp();
    const lock = await acquireDaemonLock(root, join(root, 'peer.sock'));
    rmSync(lockPath(root));
    writeFileSync(lockPath(root), 'other\n');
    releaseDaemonLock(lock);
    expect(readFileSync(lockPath(root), 'utf8')).toBe('other\n');
  });
});

describe('릴레이가 보낸 꼴이 틀린 프레임', () => {
  it('받아도 던지지 않고 버린다', async () => {
    const key = loadOrCreateMachineKey(tmp());
    const server = createServer();
    server.on('upgrade', (req, socket, head) => {
      const ws = acceptUpgrade(req, socket, head)!;
      ws.send(JSON.stringify({ t: 'challenge', nonce: 'n' }));
      ws.on('message', () => {
        for (const bad of [
          'null',
          '{"t":"recv","from":"x"}',
          '{"t":"join"}',
          '{"t":"ack","id":1}',
          '[]',
          '"x"',
        ]) {
          ws.send(bad);
        }
        ws.send(JSON.stringify({ t: 'welcome', roster: {}, online: null }));
        ws.send(JSON.stringify({ t: 'pending' }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const { RelayTransport } = await import('../../../src/peer/transport.js');
    const t = new RelayTransport({
      url: `ws://127.0.0.1:${port}`,
      team: key.id,
      key,
      mode: 'join',
      reconnect: false,
    });
    const welcomes: unknown[] = [];
    t.on('welcome', (r: unknown) => welcomes.push(r));
    await t.connect(null);
    expect(welcomes).toEqual([]);
    await t.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
});

describe('잠금 파일이 막 생겨 pid가 아직 없을 때', () => {
  it('젊은 빈 잠금은 살아 있는 것으로 보고 오래된 빈 잠금은 치운다', async () => {
    const root = tmp();
    writeFileSync(lockPath(root), '', { mode: 0o600 });
    await expect(acquireDaemonLock(root, join(root, 'peer.sock'))).rejects.toThrow('같이 뜨는 중');
    const old = new Date(Date.now() - 60_000);
    const { utimesSync } = await import('node:fs');
    utimesSync(lockPath(root), old, old);
    releaseDaemonLock(await acquireDaemonLock(root, join(root, 'peer.sock')));
  });
});
