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
  isShareId,
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
import { DEFAULT_FIRST_WATCH_APPROVAL } from './protocol.js';
import type { BlockReason, ControlResult, FirstWatchApproval, PendingWatcher } from './protocol.js';

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
  /** 첫 접속 승인을 기다리는 시한. 테스트가 줄인다 */
  approvalTtlMs?: number;
  /** 보는 사람, 승인 대기, 끊은 사람 목록이 바뀌면 부른다. 데몬이 훅 상태 파일을 다시 쓴다 */
  onControlChange?(): void;
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
  /** 주인 승인을 기다리는 중 */
  waiting: boolean;
}

/** 주인 쪽에서 본 공유 하나의 통제 상태 */
export interface ShareControl {
  watchers: string[];
  pending: PendingWatcher[];
  blocked: { person: string; reason: BlockReason }[];
}

/** 초대 유효 시간. 설계 원문의 24시간 */
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
/** 원격 구독 하나가 릴레이 소켓에 밀어 둘 수 있는 양 */
export const MAX_REMOTE_BUFFERED_BYTES = 8 * 1024 * 1024;
const WATCH_TIMEOUT_MS = 10_000;
/** 답이 없거나 다시 청하면 되는 거절을 받았을 때 다시 청하는 횟수와 간격 상한 */
const MAX_REWATCH_RETRIES = 6;
const MAX_REWATCH_DELAY_MS = 60_000;
const WATCH_NONCE_TTL_MS = 10 * 60 * 1000;
const MAX_SEEN_WATCH = 4096;
const MAX_SEEN_MESSAGES = 8192;
const MAX_REFUSED_PER_SENDER = 256;
const MAX_REFUSED_SENDERS = 1024;
/** 첫 접속 승인을 기다리는 시한. 넘으면 보는 쪽에 approval_timeout으로 알린다 */
export const APPROVAL_TTL_MS = 10 * 60 * 1000;
/** 승인 대기를 긴 안내 문구로 알리는 시간. 지나면 훅이 짧은 한 줄만 붙인다 */
export const APPROVAL_NOTICE_MS = 60 * 1000;
/** 끝난 보기를 `peer watches`에 남겨 두는 개수. 거절이나 kick으로 끝난 이유를 CLI에서 보게 한다 */
const MAX_CLOSED_WATCHES = 16;
/** 보는 쪽이 다시 청하지 않고 보기를 끝내는 거절 이유 */
const FINAL_REFUSALS = new Set([
  'not_found',
  'bad_proof',
  'kicked',
  'denied',
  'approval_timeout',
  'share_closed',
]);

/** 데몬끼리 봉인해 주고받는 것. box 안에 든다 */
type BoxMessage =
  | { t: 'watch'; share: string; nonce: string; proof: string; after: number }
  | {
      t: 'watch_ok';
      share: string;
      nonce: string;
      sub: string;
      salt: string;
      /** 주인이 이 공유로 메시지를 받는지. 없으면(이전 버전 주인 데몬) 안 받는 것으로 본다 */
      messages?: boolean;
    }
  | { t: 'watch_err'; share: string; nonce: string; reason: string }
  /** 주인 승인을 기다린다. 받아 주면 같은 nonce로 watch_ok가, 아니면 watch_err가 온다 */
  | { t: 'watch_wait'; share: string; nonce: string; expiresAt: number }
  /** 보는 쪽이 승인을 기다리다 그만뒀다. 그 nonce의 대기를 치운다 */
  | { t: 'watch_cancel'; share: string; nonce: string }
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

/** 주인 쪽. 첫 접속 승인을 기다리는 요청. 키는 `공유|기기`다 */
interface PendingApproval {
  share: string;
  watcher: string;
  /** 보는 쪽이 기다리는 요청의 nonce. 다시 청하면 새것으로 바뀐다 */
  nonce: string;
  after: number;
  at: number;
  expiresAt: number;
  timer: NodeJS.Timeout;
  /** 훅의 긴 안내 문구를 짧게 줄일 때 */
  shorten: NodeJS.Timeout;
}

/** 승인을 누가 했는지. team 승인은 설정을 ask로 조이면 거둔다 */
type GrantSource = 'owner' | 'team';

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
  /** 주인이 이 공유로 메시지를 받는지. watch_ok가 올 때마다 새로 받는다 */
  messages: boolean;
  /** 지금 기다리는 watch 요청 */
  pending?: {
    nonce: string;
    /** 주인 데몬의 첫 답(watch_ok, watch_err, watch_wait)을 기다리는 동안만 있다 */
    settle?: {
      resolve: (r: 'ok' | 'waiting') => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    };
  };
  /** 다시 청하기로 걸어 둔 타이머. 답이 없거나 다시 청하면 되는 거절일 때 건다 */
  retry?: NodeJS.Timeout;
  /** 연달아 실패한 재청 수. 답을 받으면 0으로 돌린다 */
  retries: number;
}

interface ClosedWatch {
  id: string;
  share: string;
  owner: string;
  events: number;
  reason: string;
}

export class PeerNetworkError extends Error {}

/** 주인 데몬이 시한 안에 watch에 답하지 않았다 */
export class WatchTimeout extends PeerNetworkError {}

/** 주인 데몬이 watch를 거절했다. reason은 주인 데몬이 보낸 글자를 정리한 것이다 */
export class WatchRefused extends PeerNetworkError {
  constructor(readonly reason: string) {
    super(refusalText(reason));
  }
}

/** 거절 이유를 사람이 읽는 문장으로. 이유 글자는 끝에 괄호로 남겨 스크립트가 찾게 한다 */
export function refusalText(reason: string): string {
  switch (reason) {
    case 'denied':
      return '주인이 거절했어요 (denied)';
    case 'kicked':
      return '주인이 이 공유에서 끊었어요 (kicked)';
    case 'approval_timeout':
      return '주인이 승인하지 않아 기다리다 끝났어요 (approval_timeout)';
    default:
      return `주인 데몬이 거절했어요: ${reason}`;
  }
}

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
  /**
   * 수신 한도로 거절한 메시지 id를 `공유|기기`마다 따로 기억한다. 창이 지난 뒤 릴레이가 같은
   * 봉인을 다시 보내도 넣지 않는다. 공용 seenMessages에 넣으면 한 사람이 맞는 증명으로
   * 쏟아부어 다른 팀원의 기억을 밀어낼 수 있어서 나눈다
   */
  private refusedMessages = new Map<string, Set<string>>();
  private sendLimiter = new RateLimiter();
  /** 보는 쪽이 12건으로 먼저 막는다. 주인 쪽은 릴레이에 쌓였다 한꺼번에 온 것도 받게 넉넉하다 */
  private receiveLimiter = new RateLimiter(MESSAGE_RECEIVE_LIMIT);
  private readonly maxBuffered: number;
  private readonly approvalTtl: number;
  /**
   * 주인 쪽 통제 상태. 전부 공유가 열려 있는 동안만 메모리에 둔다. 공유는 데몬이 다시 뜨면
   * 닫히므로 DB에 남길 필요가 없고 forgetShare가 공유를 닫을 때 같이 버린다.
   * - pending: 첫 접속 승인을 기다리는 요청. 키는 `공유|기기`
   * - approved: 공유마다 받아 준 기기
   * - blocked: 공유마다 끊거나 거절한 기기. 공유가 열려 있는 동안 다시 못 붙고 메시지도 못 넣는다
   */
  private pending = new Map<string, PendingApproval>();
  private approved = new Map<string, Map<string, GrantSource>>();
  /** 첫 접속 설정. 메시지마다 읽으므로 DB가 아니라 메모리에 두고 setFirstWatch로만 바꾼다 */
  private firstWatchMode: FirstWatchApproval;
  /** 거절 답과 감사 행을 쓰는 양의 상한. 끊긴 사람이 새 id로 계속 보내도 디스크와 릴레이를 못 채운다 */
  private rejectLimiter = new RateLimiter(MESSAGE_RECEIVE_LIMIT);
  private blocked = new Map<string, Map<string, BlockReason>>();
  private closedWatches: ClosedWatch[] = [];

  constructor(private readonly options: PeerNetworkOptions) {
    this.team = options.state.getTeam();
    this.roster = options.state.getRoster();
    this.maxBuffered = options.maxBufferedBytes ?? MAX_REMOTE_BUFFERED_BYTES;
    this.approvalTtl = options.approvalTtlMs ?? APPROVAL_TTL_MS;
    this.firstWatchMode = options.state.getSettings().firstWatch ?? DEFAULT_FIRST_WATCH_APPROVAL;
  }

  get key(): MachineKey {
    return this.options.key;
  }

  /** 팀이 있으면 릴레이에 붙기 시작한다. 첫 접속을 기다리지 않는다 */
  start(): void {
    if (this.team && this.roster && memberOf(this.roster.roster, this.key.id)) this.connect();
  }

  async stop(): Promise<void> {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      clearTimeout(p.shorten);
    }
    this.pending.clear();
    for (const w of this.watches.values()) if (w.retry) clearTimeout(w.retry);
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
        /** 주인이 메시지를 안 받는 공유면 없다 */
        send?(text: string): Promise<{ ok: true; id: string } | { ok: false; error: string }>;
      }
    | undefined {
    const w = this.watches.get(id);
    if (!w) return undefined;
    return {
      stream: w.feed,
      token: w.token,
      // 승인을 기다리는 동안 연 뷰어도 받아 준 뒤에 입력창이 있어야 한다. 페이지는 열 때 한 번
      // 그려지므로 기다리는 중에는 입력창을 두고 보내기는 sendMessage가 막는다
      ...(w.messages || w.feed.currentStatus === 'waiting'
        ? {
            send: (text: string) =>
              this.sendMessage(id, text, 'human').then(
                (r) => ({ ok: true as const, id: r.id }),
                (err: unknown) => ({ ok: false as const, error: errMessage(err) }),
              ),
          }
        : {}),
    };
  }

  /** 보고 있는 공유와 최근에 끝난 보기. 끝난 것은 closed에 이유가 있다 */
  listWatches(): {
    id: string;
    share: string;
    owner: string;
    status: string;
    events: number;
    closed?: string;
  }[] {
    const live = [...this.watches.values()].map((w) => ({
      id: w.id,
      share: w.share,
      owner: w.feed.ownerPerson,
      status: w.feed.currentStatus,
      events: w.feed.eventCount,
    }));
    const ended = this.closedWatches.map((c) => ({
      id: c.id,
      share: c.share,
      owner: c.owner,
      status: 'closed',
      events: c.events,
      closed: c.reason,
    }));
    return [...live, ...ended];
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
      messages: false,
      retries: 0,
    };
    this.watches.set(id, w);
    let waiting: boolean;
    try {
      waiting = (await this.requestWatch(w)) === 'waiting';
    } catch (err) {
      this.watches.delete(id);
      w.feed.close('watch_failed');
      throw err;
    }
    this.options.state.audit(
      'watch_open',
      null,
      JSON.stringify({ watch: id, share: w.share, owner: ownerMember.person, waiting }),
    );
    return { id, share: w.share, owner: ownerMember.person, feed: w.feed, token: w.token, waiting };
  }

  unwatch(id: string): boolean {
    const w = this.watches.get(id);
    if (!w) return false;
    // 승인을 기다리는 중이면 sub가 없다. 그때 주인에게 알리는 건 closeWatch가 watch_cancel로 한다
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
    for (const [key, p] of [...this.pending]) {
      if (!memberOf(r, p.watcher)) this.dropApproval(key);
    }
    // 빠진 기기가 같은 키로 다시 초대돼 와도 묻지 않고 붙지 않게 승인은 지운다. 막은 목록은
    // 공유가 닫힐 때까지 둔다. 지우면 kick한 기기가 다시 들어와 풀린다
    for (const map of this.approved.values()) {
      for (const machine of [...map.keys()]) if (!memberOf(r, machine)) map.delete(machine);
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
      case 'watch_wait':
        return this.onWatchReply(from, msg);
      case 'watch_end':
        return this.onWatchEnd(from, msg);
      case 'watch_cancel':
        return this.onWatchCancel(from, msg);
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
    if (w.feed.currentStatus === 'waiting')
      throw new PeerNetworkError('주인 승인을 기다리는 중이라 아직 메시지를 못 보내요');
    if (!w.messages) throw new PeerNetworkError('이 공유는 주인이 메시지를 받지 않게 열었어요');
    const clean = sanitizeMessageBody(raw);
    if (!clean.ok) throw new PeerNetworkError(clean.reason);
    const member = this.roster ? memberOf(this.roster.roster, w.owner) : undefined;
    const t = this.transport;
    if (!member) throw new PeerNetworkError('공유 주인이 명단에 없어요');
    if (!t || t.state !== 'online') throw new PeerNetworkError('릴레이에 안 붙어 있어요');
    // 보내기 직전에 센다. 명단이나 연결 때문에 못 보낸 시도는 한도를 안 깎는다.
    // 주인 쪽 수신 한도는 MESSAGE_RECEIVE_LIMIT로 따로 정한다
    if (!this.sendLimiter.take(`${w.share}|${w.owner}`)) {
      throw new PeerNetworkError('메시지를 너무 자주 보냈어요. 10분에 12건까지예요');
    }

    const id = newMessageId();
    const body: BoxMessage = {
      t: 'msg',
      share: w.share,
      id,
      body: clean.text,
      origin,
      proof: hmac(w.shareKey, messageProofText(w.share, this.key.id, id, clean.text)),
    };
    // 릴레이 답보다 주인 데몬의 상태가 먼저 올 수 있어서 레코드를 미리 둔다. 알리는 건 답을 받은 뒤다
    w.feed.reserveMessage(id, clean.text, Date.now());
    const box = sealBox(this.key, w.owner, member.boxKey, JSON.stringify(body));
    let result: 'queued' | 'delivered';
    try {
      result = await t.send(w.owner, Buffer.from(JSON.stringify(box)), { queue: true });
    } catch (err) {
      const reason = err instanceof RelaySendError ? err.reason : errMessage(err);
      w.feed.setMessage(id, { status: 'rejected', reason });
      throw new PeerNetworkError(`메시지를 못 보냈어요: ${errMessage(err)}`);
    }
    w.feed.setMessage(id, { status: result === 'queued' ? 'queued' : 'sent' });
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
    // 꼴이 틀린 공유 id는 감사 로그와 CLI 출력으로 흘러가지 않게 답 없이 버린다
    if (!isShareId(msg.share) || !isMessageId(msg.id)) return;
    // 릴레이가 같은 봉인을 다시 보내면 한 번만 넣는다. 기억은 검사를 다 통과한 뒤에 한다.
    // 앞에서 기억하면 증명 없는 가짜 id로 칸을 밀어내 옛 봉인을 다시 넣게 할 수 있다
    const dedupe = `${from}|${msg.id}`;
    const sender = `${msg.share}|${from}`;
    if (this.seenMessages.has(dedupe) || this.refusedMessages.get(sender)?.has(msg.id)) return;

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
      // 거절은 증명 없이도 탈 수 있는 길이 있어서 보낸 기기마다 상한을 둔다. 넘으면 답도 기록도 없이 버린다
      if (!this.rejectLimiter.take(from)) return;
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
    // 메시지는 구독이 아니라 링크 증명으로 받아서 구독을 끊어도 링크는 남는다. 끊거나 거절한 사람과
    // 아직 안 받아 준 사람은 여기서 막는다. 릴레이가 들고 있다 나중에 넘긴 봉인도 같은 규칙을 탄다
    const refusal = this.messageRefusal(msg.share, from);
    if (refusal) {
      this.rememberRefused(sender, msg.id);
      return reject(refusal);
    }
    const clean = sanitizeMessageBody(msg.body);
    if (!clean.ok) return reject(clean.reason);
    if (!this.receiveLimiter.take(sender)) {
      this.rememberRefused(sender, msg.id);
      return reject('rate_limited');
    }
    if (!owned.deliver) return reject('messages_off');
    // deliver의 첫 await 전에 기억해야 동시에 온 같은 봉인이 둘 다 들어가지 않는다
    this.seenMessages.add(dedupe);
    if (this.seenMessages.size > MAX_SEEN_MESSAGES) {
      const oldest = this.seenMessages.values().next().value;
      if (oldest !== undefined) this.seenMessages.delete(oldest);
    }

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
    const delivered = (): void => {
      status('delivered');
      this.options.state.audit(
        'message_deliver',
        msg.share,
        JSON.stringify({ id: msg.id, person }),
      );
    };
    // 들어갔는지 지켜보는 일은 쓰기 전에 걸어 둔다. 그래서 쓰기가 끝나기 전에 보일 수 있고 그때는
    // 넣음을 먼저 알린 뒤 들어감을 알린다
    let inserted = false;
    let seenEarly = false;
    const result = await owned.deliver(inbound, () => {
      if (inserted) delivered();
      else seenEarly = true;
    });
    if (!result.ok) return reject(result.reason);
    status('inserted');
    this.options.state.audit('message_insert', msg.share, JSON.stringify({ id: msg.id, person }));
    inserted = true;
    if (seenEarly) delivered();
  }

  private rememberRefused(sender: string, id: string): void {
    let ids = this.refusedMessages.get(sender);
    if (!ids) {
      ids = new Set();
      this.refusedMessages.set(sender, ids);
      if (this.refusedMessages.size > MAX_REFUSED_SENDERS) {
        const oldest = this.refusedMessages.keys().next().value;
        if (oldest !== undefined) this.refusedMessages.delete(oldest);
      }
    }
    ids.add(id);
    if (ids.size > MAX_REFUSED_PER_SENDER) {
      const oldest = ids.values().next().value;
      if (oldest !== undefined) ids.delete(oldest);
    }
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
    const block = this.blocked.get(msg.share)?.get(from);
    if (block) return reply(block);
    const after = Number.isSafeInteger(msg.after) && msg.after > 0 ? msg.after : 0;
    // 승인은 salt와 세션 키를 정하기 전에 본다. 키를 보낸 뒤에 막으면 보는 쪽이 이미 대화를 열어 읽을 수 있다
    if (!this.approved.get(msg.share)?.has(from)) {
      if (this.firstWatchMode === 'ask') {
        return this.holdForApproval(from, msg.share, msg.nonce, after);
      }
      // 기다리는 사이 설정을 team으로 바꿨으면 남은 대기를 치운다. 안 치우면 목록과 훅에 계속 보인다
      this.dropApproval(`${msg.share}|${from}`);
      this.grant(msg.share, from, 'team');
    }
    this.startSub(from, msg.share, msg.nonce, after, owned);
  }

  /** 받아 준 사람의 구독을 연다. 공유 세션 키는 여기서 처음 정한다 */
  private startSub(
    from: string,
    share: string,
    nonce: string,
    after: number,
    owned: OwnedShare,
  ): void {
    // 같은 사람이 다시 청하면 앞의 구독을 바꾼다. 보는 쪽이 모르는 교체일 수 있어서 알린다
    for (const s of [...this.subs.values()]) {
      if (s.watcher === from && s.share === share) this.endSub(s, 'replaced', true);
    }
    if (owned.stream.viewerCount >= MAX_VIEWERS_PER_SHARE) {
      this.sendBox(from, { t: 'watch_err', share, nonce, reason: 'too_many' });
      return;
    }

    const sub = randomBytes(9).toString('base64url');
    const salt = randomBytes(32);
    const shareKey = Buffer.from(owned.shareKey, 'base64url');
    const remote: RemoteSub = {
      sub,
      share,
      watcher: from,
      key: streamKey(shareKey, salt, share, from, sub),
      stream: owned.stream,
      unsubscribe: () => {},
      ended: false,
    };
    this.subs.set(sub, remote);
    this.sendBox(from, {
      t: 'watch_ok',
      share,
      nonce,
      sub,
      salt: salt.toString('base64url'),
      messages: owned.deliver !== undefined,
    });
    this.options.state.audit(
      'remote_watch',
      share,
      JSON.stringify({ person: this.personOf(from), sub }),
    );
    this.changed();
    this.pump(remote, after);
  }

  /**
   * 첫 접속을 주인이 받아 줄 때까지 붙잡아 둔다. 보는 쪽에는 watch_wait로 알린다. 같은 사람이
   * 다시 청하면(주인이나 보는 쪽이 릴레이에 다시 붙은 경우) 시한은 그대로 두고 nonce만 바꾼다.
   */
  private holdForApproval(from: string, share: string, nonce: string, after: number): void {
    const key = `${share}|${from}`;
    let p = this.pending.get(key);
    if (p) {
      p.nonce = nonce;
      p.after = after;
    } else {
      let waiting = 0;
      for (const q of this.pending.values()) if (q.share === share) waiting++;
      if (waiting >= MAX_VIEWERS_PER_SHARE) {
        this.sendBox(from, { t: 'watch_err', share, nonce, reason: 'too_many' });
        return;
      }
      const at = Date.now();
      const timer = setTimeout(() => this.expireApproval(key), this.approvalTtl);
      timer.unref();
      // 긴 안내 문구는 처음 한동안만 붙이고 그 뒤로는 짧게 줄인다. 줄이는 시점에 훅 파일을 다시 쓴다
      const shorten = setTimeout(() => this.changed(), APPROVAL_NOTICE_MS);
      shorten.unref();
      p = {
        share,
        watcher: from,
        nonce,
        after,
        at,
        expiresAt: at + this.approvalTtl,
        timer,
        shorten,
      };
      this.pending.set(key, p);
      this.options.state.audit(
        'approval_request',
        share,
        JSON.stringify({ person: this.personOf(from) }),
      );
      this.changed();
    }
    this.sendBox(from, { t: 'watch_wait', share, nonce, expiresAt: p.expiresAt });
  }

  /**
   * 승인 대기 하나를 치운다. 타이머 둘을 풀고 훅 파일을 다시 쓰게 한다. reason을 주면 보는 쪽에
   * 그 이유로 거절을 알린다. 치운 대기를 돌려준다.
   */
  private dropApproval(key: string, reason?: string): PendingApproval | undefined {
    const p = this.pending.get(key);
    if (!p) return undefined;
    clearTimeout(p.timer);
    clearTimeout(p.shorten);
    this.pending.delete(key);
    if (reason) {
      this.sendBox(p.watcher, { t: 'watch_err', share: p.share, nonce: p.nonce, reason });
    }
    this.changed();
    return p;
  }

  private expireApproval(key: string): void {
    const p = this.dropApproval(key, 'approval_timeout');
    if (!p) return;
    try {
      this.options.state.audit(
        'approval_expire',
        p.share,
        JSON.stringify({ person: this.personOf(p.watcher) }),
      );
    } catch {
      // 데몬이 멈추는 중이면 DB가 이미 닫혔을 수 있다
    }
  }

  /** 보는 쪽이 승인을 기다리다 그만뒀다. 그 요청의 nonce가 맞을 때만 치운다 */
  private onWatchCancel(from: string, msg: Extract<BoxMessage, { t: 'watch_cancel' }>): void {
    if (typeof msg.share !== 'string' || typeof msg.nonce !== 'string') return;
    const key = `${msg.share}|${from}`;
    // 릴레이가 옛 취소를 다시 보내도 그 뒤에 새로 청한 대기는 안 지워진다
    if (this.pending.get(key)?.nonce !== msg.nonce) return;
    const p = this.dropApproval(key)!;
    this.options.state.audit(
      'approval_cancel',
      p.share,
      JSON.stringify({ person: this.personOf(from) }),
    );
  }

  private grant(share: string, machine: string, by: GrantSource): void {
    let map = this.approved.get(share);
    if (!map) {
      map = new Map();
      this.approved.set(share, map);
    }
    map.set(machine, by);
    this.options.state.audit(
      'approval_grant',
      share,
      JSON.stringify({ person: this.personOf(machine), by }),
    );
  }

  private block(share: string, machine: string, reason: BlockReason): void {
    let map = this.blocked.get(share);
    if (!map) {
      map = new Map();
      this.blocked.set(share, map);
    }
    map.set(machine, reason);
    this.approved.get(share)?.delete(machine);
  }

  /** 이 공유로 이 기기가 보낸 메시지를 막을 이유. 받을 수 있으면 undefined */
  private messageRefusal(share: string, from: string): string | undefined {
    const block = this.blocked.get(share)?.get(from);
    if (block) return block;
    if (this.firstWatchMode === 'ask' && !this.approved.get(share)?.has(from)) {
      return 'not_approved';
    }
    return undefined;
  }

  /**
   * 첫 접속 설정을 바꾼다. ask로 조이면 팀 설정으로 들어온 사람의 승인을 거두고 구독을 끝낸다.
   * 보는 쪽은 approval_revoked를 받고 다시 청해 승인 대기에 오른다. 거둔 구독 수를 돌려준다.
   */
  setFirstWatch(mode: FirstWatchApproval): number {
    this.firstWatchMode = mode;
    if (mode !== 'ask') return 0;
    let revoked = 0;
    for (const [share, map] of this.approved) {
      const machines = [...map].filter(([, by]) => by === 'team').map(([m]) => m);
      if (machines.length === 0) continue;
      for (const m of machines) map.delete(m);
      for (const sub of [...this.subs.values()]) {
        if (sub.share !== share || !machines.includes(sub.watcher)) continue;
        this.endSub(sub, 'approval_revoked', true);
        revoked++;
      }
      this.options.state.audit(
        'approval_revoke',
        share,
        JSON.stringify({ persons: unique(machines.map((m) => this.personOf(m))) }),
      );
    }
    this.changed();
    return revoked;
  }

  /** 명단의 이름을 한 줄 라벨로. 감사 로그와 CLI, 훅 출력으로 나간다 */
  private personOf(machine: string): string {
    const person = this.roster ? memberOf(this.roster.roster, machine)?.person : undefined;
    return plainLabel(person, 32) ?? '?';
  }

  private machinesOf(person: string): string[] {
    if (!this.roster) throw new PeerNetworkError('아직 팀에 안 들었어요');
    const keys = this.roster.roster.members
      .filter((m) => m.person === person)
      .map((m) => m.machineKey);
    if (keys.length === 0) throw new PeerNetworkError(`명단에 없는 이름이에요: ${person}`);
    return keys;
  }

  private changed(): void {
    try {
      this.options.onControlChange?.();
    } catch (err) {
      process.stderr.write(`[peer] control change failed: ${errMessage(err)}\n`);
    }
  }

  /** 주인 쪽: 공유 하나를 누가 보고 누가 기다리고 누가 막혔는지 */
  shareControl(share: string): ShareControl {
    const watchers = new Set<string>();
    for (const s of this.subs.values()) {
      if (s.share === share) watchers.add(this.personOf(s.watcher));
    }
    const pending: PendingWatcher[] = [];
    for (const p of this.pending.values()) {
      if (p.share === share) {
        pending.push({ person: this.personOf(p.watcher), at: p.at, expiresAt: p.expiresAt });
      }
    }
    const blocked = [...(this.blocked.get(share) ?? new Map<string, BlockReason>())].map(
      ([machine, reason]) => ({ person: this.personOf(machine), reason }),
    );
    return { watchers: [...watchers], pending, blocked };
  }

  /** 주인 쪽: 승인을 기다리는 그 사람의 요청을 받아 준다. 받아 준 기기는 공유가 열린 동안 기억한다 */
  approve(person: string, shares: string[]): ControlResult {
    const hits = this.pendingOf(person, shares);
    for (const p of hits) {
      this.dropApproval(`${p.share}|${p.watcher}`);
      this.grant(p.share, p.watcher, 'owner');
      const owned = this.options.lookupShare(p.share);
      if (owned && !owned.stream.isClosed) {
        this.startSub(p.watcher, p.share, p.nonce, p.after, owned);
      } else {
        this.sendBox(p.watcher, {
          t: 'watch_err',
          share: p.share,
          nonce: p.nonce,
          reason: 'not_found',
        });
      }
    }
    return { person, shares: unique(hits.map((p) => p.share)), count: hits.length };
  }

  /** 주인 쪽: 승인을 기다리는 그 사람의 요청을 거절한다. 그 공유가 열린 동안 다시 못 붙는다 */
  deny(person: string, shares: string[]): ControlResult {
    const hits = this.pendingOf(person, shares);
    for (const p of hits) {
      this.block(p.share, p.watcher, 'denied');
      this.dropApproval(`${p.share}|${p.watcher}`, 'denied');
      this.options.state.audit('approval_deny', p.share, JSON.stringify({ person }));
    }
    return { person, shares: unique(hits.map((p) => p.share)), count: hits.length };
  }

  private pendingOf(person: string, shares: string[]): PendingApproval[] {
    const machines = new Set(this.machinesOf(person));
    const hits = [...this.pending.values()].filter(
      (p) => machines.has(p.watcher) && shares.includes(p.share),
    );
    if (hits.length === 0) throw new PeerNetworkError(`승인을 기다리는 사람이 아니에요: ${person}`);
    return hits;
  }

  /**
   * 주인 쪽: 그 사람의 기기 전부를 공유에서 끊는다. 구독을 끝내고 그 구독 몫의 세션 키를 메모리에서
   * 지운다. 지금 안 보고 있어도 막아 둔다. 공유가 열린 동안 다시 붙지 못하고 메시지도 못 넣는다.
   */
  kick(person: string, shares: string[]): ControlResult {
    const machines = this.machinesOf(person);
    if (machines.includes(this.key.id)) throw new PeerNetworkError('자기 자신은 끊을 수 없어요');
    let count = 0;
    for (const share of shares) {
      let ended = 0;
      for (const machine of machines) {
        this.block(share, machine, 'kicked');
        this.dropApproval(`${share}|${machine}`, 'kicked');
      }
      for (const sub of [...this.subs.values()]) {
        if (sub.share !== share || !machines.includes(sub.watcher)) continue;
        this.endSub(sub, 'kicked', true);
        ended++;
      }
      this.options.state.audit('kick', share, JSON.stringify({ person, ended }));
      count += ended;
    }
    this.changed();
    return { person, shares, count };
  }

  /**
   * 주인 쪽: 공유가 닫혔다. 승인을 기다리던 사람에게 알리고 그 공유의 승인과 막은 목록을 버린다.
   * 붙어 있던 구독은 공유 스트림의 closed 프레임으로 끝난다.
   */
  forgetShare(share: string): void {
    for (const [key, p] of [...this.pending]) {
      if (p.share === share) this.dropApproval(key, 'share_closed');
    }
    this.approved.delete(share);
    this.blocked.delete(share);
    this.changed();
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
    // 끊긴 구독은 키를 지웠다. 지운 키로 봉인한 프레임이 나가지 않게 여기서 한 번 더 막는다
    if (remote.ended) return;
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
    // 이 구독 몫의 세션 키를 메모리에서 지운다. 새 프레임은 ended를 보는 post가 막는다
    remote.key.fill(0);
    this.changed();
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

  /**
   * 주인 데몬에 보기를 청한다. watch_ok면 'ok', 주인 승인을 기다리면 'waiting'으로 끝난다.
   * 기다리는 동안 pending.nonce는 남겨 두고 나중에 오는 watch_ok나 watch_err를 그 nonce로 맞춘다.
   */
  private requestWatch(w: Watch): Promise<'ok' | 'waiting'> {
    return new Promise((resolve, reject) => {
      this.dropPending(w, '다시 청해서 앞 요청을 버렸어요');
      if (w.retry) clearTimeout(w.retry);
      w.retry = undefined;
      const nonce = randomBytes(16).toString('base64url');
      const timer = setTimeout(() => {
        if (w.pending?.nonce === nonce) w.pending = undefined;
        reject(new WatchTimeout('주인 데몬이 답하지 않았어요'));
      }, WATCH_TIMEOUT_MS);
      timer.unref();
      w.pending = { nonce, settle: { resolve, reject, timer } };
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

  private dropPending(w: Watch, why: string): void {
    const settle = w.pending?.settle;
    w.pending = undefined;
    if (!settle) return;
    clearTimeout(settle.timer);
    settle.reject(new PeerNetworkError(why));
  }

  private rewatch(w: Watch): void {
    this.requestWatch(w)
      .then((r) => {
        if (r === 'waiting') w.feed.markWaiting();
      })
      .catch((err: unknown) => {
        if (err instanceof WatchRefused) return this.onRefused(w, err.reason);
        w.feed.markOffline();
        // 앞 요청을 버려서 실패한 건 새 요청이 이미 나갔으니 다시 걸지 않는다
        if (err instanceof WatchTimeout) this.scheduleRewatch(w);
      });
  }

  /**
   * 조금 뒤에 다시 청한다. 주인 데몬이 답하지 않았거나 too_many처럼 다시 청하면 되는 거절일 때다.
   * 이게 없으면 다음 presence가 올 때까지 보기가 offline에 멈춘다. 간격은 두 배씩 늘린다.
   */
  private scheduleRewatch(w: Watch): void {
    if (w.retry || w.retries >= MAX_REWATCH_RETRIES || !this.watches.has(w.id)) return;
    const delay = Math.min(MAX_REWATCH_DELAY_MS, 1000 * 2 ** w.retries);
    w.retries++;
    w.retry = setTimeout(() => {
      w.retry = undefined;
      if (this.watches.has(w.id) && !w.pending) this.rewatch(w);
    }, delay);
    w.retry.unref();
  }

  /** 주인 데몬이 보기를 거절했다. 다시 청해도 안 되는 이유면 보기를 끝낸다 */
  private onRefused(w: Watch, reason: string): void {
    if (!FINAL_REFUSALS.has(reason)) {
      w.feed.markOffline();
      this.scheduleRewatch(w);
      return;
    }
    const closeAs = reason === 'not_found' || reason === 'bad_proof' ? 'share_closed' : reason;
    this.closeWatch(w, closeAs);
  }

  private onWatchReply(
    from: string,
    msg: Extract<BoxMessage, { t: 'watch_ok' | 'watch_err' | 'watch_wait' }>,
  ): void {
    const w = [...this.watches.values()].find(
      (x) => x.owner === from && x.share === msg.share && x.pending?.nonce === msg.nonce,
    );
    if (!w || !w.pending) {
      // 기다리다 그만둔 뒤 취소와 승인이 엇갈리면 맞는 보기가 없는 watch_ok가 온다. 주인 쪽에
      // 구독이 열린 채로 남지 않게 그 구독을 끊어 달라고 돌려보낸다
      if (msg.t === 'watch_ok' && typeof msg.sub === 'string' && isShareId(msg.share)) {
        this.sendBox(from, { t: 'unwatch', share: msg.share, sub: msg.sub });
      }
      return;
    }
    const settle = w.pending.settle;
    w.retries = 0;
    if (msg.t === 'watch_wait') {
      w.feed.markWaiting();
      if (settle) {
        clearTimeout(settle.timer);
        w.pending.settle = undefined;
        settle.resolve('waiting');
      }
      return;
    }
    w.pending = undefined;
    if (settle) clearTimeout(settle.timer);
    if (msg.t === 'watch_err') {
      // 주인 데몬이 보낸 글자라 CLI와 뷰어에 찍히기 전에 정리한다
      const err = new WatchRefused(plainLabel(msg.reason, 64) ?? 'unknown');
      if (settle) settle.reject(err);
      else this.onRefused(w, err.reason);
      return;
    }
    if (typeof msg.sub !== 'string' || typeof msg.salt !== 'string') {
      const err = new PeerNetworkError('주인 데몬 답이 맞지 않아요');
      if (settle) settle.reject(err);
      else w.feed.markOffline();
      return;
    }
    w.sub = msg.sub;
    w.messages = msg.messages === true;
    w.key = streamKey(
      w.shareKey,
      Buffer.from(msg.salt, 'base64url'),
      w.share,
      this.key.id,
      msg.sub,
    );
    settle?.resolve('ok');
  }

  private onWatchEnd(from: string, msg: Extract<BoxMessage, { t: 'watch_end' }>): void {
    const w = [...this.watches.values()].find((x) => x.owner === from && x.sub === msg.sub);
    if (!w) return;
    w.sub = undefined;
    w.key?.fill(0);
    w.key = undefined;
    // 주인이 끊었으면 다시 청하지 않는다. 다시 청해도 주인 데몬이 kicked로 거절한다
    if (msg.reason === 'kicked') return this.closeWatch(w, 'kicked');
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
    if (w.retry) clearTimeout(w.retry);
    w.retry = undefined;
    // 승인을 기다리던 중이면 주인 쪽 대기가 시한까지 남지 않게 그 nonce로 취소를 보낸다
    if (w.pending && !w.sub) {
      this.sendBox(w.owner, { t: 'watch_cancel', share: w.share, nonce: w.pending.nonce });
    }
    this.dropPending(w, `보기가 끝났어요: ${reason}`);
    w.key?.fill(0);
    w.key = undefined;
    this.closedWatches.push({
      id: w.id,
      share: w.share,
      owner: w.feed.ownerPerson,
      events: w.feed.eventCount,
      reason,
    });
    if (this.closedWatches.length > MAX_CLOSED_WATCHES) this.closedWatches.shift();
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

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
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
