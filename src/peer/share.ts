import { TranscriptTail } from './tail.js';
import type { TailOptions, TailStatus } from './tail.js';
import { TranscriptTransformer } from './transform.js';
import type { RedactOptions, ToolsLevel } from './redact.js';
import { ShareFeed } from './feed.js';
import type { ShareStatus } from './feed.js';

export { DEFAULT_MAX_BACKLOG_BYTES } from './feed.js';
export type { BacklogSlice, ShareFrame, ShareListener, ShareStatus } from './feed.js';

export interface ShareStreamOptions extends RedactOptions {
  id: string;
  transcriptPath: string;
  tools: ToolsLevel;
  /** 들고 있는 이벤트의 직렬화 바이트 상한. 테스트가 작게 준다 */
  maxBacklogBytes?: number;
  tail?: Omit<TailOptions, 'startOffset'>;
}

/**
 * 공유 하나. 대화 기록을 따라 읽어 바꾼 이벤트를 메모리에 쌓고 붙은 뷰어에 흘린다.
 *
 * 바꾼 결과만 메모리에 들고 원문 줄은 들지 않는다. 디스크에는 아무것도 안 쓴다.
 * 처음 붙는 뷰어가 앞부분을 받아야 해서 바꾼 이벤트를 직렬화한 글자로 상한까지 남긴다.
 */
export class ShareStream extends ShareFeed {
  readonly transcriptPath: string;
  readonly tools: ToolsLevel;

  private tail: TranscriptTail;
  private transformer: TranscriptTransformer;
  private title: string | undefined;
  private lastUnknown = 0;

  constructor(options: ShareStreamOptions) {
    super(options.id, options.maxBacklogBytes);
    this.transcriptPath = options.transcriptPath;
    this.tools = options.tools;
    this.tail = new TranscriptTail(options.transcriptPath, options.tail);
    this.transformer = new TranscriptTransformer({ tools: options.tools, home: options.home });
  }

  override get unknownLines(): number {
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

  /**
   * 새로 쓰인 줄을 읽어 흘린다. 데몬이 주기적으로 부른다.
   * 모르는 줄 수가 늘었으면 true — 데몬이 감사 로그에 버전을 남길 때 쓴다.
   */
  poll(): { unknownGrew: boolean } {
    if (this.isClosed || this.status === 'truncated') {
      return { unknownGrew: false };
    }

    const { lines, status } = this.tail.read();
    this.setStatus(toShareStatus(status));

    for (const line of lines) {
      for (const event of this.transformer.push(line)) {
        if (event.kind === 'title') this.title = event.text;
        this.pushEvent(JSON.stringify(event));
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
}

function toShareStatus(status: TailStatus): ShareStatus {
  return status === 'ok' ? 'live' : status;
}
