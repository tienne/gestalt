import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadOrCreateMachineKey } from '../../../src/peer/keys.js';
import type { MachineKey } from '../../../src/peer/keys.js';
import {
  checkRosterUpdate,
  decodeInvite,
  encodeInvite,
  formatShareLink,
  nextRoster,
  parseShareLink,
  signRoster,
} from '../../../src/peer/roster.js';
import type { Roster, SignedRoster } from '../../../src/peer/roster.js';
import { PeerNetwork } from '../../../src/peer/network.js';
import { PeerState } from '../../../src/peer/state.js';

let dirs: string[] = [];
const keyIn = (): MachineKey => {
  const d = mkdtempSync(join(tmpdir(), 'peer-roster-'));
  dirs.push(d);
  return loadOrCreateMachineKey(d);
};

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function firstRoster(admin: MachineKey, member: MachineKey): Roster {
  return {
    v: 1,
    team: admin.id,
    epoch: 1,
    relay: 'ws://relay.test:8443',
    members: [
      { person: 'tienne', machineKey: admin.id, boxKey: admin.boxKey, role: 'admin', addedAt: 1 },
      { person: 'alice', machineKey: member.id, boxKey: member.boxKey, role: 'member', addedAt: 2 },
    ],
    issuedAt: 3,
    issuer: admin.id,
  };
}

describe('checkRosterUpdate', () => {
  let admin: MachineKey;
  let member: MachineKey;
  let r1: SignedRoster;
  let expectTeam: { team: string; anchor: string };

  beforeEach(() => {
    admin = keyIn();
    member = keyIn();
    r1 = signRoster(firstRoster(admin, member), admin);
    expectTeam = { team: admin.id, anchor: admin.id };
  });

  it('믿을 관리자가 서명한 첫 명단과 판을 올린 명단을 받는다', () => {
    expect(checkRosterUpdate(null, r1, expectTeam)).toEqual({ ok: true });
    const r2 = signRoster(nextRoster(r1.roster, r1.roster.members.slice(0, 1), admin.id), admin);
    expect(checkRosterUpdate(r1, r2, expectTeam)).toEqual({ ok: true });
  });

  it('서명이 안 맞으면 버린다', () => {
    const tampered: SignedRoster = {
      ...r1,
      roster: {
        ...r1.roster,
        members: r1.roster.members.map((m) => ({ ...m, role: 'admin' as const })),
      },
    };
    expect(checkRosterUpdate(null, tampered, expectTeam)).toMatchObject({
      ok: false,
      reason: '명단 서명이 맞지 않아요',
    });
  });

  it('판이 낮거나 같으면 버린다', () => {
    const r2 = signRoster(nextRoster(r1.roster, r1.roster.members, admin.id), admin);
    expect(checkRosterUpdate(r2, r1, expectTeam)).toMatchObject({ ok: false });
    expect(checkRosterUpdate(r2, r1, expectTeam)).toMatchObject({
      reason: expect.stringContaining('판이 낮거나 같아요'),
    });
    // 같은 판에 내용만 바꿔 다시 서명한 것도 안 받는다
    const same = signRoster({ ...r2.roster, members: r2.roster.members.slice(0, 1) }, admin);
    expect(checkRosterUpdate(r2, same, expectTeam)).toMatchObject({ ok: false });
  });

  it('관리자가 아닌 기기가 스스로 관리자로 올려 서명한 판은 버린다', () => {
    const forged = signRoster(
      nextRoster(
        r1.roster,
        r1.roster.members.map((m) => ({ ...m, role: 'admin' as const })),
        member.id,
      ),
      member,
    );
    expect(checkRosterUpdate(r1, forged, expectTeam)).toMatchObject({
      ok: false,
      reason: '지금 명단의 관리자가 서명하지 않았어요',
    });
    // 명단이 없을 때도 출발점 키가 아니면 안 받는다
    expect(checkRosterUpdate(null, forged, expectTeam)).toMatchObject({ ok: false });
  });

  it('다른 팀 명단과 형식이 틀린 명단은 버린다', () => {
    expect(checkRosterUpdate(null, r1, { team: member.id, anchor: admin.id })).toMatchObject({
      ok: false,
      reason: '다른 팀의 명단이에요',
    });
    expect(
      checkRosterUpdate(
        null,
        { roster: { ...r1.roster, relay: 'http://x' }, sig: r1.sig },
        expectTeam,
      ),
    ).toMatchObject({
      ok: false,
    });
    expect(checkRosterUpdate(null, null, expectTeam)).toMatchObject({ ok: false });
    const dup = signRoster(
      { ...r1.roster, members: [r1.roster.members[0]!, r1.roster.members[0]!] },
      admin,
    );
    expect(checkRosterUpdate(null, dup, expectTeam)).toMatchObject({ ok: false });
  });
});

describe('초대 코드와 공유 링크', () => {
  it('초대 코드를 그대로 되읽고 꼴이 틀리면 던진다', () => {
    const admin = keyIn();
    const invite = {
      v: 1 as const,
      team: admin.id,
      relay: 'wss://relay.test',
      admin: admin.id,
      adminBox: admin.boxKey,
      id: 'abcdefghijkl',
      secret: 'A'.repeat(43),
      person: '앨리스',
      expiresAt: 123,
    };
    expect(decodeInvite(encodeInvite(invite))).toEqual(invite);
    expect(() => decodeInvite('gpi1.@@@')).toThrow();
    expect(() => decodeInvite('nope')).toThrow('초대 코드 꼴이 아니에요');
  });

  it('공유 링크의 키는 # 뒤에 있고 호스트에 포트가 붙는다', () => {
    const link = formatShareLink('ws://10.0.0.5:8443', 'abc_DEF-1', 'k'.repeat(43));
    expect(link).toBe(`gestalt://peer/10.0.0.5:8443/abc_DEF-1#${'k'.repeat(43)}`);
    expect(parseShareLink(link)).toEqual({
      relayHost: '10.0.0.5:8443',
      shareId: 'abc_DEF-1',
      shareKey: 'k'.repeat(43),
    });
    expect(() => parseShareLink('gestalt://peer/host/id')).toThrow();
  });
});

describe('PeerNetwork 명단 받기', () => {
  it('릴레이가 돌린 명단이라도 서명이 틀리거나 판이 낮으면 버리고 감사 로그에 남긴다', () => {
    const admin = keyIn();
    const member = keyIn();
    const dbPath = resolve('.gestalt-test', `peer-${randomUUID()}.db`);
    const state = new PeerState(dbPath);
    const r1 = signRoster(firstRoster(admin, member), admin);
    state.setTeam({ team: admin.id, relay: r1.roster.relay, person: 'alice', anchor: admin.id });
    state.setRoster(r1);
    const network = new PeerNetwork({ state, key: member, lookupShare: () => undefined });
    try {
      const apply = (r: SignedRoster): void =>
        (network as unknown as { onRemoteRoster(r: SignedRoster): void }).onRemoteRoster(r);

      const forged = signRoster(
        nextRoster(
          r1.roster,
          r1.roster.members.map((m) => ({ ...m, role: 'admin' as const })),
          member.id,
        ),
        member,
      );
      apply(forged);
      const r2 = signRoster(nextRoster(r1.roster, r1.roster.members, admin.id), admin);
      apply(r2);
      apply(r1);

      expect(state.getRoster()!.roster.epoch).toBe(2);
      const log = state.auditLog().map((r) => [r.action, JSON.parse(r.detail!).reason ?? null]);
      expect(log).toEqual([
        ['roster_reject', '지금 명단의 관리자가 서명하지 않았어요'],
        ['roster_accept', null],
        ['roster_reject', '판이 낮거나 같아요 (지금 2, 받은 것 1)'],
      ]);
    } finally {
      state.close();
      rmSync(dbPath, { force: true });
    }
  });
});
