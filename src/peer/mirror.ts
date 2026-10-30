import { ShareFeed } from './feed.js';
import type { ShareFrame, ShareListener, ShareStatus } from './feed.js';
import type { MessageStatus, QuestionState } from './message.js';

/** 내가 보낸 메시지 기록 상한. 넘으면 오래된 것부터 잊는다 */
const MAX_MY_MESSAGES = 100;
/** 받아 둔 질문 상한. 넘으면 오래된 것부터 잊는다 */
export const MAX_QUESTIONS_PER_WATCH = 16;

export interface MyQuestion {
  id: string;
  text: string;
  expiresAt: number;
  state: QuestionState;
  reason?: string;
}

export interface MyMessage {
  id: string;
  text: string;
  status: MessageStatus;
  at: number;
  reason?: string;
}

/**
 * 보는 사람 데몬이 원격 공유를 받아 로컬 뷰어로 옮기는 자리. 뷰어 서버는 내 공유와
 * 똑같이 다룬다.
 *
 * 이벤트 번호는 주인 쪽 번호를 그대로 쓴다. 다시 붙어서 이어 받을 때 주인 쪽이 그 사이를
 * 버렸으면 번호가 건너뛴다. 그때는 들고 있던 걸 비우고 건너뛴 개수를 생략으로 알린다.
 */
export class MirrorFeed extends ShareFeed {
  private unknown = 0;
  private mine = new Map<string, MyMessage>();
  /** 미리 두기만 하고 아직 안 알린 메시지. 새로 붙은 뷰어에도 안 보낸다 */
  private reserved = new Set<string>();
  private questions = new Map<string, MyQuestion>();

  constructor(
    id: string,
    readonly ownerKey: string,
    readonly ownerPerson: string,
    readonly shareId: string,
    maxBacklogBytes?: number,
  ) {
    super(id, maxBacklogBytes);
  }

  override get unknownLines(): number {
    return this.unknown;
  }

  /** 주인 쪽 프레임을 반영한다. 주인 쪽 trimmed는 번호 건너뜀으로 따로 잡으므로 무시한다 */
  apply(frames: ShareFrame[]): void {
    if (this.isClosed) return;
    for (const frame of frames) {
      switch (frame.type) {
        case 'event': {
          if (!Number.isSafeInteger(frame.seq) || typeof frame.json !== 'string') continue;
          if (frame.seq <= this.eventCount) continue;
          if (frame.seq > this.eventCount + 1) {
            const gap = frame.seq - 1 - this.eventCount;
            this.skipTo(frame.seq - 1);
            this.emit({ type: 'trimmed', dropped: gap });
          }
          this.pushEvent(frame.json);
          break;
        }
        case 'stats':
          if (Number.isSafeInteger(frame.unknownLines) && frame.unknownLines !== this.unknown) {
            this.unknown = frame.unknownLines;
            this.emit({ type: 'stats', unknownLines: this.unknown });
          }
          break;
        case 'state':
          if (isShareStatus(frame.status)) this.setStatus(frame.status);
          break;
        case 'closed':
          this.close(typeof frame.reason === 'string' ? frame.reason : 'closed');
          return;
        case 'trimmed':
          break;
      }
    }
    this.trim();
  }

  markOffline(): void {
    this.setStatus('offline');
  }

  /** 주인 승인을 기다린다. 받아 주면 주인 쪽 state 프레임이 live로 바꾼다 */
  markWaiting(): void {
    this.setStatus('waiting');
  }

  get messages(): MyMessage[] {
    return [...this.mine.values()];
  }

  /** 내가 보낸 메시지 상태를 바꾸고 붙은 뷰어에 알린다. 뒤 단계에서 앞 단계로는 안 돌아간다 */
  setMessage(id: string, patch: Partial<Omit<MyMessage, 'id'>> & { status: MessageStatus }): void {
    const prev = this.mine.get(id);
    if (prev && STATUS_ORDER[patch.status] < STATUS_ORDER[prev.status]) return;
    const next: MyMessage = {
      id,
      text: patch.text ?? prev?.text ?? '',
      status: patch.status,
      at: patch.at ?? prev?.at ?? Date.now(),
      ...(patch.reason ? { reason: patch.reason } : {}),
    };
    this.mine.delete(id);
    this.mine.set(id, next);
    this.reserved.delete(id);
    this.dropOldest();
    this.emit({ type: 'msg', ...next });
  }

  private dropOldest(): void {
    while (this.mine.size > MAX_MY_MESSAGES) {
      const oldest = this.mine.keys().next().value;
      if (oldest === undefined) break;
      this.mine.delete(oldest);
      this.reserved.delete(oldest);
    }
  }

  /**
   * 보내기 전에 레코드만 둔다. 뷰어에는 안 알린다. 릴레이 답보다 주인 데몬의 상태가 먼저 와도
   * 그 상태를 버리지 않으려고 쓴다. 가장 앞 단계인 queued로 두므로 뒤에 오는 어떤 상태든 덮는다.
   */
  reserveMessage(id: string, text: string, at: number): void {
    this.mine.set(id, { id, text, status: 'queued', at });
    this.reserved.add(id);
    this.dropOldest();
  }

  getMessage(id: string): MyMessage | undefined {
    return this.mine.get(id);
  }

  /** 주인 세션 모델이 나에게 물은 질문을 둔다. 이미 받은 id면 false */
  addQuestion(id: string, text: string, expiresAt: number): boolean {
    if (this.isClosed || this.questions.has(id)) return false;
    const q: MyQuestion = { id, text, expiresAt, state: 'open' };
    this.questions.set(id, q);
    while (this.questions.size > MAX_QUESTIONS_PER_WATCH) {
      const oldest = this.questions.keys().next().value;
      if (oldest === undefined) break;
      this.questions.delete(oldest);
    }
    this.emit({ type: 'ask', ...q });
    return true;
  }

  getQuestion(id: string): MyQuestion | undefined {
    return this.questions.get(id);
  }

  /**
   * 질문 상태를 바꾸고 붙은 뷰어에 알린다. 끝난 상태(delivered, rejected, closed)에서는 안 바뀌고
   * 답 상태는 메시지처럼 뒤 단계에서 앞 단계로 안 돌아간다. closed는 아직 답하지 않았을 때만 된다.
   */
  setQuestion(id: string, state: QuestionState, reason?: string): void {
    const q = this.questions.get(id);
    if (!q || QUESTION_DONE.has(q.state)) return;
    if (state === 'closed' && q.state !== 'open') return;
    if (QUESTION_ORDER[state] < QUESTION_ORDER[q.state]) return;
    q.state = state;
    if (reason) q.reason = reason;
    else delete q.reason;
    this.emit({ type: 'ask', ...q });
  }

  /**
   * 주인 데몬이 내 답을 주인 세션에 못 넣어 질문을 다시 열었다. 내 답이 아직 끝나지 않았거나 거절된
   * 상태이고 시한 전일 때만 open으로 되돌려 다시 답하게 한다. 이유는 남겨 뷰어에 보인다.
   */
  reopenQuestion(id: string, reason?: string, now = Date.now()): void {
    const q = this.questions.get(id);
    if (!q || now >= q.expiresAt) return;
    if (q.state !== 'queued' && q.state !== 'sent' && q.state !== 'rejected') return;
    q.state = 'open';
    if (reason) q.reason = reason;
    else delete q.reason;
    this.emit({ type: 'ask', ...q });
  }

  override subscribe(listener: ShareListener, afterSeq = 0): () => void {
    const off = super.subscribe(listener, afterSeq);
    for (const m of this.mine.values()) {
      if (!this.reserved.has(m.id)) listener({ type: 'msg', ...m });
    }
    for (const q of this.questions.values()) listener({ type: 'ask', ...q });
    return off;
  }
}

const QUESTION_DONE = new Set<QuestionState>(['delivered', 'rejected', 'closed']);

const QUESTION_ORDER: Record<QuestionState, number> = {
  open: 0,
  queued: 1,
  sent: 2,
  inserted: 3,
  delivered: 4,
  rejected: 5,
  closed: 5,
};

/** 거절은 어느 단계에서든 올 수 있어서 끝에 둔다 */
const STATUS_ORDER: Record<MessageStatus, number> = {
  queued: 0,
  sent: 1,
  arrived: 2,
  inserted: 3,
  delivered: 4,
  rejected: 5,
};

/** 주인 쪽이 보내는 상태만 받는다. waiting은 보는 쪽 데몬이 정한다 */
function isShareStatus(v: unknown): v is ShareStatus {
  return v === 'live' || v === 'missing' || v === 'truncated' || v === 'offline';
}
