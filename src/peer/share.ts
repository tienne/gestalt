import { TranscriptTail } from './tail.js';
import type { TailOptions, TailStatus } from './tail.js';
import { TranscriptTransformer } from './transform.js';
import { redactText } from './redact.js';
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
  private readonly home: string | undefined;
  /** 대화 기록에 들어오기를 기다리는 메시지 id와 보이면 부를 함수 */
  private awaiting = new Map<string, () => void>();

  constructor(options: ShareStreamOptions) {
    super(options.id, options.maxBacklogBytes);
    this.transcriptPath = options.transcriptPath;
    this.tools = options.tools;
    this.home = options.home;
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
      // 세션이 놀다가 메시지로 새 턴을 시작하면 user 줄로 남을 수 있다. 그 줄은 주인
      // 프롬프트처럼 보이면 안 되므로 바꾸지 않고 아래 peer_message로만 보여준다
      if (this.awaiting.size > 0 && this.spot(line)) continue;
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

  /**
   * 메시지가 주인 세션에 들어가면 부를 함수를 건다. Claude Code는 받은 메시지를
   * `queue-operation`과 `attachment` 줄에 본문째 남긴다. 그 줄은 뷰어로 안 내보내고 id만 본다.
   */
  awaitMessage(id: string, onSeen: () => void): void {
    if (this.isClosed) return;
    if (this.awaiting.size >= MAX_AWAITING) {
      const oldest = this.awaiting.keys().next().value;
      if (oldest !== undefined) this.awaiting.delete(oldest);
    }
    this.awaiting.set(id, onSeen);
  }

  cancelAwait(id: string): void {
    this.awaiting.delete(id);
  }

  /** 들어간 메시지를 대화 흐름에 끼운다. 보는 사람 모두가 같은 자리에서 본다 */
  pushPeerMessage(m: { id: string; from: string; origin: 'human' | 'agent'; text: string }): void {
    if (this.isClosed) return;
    const event = {
      kind: 'peer_message' as const,
      id: m.id,
      from: m.from,
      origin: m.origin,
      text: redactText(m.text, { home: this.home }),
      at: new Date().toISOString(),
    };
    this.pushEvent(JSON.stringify(event));
    this.trim();
  }

  /** 기다리던 메시지가 보이면 알린다. 그 줄이 user 줄이면 true — 프롬프트로 바꾸지 않는다 */
  private spot(line: string): boolean {
    let consumed = false;
    // 줄 전체를 매번 파싱하지 않는다. 기다리는 id가 글자로 들어 있을 때만 본다
    for (const [id, onSeen] of this.awaiting) {
      if (!line.includes(id)) continue;
      let type: unknown;
      try {
        type = (JSON.parse(line) as { type?: unknown }).type;
      } catch {
        continue;
      }
      if (type !== 'queue-operation' && type !== 'attachment' && type !== 'user') continue;
      if (type === 'user') consumed = true;
      this.awaiting.delete(id);
      try {
        onSeen();
      } catch {
        // 상태 알림이 실패해도 따라 읽기는 계속한다
      }
    }
    return consumed;
  }
}

/** 기다리는 메시지 수 상한. 넘으면 오래된 것부터 잊는다 */
const MAX_AWAITING = 512;

function toShareStatus(status: TailStatus): ShareStatus {
  return status === 'ok' ? 'live' : status;
}
