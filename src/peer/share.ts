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
  /** 대화 기록에 들어오기를 기다리는 메시지. 키는 그 메시지의 여는 태그 글자다 */
  private awaiting = new Map<string, Awaiting>();

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

    const now = Date.now();
    this.expireAwaiting(now);
    for (const line of lines) {
      // 세션이 놀다가 메시지로 새 턴을 시작하면 user 줄로 남을 수 있다. 그 줄은 주인
      // 프롬프트처럼 보이면 안 되므로 바꾸지 않고 peer_message로만 보여준다. 대부분의 줄은
      // 여는 태그 앞부분이 없어서 파싱 없이 지나간다
      if (line.includes(PEER_TAG_IN_JSON) && this.spot(line, now)) continue;
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
   * `queue-operation`과 `attachment` 줄에 본문째 남긴다. 두 줄은 transformer가 버리는 종류라
   * 뷰어로 안 나간다.
   *
   * id 글자만 찾지 않고 그 메시지의 여는 태그(`<peer-message from=… id=…>`) 전체를 찾는다.
   * 다른 메시지 본문에 id를 적어 넣어도 본문에는 `<`+글자가 못 들어가서 여는 태그를 흉내 낼 수 없다.
   */
  awaitMessage(header: string, onSeen: () => void, now = Date.now()): void {
    if (this.isClosed) return;
    this.expireAwaiting(now);
    if (this.awaiting.size >= MAX_AWAITING) {
      const oldest = this.awaiting.keys().next().value;
      if (oldest !== undefined) this.awaiting.delete(oldest);
    }
    this.awaiting.set(header, {
      onSeen,
      seen: false,
      until: now + AWAIT_TTL_MS,
    });
  }

  cancelAwait(header: string): void {
    this.awaiting.delete(header);
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

  /**
   * 여는 태그가 든 줄을 본다. 기다리던 메시지가 보이면 알린다. user 줄이고 본문 자리 어디에든
   * 여는 태그 앞부분이 들어 있으면 true — 프롬프트로 바꾸지 않는다. 맨 앞만 보지 않는 건 새 턴
   * user 줄 앞에 Claude Code가 무엇을 붙이는지 확인하지 못했고 text 블록을 이어 붙여 보기
   * 때문이다. 대신 여는 태그 글자를 그대로 적은 주인 프롬프트도 뷰어에서 숨는다.
   *
   * 줄 종류마다 메시지 본문이 있는 자리만 본다. 배열 content의 tool_result 블록은 주인
   * 에이전트가 기록을 읽거나 되풀이한 글자일 수 있어서 판정에도 숨기기에도 안 쓴다.
   * user 줄은 기다리는 항목이 없어도 숨긴다. 보류된 메시지가 지켜보는 시한이 지난 뒤에
   * 받아들여져도 주인 프롬프트로 나가지 않는다.
   */
  private spot(line: string, now: number): boolean {
    let parsed: TranscriptLineShape;
    try {
      parsed = JSON.parse(line) as TranscriptLineShape;
    } catch {
      return false;
    }
    const text = messageText(parsed);
    if (text === undefined) return false;
    for (const [header, w] of this.awaiting) {
      if (w.seen || !text.includes(header)) continue;
      w.seen = true;
      w.until = now + SEEN_HOLD_MS;
      try {
        w.onSeen();
      } catch {
        // 상태 알림이 실패해도 따라 읽기는 계속한다
      }
    }
    return parsed.type === 'user' && text.includes(PEER_TAG);
  }

  /** 보류되거나 거절돼 끝내 안 보인 메시지와 다 본 메시지를 잊는다 */
  private expireAwaiting(now: number): void {
    for (const [needle, w] of this.awaiting) {
      if (now >= w.until) this.awaiting.delete(needle);
    }
  }
}

interface Awaiting {
  onSeen: () => void;
  seen: boolean;
  until: number;
}

/** 팀원 메시지 여는 태그의 앞부분. 대화 기록 줄은 JSON이라 따옴표가 `\"`로 적혀 있다 */
const PEER_TAG = '<peer-message from="';
const PEER_TAG_IN_JSON = JSON.stringify(PEER_TAG).slice(1, -1);

interface TranscriptLineShape {
  type?: unknown;
  content?: unknown;
  attachment?: { type?: unknown; prompt?: unknown };
  message?: { content?: unknown };
}

/** 줄 종류마다 메시지 본문이 들어가는 자리의 글자. 볼 자리가 아니면 undefined */
function messageText(line: TranscriptLineShape): string | undefined {
  switch (line.type) {
    case 'queue-operation':
      return typeof line.content === 'string' ? line.content : undefined;
    case 'attachment':
      return line.attachment?.type === 'queued_command' &&
        typeof line.attachment.prompt === 'string'
        ? line.attachment.prompt
        : undefined;
    case 'user': {
      const content = line.message?.content;
      if (typeof content === 'string') return content;
      if (!Array.isArray(content)) return undefined;
      // text 블록만 모은다. tool_result 블록은 뺀다
      const texts = content
        .filter(
          (b): b is { type: 'text'; text: string } =>
            typeof b === 'object' &&
            b !== null &&
            (b as { type?: unknown }).type === 'text' &&
            typeof (b as { text?: unknown }).text === 'string',
        )
        .map((b) => b.text);
      return texts.length > 0 ? texts.join('\n') : undefined;
    }
    default:
      return undefined;
  }
}

/** 기다리는 메시지 수 상한. 넘으면 오래된 것부터 잊는다 */
const MAX_AWAITING = 512;
/** 넣은 뒤 이만큼 안 보이면 잊는다. 보류된 메시지는 주인이 늦게 받아 줄 수 있어서 넉넉히 둔다 */
const AWAIT_TTL_MS = 60 * 60 * 1000;
/** 처음 보인 뒤 뒤따르는 user 줄을 숨기려고 기억해 두는 시간 */
const SEEN_HOLD_MS = 10 * 60 * 1000;

function toShareStatus(status: TailStatus): ShareStatus {
  return status === 'ok' ? 'live' : status;
}
