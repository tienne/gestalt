import { isRawKey } from './keys.js';
import type { MachineKey } from './keys.js';
import { canonical, signText, verifyText } from './seal.js';

/**
 * 팀 명단. 관리자 키로 서명한 문서 하나이고 판(epoch) 번호가 있다.
 *
 * 팀 id는 팀을 만든 관리자의 기기 id다. 릴레이와 처음 명단을 받는 쪽은 이 id를 믿을
 * 출발점으로 삼는다. 판을 올린 명단은 지금 들고 있는 명단의 관리자가 서명해야 받는다.
 */

export type Role = 'admin' | 'member';

export interface RosterMember {
  person: string;
  /** 기기 id(Ed25519 공개키) */
  machineKey: string;
  /** X25519 공개키 */
  boxKey: string;
  role: Role;
  addedAt: number;
}

export interface Roster {
  v: 1;
  team: string;
  epoch: number;
  /** 팀 릴레이 주소. `ws://` 또는 `wss://` */
  relay: string;
  members: RosterMember[];
  issuedAt: number;
  /** 서명한 관리자 기기 id */
  issuer: string;
}

export interface SignedRoster {
  roster: Roster;
  sig: string;
}

const PERSON = /^[\p{L}\p{N}._-]{1,32}$/u;

export function isPersonName(value: unknown): value is string {
  return typeof value === 'string' && PERSON.test(value);
}

export function isRelayUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 512) return false;
  try {
    const u = new URL(value);
    return (u.protocol === 'ws:' || u.protocol === 'wss:') && u.host !== '';
  } catch {
    return false;
  }
}

/** 서명할 바이트. 목적 문자열을 앞에 붙여 다른 서명과 섞이지 않게 한다 */
function rosterSigned(roster: Roster): string {
  return `gestalt-peer-roster-v1\n${canonical(roster)}`;
}

export function signRoster(roster: Roster, key: MachineKey): SignedRoster {
  if (roster.issuer !== key.id) throw new Error('명단의 issuer와 서명하는 키가 달라요');
  return { roster, sig: signText(key, rosterSigned(roster)) };
}

export function memberOf(roster: Roster, machineKey: string): RosterMember | undefined {
  return roster.members.find((m) => m.machineKey === machineKey);
}

export function isAdmin(roster: Roster, machineKey: string): boolean {
  return memberOf(roster, machineKey)?.role === 'admin';
}

export type RosterVerdict = { ok: true } | { ok: false; reason: string };

/**
 * 새 명단을 받을지 정한다.
 *
 * - 지금 명단이 없으면 `anchor`(팀 id나 초대한 관리자 id)가 서명하고 그 키가 새 명단의
 *   관리자여야 한다.
 * - 지금 명단이 있으면 판이 더 높고 지금 명단의 관리자가 서명해야 한다. 같은 판은 다시
 *   받지 않는다 — 같은 판에 다른 내용을 서명해 돌리는 걸 막는다.
 */
export function checkRosterUpdate(
  current: SignedRoster | null,
  incoming: unknown,
  expect: { team: string; anchor: string },
): RosterVerdict {
  const shape = checkShape(incoming);
  if (!shape.ok) return shape;
  const { roster, sig } = incoming as SignedRoster;
  if (roster.team !== expect.team) return { ok: false, reason: '다른 팀의 명단이에요' };
  if (!verifyText(roster.issuer, rosterSigned(roster), sig)) {
    return { ok: false, reason: '명단 서명이 맞지 않아요' };
  }
  if (!isAdmin(roster, roster.issuer)) {
    return { ok: false, reason: '서명한 키가 새 명단의 관리자가 아니에요' };
  }
  if (!current) {
    if (roster.issuer !== expect.anchor) {
      return { ok: false, reason: '믿을 수 있는 관리자가 서명한 명단이 아니에요' };
    }
    return { ok: true };
  }
  if (roster.epoch <= current.roster.epoch) {
    return {
      ok: false,
      reason: `판이 낮거나 같아요 (지금 ${current.roster.epoch}, 받은 것 ${roster.epoch})`,
    };
  }
  if (!isAdmin(current.roster, roster.issuer)) {
    return { ok: false, reason: '지금 명단의 관리자가 서명하지 않았어요' };
  }
  return { ok: true };
}

function checkShape(value: unknown): RosterVerdict {
  const bad = (reason: string): RosterVerdict => ({ ok: false, reason: `명단 형식: ${reason}` });
  if (typeof value !== 'object' || value === null) return bad('객체가 아니에요');
  const { roster, sig } = value as Partial<SignedRoster>;
  if (typeof sig !== 'string') return bad('서명이 없어요');
  if (typeof roster !== 'object' || roster === null) return bad('명단이 없어요');
  if (roster.v !== 1) return bad('버전');
  if (!isRawKey(roster.team) || !isRawKey(roster.issuer)) return bad('키');
  if (!Number.isSafeInteger(roster.epoch) || roster.epoch < 1) return bad('판');
  if (!Number.isSafeInteger(roster.issuedAt)) return bad('시각');
  if (!isRelayUrl(roster.relay)) return bad('릴레이 주소');
  if (!Array.isArray(roster.members) || roster.members.length === 0) return bad('멤버');
  if (roster.members.length > 1000) return bad('멤버가 너무 많아요');
  const seen = new Set<string>();
  for (const m of roster.members) {
    if (typeof m !== 'object' || m === null) return bad('멤버');
    if (!isPersonName(m.person)) return bad('이름');
    if (!isRawKey(m.machineKey) || !isRawKey(m.boxKey)) return bad('멤버 키');
    if (m.role !== 'admin' && m.role !== 'member') return bad('역할');
    if (!Number.isSafeInteger(m.addedAt)) return bad('추가 시각');
    if (seen.has(m.machineKey)) return bad('같은 기기가 두 번 있어요');
    seen.add(m.machineKey);
  }
  return { ok: true };
}

/** 같은 내용을 다시 서명하지 않고 한 판 올린 새 명단을 만든다 */
export function nextRoster(
  current: Roster,
  members: RosterMember[],
  issuer: string,
  now = Date.now(),
): Roster {
  return { ...current, epoch: current.epoch + 1, members, issuedAt: now, issuer };
}

/**
 * 초대 코드. 관리자가 만들어 사람에게 건넨다. 1회용이고 24시간 유효하다.
 * `secret`은 관리자 데몬만 들고 있다가 join 요청의 증명을 맞춰 본다.
 */
export interface Invite {
  v: 1;
  team: string;
  relay: string;
  /** 초대한 관리자 기기 id와 X25519 공개키. join 요청을 이 키에 봉인한다 */
  admin: string;
  adminBox: string;
  id: string;
  secret: string;
  person: string;
  expiresAt: number;
}

const INVITE_PREFIX = 'gpi1.';

export function encodeInvite(invite: Invite): string {
  return INVITE_PREFIX + Buffer.from(JSON.stringify(invite), 'utf8').toString('base64url');
}

export function decodeInvite(code: string): Invite {
  const trimmed = code.trim();
  if (!trimmed.startsWith(INVITE_PREFIX)) throw new Error('초대 코드 꼴이 아니에요');
  let v: Partial<Invite>;
  try {
    v = JSON.parse(Buffer.from(trimmed.slice(INVITE_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw new Error('초대 코드를 못 읽었어요');
  }
  if (
    v.v !== 1 ||
    !isRawKey(v.team) ||
    !isRawKey(v.admin) ||
    !isRawKey(v.adminBox) ||
    !isRelayUrl(v.relay) ||
    typeof v.id !== 'string' ||
    !/^[A-Za-z0-9_-]{8,64}$/.test(v.id) ||
    typeof v.secret !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(v.secret) ||
    !isPersonName(v.person) ||
    !Number.isSafeInteger(v.expiresAt)
  ) {
    throw new Error('초대 코드 내용이 맞지 않아요');
  }
  return v as Invite;
}

/** join 요청에 싣는 증명. 초대 코드를 가진 사람만 만든다 */
export function joinProofText(inviteId: string, machineKey: string, boxKey: string): string {
  return canonical({ p: 'gestalt-peer-join-v1', invite: inviteId, key: machineKey, box: boxKey });
}

/**
 * 공유 링크. `gestalt://peer/<릴레이 호스트>/<공유 id>#<공유 키>`.
 * 공유 키는 `#` 뒤라 릴레이로 안 간다.
 */
export interface ShareLink {
  relayHost: string;
  shareId: string;
  shareKey: string;
}

const LINK = /^gestalt:\/\/peer\/([^/#?\s]{1,255})\/([A-Za-z0-9_-]{1,64})#([A-Za-z0-9_-]{43})$/;

export function formatShareLink(relayUrl: string, shareId: string, shareKey: string): string {
  return `gestalt://peer/${new URL(relayUrl).host}/${shareId}#${shareKey}`;
}

export function parseShareLink(link: string): ShareLink {
  const m = LINK.exec(link.trim());
  if (!m) throw new Error('공유 링크 꼴이 아니에요 (gestalt://peer/<릴레이>/<공유 id>#<키>)');
  return { relayHost: m[1]!, shareId: m[2]!, shareKey: m[3]! };
}
