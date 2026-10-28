import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateMachineKey } from '../../../src/peer/keys.js';
import type { MachineKey } from '../../../src/peer/keys.js';
import { RelayServer } from '../../../src/peer/relay.js';
import { nextRoster, signRoster } from '../../../src/peer/roster.js';
import type { SignedRoster } from '../../../src/peer/roster.js';
import { signText } from '../../../src/peer/seal.js';
import { RelayTransport } from '../../../src/peer/transport.js';
import { helloSigned } from '../../../src/peer/wire.js';
import { connectWs } from '../../../src/peer/ws.js';
import { MESSAGE_RECEIVE_LIMIT } from '../../../src/peer/message.js';

describe('RelayServer', () => {
  let dir: string;
  let admin: MachineKey;
  let alice: MachineKey;
  let relay: RelayServer;
  let url: string;
  let r1: SignedRoster;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-relay-'));
    admin = loadOrCreateMachineKey(mkdtempSync(join(dir, 'a-')));
    alice = loadOrCreateMachineKey(mkdtempSync(join(dir, 'b-')));
    r1 = signRoster(
      {
        v: 1,
        team: admin.id,
        epoch: 1,
        relay: 'ws://127.0.0.1:1',
        members: [
          {
            person: 'tienne',
            machineKey: admin.id,
            boxKey: admin.boxKey,
            role: 'admin',
            addedAt: 1,
          },
          {
            person: 'alice',
            machineKey: alice.id,
            boxKey: alice.boxKey,
            role: 'member',
            addedAt: 1,
          },
        ],
        issuedAt: 1,
        issuer: admin.id,
      },
      admin,
    );
    relay = new RelayServer({
      team: admin.id,
      host: '127.0.0.1',
      port: 0,
      rosterFile: join(dir, 'roster.json'),
    });
    url = `ws://127.0.0.1:${await relay.start()}`;
  });

  afterEach(async () => {
    await relay.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  /** hello 하나를 손으로 보내고 첫 답을 받는다 */
  async function rawHello(
    make: (nonce: string) => Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const ws = await connectWs(url);
    return new Promise((resolve) => {
      ws.on('message', (text: string) => {
        const frame = JSON.parse(text) as Record<string, unknown>;
        if (frame.t === 'challenge') ws.send(JSON.stringify(make(String(frame.nonce))));
        else {
          resolve(frame);
          ws.close();
        }
      });
    });
  }

  it('서명이 안 맞는 hello와 다른 팀 hello는 거절한다', async () => {
    const badSig = await rawHello((nonce) => ({
      t: 'hello',
      team: admin.id,
      key: alice.id,
      mode: 'member',
      // 다른 nonce에 서명한 걸 들고 온다
      sig: signText(alice, helloSigned(admin.id, nonce + 'x', 'member')),
      roster: r1,
    }));
    expect(badSig).toMatchObject({ t: 'error', code: 'bad_signature' });

    const wrongTeam = await rawHello((nonce) => ({
      t: 'hello',
      team: alice.id,
      key: alice.id,
      mode: 'member',
      sig: signText(alice, helloSigned(alice.id, nonce, 'member')),
    }));
    expect(wrongTeam).toMatchObject({ t: 'error', code: 'wrong_team' });
  });

  it('명단을 아직 못 받은 릴레이는 member를 안 받고 관리자가 들고 온 명단부터 받는다', async () => {
    const t = new RelayTransport({ url, team: admin.id, key: alice, reconnect: false });
    await expect(t.connect(null)).rejects.toThrow('명단을 못 받았어요');
    await t.close();

    const a = new RelayTransport({ url, team: admin.id, key: admin, reconnect: false });
    await a.connect(r1);
    expect(relay.epoch).toBe(1);
    expect(statSync(join(dir, 'roster.json')).mode & 0o777).toBe(0o600);
    await a.close();
  });

  it('다시 뜬 릴레이는 남겨 둔 명단보다 낮은 판을 안 받는다', async () => {
    const a = new RelayTransport({ url, team: admin.id, key: admin, reconnect: false });
    await a.connect(r1);
    const r2 = signRoster(nextRoster(r1.roster, r1.roster.members.slice(0, 1), admin.id), admin);
    a.publishRoster(r2);
    await new Promise((r) => setTimeout(r, 50));
    expect(relay.epoch).toBe(2);
    await a.close();
    await relay.stop();

    relay = new RelayServer({
      team: admin.id,
      host: '127.0.0.1',
      port: 0,
      rosterFile: join(dir, 'roster.json'),
    });
    url = `ws://127.0.0.1:${await relay.start()}`;
    expect(relay.epoch).toBe(2);
    // alice가 빠지기 전 판 1을 들고 와도 받지 않고 member로도 안 받는다
    const t = new RelayTransport({ url, team: admin.id, key: alice, reconnect: false });
    await expect(t.connect(r1)).rejects.toThrow('명단에 없는');
    expect(relay.epoch).toBe(2);
    await t.close();
  });
  it('받는 기기가 오프라인이면 queue로 보낸 것만 들고 있다가 붙을 때 넘기고 빠진 기기 몫은 버린다', async () => {
    const a = new RelayTransport({ url, team: admin.id, key: admin, reconnect: false });
    await a.connect(r1);
    await expect(a.send(alice.id, Buffer.from('no-queue'))).rejects.toThrow('안 붙어 있어요');
    expect(await a.send(alice.id, Buffer.from('held-1'), { queue: true })).toBe('queued');
    expect(relay.queuedSends).toBe(1);

    const b = new RelayTransport({ url, team: admin.id, key: alice, reconnect: false });
    const got: string[] = [];
    b.onReceive((from, data) =>
      got.push(`${from === admin.id ? 'admin' : from}:${Buffer.from(data).toString()}`),
    );
    await b.connect(r1);
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toEqual(['admin:held-1']);
    expect(relay.queuedSends).toBe(0);
    await b.close();

    // alice가 오프라인일 때 쌓인 것은 alice를 빼면 버린다
    await new Promise((r) => setTimeout(r, 50));
    expect(await a.send(alice.id, Buffer.from('held-2'), { queue: true })).toBe('queued');
    a.publishRoster(
      signRoster(nextRoster(r1.roster, r1.roster.members.slice(0, 1), admin.id), admin),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(relay.queuedSends).toBe(0);
    await a.close();
  });
  it('오프라인 기기에게 한 사람이 들고 있게 하는 양은 주인 쪽 수신 한도까지다', async () => {
    const a = new RelayTransport({ url, team: admin.id, key: admin, reconnect: false });
    await a.connect(r1);
    for (let i = 0; i < MESSAGE_RECEIVE_LIMIT; i++) {
      expect(await a.send(alice.id, Buffer.from(`m${i}`), { queue: true })).toBe('queued');
    }
    await expect(a.send(alice.id, Buffer.from('over'), { queue: true })).rejects.toThrow(
      'queue_full',
    );
    expect(relay.queuedSends).toBe(MESSAGE_RECEIVE_LIMIT);
    await a.close();
  });
});
