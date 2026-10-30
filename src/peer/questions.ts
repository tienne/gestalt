import type { MachineKey } from './keys.js';
import type { InboxResult } from './inbox.js';
import type { MirrorFeed } from './mirror.js';
import {
  cleanQuestion,
  isQuestionId,
  MAX_MESSAGE_BYTES,
  MAX_QUESTION_BYTES,
  MESSAGE_RECEIVE_LIMIT,
  newQuestionId,
  plainLabel,
  RateLimiter,
  sanitizeMessageBody,
} from './message.js';
import type { InboundAnswer, InboundMessage, OwnedShare } from './network.js';
import { errMessage, PeerNetworkError } from './errors.js';
import { isShareId } from './roster.js';
import { canonical, signText, verifyText } from './seal.js';
import type { PeerState } from './state.js';
import { RelaySendError } from './transport.js';

/**
 * ges_peer ask_user. 주인 세션 모델이 공유를 보는 팀원에게 묻고 그 사람 기기가 서명한 답을 받는다.
 * 주인 쪽(질문 내기, 답 검사)과 보는 쪽(질문 받기, 답 서명)이 다 여기 있다. 통로와 명단, 승인 기록은
 * PeerNetwork가 들고 있고 이 쪽은 QuestionHost로만 닿는다.
 */

/** 한 데몬이 동시에 열어 두는 질문 수 */
export const MAX_OPEN_QUESTIONS = 32;
/** 질문 시한의 기본값과 범위 */
export const DEFAULT_ASK_TTL_MS = 10 * 60 * 1000;
export const MIN_ASK_TTL_MS = 60 * 1000;
export const MAX_ASK_TTL_MS = 60 * 60 * 1000;
/** 답의 서명 시각이 이만큼 어긋나도 받는다. 기기끼리 시계가 조금씩 다르다 */
const ANSWER_CLOCK_SKEW_MS = 5 * 60 * 1000;
/** Ed25519 서명을 base64url로 쓴 길이 */
const SIGNATURE_CHARS = 86;
/** 닫힌 질문 id를 기억하는 수. 늦게 온 답에 answered, expired로 답하려고 둔다 */
const MAX_CLOSED_QUESTIONS = 256;

/** ges_peer ask_user의 답 */
export interface AskResult {
  question: string;
  /** 질문이 간 사람 */
  to: string[];
  /** 질문이 간 공유 id */
  shares: string[];
  expiresAt: number;
}

/** 질문과 답에 쓰는 봉인 메시지. PeerNetwork의 봉인 종류에 같이 든다 */
export type QuestionBox =
  /** 주인 → 보는 쪽. 주인 세션 모델의 질문 */
  | { t: 'ask'; share: string; q: string; text: string; expiresAt: number }
  /** 주인 → 보는 쪽. 다른 사람이 먼저 답했거나(answered) 시한이 지나(expired) 끝났다 */
  | { t: 'ask_close'; share: string; q: string; reason: string }
  /** 보는 쪽 → 주인. 뷰어에서 사람이 쓴 답. sig는 answerSignedText에 건 기기 서명이다 */
  | { t: 'answer'; share: string; q: string; body: string; at: number; sig: string }
  /**
   * 주인 → 보는 쪽. 답 상태. reopened는 주인 세션에 넣지 못해 질문을 다시 열었다는 뜻이라 보는 쪽이
   * 다시 답할 수 있다
   */
  | {
      t: 'answer_status';
      share: string;
      q: string;
      status: AnswerStatus;
      reason?: string;
      reopened?: boolean;
    };

type AnswerStatus = 'inserted' | 'delivered' | 'rejected';

/** 주인 쪽. 주인 세션 모델이 낸 질문 하나 */
interface OpenQuestion {
  id: string;
  /** 질문을 보낸 자리. `공유|기기`다 */
  asked: Set<string>;
  askedAt: number;
  expiresAt: number;
  timer: NodeJS.Timeout;
  /** 답 하나를 넣는 중이다. 동시에 온 다른 답은 answered로 막는다 */
  answering: boolean;
}

/** 주인 쪽에서 본 원격 구독 하나 */
export interface QuestionSub {
  share: string;
  watcher: string;
  ended: boolean;
}

/** 보는 쪽에서 본 원격 공유 하나 */
export interface QuestionWatch {
  id: string;
  owner: string;
  share: string;
  /** 구독이 열려 있으면 있다 */
  sub?: string;
  feed: MirrorFeed;
}

/** 질문과 답이 PeerNetwork에서 빌려 쓰는 것 */
export interface QuestionHost {
  readonly state: PeerState;
  readonly key: MachineKey;
  sendBox(to: string, msg: QuestionBox): boolean;
  /** 주인 쪽. 지금 열린 원격 구독 */
  subs(): Iterable<QuestionSub>;
  /** 보는 쪽. 보고 있는 원격 공유 */
  watches(): Iterable<QuestionWatch>;
  watch(id: string): QuestionWatch | undefined;
  personOf(machine: string): string;
  machinesOf(person: string): string[];
  /** 이 공유로 이 기기가 보낸 것을 막을 이유(kicked, denied, not_approved). 받으면 undefined */
  refusal(share: string, from: string): string | undefined;
  /** 거절 답과 감사 행 상한. 넘으면 false */
  takeReject(from: string): boolean;
  lookupShare(id: string): OwnedShare | undefined;
  insertInbound(
    deliver: NonNullable<OwnedShare['deliver']>,
    inbound: InboundMessage | InboundAnswer,
    on: { inserted(maybeWritten: boolean): void; delivered(): void },
  ): Promise<InboxResult>;
  /**
   * 주인 기기에 보낼 봉인을 만든다. 주인이 명단에 없거나 릴레이에 안 붙어 있으면 바로 던진다. 돌려준
   * 함수를 부르면 릴레이 큐에 넣어 보낸다
   */
  prepareSend(owner: string, msg: QuestionBox): () => Promise<'queued' | 'delivered'>;
}

export class QuestionDesk {
  /** 주인 쪽. 열린 질문. 공유처럼 데몬이 다시 뜨면 사라진다 */
  private open = new Map<string, OpenQuestion>();
  /** 주인 쪽. 닫힌 질문과 닫힌 이유. 늦게 온 답의 거절 이유로 쓴다 */
  private closed = new Map<string, 'answered' | 'expired'>();
  /**
   * 보는 쪽. 주인 기기마다 받는 새 질문 수. 질문마다 감사 행과 뷰어 알림이 따른다. 주인 쪽이 열린
   * 질문 32개와 최소 시한 60초를 허용하므로 메시지 수신 한도(10분에 36건)를 쓴다
   */
  private askLimiter = new RateLimiter(MESSAGE_RECEIVE_LIMIT);
  /**
   * 주인 쪽. 같은 기기가 같은 공유(`공유|기기`)에서 인박스에 답을 넣으려는 수를 10분에 36번으로 센다.
   * 인박스가 없는 동안 다시 열린 질문에 계속 답하는 경우를 위해 뒀다. network.test.ts의 "같은 기기가
   * 인박스에 계속 못 넣는 답을 보내면 36번 뒤에 rate_limited로 막는다"가 본다
   */
  private answerLimiter = new RateLimiter(MESSAGE_RECEIVE_LIMIT);

  constructor(private readonly host: QuestionHost) {}

  stop(): void {
    for (const q of this.open.values()) clearTimeout(q.timer);
    this.open.clear();
  }

  /** 질문과 답 봉인을 받는다. PeerNetwork.onReceive가 넘긴다 */
  receive(from: string, msg: QuestionBox): void {
    switch (msg.t) {
      case 'ask':
        return this.onAsk(from, msg);
      case 'ask_close':
        return this.onAskClose(from, msg);
      case 'answer':
        return void this.onAnswer(from, msg).catch((err: unknown) => {
          process.stderr.write(`[peer] answer failed: ${errMessage(err)}\n`);
        });
      case 'answer_status':
        return this.onAnswerStatus(from, msg);
    }
  }

  /**
   * 주인 쪽: 주인 세션 모델의 질문을 그 세션 공유를 지금 보고 있는 팀원에게 보낸다. to를 주면 그
   * 사람 기기만이다. 구독이 열린 기기만 받으므로 승인 전, 거절, kick된 기기에는 안 간다. 질문
   * 글자는 부르는 쪽이 가린 뒤 넘긴다. 답은 나중에 onAnswer가 받아 주인 세션에 넣는다.
   */
  ask(shares: string[], raw: string, to: string | undefined, ttlMs: number): AskResult {
    // 말없이 자르면 모델은 질문이 다 갔다고 여긴다. 넘으면 거절해서 줄여 다시 내게 한다
    if (Buffer.byteLength(raw) > MAX_QUESTION_BYTES) {
      throw new PeerNetworkError(
        `질문이 ${MAX_QUESTION_BYTES / 1024}KB를 넘어요. 줄여서 다시 보내 주세요`,
      );
    }
    const text = cleanQuestion(raw);
    if (!text) throw new PeerNetworkError('질문이 비었어요');
    if (this.open.size >= MAX_OPEN_QUESTIONS) {
      throw new PeerNetworkError(`열린 질문이 ${MAX_OPEN_QUESTIONS}개라 더 못 내요`);
    }
    const only = to === undefined ? undefined : new Set(this.host.machinesOf(to));
    const targets = new Map<string, QuestionSub>();
    for (const sub of this.host.subs()) {
      if (sub.ended || !shares.includes(sub.share)) continue;
      if (only && !only.has(sub.watcher)) continue;
      targets.set(`${sub.share}|${sub.watcher}`, sub);
    }
    if (targets.size === 0) {
      throw new PeerNetworkError(
        to === undefined
          ? '지금 이 세션을 보는 팀원이 없어요'
          : `${plainLabel(to, 32) ?? '?'} 님은 지금 이 세션을 보고 있지 않아요`,
      );
    }

    const id = newQuestionId();
    const askedAt = Date.now();
    const expiresAt = askedAt + ttlMs;
    const asked = new Set<string>();
    for (const [key, sub] of targets) {
      const sent = this.host.sendBox(sub.watcher, {
        t: 'ask',
        share: sub.share,
        q: id,
        text,
        expiresAt,
      });
      if (sent) asked.add(key);
    }
    if (asked.size === 0) throw new PeerNetworkError('릴레이에 안 붙어 있어요');
    const timer = setTimeout(() => this.expireQuestion(id), ttlMs);
    timer.unref();
    this.open.set(id, { id, asked, askedAt, expiresAt, timer, answering: false });

    const sent = [...asked].map((key) => targets.get(key)!);
    const persons = unique(sent.map((s) => this.host.personOf(s.watcher)));
    const sentShares = unique(sent.map((s) => s.share));
    for (const share of sentShares) {
      this.host.state.audit(
        'ask_open',
        share,
        JSON.stringify({
          question: id,
          persons: unique(
            sent.filter((s) => s.share === share).map((s) => this.host.personOf(s.watcher)),
          ),
          expiresAt,
        }),
      );
    }
    return { question: id, to: persons, shares: sentShares, expiresAt };
  }

  private expireQuestion(id: string): void {
    const q = this.open.get(id);
    if (!q) return;
    this.closeQuestion(q, 'expired');
    try {
      this.host.state.audit('ask_expire', null, JSON.stringify({ question: id }));
    } catch {
      // 데몬이 멈추는 중이면 DB가 이미 닫혔을 수 있다
    }
  }

  /** 질문을 끝내고 받은 사람 뷰어에 알린다. except 자리(먼저 답한 기기)에는 안 알린다 */
  private closeQuestion(q: OpenQuestion, reason: 'answered' | 'expired', except?: string): void {
    if (this.open.get(q.id) !== q) return;
    clearTimeout(q.timer);
    this.open.delete(q.id);
    this.closed.set(q.id, reason);
    if (this.closed.size > MAX_CLOSED_QUESTIONS) {
      const oldest = this.closed.keys().next().value;
      if (oldest !== undefined) this.closed.delete(oldest);
    }
    for (const key of q.asked) {
      if (key === except) continue;
      const [share, watcher] = key.split('|') as [string, string];
      this.host.sendBox(watcher, { t: 'ask_close', share, q: q.id, reason });
    }
  }

  /**
   * 주인 쪽: 답을 검사하고 주인 세션 인박스에 `<peer-answer … verified>`로 넣는다. 검사 순서는
   * 제안서 "ask_user 서명 답" 절의 표와 같다. 하나라도 걸리면 넣지 않는다. network.test.ts의 "ask_user 서명
   * 답" 블록이 kicked, not_approved, not_asked, answered, bad_signature, bad_frame, bad_time, expired, 길이
   * 검사, rate_limited, 인박스 실패 뒤 처리를 넣어 본다.
   */
  private async onAnswer(from: string, msg: Extract<QuestionBox, { t: 'answer' }>): Promise<void> {
    // 꼴이 틀린 id는 감사 로그와 답으로 흘러가지 않게 답 없이 버린다
    if (!isShareId(msg.share) || !isQuestionId(msg.q)) return;
    const person = this.host.personOf(from);
    const status = (s: AnswerStatus, reason?: string): void => {
      this.host.sendBox(from, {
        t: 'answer_status',
        share: msg.share,
        q: msg.q,
        status: s,
        ...(reason ? { reason } : {}),
      });
    };
    const reject = (reason: string): void => {
      if (!this.host.takeReject(from)) return;
      status('rejected', reason);
      this.host.state.audit(
        'answer_reject',
        msg.share,
        JSON.stringify({ question: msg.q, person, reason }),
      );
    };

    const owned = this.host.lookupShare(msg.share);
    if (!owned || owned.stream.isClosed) return reject('share_closed');
    const deliver = owned.deliver;
    if (!deliver) return reject('messages_off');
    // 승인과 kick은 구독이 아니라 공유 단위 기록으로 본다. 질문을 받은 뒤 끊긴 기기도 여기서 막힌다
    const refusal = this.host.refusal(msg.share, from);
    if (refusal) return reject(refusal);
    const q = this.open.get(msg.q);
    if (!q) return reject(this.closed.get(msg.q) ?? 'unknown_question');
    const seat = `${msg.share}|${from}`;
    if (!q.asked.has(seat)) return reject('not_asked');
    if (q.answering) return reject('answered');
    if (
      typeof msg.body !== 'string' ||
      typeof msg.sig !== 'string' ||
      !Number.isSafeInteger(msg.at)
    )
      return reject('bad_frame');
    if (msg.sig.length !== SIGNATURE_CHARS) return reject('bad_signature');
    // 서명 검증 비용이 본문 크기에 비례해서 상한을 먼저 본다. UTF-16 길이는 바이트 수보다 크지 않다
    if (msg.body.length > MAX_MESSAGE_BYTES) {
      return reject(`본문이 ${MAX_MESSAGE_BYTES / 1024}KB를 넘어요`);
    }
    if (!verifyText(from, answerSignedText(msg.share, msg.q, msg.body, from, msg.at), msg.sig)) {
      return reject('bad_signature');
    }
    const now = Date.now();
    if (msg.at < q.askedAt - ANSWER_CLOCK_SKEW_MS || msg.at > now + ANSWER_CLOCK_SKEW_MS) {
      return reject('bad_time');
    }
    if (now >= q.expiresAt) return reject('expired');
    const clean = sanitizeMessageBody(msg.body);
    if (!clean.ok) return reject(clean.reason);
    if (!this.answerLimiter.take(seat)) return reject('rate_limited');

    // 인박스 쓰기를 기다리는 사이에 온 다른 답은 answered로 막는다. 소켓에 붙기 전에 실패했거나 deliver가
    // 던졌으면 질문을 열어 두고 답한 기기에 reopened로 알려 다시 답하게 한다. 이 알림은 거절 상한을 타지
    // 않는다. 넣었으면(붙은 뒤 실패 포함) 질문을 먼저 끝내고 넣음을 알린다
    q.answering = true;
    let result: InboxResult = { ok: false, reason: 'deliver_failed' };
    try {
      // 받은 기록이 던지면(DB가 닫히는 중 등) deliver가 던진 것과 같게 넣지 않고 질문을 다시 연다.
      // 넣은 뒤의 감사 기록은 여기서 잡지 않는다. 잡으면 이미 넣음을 알린 기기에 거절을 또 보낸다
      let received = false;
      try {
        this.host.state.audit(
          'answer_receive',
          msg.share,
          JSON.stringify({ question: q.id, person, bytes: Buffer.byteLength(clean.text) }),
        );
        received = true;
      } catch (err) {
        process.stderr.write(`[peer] answer audit failed: ${errMessage(err)}\n`);
      }
      if (received)
        result = await this.host.insertInbound(
          deliver,
          { kind: 'answer', question: q.id, share: msg.share, from, person, body: clean.text },
          {
            inserted: (maybeWritten) => {
              this.closeQuestion(q, 'answered', seat);
              status('inserted');
              this.host.state.audit(
                'answer_insert',
                msg.share,
                JSON.stringify({
                  question: q.id,
                  person,
                  ...(maybeWritten ? { maybeWritten: true } : {}),
                }),
              );
            },
            delivered: () => {
              status('delivered');
              this.host.state.audit(
                'answer_deliver',
                msg.share,
                JSON.stringify({ question: q.id, person }),
              );
            },
          },
        );
    } finally {
      q.answering = false;
    }
    if (result.ok || result.maybeWritten) return;
    this.reopen(from, msg, person, result);
  }

  /**
   * 주인 쪽: 답을 넣지 못했다. 질문이 아직 열려 있으면 reopened를 실어 답한 기기가 다시 답하게 한다. 이
   * 알림은 거절 상한을 타지 않는다
   */
  private reopen(
    from: string,
    msg: Extract<QuestionBox, { t: 'answer' }>,
    person: string,
    result: Extract<InboxResult, { ok: false }>,
  ): void {
    const q = this.open.get(msg.q);
    this.host.sendBox(from, {
      t: 'answer_status',
      share: msg.share,
      q: msg.q,
      status: 'rejected',
      reason: result.reason,
      ...(q && !q.answering ? { reopened: true } : {}),
    });
    try {
      this.host.state.audit(
        'answer_reject',
        msg.share,
        JSON.stringify({ question: msg.q, person, reason: result.reason }),
      );
    } catch (err) {
      process.stderr.write(`[peer] answer audit failed: ${errMessage(err)}\n`);
    }
  }

  /** 보는 쪽: 내가 보는 공유의 주인 데몬이 보낸 질문을 뷰어에 띄운다 */
  private onAsk(from: string, msg: Extract<QuestionBox, { t: 'ask' }>): void {
    if (!isQuestionId(msg.q) || !Number.isSafeInteger(msg.expiresAt)) return;
    // 주인 데몬이 보낸 글자라 보여주기 전에 제어 문자를 지운다
    const text = cleanQuestion(msg.text);
    const now = Date.now();
    if (!text || msg.expiresAt <= now) return;
    const targets = [...this.host.watches()].filter(
      (w) => w.owner === from && w.share === msg.share && w.sub && !w.feed.getQuestion(msg.q),
    );
    if (targets.length === 0) return;
    // 새 질문 수를 주인 기기마다 10분에 36개로 센다. 질문마다 감사 행과 뷰어 알림이 따른다
    if (!this.askLimiter.take(from)) {
      process.stderr.write('[peer] ask dropped: rate limited\n');
      return;
    }
    for (const w of targets) {
      w.feed.addQuestion(msg.q, text, Math.min(msg.expiresAt, now + MAX_ASK_TTL_MS));
      this.host.state.audit(
        'ask_receive',
        null,
        JSON.stringify({ watch: w.id, share: w.share, question: msg.q }),
      );
    }
  }

  private onAskClose(from: string, msg: Extract<QuestionBox, { t: 'ask_close' }>): void {
    if (!isQuestionId(msg.q)) return;
    const reason = plainLabel(msg.reason, 32);
    for (const w of this.host.watches()) {
      if (w.owner === from && w.share === msg.share) w.feed.setQuestion(msg.q, 'closed', reason);
    }
  }

  private onAnswerStatus(from: string, msg: Extract<QuestionBox, { t: 'answer_status' }>): void {
    if (!isQuestionId(msg.q)) return;
    if (msg.status !== 'inserted' && msg.status !== 'delivered' && msg.status !== 'rejected')
      return;
    const reason = plainLabel(msg.reason);
    for (const w of this.host.watches()) {
      if (w.owner !== from || w.share !== msg.share) continue;
      if (msg.status === 'rejected' && msg.reopened === true) w.feed.reopenQuestion(msg.q, reason);
      else w.feed.setQuestion(msg.q, msg.status, reason);
    }
  }

  /**
   * 보는 쪽: 뷰어에서 사람이 쓴 답을 기기 키로 서명해 주인 데몬에 보낸다. 부르는 곳은 lookupWatch가
   * 뷰어에 넘기는 answer 하나다. IPC에 답 요청이 없는 건 network.test.ts의 "IPC와 MCP 도구에는 답을
   * 서명하는 길이 없다"가 본다. 주인 데몬이 오프라인이면 릴레이가 메시지처럼 들고 있는다.
   */
  async answer(watchId: string, question: string, raw: string): Promise<{ question: string }> {
    const w = this.host.watch(watchId);
    if (!w) throw new PeerNetworkError(`보고 있는 공유가 아니에요: ${watchId}`);
    const q = isQuestionId(question) ? w.feed.getQuestion(question) : undefined;
    if (!q || q.state !== 'open') throw new PeerNetworkError('답할 수 있는 질문이 아니에요');
    if (Date.now() >= q.expiresAt) {
      w.feed.setQuestion(q.id, 'closed', 'expired');
      throw new PeerNetworkError('시한이 지난 질문이에요');
    }
    const clean = sanitizeMessageBody(raw);
    if (!clean.ok) throw new PeerNetworkError(clean.reason);
    const at = Date.now();
    const key = this.host.key;
    const box: QuestionBox = {
      t: 'answer',
      share: w.share,
      q: q.id,
      body: clean.text,
      at,
      sig: signText(key, answerSignedText(w.share, q.id, clean.text, key.id, at)),
    };
    // 상태를 옮기는 건 봉인 뒤, 첫 await 앞이다. 여기까지가 동기로 돌아서 같은 질문의 두 번째 호출은
    // 위 open 검사에서 걸린다. 주인이 명단에 없거나 릴레이가 끊겼으면 prepareSend가 먼저 던진다
    const send = this.host.prepareSend(w.owner, box);
    w.feed.setQuestion(q.id, 'queued');
    let result: 'queued' | 'delivered';
    try {
      result = await send();
    } catch (err) {
      const reason = err instanceof RelaySendError ? err.reason : errMessage(err);
      w.feed.setQuestion(q.id, 'rejected', plainLabel(reason));
      throw new PeerNetworkError(`답을 못 보냈어요: ${errMessage(err)}`);
    }
    if (result === 'delivered') w.feed.setQuestion(q.id, 'sent');
    this.host.state.audit(
      'answer_send',
      null,
      JSON.stringify({ watch: w.id, share: w.share, question: q.id }),
    );
    return { question: q.id };
  }
}

/**
 * 답에 거는 기기 서명의 대상. 질문 id와 공유, 본문, 답한 기기, 시각을 한 덩어리로 묶어 어느 질문에
 * 무엇이라고 답했는지를 그 기기가 보증한다. 봉인 상자의 서명은 통로의 서명이라 따로 둔다.
 */
export function answerSignedText(
  share: string,
  question: string,
  body: string,
  device: string,
  at: number,
): string {
  return canonical({ p: 'gestalt-peer-answer-v1', share, question, body, device, at });
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
