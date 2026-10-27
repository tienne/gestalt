import { TranscriptTail } from './tail.js';
import type { TailStatus } from './tail.js';
import { TranscriptTransformer } from './transform.js';
import type { PeerEvent } from './transform.js';
import type { RedactOptions, ToolsLevel } from './redact.js';

/** 뷰어 하나가 받는 것. seq는 SSE id로 써서 다시 붙었을 때 이어 받게 한다 */
export type ShareFrame =
  | { type: 'event'; seq: number; event: PeerEvent }
  | { type: 'stats'; unknownLines: number }
  | { type: 'state'; status: ShareStatus }
  | { type: 'closed'; reason: string };

export type ShareStatus = 'live' | 'missing' | 'truncated';

export type ShareListener = (frame: ShareFrame) => void;

export interface ShareStreamOptions extends RedactOptions {
  id: string;
  transcriptPath: string;
  tools: ToolsLevel;
}

/**
 * 공유 하나. 대화 기록을 따라 읽어 바꾼 이벤트를 메모리에 쌓고 붙은 뷰어에 흘린다.
 *
 * 바꾼 결과만 메모리에 들고 원문 줄은 들지 않는다. 디스크에는 아무것도 안 쓴다.
 * 처음 붙는 뷰어가 앞부분을 한 번에 받아야 해서 바꾼 이벤트는 공유가 닫힐 때까지 남긴다.
 */
export class ShareStream {
  readonly id: string;
  readonly transcriptPath: string;
  readonly tools: ToolsLevel;

  private tail: TranscriptTail;
  private transformer: TranscriptTransformer;
  private events: PeerEvent[] = [];
  private listeners = new Set<ShareListener>();
  private status: ShareStatus = 'live';
  private title: string | undefined;
  private lastUnknown = 0;
  private closedReason: string | undefined;

  constructor(options: ShareStreamOptions) {
    this.id = options.id;
    this.transcriptPath = options.transcriptPath;
    this.tools = options.tools;
    this.tail = new TranscriptTail(options.transcriptPath);
    this.transformer = new TranscriptTransformer({ tools: options.tools, home: options.home });
  }

  get currentStatus(): ShareStatus {
    return this.status;
  }

  get unknownLines(): number {
    return this.transformer.unknownLines;
  }

  get claudeVersion(): string | undefined {
    return this.transformer.version;
  }

  get sessionTitle(): string | undefined {
    return this.title;
  }

  get eventCount(): number {
    return this.events.length;
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
        this.events.push(event);
        this.emit({ type: 'event', seq: this.events.length, event });
      }
    }

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
    for (let i = Math.max(0, afterSeq); i < this.events.length; i++) {
      listener({ type: 'event', seq: i + 1, event: this.events[i]! });
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
    // 닫힌 공유의 내용을 메모리에 붙잡아 둘 이유가 없다
    this.events = [];
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
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[peer] viewer listener failed: ${msg}\n`);
      }
    }
  }
}

function toShareStatus(status: TailStatus): ShareStatus {
  return status === 'ok' ? 'live' : status;
}
