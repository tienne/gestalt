import { errMessage, PeerNetworkError } from './errors.js';
import type { MachineKey } from './keys.js';
import { MESSAGE_RECEIVE_LIMIT, plainLabel, RateLimiter } from './message.js';
import type { MirrorFeed } from './mirror.js';
import type { OwnedShare } from './network.js';
import { isPeekCursor, isPeekId, newPeekId, normalizePeek, peekJson } from './peek.js';
import type { PeerPeek } from './peek.js';
import type { PeekNotice } from './protocol.js';
import { isShareId } from './roster.js';
import { canonical, hmac, safeEqual } from './seal.js';
import type { PeerState } from './state.js';
import { RelaySendError } from './transport.js';

/**
 * ges_peer peek의 봉인 요청과 답. 보는 쪽(요청 보내기, 답 받기)과 주인 쪽(요청 검사, 요약 주기, 훅
 * 알림)이 다 여기 있다. 요약을 만드는 건 peek.ts다. 통로와 명단, 승인 기록은 PeerNetwork가 들고
 * 있고 이 쪽은 PeekHost로만 닿는다.
 */

/** 요약을 가져갔다고 주인 세션에 알리는 시간. 이 동안 보는 중 표시 훅이 한 줄을 붙인다 */
export const PEEK_NOTICE_MS = 10 * 60 * 1000;
/** 보는 쪽이 요약 답을 기다리는 시한. 이전 버전 주인 데몬은 peek을 몰라서 답하지 않는다 */
export const PEEK_TIMEOUT_MS = 10_000;
/** 보는 쪽에서 답을 기다리는 요약 요청 수 */
const MAX_PENDING_PEEKS = 16;
/** 주인 쪽이 기억하는 요약 요청 id 수. PeerNetwork의 메시지 기억(seenMessages)과는 따로 센다 */
const MAX_SEEN_PEEKS = 4096;

/**
 * 주인 데몬이 보낼 수 있는 거절 이유. 이 밖의 글자는 unknown으로 바꾼다. 거절 문구는 MCP 오류로 보는
 * 쪽 모델에 들어가므로 주인 데몬이 지어낸 글자를 싣지 않는다
 */
const PEEK_REASONS = new Set([
  'share_closed',
  'bad_frame',
  'bad_proof',
  'kicked',
  'denied',
  'not_approved',
  'peek_off',
  'rate_limited',
]);

/** 요약 요청과 답 봉인. PeerNetwork의 봉인 종류에 같이 든다 */
export type PeekBox =
  /** 보는 쪽 → 주인. 보는 쪽 에이전트의 요약 요청. proof는 링크의 공유 키로 만든다 */
  | { t: 'peek'; share: string; id: string; since?: string; proof: string }
  /** 주인 → 보는 쪽. 요약이나 거절 이유 둘 중 하나가 든다 */
  | { t: 'peek_reply'; share: string; id: string; peek?: PeerPeek; reason?: string };

/** 보는 쪽에서 본 원격 공유 하나 */
export interface PeekWatch {
  id: string;
  owner: string;
  share: string;
  /** 링크의 공유 키 */
  shareKey: Buffer;
  feed: MirrorFeed;
}

/**
 * 보는 쪽 에이전트가 준 공유 id로 보고 있는 원격 공유를 고른다. 주인 쪽 공유 id가 먼저고 보기 id도
 * 받는다. 못 찾으면 지금 보는 공유 id와 주인 이름을 실패 문구에 싣는다. 에이전트가 따로 목록을
 * 부르지 않고 다시 고를 수 있게 하려는 것이다. peek과 send가 같이 쓴다.
 */
export function pickWatch<T extends PeekWatch>(list: T[], target: string): T {
  if (!isShareId(target)) throw new PeerNetworkError('공유 id 꼴이 아니에요');
  const w = list.find((x) => x.share === target) ?? list.find((x) => x.id === target);
  if (w) return w;
  const open = list.map((x) => `${x.share} (${plainLabel(x.feed.ownerPerson, 32) ?? '?'})`);
  throw new PeerNetworkError(
    open.length === 0
      ? '보고 있는 공유가 없어요. 사람이 `gestalt peer watch <링크>`로 먼저 열어야 해요'
      : `보고 있는 공유가 아니에요: ${target}. 지금 보는 공유는 ${open.join(', ')}예요`,
  );
}

/** 요약 요청과 답이 PeerNetwork에서 빌려 쓰는 것 */
export interface PeekHost {
  readonly state: PeerState;
  readonly key: MachineKey;
  sendBox(to: string, msg: PeekBox): boolean;
  /** 보는 쪽. 보고 있는 원격 공유 */
  watches(): Iterable<PeekWatch>;
  /**
   * 주인 기기에 보낼 봉인을 만든다. 주인이 명단에 없거나 릴레이에 안 붙어 있으면 바로 던진다. 돌려준
   * 함수를 부르면 릴레이 큐에 안 넣고 보낸다. 주인이 오프라인이면 바로 실패한다
   */
  prepareDirect(owner: string, msg: PeekBox): () => Promise<'queued' | 'delivered'>;
  personOf(machine: string): string;
  /** 이 공유로 이 기기가 보낸 것을 막을 이유(kicked, denied, not_approved). 받으면 undefined */
  refusal(share: string, from: string): string | undefined;
  /** 거절 답과 감사 행 상한. 넘으면 false */
  takeReject(from: string): boolean;
  lookupShare(id: string): OwnedShare | undefined;
  /** 요약을 가져간 사람이 바뀌었다. 데몬이 훅 상태 파일을 다시 쓴다 */
  changed(): void;
}

export interface PeekDeskOptions {
  /** 요약을 가져갔다고 알리는 시간. 테스트가 줄인다 */
  noticeMs?: number;
  /** 보는 쪽이 답을 기다리는 시한. 테스트가 줄인다 */
  timeoutMs?: number;
}

/** 보는 쪽. 답을 기다리는 요약 요청 */
interface PendingPeek {
  owner: string;
  share: string;
  person: string;
  resolve: (r: { peek: PeerPeek; owner: string }) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class PeekDesk {
  /** 주인 쪽. 같은 기기가 같은 공유(`공유|기기`)에서 요약을 가져가는 수. 10분에 36번 */
  private limiter = new RateLimiter(MESSAGE_RECEIVE_LIMIT);
  /** 주인 쪽. 증명이 맞은 요청의 `기기|id`. 릴레이가 같은 봉인을 다시 보내면 버린다 */
  private seen = new Set<string>();
  /** 주인 쪽. 공유마다 최근 요약을 가져간 사람(명단 이름)과 시각. 알리는 시간이 지나면 지운다 */
  private peeked = new Map<string, Map<string, { at: number; timer: NodeJS.Timeout }>>();
  /** 보는 쪽. 답을 기다리는 요약 요청. 키는 요청 id */
  private pending = new Map<string, PendingPeek>();
  private readonly noticeMs: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly host: PeekHost,
    options: PeekDeskOptions = {},
  ) {
    this.noticeMs = options.noticeMs ?? PEEK_NOTICE_MS;
    this.timeoutMs = options.timeoutMs ?? PEEK_TIMEOUT_MS;
  }

  stop(): void {
    for (const map of this.peeked.values()) for (const p of map.values()) clearTimeout(p.timer);
    this.peeked.clear();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new PeerNetworkError('데몬이 멈췄어요'));
    }
    this.pending.clear();
  }

  /** 요약 봉인을 받는다. PeerNetwork.onReceive가 넘긴다 */
  receive(from: string, msg: PeekBox): void {
    if (msg.t === 'peek') this.onRequest(from, msg);
    else this.onReply(from, msg);
  }

  /** 주인 쪽: 그 공유에서 최근 요약을 가져간 사람 */
  notices(share: string): PeekNotice[] {
    return [...(this.peeked.get(share) ?? [])].map(([person, p]) => ({ person, at: p.at }));
  }

  /** 주인 쪽: 공유가 닫혔다. 그 공유의 알림을 버린다 */
  forget(share: string): void {
    for (const p of this.peeked.get(share)?.values() ?? []) clearTimeout(p.timer);
    this.peeked.delete(share);
  }

  /**
   * 보는 쪽: 보고 있는 공유의 요약을 주인 데몬에 청한다. target은 주인 쪽 공유 id이고 보기 id도
   * 받는다. 증명은 메시지처럼 링크의 공유 키로 만든다. 받아 줄지는 주인 데몬이 명단과 증명, 승인과
   * kick 기록으로 정한다. 받은 요약은 주인 데몬이 보낸 값이라 꼴과 크기를 다시 본다.
   */
  async peek(target: string, since?: string): Promise<{ peek: PeerPeek; owner: string }> {
    if (since !== undefined && !isPeekCursor(since)) {
      throw new PeerNetworkError('since는 앞 peek이 돌려준 cursor예요');
    }
    const w = pickWatch([...this.host.watches()], target);
    if (this.pending.size >= MAX_PENDING_PEEKS) {
      throw new PeerNetworkError('답을 기다리는 요약 요청이 많아요. 조금 뒤에 다시 불러 주세요');
    }
    const id = newPeekId();
    const send = this.host.prepareDirect(w.owner, {
      t: 'peek',
      share: w.share,
      id,
      ...(since !== undefined ? { since } : {}),
      proof: hmac(w.shareKey, peekProofText(w.share, this.host.key.id, id, since)),
    });
    const reply = new Promise<{ peek: PeerPeek; owner: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new PeerNetworkError('주인 데몬이 답하지 않았어요. 요약을 모르는 이전 버전일 수 있어요'),
        );
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(id, {
        owner: w.owner,
        share: w.share,
        person: w.feed.ownerPerson,
        resolve,
        reject,
        timer,
      });
    });
    // 릴레이 ack를 기다리는 사이에 답이나 시한이 먼저 올 수 있다. 그때 reply를 아무도 안 잡고 있으면
    // 처리되지 않은 reject로 데몬이 죽는다. 부르는 쪽은 아래 return으로 같은 reject를 그대로 받는다
    reply.catch(() => {});
    try {
      await send();
    } catch (err) {
      const p = this.pending.get(id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(id);
      }
      const reason = err instanceof RelaySendError ? err.reason : errMessage(err);
      throw new PeerNetworkError(
        `주인 데몬에 요약을 요청하지 못했어요 (${plainLabel(reason, 64)})`,
      );
    }
    return reply;
  }

  /** 보는 쪽: 주인 데몬의 요약 답. id와 보낸 기기, 공유가 내가 낸 요청과 맞는 답만 꺼낸다 */
  private onReply(from: string, msg: Extract<PeekBox, { t: 'peek_reply' }>): void {
    if (!isPeekId(msg.id)) return;
    const p = this.pending.get(msg.id);
    if (!p || p.owner !== from || p.share !== msg.share) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.peek === undefined) {
      const reason =
        typeof msg.reason === 'string' && PEEK_REASONS.has(msg.reason) ? msg.reason : 'unknown';
      return p.reject(new PeerNetworkError(peekRefusalText(reason)));
    }
    const peek = normalizePeek(msg.peek);
    if (!peek || peek.share !== p.share) {
      return p.reject(new PeerNetworkError('주인 데몬이 보낸 요약 꼴이 맞지 않아요'));
    }
    this.host.state.audit(
      'peek_receive',
      null,
      JSON.stringify({ share: p.share, owner: plainLabel(p.person, 32) ?? '?' }),
    );
    p.resolve({ peek, owner: p.person });
  }

  /**
   * 주인 쪽: 요약 요청을 검사하고 답한다. 메시지처럼 구독이 아니라 링크 증명과 승인, kick 기록으로
   * 본다. 그래서 구독이 끊긴 사람도 받아 준 기기면 가져가고 승인 전이나 kick된 기기는 막힌다.
   * 순서는 꼴 → 공유 → 증명 → 승인과 kick → `--agent-peek` → 횟수다. 가져가면 감사 로그에 남기고
   * 보는 중 표시 훅으로 주인 세션에 한동안 알린다.
   */
  private onRequest(from: string, msg: Extract<PeekBox, { t: 'peek' }>): void {
    // 꼴이 틀린 id는 감사 로그와 답으로 흘러가지 않게 답 없이 버린다. network.test.ts의 "꼴이 틀린 공유
    // id나 요청 id의 요약 요청은 답도 감사 행도 없이 버린다"가 본다
    if (!isShareId(msg.share) || !isPeekId(msg.id)) return;
    const dedupe = `${from}|${msg.id}`;
    if (this.seen.has(dedupe)) return;
    const person = this.host.personOf(from);
    const reject = (reason: string): void => {
      if (!this.host.takeReject(from)) return;
      this.host.sendBox(from, { t: 'peek_reply', share: msg.share, id: msg.id, reason });
      this.host.state.audit(
        'peek_reject',
        msg.share,
        JSON.stringify({ id: msg.id, person, reason }),
      );
    };
    const owned = this.host.lookupShare(msg.share);
    if (!owned || owned.stream.isClosed) return reject('share_closed');
    if (typeof msg.proof !== 'string' || (msg.since !== undefined && !isPeekCursor(msg.since))) {
      return reject('bad_frame');
    }
    const expected = hmac(
      Buffer.from(owned.shareKey, 'base64url'),
      peekProofText(msg.share, from, msg.id, msg.since),
    );
    if (!safeEqual(msg.proof, expected)) return reject('bad_proof');
    // 기억은 증명이 맞은 뒤에 한다. 앞에서 기억하면 증명 없는 가짜 id로 칸을 밀어낼 수 있다. 거절한
    // 요청도 기억해서 다시 와도 답과 감사 행을 또 쓰지 않는다. 요약 요청 id는 PeekDesk.seen에만
    // 기억하고 PeerNetwork의 seenMessages와 같이 쓰지 않는다
    this.seen.add(dedupe);
    if (this.seen.size > MAX_SEEN_PEEKS) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    const refusal = this.host.refusal(msg.share, from);
    if (refusal) return reject(refusal);
    if (!owned.peek) return reject('peek_off');
    if (!this.limiter.take(`${msg.share}|${from}`)) return reject('rate_limited');
    const peek = owned.peek(msg.since);
    this.host.sendBox(from, { t: 'peek_reply', share: msg.share, id: msg.id, peek });
    this.host.state.audit(
      'peek_serve',
      msg.share,
      JSON.stringify({
        id: msg.id,
        person,
        since: msg.since ?? null,
        bytes: Buffer.byteLength(peekJson(peek)),
      }),
    );
    this.note(msg.share, person);
  }

  /** 주인 쪽: 요약을 가져간 사람을 알리는 시간 동안 기억한다. 다시 가져가면 시간을 새로 잰다 */
  private note(share: string, person: string): void {
    let map = this.peeked.get(share);
    if (!map) {
      map = new Map();
      this.peeked.set(share, map);
    }
    const prev = map.get(person);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => {
      const m = this.peeked.get(share);
      if (m?.get(person)?.timer !== timer) return;
      m.delete(person);
      if (m.size === 0) this.peeked.delete(share);
      this.host.changed();
    }, this.noticeMs);
    timer.unref();
    map.set(person, { at: Date.now(), timer });
    this.host.changed();
  }
}

/** 요약 거절 이유를 사람이 읽는 문장으로. 이유 글자는 끝에 괄호로 남겨 스크립트가 찾게 한다 */
export function peekRefusalText(reason: string): string {
  switch (reason) {
    case 'peek_off':
      return '주인이 에이전트 요약을 허락하지 않았어요. 주인이 공유를 --agent-peek으로 열어야 해요 (peek_off)';
    case 'not_approved':
      return '주인이 아직 받아 주지 않았어요 (not_approved)';
    case 'kicked':
      return '주인이 이 공유에서 끊었어요 (kicked)';
    case 'denied':
      return '주인이 거절했어요 (denied)';
    case 'rate_limited':
      return '요약을 너무 자주 가져갔어요. 10분에 36번까지예요 (rate_limited)';
    default:
      return `주인 데몬이 요약을 거절했어요 (${reason})`;
  }
}

/** 링크를 가진 쪽만 만드는 요약 요청 증명. 요청 id와 since까지 넣어 릴레이가 바꾸지 못하게 한다 */
export function peekProofText(
  share: string,
  from: string,
  id: string,
  since: string | undefined,
): string {
  return canonical({ p: 'gestalt-peer-peek-v1', share, from, id, since: since ?? '' });
}
