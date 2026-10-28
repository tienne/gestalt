import { randomBytes } from 'node:crypto';
import type { ShareFeed, ShareFrame } from './feed.js';
import type { MachineKey } from './keys.js';
import { isRawKey } from './keys.js';
import { MirrorFeed } from './mirror.js';
import {
  checkRosterUpdate,
  decodeInvite,
  encodeInvite,
  formatShareLink,
  isAdmin,
  isPersonName,
  isRelayUrl,
  joinProofText,
  memberOf,
  nextRoster,
  parseShareLink,
  signRoster,
} from './roster.js';
import type { Roster, RosterMember, SignedRoster } from './roster.js';
import {
  aeadOpen,
  aeadSeal,
  canonical,
  deriveKey,
  hmac,
  openBox,
  safeEqual,
  sealBox,
} from './seal.js';
import type { PeerState, TeamConfig } from './state.js';
import { RelayTransport } from './transport.js';
import type { RelayTransportOptions, TransportState } from './transport.js';
import { MAX_VIEWERS_PER_SHARE, REPLAY_CHUNK_BYTES } from './viewer.js';
import { errMessage } from './errors.js';
import type { InboxResult } from './inbox.js';
import {
  isMessageId,
  MESSAGE_RECEIVE_LIMIT,
  newMessageId,
  plainLabel,
  RateLimiter,
  sanitizeMessageBody,
} from './message.js';
import type { MessageOrigin, MessageStatus } from './message.js';
import { RelaySendError } from './transport.js';

/** 주인 데몬이 내 공유를 넘겨줄 때 쓰는 것 */
export interface OwnedShare {
  stream: ShareFeed;
  shareKey: string;
  /**
   * 메시지를 주인 세션 인박스에 쓴다. 쓴 뒤 그 메시지가 대화 기록에 보이면 onSeen을 부른다.
   * 없으면 이 공유는 메시지를 못 받는다.
   */
  deliver?(m: InboundMessage, onSeen: () => void): Promise<InboxResult>;
}

/** 주인 데몬이 받아 검사를 마친 메시지 */
export interface InboundMessage {
  id: string;
  share: string;
  from: string;
  person: string;
  origin: MessageOrigin;
  /** sanitizeMessageBody를 거친 본문 */
  body: string;
}

export interface PeerNetworkOptions {
  state: PeerState;
  key: MachineKey;
  lookupShare(id: string): OwnedShare | undefined;
  /** 테스트가 다시 붙는 간격을 줄일 때 쓴다 */
  transport?: Partial<
    Pick<RelayTransportOptions, 'minBackoffMs' | 'maxBackoffMs' | 'ackTimeoutMs'>
  >;
  /** 원격 구독 하나의 릴레이 소켓에 밀린 양이 이걸 넘으면 그 구독을 끊는다 */
  maxBufferedBytes?: number;
}

export interface TeamStatus {
  team: string;
  person: string;
  relay: string;
  epoch: number;
  role: 'admin' | 'member' | null;
  connection: TransportState;
  remoteViewers: number;
  watches: number;
}

export interface MemberInfo {
  person: string;
  machineKey: string;
  role: 'admin' | 'member';
  addedAt: number;
  online: boolean;
  me: boolean;
}

export interface WatchInfo {
  id: string;
  share: string;
  owner: string;
  feed: MirrorFeed;
  token: string;
}

/** 초대 유효 시간. 설계 원문의 24시간 */
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
/** 원격 구독 하나가 릴레이 소켓에 밀어 둘 수 있는 양 */
export const MAX_REMOTE_BUFFERED_BYTES = 8 * 1024 * 1024;
const WATCH_TIMEOUT_MS = 10_000;
const WATCH_NONCE_TTL_MS = 10 * 60 * 1000;
const MAX_SEEN_WATCH = 4096;
const MAX_SEEN_MESSAGES = 8192;

/** 데몬끼리 봉인해 주고받는 것. box 안에 든다 */
type BoxMessage =
  | { t: 'watch'; share: string; nonce: string; proof: string; after: number }
  | { t: 'watch_ok'; share: string; nonce: string; sub: string; salt: string }
  | { t: 'watch_err'; share: string; nonce: string; reason: string }
  | { t: 'watch_end'; share: string; sub: string; reason: string }
  | { t: 'unwatch'; share: string; sub: string }
  | { t: 'join'; invite: string; proof: string; box: string }
  | { t: 'msg'; share: string; id: string; body: string; origin: MessageOrigin; proof: string }
  | { t: 'msg_status'; share: string; id: string; status: MessageStatus; reason?: string };

/** 공유 스트림 봉투. 공유 세션 키로 연다. share와 sub는 릴레이도 보는 라우팅 정보다 */
interface StreamEnvelope {
  k: 's';
  share: string;
  sub: string;
  d: string;
}

/** 주인 쪽. 원격으로 보는 사람 한 명 */
interface RemoteSub {
  sub: string;
  share: string;
  watcher: string;
  key: Buffer;
  stream: ShareFeed;
  unsubscribe: () => void;
  ended: boolean;
}

/** 보는 쪽. 원격 공유 하나 */
interface Watch {
  id: string;
  token: string;
  share: string;
  shareKey: Buffer;
  owner: string;
  feed: MirrorFeed;
  sub?: string;
  key?: Buffer;
  /** 지금 기다리는 watch 요청 */
  pending?: {
    nonce: string;
    resolve: () => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  };
}

export class PeerNetworkError extends Error {}

/**
 * 팀, 명단, 릴레이 통로, 원격 공유를 묶는다. 데몬이 하나 들고 있다.
 *
 * 주인 쪽: 보는 사람이 링크의 공유 키로 증명을 보내면 명단을 확인하고 구독마다 새 공유
 * 세션 키를 정해 그 키로 봉인한 프레임을 흘린다. 세션 키는 링크의 공유 키와 주인이 고른
 * salt로 만든다. salt는 보는 사람 X25519 키에 봉인해 보내므로 링크만 가진 사람도,
 * 릴레이도 못 연다.
 *
 * 보는 쪽: 받은 프레임을 MirrorFeed에 옮겨 로컬 뷰어로 보여준다.
 */
export class PeerNetwork {
  private transport: RelayTransport | null = null;
  private team: TeamConfig | null;
  private roster: SignedRoster | null;
  private subs = new Map<string, RemoteSub>();
  private watches = new Map<string, Watch>();
  private online = new Set<string>();
  private announced: string[] = [];
  /** 최근 받은 watch 요청의 `기기|nonce`와 받은 시각. 릴레이가 옛 요청을 다시 보내면 거절한다 */
  private seenWatch = new Map<string, number>();
  /** 받은 메시지의 `기기|id`. 릴레이가 같은 봉인을 다시 보내면 버린다 */
  private seenMessages = new Set<string>();
  private sendLimiter = new RateLimiter();
  /** 보는 쪽이 12건으로 먼저 막는다. 주인 쪽은 릴레이에 쌓였다 한꺼번에 온 것도 받게 넉넉하다 */
  private receiveLimiter = new RateLimiter(MESSAGE_RECEIVE_LIMIT);
  private readonly maxBuffered: number;

  constructor(private readonly options: PeerNetworkOptions) {
    this.team = options.state.getTeam();
    this.roster = options.state.getRoster();
    this.maxBuffered = options.maxBufferedBytes ?? MAX_REMOTE_BUFFERED_BYTES;
  }

  get key(): MachineKey {
    return this.options.key;
  }

  /** 팀이 있으면 릴레이에 붙기 시작한다. 첫 접속을 기다리지 않는다 */
  start(): void {
    if (this.team && this.roster && memberOf(this.roster.roster, this.key.id)) this.connect();
  }

  async stop(): Promise<void> {
    for (const s of [...this.subs.values()]) this.endSub(s, 'daemon_stop', false);
    for (const w of [...this.watches.values()]) this.closeWatch(w, 'daemon_stop');
    const t = this.transport;
    this.transport = null;
    await t?.close();
  }

  status(): TeamStatus | null {
    if (!this.team || !this.roster) return null;
    return {
      team: this.team.team,
      person: this.team.person,
      relay: this.roster.roster.relay,
      epoch: this.roster.roster.epoch,
      role: memberOf(this.roster.roster, this.key.id)?.role ?? null,
      connection: this.transport?.state ?? 'idle',
      remoteViewers: this.subs.size,
      watches: this.watches.size,
    };
  }

  members(): MemberInfo[] {
    if (!this.roster) throw new PeerNetworkError('아직 팀에 안 들었어요');
    return this.roster.roster.members.map((m) => ({
      person: m.person,
      machineKey: m.machineKey,
      role: m.role,
      addedAt: m.addedAt,
      online:
        m.machineKey === this.key.id
          ? this.transport?.state === 'online'
          : this.online.has(m.machineKey),
      me: m.machineKey === this.key.id,
    }));
  }

  /** 팀을 만들고 첫 관리자가 된다 */
  init(person: string, relay: string): TeamStatus {
    if (this.team) throw new PeerNetworkError(`이미 팀에 들어 있어요 (${this.team.team})`);
    if (!isPersonName(person))
      throw new PeerNetworkError('이름은 글자, 숫자, `.`, `_`, `-`로 32자까지예요');
    if (!isRelayUrl(relay)) throw new PeerNetworkError('--relay는 ws:// 또는 wss:// 주소예요');
    const now = Date.now();
    const roster: Roster = {
      v: 1,
      team: this.key.id,
      epoch: 1,
      relay,
      members: [
        { person, machineKey: this.key.id, boxKey: this.key.boxKey, role: 'admin', addedAt: now },
      ],
      issuedAt: now,
      issuer: this.key.id,
    };
    const team: TeamConfig = { team: this.key.id, relay, person, anchor: this.key.id };
    this.team = team;
    this.options.state.setTeam(team);
    this.applyRoster(signRoster(roster, this.key), 'local');
    this.options.state.audit('team_init', null, JSON.stringify({ team: team.team, relay }));
    this.connect();
    return this.status()!;
  }

  /** 1회용 초대 코드를 만든다. 관리자만 */
  invite(person: string, now = Date.now()): { code: string; expiresAt: number } {
    const roster = this.requireAdmin();
    if (!isPersonName(person))
      throw new PeerNetworkError('이름은 글자, 숫자, `.`, `_`, `-`로 32자까지예요');
    const id = randomBytes(9).toString('base64url');
    const secret = randomBytes(32).toString('base64url');
    const expiresAt = now + INVITE_TTL_MS;
    this.options.state.insertInvite({ id, secret, person, createdAt: now, expiresAt });
    this.options.state.audit('invite_create', null, JSON.stringify({ invite: id, person }));
    const code = encodeInvite({
      v: 1,
      team: roster.team,
      relay: roster.relay,
      admin: this.key.id,
      adminBox: this.key.boxKey,
      id,
      secret,
      person,
      expiresAt,
    });
    return { code, expiresAt };
  }

  /**
   * 초대를 받는다. 릴레이에 join 모드로 붙어 초대한 관리자에게 봉인한 요청을 넘기고 관리자가
   * 나를 넣은 명단에 서명해 돌릴 때까지 기다린다.
   */
  async join(code: string, timeoutMs = 60_000): Promise<TeamStatus> {
    const invite = decodeInvite(code);
    if (this.team && this.roster && memberOf(this.roster.roster, this.key.id)) {
      throw new PeerNetworkError(`이미 팀에 들어 있어요 (${this.team.team})`);
    }
    if (Date.now() >= invite.expiresAt) throw new PeerNetworkError('초대 코드가 만료됐어요');

    const t = new RelayTransport({
      url: invite.relay,
      team: invite.team,
      key: this.key,
      mode: 'join',
      reconnect: false,
    });
    try {
      const roster = await new Promise<SignedRoster>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new PeerNetworkError(
                '관리자가 아직 명단에 서명하지 않았어요. 관리자 데몬이 떠 있는지 확인하고 다시 join해 주세요',
              ),
            ),
          timeoutMs,
        );
        timer.unref();
        const done = (fn: () => void): void => {
          clearTimeout(timer);
          fn();
        };
        t.on('welcome', (incoming: SignedRoster) => {
          const verdict = checkRosterUpdate(null, incoming, {
            team: invite.team,
            anchor: invite.admin,
          });
          if (!verdict.ok) return done(() => reject(new PeerNetworkError(verdict.reason)));
          if (!memberOf(incoming.roster, this.key.id)) {
            return done(() => reject(new PeerNetworkError('받은 명단에 이 기기가 없어요')));
          }
          done(() => resolve(incoming));
        });
        t.on('pending', () => {
          const body: BoxMessage = {
            t: 'join',
            invite: invite.id,
            proof: hmac(
              Buffer.from(invite.secret, 'base64url'),
              joinProofText(invite.id, this.key.id, this.key.boxKey),
            ),
            box: this.key.boxKey,
          };
          const box = sealBox(this.key, invite.admin, invite.adminBox, JSON.stringify(body));
          t.sendJoin(invite.admin, Buffer.from(JSON.stringify(box)));
        });
        t.on('state', (s: TransportState) => {
          if (s === 'offline' || s === 'removed') {
            done(() => reject(new PeerNetworkError('릴레이 연결이 끊겨 join을 못 마쳤어요')));
          }
        });
        t.connect(null).catch((err: unknown) => done(() => reject(err as Error)));
      });

      const me = memberOf(roster.roster, this.key.id)!;
      const team: TeamConfig = {
        team: invite.team,
        relay: roster.roster.relay,
        person: me.person,
        anchor: invite.admin,
      };
      // 다른 팀에서 넘어오면 옛 명단을 버린다. 판 비교는 같은 팀 안에서만 뜻이 있다
      if (this.team && this.team.team !== team.team) this.roster = null;
      this.team = team;
      this.options.state.setTeam(team);
      this.applyRoster(roster, 'join');
      this.options.state.audit(
        'team_join',
        null,
        JSON.stringify({ team: team.team, person: me.person }),
      );
    } finally {
      await t.close();
    }
    // 명단에서 빠져 removed로 굳은 통로나 옛 팀 통로는 다시 안 쓴다
    const old = this.transport;
    this.transport = null;
    await old?.close();
    this.connect();
    return this.status()!;
  }

  /** 사람 이름으로 그 사람의 기기를 모두 뺀다. 관리자만 */
  remove(person: string): { removed: number; epoch: number } {
    const roster = this.requireAdmin();
    const me = memberOf(roster, this.key.id)!;
    if (person === me.person) throw new PeerNetworkError('자기 자신은 뺄 수 없어요');
    const keep = roster.members.filter((m) => m.person !== person);
    const removed = roster.members.length - keep.length;
    if (removed === 0) throw new PeerNetworkError(`명단에 없는 이름이에요: ${person}`);
    const signed = signRoster(nextRoster(roster, keep, this.key.id), this.key);
    this.applyRoster(signed, 'local');
    this.options.state.audit(
      'member_remove',
      null,
      JSON.stringify({ person, removed, epoch: signed.roster.epoch }),
    );
    this.transport?.publishRoster(signed);
    return { removed, epoch: signed.roster.epoch };
  }

  /** 내 공유의 링크. 팀이 없으면 undefined */
  linkFor(shareId: string, shareKey: string): string | undefined {
    if (!this.roster) return undefined;
    return formatShareLink(this.roster.roster.relay, shareId, shareKey);
  }

  /** 지금 연 공유 id 전부를 릴레이에 알린다 */
  announce(shareIds: string[]): void {
    this.announced = [...shareIds];
    this.transport?.announce(this.announced);
  }

  lookupWatch(id: string):
    | {
        stream: ShareFeed;
        token: string;
        send(text: string): Promise<{ ok: true; id: string } | { ok: false; error: string }>;
      }
    | undefined {
    const w = this.watches.get(id);
    if (!w) return undefined;
    return {
      stream: w.feed,
      token: w.token,
      send: (text) =>
        this.sendMessage(id, text, 'human').then(
          (r) => ({ ok: true as const, id: r.id }),
          (err: unknown) => ({ ok: false as const, error: errMessage(err) }),
        ),
    };
  }

  listWatches(): { id: string; share: string; owner: string; status: string; events: number }[] {
    return [...this.watches.values()].map((w) => ({
      id: w.id,
      share: w.share,
      owner: w.feed.ownerPerson,
      status: w.feed.currentStatus,
      events: w.feed.eventCount,
    }));
  }

  /** 링크로 원격 공유를 보기 시작한다. 주인 데몬이 받아 줄 때까지 기다린다 */
  async watch(link: string): Promise<WatchInfo> {
    const parsed = parseShareLink(link);
    const roster = this.roster;
    if (!this.team || !roster)
      throw new PeerNetworkError(
        '아직 팀에 안 들었어요. `gestalt peer join <코드>`를 먼저 해 주세요',
      );
    const relayHost = new URL(roster.roster.relay).host;
    if (parsed.relayHost !== relayHost) {
      throw new PeerNetworkError(
        `우리 팀 릴레이(${relayHost})의 링크가 아니에요: ${parsed.relayHost}`,
      );
    }
    const t = this.transport;
    if (!t || t.state !== 'online')
      throw new PeerNetworkError(`릴레이에 안 붙어 있어요 (${t?.state ?? 'idle'})`);
    const owner = await t.resolveShare(parsed.shareId);
    if (!owner)
      throw new PeerNetworkError(
        '그 공유를 연 기기가 릴레이에 없어요. 주인 데몬이 오프라인이거나 공유가 닫혔어요',
      );
    const ownerMember = memberOf(roster.roster, owner);
    if (!ownerMember) throw new PeerNetworkError('공유를 연 기기가 명단에 없어요');
    if (owner === this.key.id)
      throw new PeerNetworkError('내 공유는 `gestalt peer shares`의 주소로 봐요');

    const id = randomBytes(6).toString('base64url');
    const w: Watch = {
      id,
      token: randomBytes(24).toString('base64url'),
      share: parsed.shareId,
      shareKey: Buffer.from(parsed.shareKey, 'base64url'),
      owner,
      feed: new MirrorFeed(id, owner, ownerMember.person, parsed.shareId),
    };
    this.watches.set(id, w);
    try {
      await this.requestWatch(w);
    } catch (err) {
      this.watches.delete(id);
      w.feed.close('watch_failed');
      throw err;
    }
    this.options.state.audit(
      'watch_open',
      null,
      JSON.stringify({ watch: id, share: w.share, owner: ownerMember.person }),
    );
    return { id, share: w.share, owner: ownerMember.person, feed: w.feed, token: w.token };
  }

  unwatch(id: string): boolean {
    const w = this.watches.get(id);
    if (!w) return false;
    if (w.sub) this.sendBox(w.owner, { t: 'unwatch', share: w.share, sub: w.sub });
    this.closeWatch(w, 'unwatch');
    return true;
  }

  // ── 릴레이 ──────────────────────────────────────────────

  private connect(): void {
    if (this.transport || !this.team || !this.roster) return;
    const t = new RelayTransport({
      url: this.roster.roster.relay,
      team: this.team.team,
      key: this.key,
      mode: 'member',
      ...this.options.transport,
    });
    this.transport = t;
    t.announce(this.announced);
    t.on('welcome', (roster: SignedRoster, online: string[]) => this.onWelcome(roster, online));
    t.on('roster', (roster: SignedRoster) => this.onRemoteRoster(roster));
    t.on('presence', (key: string, isOnline: boolean) => this.onPresence(key, isOnline));
    t.on('join', (from: string, data: Buffer) => this.onJoinRequest(from, data));
    t.on('state', (s: TransportState) => this.onTransportState(s));
    t.onReceive((from, data) => this.onReceive(from, data));
    t.connect(this.roster).catch((err: unknown) => {
      process.stderr.write(`[peer] relay: ${errMessage(err)}\n`);
    });
  }

  private onWelcome(roster: SignedRoster, online: unknown): void {
    this.online = new Set(Array.isArray(online) ? online.filter(isRawKey) : []);
    this.onRemoteRoster(roster);
    // 다시 붙었으면 끊긴 동안 멈춘 구독을 다시 청한다
    for (const w of [...this.watches.values()]) {
      if (this.online.has(w.owner)) this.rewatch(w);
      else w.feed.markOffline();
    }
  }

  private onTransportState(s: TransportState): void {
    if (s === 'offline') {
      this.online.clear();
      for (const sub of [...this.subs.values()]) this.endSub(sub, 'relay_lost', false);
      for (const w of this.watches.values()) w.feed.markOffline();
    } else if (s === 'removed') {
      this.online.clear();
      for (const sub of [...this.subs.values()]) this.endSub(sub, 'removed', false);
      for (const w of [...this.watches.values()]) this.closeWatch(w, 'removed');
    }
  }

  private onPresence(key: string, isOnline: boolean): void {
    if (!isRawKey(key)) return;
    if (isOnline) this.online.add(key);
    else this.online.delete(key);
    for (const sub of [...this.subs.values()]) {
      if (!isOnline && sub.watcher === key) this.endSub(sub, 'watcher_offline', false);
    }
    for (const w of [...this.watches.values()]) {
      if (w.owner !== key) continue;
      if (isOnline) this.rewatch(w);
      else w.feed.markOffline();
    }
  }

  private onRemoteRoster(incoming: SignedRoster): void {
    if (!this.team) return;
    const current = this.roster;
    if (current && current.sig === incoming?.sig) return;
    this.applyRoster(incoming, 'relay');
  }

  /**
   * 명단을 받는다. 서명이 안 맞거나 판이 낮으면 버리고 감사 로그에 남긴다. 받으면 명단에서
   * 빠진 기기의 원격 구독을 바로 끊는다.
   */
  private applyRoster(incoming: SignedRoster, source: 'local' | 'relay' | 'join'): boolean {
    const team = this.team!;
    const verdict = checkRosterUpdate(this.roster, incoming, {
      team: team.team,
      anchor: team.anchor,
    });
    if (!verdict.ok) {
      this.options.state.audit(
        'roster_reject',
        null,
        JSON.stringify({ source, reason: verdict.reason, epoch: incoming?.roster?.epoch ?? null }),
      );
      return false;
    }
    this.roster = incoming;
    this.options.state.setRoster(incoming);
    this.transport?.setRoster(incoming);
    this.options.state.audit(
      'roster_accept',
      null,
      JSON.stringify({ source, epoch: incoming.roster.epoch }),
    );

    const r = incoming.roster;
    for (const sub of [...this.subs.values()]) {
      if (!memberOf(r, sub.watcher)) this.endSub(sub, 'removed', false);
    }
    for (const w of [...this.watches.values()]) {
      if (!memberOf(r, w.owner)) this.closeWatch(w, 'owner_removed');
    }
    if (!memberOf(r, this.key.id)) {
      for (const w of [...this.watches.values()]) this.closeWatch(w, 'removed');
    }
    return true;
  }

  private requireAdmin(): Roster {
    if (!this.roster) throw new PeerNetworkError('아직 팀에 안 들었어요');
    if (!isAdmin(this.roster.roster, this.key.id))
      throw new PeerNetworkError('관리자만 할 수 있어요');
    return this.roster.roster;
  }

  // ── 받기 ──────────────────────────────────────────────

  private onReceive(from: string, data: Uint8Array): void {
    let env: unknown;
    try {
      env = JSON.parse(Buffer.from(data).toString('utf8'));
    } catch {
      return;
    }
    if (typeof env !== 'object' || env === null) return;
    const kind = (env as { k?: unknown }).k;
    if (kind === 's') return this.onStream(from, env as StreamEnvelope);
    if (kind !== 'box') return;
    // 명단 밖 기기가 보낸 건 열지도 않는다
    if (!this.roster || !memberOf(this.roster.roster, from)) return;
    const plain = openBox(this.key, from, env);
    if (plain === null) return;
    let msg: BoxMessage;
    try {
      msg = JSON.parse(plain) as BoxMessage;
    } catch {
      return;
    }
    switch (msg.t) {
      case 'watch':
        return this.onWatchRequest(from, msg);
      case 'watch_ok':
      case 'watch_err':
        return this.onWatchReply(from, msg);
      case 'watch_end':
        return this.onWatchEnd(from, msg);
      case 'unwatch': {
        const sub = this.subs.get(msg.sub);
        if (sub && sub.watcher === from) this.endSub(sub, 'unwatch', false);
        return;
      }
      case 'msg':
        return void this.onMessageRequest(from, msg).catch((err: unknown) => {
          process.stderr.write(`[peer] message failed: ${errMessage(err)}\n`);
        });
      case 'msg_status':
        return this.onMessageStatus(from, msg);
      default:
        return;
    }
  }

  // ── 메시지 ──────────────────────────────────────────────

  /**
   * 보는 쪽: 원격 공유 주인 세션에 메시지를 보낸다. 주인 데몬이 오프라인이면 릴레이가 7일까지
   * 들고 있는다. 상태는 보기의 MirrorFeed에 쌓여 뷰어로 간다.
   */
  async sendMessage(
    watchId: string,
    raw: string,
    origin: MessageOrigin = 'human',
  ): Promise<{ id: string; status: MessageStatus }> {
    const w = this.watches.get(watchId);
    if (!w) throw new PeerNetworkError(`보고 있는 공유가 아니에요: ${watchId}`);
    const clean = sanitizeMessageBody(raw);
    if (!clean.ok) throw new PeerNetworkError(clean.reason);
    // 주인 쪽도 같은 한도로 막는다. 여기서 먼저 막아 릴레이까지 안 보낸다
    if (!this.sendLimiter.take(`${w.share}|${w.owner}`)) {
      throw new PeerNetworkError('메시지를 너무 자주 보냈어요. 10분에 12건까지예요');
    }
    const member = this.roster ? memberOf(this.roster.roster, w.owner) : undefined;
    const t = this.transport;
    if (!member) throw new PeerNetworkError('공유 주인이 명단에 없어요');
    if (!t || t.state !== 'online') throw new PeerNetworkError('릴레이에 안 붙어 있어요');

    const id = newMessageId();
    const body: BoxMessage = {
      t: 'msg',
      share: w.share,
      id,
      body: clean.text,
      origin,
      proof: hmac(w.shareKey, messageProofText(w.share, this.key.id, id, clean.text)),
    };
    w.feed.setMessage(id, { status: 'sent', text: clean.text, at: Date.now() });
    const box = sealBox(this.key, w.owner, member.boxKey, JSON.stringify(body));
    let result: 'queued' | 'delivered';
    try {
      result = await t.send(w.owner, Buffer.from(JSON.stringify(box)), { queue: true });
    } catch (err) {
      const reason = err instanceof RelaySendError ? err.reason : errMessage(err);
      w.feed.setMessage(id, { status: 'rejected', reason });
      throw new PeerNetworkError(`메시지를 못 보냈어요: ${errMessage(err)}`);
    }
    if (result === 'queued') {
      // 앞 단계로 안 돌아가므로 sent를 지우고 queued로 다시 쓴다
      w.feed.forgetMessage(id);
      w.feed.setMessage(id, { status: 'queued', text: clean.text });
    }
    return { id, status: w.feed.getMessage(id)?.status ?? 'sent' };
  }

  listMessages(
    watchId: string,
  ): { id: string; status: MessageStatus; text: string; at: number; reason?: string }[] {
    const w = this.watches.get(watchId);
    if (!w) throw new PeerNetworkError(`보고 있는 공유가 아니에요: ${watchId}`);
    return w.feed.messages;
  }

  /** 주인 쪽: 받은 메시지를 검사하고 주인 세션 인박스에 쓴다 */
  private async onMessageRequest(
    from: string,
    msg: Extract<BoxMessage, { t: 'msg' }>,
  ): Promise<void> {
    if (typeof msg.share !== 'string' || !isMessageId(msg.id)) return;
    // 릴레이가 같은 봉인을 다시 보내면 한 번만 넣는다
    const dedupe = `${from}|${msg.id}`;
    if (this.seenMessages.has(dedupe)) return;
    this.seenMessages.add(dedupe);
    if (this.seenMessages.size > MAX_SEEN_MESSAGES) {
      const oldest = this.seenMessages.values().next().value;
      if (oldest !== undefined) this.seenMessages.delete(oldest);
    }

    const status = (s: MessageStatus, reason?: string): void => {
      this.sendBox(from, {
        t: 'msg_status',
        share: msg.share,
        id: msg.id,
        status: s,
        ...(reason ? { reason } : {}),
      });
    };
    const person = (this.roster ? memberOf(this.roster.roster, from)?.person : undefined) ?? '?';
    const reject = (reason: string): void => {
      status('rejected', reason);
      this.options.state.audit(
        'message_reject',
        msg.share,
        JSON.stringify({ id: msg.id, person, reason }),
      );
    };

    const owned = this.options.lookupShare(msg.share);
    if (!owned || owned.stream.isClosed) return reject('share_closed');
    if (typeof msg.body !== 'string' || typeof msg.proof !== 'string') return reject('bad_frame');
    const expected = hmac(
      Buffer.from(owned.shareKey, 'base64url'),
      messageProofText(msg.share, from, msg.id, msg.body),
    );
    if (!safeEqual(msg.proof, expected)) return reject('bad_proof');
    const clean = sanitizeMessageBody(msg.body);
    if (!clean.ok) return reject(clean.reason);
    if (!this.receiveLimiter.take(`${msg.share}|${from}`)) return reject('rate_limited');
    if (!owned.deliver) return reject('no_inbox');

    const origin: MessageOrigin = msg.origin === 'agent' ? 'agent' : 'human';
    this.options.state.audit(
      'message_receive',
      msg.share,
      JSON.stringify({ id: msg.id, person, origin, bytes: Buffer.byteLength(clean.text) }),
    );
    status('arrived');
    const inbound: InboundMessage = {
      id: msg.id,
      share: msg.share,
      from,
      person,
      origin,
      body: clean.text,
    };
    const result = await owned.deliver(inbound, () => {
      status('delivered');
      this.options.state.audit(
        'message_deliver',
        msg.share,
        JSON.stringify({ id: msg.id, person }),
      );
    });
    if (!result.ok) return reject(result.reason);
    status('inserted');
    this.options.state.audit('message_insert', msg.share, JSON.stringify({ id: msg.id, person }));
  }

  /** 보는 쪽: 주인 데몬이 알려 온 상태를 반영한다 */
  private onMessageStatus(from: string, msg: Extract<BoxMessage, { t: 'msg_status' }>): void {
    if (!isMessageId(msg.id) || !isMessageStatus(msg.status)) return;
    for (const w of this.watches.values()) {
      if (w.owner !== from || w.share !== msg.share || !w.feed.getMessage(msg.id)) continue;
      // 주인 데몬이 보낸 글자라 CLI 터미널에 찍히기 전에 제어 문자를 지운다
      const reason = plainLabel(msg.reason);
      w.feed.setMessage(msg.id, { status: msg.status, ...(reason ? { reason } : {}) });
    }
  }

  private onJoinRequest(from: string, data: Uint8Array): void {
    try {
      this.handleJoin(from, data);
    } catch (err) {
      process.stderr.write(`[peer] join failed: ${errMessage(err)}\n`);
    }
  }

  private handleJoin(from: string, data: Uint8Array): void {
    if (!this.roster || !isAdmin(this.roster.roster, this.key.id) || !isRawKey(from)) return;
    let env: unknown;
    try {
      env = JSON.parse(Buffer.from(data).toString('utf8'));
    } catch {
      return;
    }
    const plain = openBox(this.key, from, env);
    if (plain === null) return;
    const msg = JSON.parse(plain) as Partial<Extract<BoxMessage, { t: 'join' }>>;
    if (msg.t !== 'join' || typeof msg.invite !== 'string' || !isRawKey(msg.box)) return;
    const invite = this.options.state.getInvite(msg.invite);
    if (!invite || Date.now() >= invite.expiresAt) return;
    const expected = hmac(
      Buffer.from(invite.secret, 'base64url'),
      joinProofText(invite.id, from, msg.box),
    );
    if (!safeEqual(msg.proof, expected)) return;

    const roster = this.roster.roster;
    if (memberOf(roster, from)) {
      // 같은 초대로 다시 왔다. 이미 넣었으니 명단만 다시 돌린다
      this.transport?.publishRoster(this.roster);
      return;
    }
    // 이미 쓴 초대다. 명단에 없으면 그사이 뺀 기기라 다시 넣지 않는다. 봉인에 시각이 없어서
    // 옛 join 요청을 그대로 다시 보내도 증명은 맞는다
    if (invite.usedBy !== null) return;
    const member: RosterMember = {
      person: invite.person,
      machineKey: from,
      boxKey: msg.box,
      role: 'member',
      addedAt: Date.now(),
    };
    const signed = signRoster(
      nextRoster(roster, [...roster.members, member], this.key.id),
      this.key,
    );
    if (!this.applyRoster(signed, 'local')) return;
    this.options.state.useInvite(invite.id, from);
    this.options.state.audit(
      'member_join',
      null,
      JSON.stringify({ person: invite.person, invite: invite.id, epoch: signed.roster.epoch }),
    );
    this.transport?.publishRoster(signed);
  }

  // ── 주인 쪽 ──────────────────────────────────────────────

  private onWatchRequest(from: string, msg: Extract<BoxMessage, { t: 'watch' }>): void {
    const reply = (reason: string): void => {
      this.sendBox(from, {
        t: 'watch_err',
        share: String(msg.share),
        nonce: String(msg.nonce),
        reason,
      });
    };
    if (typeof msg.share !== 'string' || typeof msg.nonce !== 'string') return;
    const owned = this.options.lookupShare(msg.share);
    if (!owned || owned.stream.isClosed) return reply('not_found');
    const shareKey = Buffer.from(owned.shareKey, 'base64url');
    if (!safeEqual(msg.proof, hmac(shareKey, watchProofText(msg.share, from, msg.nonce)))) {
      return reply('bad_proof');
    }
    if (!this.rememberWatchNonce(from, msg.nonce)) return reply('replay');
    // 같은 사람이 다시 청하면 앞의 구독을 바꾼다. 보는 쪽이 모르는 교체일 수 있어서 알린다
    for (const s of [...this.subs.values()]) {
      if (s.watcher === from && s.share === msg.share) this.endSub(s, 'replaced', true);
    }
    if (owned.stream.viewerCount >= MAX_VIEWERS_PER_SHARE) return reply('too_many');

    const sub = randomBytes(9).toString('base64url');
    const salt = randomBytes(32);
    const remote: RemoteSub = {
      sub,
      share: msg.share,
      watcher: from,
      key: streamKey(shareKey, salt, msg.share, from, sub),
      stream: owned.stream,
      unsubscribe: () => {},
      ended: false,
    };
    this.subs.set(sub, remote);
    this.sendBox(from, {
      t: 'watch_ok',
      share: msg.share,
      nonce: msg.nonce,
      sub,
      salt: salt.toString('base64url'),
    });
    const person = this.roster ? memberOf(this.roster.roster, from)?.person : undefined;
    this.options.state.audit(
      'remote_watch',
      msg.share,
      JSON.stringify({ person: person ?? null, sub }),
    );
    this.pump(remote, Number.isSafeInteger(msg.after) && msg.after > 0 ? msg.after : 0);
  }

  /**
   * 처음 보는 nonce면 기억하고 true. 공유는 데몬이 다시 뜨면 닫히므로 메모리에만 둔다.
   * 10분 지난 것과 상한을 넘는 오래된 것부터 잊는다.
   */
  private rememberWatchNonce(from: string, nonce: string, now = Date.now()): boolean {
    const key = `${from}|${nonce}`;
    if (this.seenWatch.has(key)) return false;
    for (const [k, at] of this.seenWatch) {
      if (now - at < WATCH_NONCE_TTL_MS && this.seenWatch.size < MAX_SEEN_WATCH) break;
      this.seenWatch.delete(k);
    }
    this.seenWatch.set(key, now);
    return true;
  }

  /** 뷰어 서버의 pump와 같다. 릴레이 소켓이 비는 만큼씩 앞부분을 보내고 다 따라잡으면 바로 붙는다 */
  private pump(remote: RemoteSub, after: number): void {
    const stream = remote.stream;
    let cursor = after;
    const step = (): void => {
      if (remote.ended) return;
      const t = this.transport;
      if (!t || t.state !== 'online') return this.endSub(remote, 'relay_lost', false);
      while (!stream.isClosed) {
        if (t.bufferedAmount > this.maxBuffered) {
          setTimeout(step, 20).unref();
          return;
        }
        const { dropped, items } = stream.backlogAfter(cursor, REPLAY_CHUNK_BYTES);
        const frames: ShareFrame[] = [];
        if (dropped > 0) {
          frames.push({ type: 'trimmed', dropped });
          cursor += dropped;
        }
        if (items.length === 0) {
          if (frames.length > 0) this.post(remote, frames);
          break;
        }
        for (const item of items) {
          frames.push({ type: 'event', ...item });
          cursor = item.seq;
        }
        this.post(remote, frames);
      }
      remote.unsubscribe = stream.subscribe((frame) => this.onLocalFrame(remote, frame), cursor);
      if (remote.ended) remote.unsubscribe();
    };
    this.post(remote, [
      { type: 'state', status: stream.currentStatus },
      { type: 'stats', unknownLines: stream.unknownLines },
    ]);
    step();
  }

  private onLocalFrame(remote: RemoteSub, frame: ShareFrame): void {
    if (remote.ended) return;
    const t = this.transport;
    if (!t || t.state !== 'online') return this.endSub(remote, 'relay_lost', false);
    if (frame.type !== 'closed' && t.bufferedAmount > this.maxBuffered) {
      // 이어 받기는 보는 쪽이 다시 청해서 한다
      return this.endSub(remote, 'slow', true);
    }
    this.post(remote, [frame]);
    if (frame.type === 'closed') this.endSub(remote, 'share_closed', false);
  }

  private post(remote: RemoteSub, frames: ShareFrame[]): void {
    const env: StreamEnvelope = {
      k: 's',
      share: remote.share,
      sub: remote.sub,
      d: aeadSeal(
        remote.key,
        Buffer.from(JSON.stringify(frames)),
        streamAad(remote.share, remote.sub, remote.watcher),
      ),
    };
    this.transport?.post(remote.watcher, Buffer.from(JSON.stringify(env)));
  }

  private endSub(remote: RemoteSub, reason: string, notify: boolean): void {
    if (remote.ended) return;
    remote.ended = true;
    remote.unsubscribe();
    this.subs.delete(remote.sub);
    if (notify)
      this.sendBox(remote.watcher, {
        t: 'watch_end',
        share: remote.share,
        sub: remote.sub,
        reason,
      });
    try {
      this.options.state.audit(
        'remote_watch_end',
        remote.share,
        JSON.stringify({ sub: remote.sub, reason }),
      );
    } catch {
      // 데몬이 멈추는 중이면 DB가 이미 닫혔을 수 있다
    }
  }

  // ── 보는 쪽 ──────────────────────────────────────────────

  private requestWatch(w: Watch): Promise<void> {
    return new Promise((resolve, reject) => {
      if (w.pending) {
        clearTimeout(w.pending.timer);
        w.pending.reject(new PeerNetworkError('다시 청해서 앞 요청을 버렸어요'));
      }
      const nonce = randomBytes(16).toString('base64url');
      const timer = setTimeout(() => {
        w.pending = undefined;
        reject(new PeerNetworkError('주인 데몬이 답하지 않았어요'));
      }, WATCH_TIMEOUT_MS);
      timer.unref();
      w.pending = { nonce, resolve, reject, timer };
      w.sub = undefined;
      w.key = undefined;
      const sent = this.sendBox(w.owner, {
        t: 'watch',
        share: w.share,
        nonce,
        proof: hmac(w.shareKey, watchProofText(w.share, this.key.id, nonce)),
        after: w.feed.eventCount,
      });
      if (!sent) {
        clearTimeout(timer);
        w.pending = undefined;
        reject(new PeerNetworkError('릴레이에 안 붙어 있어요'));
      }
    });
  }

  private rewatch(w: Watch): void {
    this.requestWatch(w).catch((err: unknown) => {
      if (err instanceof PeerNetworkError && /not_found|bad_proof/.test(err.message)) {
        this.closeWatch(w, 'share_closed');
      } else {
        w.feed.markOffline();
      }
    });
  }

  private onWatchReply(
    from: string,
    msg: Extract<BoxMessage, { t: 'watch_ok' | 'watch_err' }>,
  ): void {
    const w = [...this.watches.values()].find(
      (x) => x.owner === from && x.share === msg.share && x.pending?.nonce === msg.nonce,
    );
    if (!w || !w.pending) return;
    const pending = w.pending;
    w.pending = undefined;
    clearTimeout(pending.timer);
    if (msg.t === 'watch_err') {
      pending.reject(new PeerNetworkError(`주인 데몬이 거절했어요: ${msg.reason}`));
      return;
    }
    if (typeof msg.sub !== 'string' || typeof msg.salt !== 'string') {
      pending.reject(new PeerNetworkError('주인 데몬 답이 맞지 않아요'));
      return;
    }
    w.sub = msg.sub;
    w.key = streamKey(
      w.shareKey,
      Buffer.from(msg.salt, 'base64url'),
      w.share,
      this.key.id,
      msg.sub,
    );
    pending.resolve();
  }

  private onWatchEnd(from: string, msg: Extract<BoxMessage, { t: 'watch_end' }>): void {
    const w = [...this.watches.values()].find((x) => x.owner === from && x.sub === msg.sub);
    if (!w) return;
    w.sub = undefined;
    w.key = undefined;
    this.rewatch(w);
  }

  private onStream(from: string, env: StreamEnvelope): void {
    if (typeof env.share !== 'string' || typeof env.sub !== 'string') return;
    const w = [...this.watches.values()].find(
      (x) => x.owner === from && x.sub === env.sub && x.share === env.share,
    );
    if (!w || !w.key) return;
    const plain = aeadOpen(w.key, env.d, streamAad(env.share, env.sub, this.key.id));
    if (!plain) return;
    let frames: ShareFrame[];
    try {
      frames = JSON.parse(plain.toString('utf8')) as ShareFrame[];
    } catch {
      return;
    }
    if (!Array.isArray(frames)) return;
    w.feed.apply(frames);
    if (w.feed.isClosed) this.closeWatch(w, w.feed.closeReason ?? 'closed');
  }

  private closeWatch(w: Watch, reason: string): void {
    if (!this.watches.has(w.id)) return;
    this.watches.delete(w.id);
    if (w.pending) {
      clearTimeout(w.pending.timer);
      w.pending.reject(new PeerNetworkError(`보기가 끝났어요: ${reason}`));
      w.pending = undefined;
    }
    w.feed.close(reason);
    try {
      this.options.state.audit(
        'watch_close',
        null,
        JSON.stringify({ watch: w.id, share: w.share, reason }),
      );
    } catch {
      // 데몬이 멈추는 중이면 DB가 이미 닫혔을 수 있다
    }
  }

  private sendBox(to: string, msg: BoxMessage): boolean {
    const t = this.transport;
    const member = this.roster ? memberOf(this.roster.roster, to) : undefined;
    if (!t || !member) return false;
    const box = sealBox(this.key, to, member.boxKey, JSON.stringify(msg));
    return t.post(to, Buffer.from(JSON.stringify(box)));
  }
}

/** 링크를 가진 쪽만 만드는 증명. 보는 기기 id와 nonce를 넣어 남의 요청을 다시 못 쓰게 한다 */
function watchProofText(share: string, watcher: string, nonce: string): string {
  return canonical({ p: 'gestalt-peer-watch-v1', share, watcher, nonce });
}

/** 링크를 가진 쪽만 만드는 메시지 증명. 본문까지 넣어 릴레이가 내용을 바꾸지 못하게 한다 */
function messageProofText(share: string, from: string, id: string, body: string): string {
  return canonical({ p: 'gestalt-peer-msg-v1', share, from, id, body });
}

function isMessageStatus(v: unknown): v is MessageStatus {
  return (
    v === 'queued' ||
    v === 'sent' ||
    v === 'arrived' ||
    v === 'inserted' ||
    v === 'delivered' ||
    v === 'rejected'
  );
}

function streamKey(
  shareKey: Buffer,
  salt: Buffer,
  share: string,
  watcher: string,
  sub: string,
): Buffer {
  return deriveKey(shareKey, salt, `gestalt-peer-stream-v1|${share}|${watcher}|${sub}`);
}

function streamAad(share: string, sub: string, watcher: string): string {
  return `gestalt-peer-stream-v1|${share}|${sub}|${watcher}`;
}
