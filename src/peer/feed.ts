import { errMessage } from './errors.js';
import type { MessageStatus, QuestionState } from './message.js';

/**
 * 뷰어 하나가 받는 것. seq는 SSE id로 써서 다시 붙었을 때 이어 받게 한다. 이벤트는
 * 쌓을 때 한 번 직렬화한 글자를 그대로 넘긴다. 뷰어마다 다시 직렬화하지 않는다.
 */
export type ShareFrame =
  | { type: 'event'; seq: number; json: string }
  /** 붙은 뷰어가 받을 앞부분 중 메모리 상한에 밀려 버려진 이벤트 수 */
  | { type: 'trimmed'; dropped: number }
  | { type: 'stats'; unknownLines: number }
  | { type: 'state'; status: ShareStatus }
  /**
   * 공유 종료. 앞부분을 따라잡는 중에 종료되면 아직 못 보낸 이벤트는 사라지므로 그 개수를
   * missed에 싣는다. 붙어 있던 뷰어는 다 받은 뒤라 안 싣는다
   */
  | { type: 'closed'; reason: string; missed?: number }
  /** 보는 쪽 데몬에서만 생긴다. 내가 보낸 메시지와 그 상태. 주인 쪽 스트림에는 없다 */
  | {
      type: 'msg';
      id: string;
      status: MessageStatus;
      text: string;
      at: number;
      reason?: string;
    }
  /** 보는 쪽 데몬에서만 생긴다. 주인 세션 모델이 나에게 물은 질문과 내 답의 상태 */
  | {
      type: 'ask';
      id: string;
      text: string;
      expiresAt: number;
      state: QuestionState;
      reason?: string;
    };

/**
 * offline은 원격 공유에서 주인 데몬이 릴레이에서 빠졌을 때다. waiting은 원격 공유에서 주인이
 * 첫 접속을 받아 주길 기다릴 때로 보는 쪽 데몬만 쓴다.
 */
export type ShareStatus = 'live' | 'missing' | 'truncated' | 'offline' | 'waiting';

export type ShareListener = (frame: ShareFrame) => void;

/**
 * 새 뷰어에게 다시 보낼 앞부분의 상한. 넘으면 오래된 것부터 버린다. 공유는 최대 7일
 * 열려 있고 도구 출력이 크면 events가 끝없이 는다.
 */
export const DEFAULT_MAX_BACKLOG_BYTES = 32 * 1024 * 1024;

interface Held {
  json: string;
  bytes: number;
}

export interface BacklogSlice {
  /** `afterSeq` 뒤로 상한에 밀려 버려진 이벤트 수 */
  dropped: number;
  items: { seq: number; json: string }[];
}

/**
 * 바꾼 이벤트를 직렬화한 글자로 상한까지 들고 붙은 뷰어에 흘린다. 뷰어 서버는 이것만 안다.
 * 내 대화 기록을 읽는 ShareStream과 원격 공유를 받아 옮기는 MirrorFeed가 이걸 물려받는다.
 *
 * seq는 공유가 연 뒤로 나온 이벤트의 번호다. 앞부분을 버려도 번호는 안 당긴다.
 * 배열 위치로 매기면 버린 만큼 번호가 밀려 Last-Event-ID로 이어 받을 때 겹치거나 빠진다.
 */
export class ShareFeed {
  readonly id: string;

  /**
   * `events[head]`부터가 살아 있다. 앞에서 하나씩 shift하면 큰 배열에서 매번 다 옮긴다.
   * head 앞 칸은 버릴 때 비워 둔다. 압축은 head가 1024를 넘어야 돌아서 칸에 참조를
   * 남기면 버린 이벤트를 GC가 못 가져간다.
   */
  private events: (Held | undefined)[] = [];
  private head = 0;
  /** `events[0]` 앞에서 잘라 낸 이벤트 수. `events[i]`의 seq는 `base + i + 1`이다 */
  private base = 0;
  private backlogBytes = 0;
  private readonly maxBacklogBytes: number;
  private listeners = new Set<ShareListener>();
  protected status: ShareStatus = 'live';
  private closedReason: string | undefined;

  constructor(id: string, maxBacklogBytes = DEFAULT_MAX_BACKLOG_BYTES) {
    this.id = id;
    this.maxBacklogBytes = maxBacklogBytes;
  }

  get currentStatus(): ShareStatus {
    return this.status;
  }

  get unknownLines(): number {
    return 0;
  }

  get eventCount(): number {
    return this.base + this.events.length;
  }

  /** 상한에 밀려 버린 이벤트 수 */
  get droppedEvents(): number {
    return this.base + this.head;
  }

  get viewerCount(): number {
    return this.listeners.size;
  }

  get isClosed(): boolean {
    return this.closedReason !== undefined;
  }

  get closeReason(): string | undefined {
    return this.closedReason;
  }

  /**
   * 쌓인 것 중 `afterSeq` 뒤를 `maxBytes`쯤까지 꺼낸다. 이벤트 하나가 상한보다 커도 하나는
   * 꺼낸다. 뷰어가 소켓이 비는 만큼씩 앞부분을 보내려고 쓴다. 한 번에 다 넘기면 안 읽는
   * 뷰어마다 앞부분 전체가 소켓 버퍼에 쌓인다.
   */
  backlogAfter(afterSeq: number, maxBytes: number): BacklogSlice {
    if (this.closedReason !== undefined) return { dropped: 0, items: [] };
    const droppedTotal = this.droppedEvents;
    const after = Math.max(0, afterSeq);
    const items: BacklogSlice['items'] = [];
    let bytes = 0;
    for (let i = Math.max(after, droppedTotal) - this.base; i < this.events.length; i++) {
      const held = this.events[i]!;
      if (items.length > 0 && bytes + held.bytes > maxBytes) break;
      items.push({ seq: this.base + i + 1, json: held.json });
      bytes += held.bytes;
    }
    return { dropped: after < droppedTotal ? droppedTotal - after : 0, items };
  }

  /**
   * `afterSeq` 뒤에 들고 있는 이벤트를 새것부터 꺼낸다. 요약(peek)이 최근 것만 추리다 다 모이면
   * 멈추려고 쓴다. 부르는 쪽은 await 없이 한 번에 돈다. 도는 사이에 이벤트가 늘거나 버려지면 번호가
   * 어긋난다.
   */
  *newestFirst(afterSeq = 0): Generator<{ seq: number; json: string }> {
    for (let i = this.events.length - 1; i >= this.head; i--) {
      const seq = this.base + i + 1;
      if (seq <= afterSeq) return;
      yield { seq, json: this.events[i]!.json };
    }
  }

  /** 그 번호의 이벤트. 상한에 밀려 버렸거나 아직 없으면 undefined */
  eventAt(seq: number): string | undefined {
    if (!Number.isSafeInteger(seq)) return undefined;
    const i = seq - this.base - 1;
    if (i < this.head || i >= this.events.length) return undefined;
    return this.events[i]?.json;
  }

  /**
   * 뷰어를 붙인다. 지금 상태와 `afterSeq` 뒤 앞부분을 한 번에 보내고 이후는 생기는 대로.
   * 떼어내는 함수를 돌려준다. 앞부분이 큰 뷰어는 backlogAfter로 먼저 따라잡은 뒤 이벤트
   * 루프로 돌아가기 전에 바로 붙어야 사이에 poll이 끼어 이벤트가 빠지지 않는다.
   */
  subscribe(listener: ShareListener, afterSeq = 0): () => void {
    listener({ type: 'state', status: this.status });
    listener({ type: 'stats', unknownLines: this.unknownLines });
    const { dropped, items } = this.backlogAfter(afterSeq, Infinity);
    if (dropped > 0) listener({ type: 'trimmed', dropped });
    for (const item of items) listener({ type: 'event', ...item });
    if (this.closedReason !== undefined) {
      // close가 events를 비워도 base를 늘려 두므로 eventCount는 그때까지 나온 전체 개수다
      listener({
        type: 'closed',
        reason: this.closedReason,
        missed: Math.max(0, this.eventCount - afterSeq),
      });
      return () => {};
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(reason: string): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    this.emit({ type: 'closed', reason });
    this.listeners.clear();
    // 종료된 공유의 내용을 메모리에 붙잡아 둘 이유가 없다
    this.base += this.events.length;
    this.events = [];
    this.head = 0;
    this.backlogBytes = 0;
  }

  /** 이벤트 하나를 쌓고 흘린다. 상한 정리는 부른 쪽이 trim으로 한 번에 한다 */
  protected pushEvent(json: string): void {
    const bytes = Buffer.byteLength(json);
    this.events.push({ json, bytes });
    this.backlogBytes += bytes;
    this.emit({ type: 'event', seq: this.eventCount, json });
  }

  /**
   * 들고 있던 걸 다 버리고 다음 이벤트 번호를 `seq + 1`부터 잇는다. 원격 공유에서 주인
   * 쪽이 버린 구간을 건너뛸 때 쓴다. 버린 개수는 droppedEvents에 들어간다.
   */
  protected skipTo(seq: number): void {
    if (seq <= this.eventCount) return;
    this.base = seq;
    this.events = [];
    this.head = 0;
    this.backlogBytes = 0;
  }

  /** 가장 최근 이벤트 하나는 상한을 넘어도 남긴다. 다 버리면 새 뷰어가 지금 상태를 못 본다 */
  protected trim(): void {
    while (this.backlogBytes > this.maxBacklogBytes && this.events.length - this.head > 1) {
      this.backlogBytes -= this.events[this.head]!.bytes;
      this.events[this.head] = undefined;
      this.head++;
    }
    if (this.head > 1024 && this.head * 2 > this.events.length) {
      this.base += this.head;
      this.events = this.events.slice(this.head);
      this.head = 0;
    }
  }

  protected setStatus(next: ShareStatus): void {
    if (next === this.status) return;
    this.status = next;
    this.emit({ type: 'state', status: next });
  }

  protected emit(frame: ShareFrame): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(frame);
      } catch (err) {
        // 뷰어 하나가 끊겨 쓰기에 실패해도 다른 뷰어와 데몬은 계속 돈다
        this.listeners.delete(listener);
        process.stderr.write(`[peer] viewer listener failed: ${errMessage(err)}\n`);
      }
    }
  }
}
