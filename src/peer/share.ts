import { TranscriptTail } from './tail.js';
import type { TailOptions, TailStatus } from './tail.js';
import { TranscriptTransformer } from './transform.js';
import type { PeerEvent } from './transform.js';
import type { RedactOptions, ToolsLevel } from './redact.js';
import { errMessage } from './errors.js';

/** 뷰어 하나가 받는 것. seq는 SSE id로 써서 다시 붙었을 때 이어 받게 한다 */
export type ShareFrame =
  | { type: 'event'; seq: number; event: PeerEvent }
  /** 붙은 뷰어가 받을 앞부분 중 메모리 상한에 밀려 버려진 이벤트 수 */
  | { type: 'trimmed'; dropped: number }
  | { type: 'stats'; unknownLines: number }
  | { type: 'state'; status: ShareStatus }
  | { type: 'closed'; reason: string };

export type ShareStatus = 'live' | 'missing' | 'truncated';

export type ShareListener = (frame: ShareFrame) => void;

export interface ShareStreamOptions extends RedactOptions {
  id: string;
  transcriptPath: string;
  tools: ToolsLevel;
  /** 들고 있는 이벤트의 직렬화 바이트 상한. 테스트가 작게 준다 */
  maxBacklogBytes?: number;
  tail?: Omit<TailOptions, 'startOffset'>;
}

/**
 * 새 뷰어에게 다시 보낼 앞부분의 상한. 넘으면 오래된 것부터 버린다. 공유는 최대 7일
 * 열려 있고 도구 출력이 크면 events가 끝없이 는다.
 */
export const DEFAULT_MAX_BACKLOG_BYTES = 32 * 1024 * 1024;

interface Held {
  event: PeerEvent;
  bytes: number;
}

/**
 * 공유 하나. 대화 기록을 따라 읽어 바꾼 이벤트를 메모리에 쌓고 붙은 뷰어에 흘린다.
 *
 * 바꾼 결과만 메모리에 들고 원문 줄은 들지 않는다. 디스크에는 아무것도 안 쓴다.
 * 처음 붙는 뷰어가 앞부분을 한 번에 받아야 해서 바꾼 이벤트를 상한까지 남긴다.
 *
 * seq는 공유가 연 뒤로 나온 이벤트의 번호다. 앞부분을 버려도 번호는 안 당긴다.
 * 배열 위치로 매기면 버린 만큼 번호가 밀려 Last-Event-ID로 이어 받을 때 겹치거나 빠진다.
 */
export class ShareStream {
  readonly id: string;
  readonly transcriptPath: string;
  readonly tools: ToolsLevel;

  private tail: TranscriptTail;
  private transformer: TranscriptTransformer;
  /** `events[head]`부터가 살아 있다. 앞에서 하나씩 shift하면 큰 배열에서 매번 다 옮긴다 */
  private events: Held[] = [];
  private head = 0;
  /** `events[0]` 앞에서 잘라 낸 이벤트 수. `events[i]`의 seq는 `base + i + 1`이다 */
  private base = 0;
  private backlogBytes = 0;
  private readonly maxBacklogBytes: number;
  private listeners = new Set<ShareListener>();
  private status: ShareStatus = 'live';
  private title: string | undefined;
  private lastUnknown = 0;
  private closedReason: string | undefined;

  constructor(options: ShareStreamOptions) {
    this.id = options.id;
    this.transcriptPath = options.transcriptPath;
    this.tools = options.tools;
    this.maxBacklogBytes = options.maxBacklogBytes ?? DEFAULT_MAX_BACKLOG_BYTES;
    this.tail = new TranscriptTail(options.transcriptPath, options.tail);
    this.transformer = new TranscriptTransformer({ tools: options.tools, home: options.home });
  }

  get currentStatus(): ShareStatus {
    return this.status;
  }

  get unknownLines(): number {
    return this.transformer.unknownLines;
  }

  get failedLines(): number {
    return this.transformer.failedLines;
  }

  get oversizedLines(): number {
    return this.tail.oversizedLines;
  }

  get claudeVersion(): string | undefined {
    return this.transformer.version;
  }

  get sessionTitle(): string | undefined {
    return this.title;
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

  /**
   * 새로 쓰인 줄을 읽어 흘린다. 데몬이 주기적으로 부른다.
   * 모르는 줄 수가 늘었으면 true — 데몬이 감사 로그에 버전을 남길 때 쓴다.
   */
  poll(): { unknownGrew: boolean } {
    if (this.closedReason !== undefined || this.status === 'truncated') {
      return { unknownGrew: false };
    }

    const { lines, status } = this.tail.read();
    this.setStatus(toShareStatus(status));

    for (const line of lines) {
      for (const event of this.transformer.push(line)) {
        if (event.kind === 'title') this.title = event.text;
        const bytes = Buffer.byteLength(JSON.stringify(event));
        this.events.push({ event, bytes });
        this.backlogBytes += bytes;
        this.emit({ type: 'event', seq: this.eventCount, event });
      }
    }
    this.trim();

    const unknown = this.transformer.unknownLines;
    const unknownGrew = unknown > this.lastUnknown;
    if (unknownGrew) {
      this.lastUnknown = unknown;
      this.emit({ type: 'stats', unknownLines: unknown });
    }
    return { unknownGrew };
  }

  /**
   * 뷰어를 붙인다. 지금까지 쌓인 것 중 `afterSeq` 뒤부터 먼저 보내고 이후는 생기는 대로.
   * 떼어내는 함수를 돌려준다.
   */
  subscribe(listener: ShareListener, afterSeq = 0): () => void {
    listener({ type: 'state', status: this.status });
    listener({ type: 'stats', unknownLines: this.transformer.unknownLines });
    const dropped = this.droppedEvents;
    const after = Math.max(0, afterSeq);
    if (after < dropped) listener({ type: 'trimmed', dropped: dropped - after });
    for (let i = Math.max(after, dropped) - this.base; i < this.events.length; i++) {
      listener({ type: 'event', seq: this.base + i + 1, event: this.events[i]!.event });
    }
    if (this.closedReason !== undefined) {
      listener({ type: 'closed', reason: this.closedReason });
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

  /** 가장 최근 이벤트 하나는 상한을 넘어도 남긴다. 다 버리면 새 뷰어가 지금 상태를 못 본다 */
  private trim(): void {
    while (this.backlogBytes > this.maxBacklogBytes && this.events.length - this.head > 1) {
      this.backlogBytes -= this.events[this.head]!.bytes;
      this.head++;
    }
    if (this.head > 1024 && this.head * 2 > this.events.length) {
      this.base += this.head;
      this.events = this.events.slice(this.head);
      this.head = 0;
    }
  }

  private setStatus(next: ShareStatus): void {
    if (next === this.status) return;
    this.status = next;
    this.emit({ type: 'state', status: next });
  }

  private emit(frame: ShareFrame): void {
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

function toShareStatus(status: TailStatus): ShareStatus {
  return status === 'ok' ? 'live' : status;
}
