import { redactText, redactValue, truncateBytes, TOOL_RESULT_SUMMARY_BYTES } from './redact.js';
import type { RedactOptions, ToolsLevel } from './redact.js';

/** 뷰어로 나가는 한 줄. 대화 기록 원문은 이 모양으로만 바깥에 나간다 */
export type PeerEvent =
  | { kind: 'prompt'; text: string; at?: string }
  | { kind: 'reply'; text: string; at?: string }
  | { kind: 'tool_call'; id: string; name: string; input?: string; at?: string }
  | {
      kind: 'tool_result';
      toolUseId: string;
      text?: string;
      truncated: boolean;
      hidden: boolean;
      isError: boolean;
      at?: string;
    }
  | { kind: 'title'; text: string }
  | { kind: 'sidechain'; at?: string }
  | { kind: 'compacted'; at?: string }
  /** 팀원이 넣어 주인 세션에 들어간 메시지. 대화 기록 줄이 아니라 주인 데몬이 직접 끼운다 */
  | {
      kind: 'peer_message';
      id: string;
      from: string;
      origin: 'human' | 'agent';
      text: string;
      at?: string;
    }
  /** 주인 세션 모델의 질문에 팀원이 뷰어에서 단 답. 주인 데몬이 서명을 확인한 것만 끼운다 */
  | { kind: 'peer_answer'; question: string; from: string; text: string; at?: string };

/** `tool_use` 입력 요약 길이. 결과보다 짧게 둔다 — 입력은 접힌 줄 제목처럼 읽힌다 */
const TOOL_INPUT_SUMMARY_BYTES = 1024;

/**
 * 내용을 안 보내는 줄 종류. 2.1.311 기록에서 본 것들이다. 여기 있는 건 조용히
 * 버리고 여기에도 허용 목록에도 없는 종류만 "모르는 줄"로 센다.
 *
 * 이 목록은 차단 목록이 아니다. 지워도 새는 게 없고 "모르는 줄" 숫자만 는다.
 */
const KNOWN_DROPPED = new Set([
  'api-request',
  'api-request-blob',
  'api-request-shape',
  'attachment',
  'system',
  'last-prompt',
  'queue-operation',
  'tools-used',
  'cost-state',
  'mode',
  'atis-latch',
  'summary',
  'file-history-snapshot',
]);

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g;

/** user 텍스트에서 `<system-reminder>` 블록을 지운다. 닫는 태그가 없으면 끝까지 지운다 */
export function stripSystemReminders(text: string): string {
  return text.replace(SYSTEM_REMINDER, '').trim();
}

export interface TransformOptions extends RedactOptions {
  tools: ToolsLevel;
}

/**
 * 대화 기록 jsonl 한 줄씩 받아 허용 목록에 있는 것만 `PeerEvent`로 바꾼다.
 *
 * 허용 목록이다. 줄 종류든 content 블록 종류든 여기서 명시적으로 꺼내지 않은 건
 * 아무것도 안 나간다. 형식이 바뀌어 새 필드나 새 종류가 생겨도 그대로 새지 않는다.
 *
 * 상태가 있다 — 서브에이전트 줄이 이어지면 표시를 한 번만 낸다.
 */
export class TranscriptTransformer {
  private inSidechain = false;
  private unknown = 0;
  private failed = 0;
  private claudeVersion: string | undefined;

  constructor(private readonly options: TransformOptions) {}

  /** 모르는 줄 종류와 JSON으로 안 읽힌 줄을 합친 수 */
  get unknownLines(): number {
    return this.unknown;
  }

  /**
   * 바꾸다 예외가 난 줄 수. 모르는 줄과 따로 센다. 모르는 줄은 형식이 바뀐 신호라 감사
   * 로그에 버전과 함께 남기는데 여기에 섞이면 그 신호가 흐려진다.
   */
  get failedLines(): number {
    return this.failed;
  }

  /** 마지막으로 본 Claude Code 버전. 모르는 줄이 생겼을 때 감사 로그에 남긴다 */
  get version(): string | undefined {
    return this.claudeVersion;
  }

  /**
   * 한 줄을 바꾼다. 줄 하나에서 난 예외는 여기서 접고 그 줄만 버린다. 2만 단계로
   * 중첩된 도구 입력이 가리기 재귀에서 스택을 넘기는 걸 봤다. 던지게 두면 이 공유의
   * 나머지 줄을 더 못 읽는다. 읽던 중이면 tick이 그 공유를 error로 종료하고 공유를 여는
   * 첫 poll이면 share 요청이 실패한다.
   */
  push(line: string): PeerEvent[] {
    try {
      return this.parse(line);
    } catch {
      this.failed++;
      return [];
    }
  }

  private parse(line: string): PeerEvent[] {
    const trimmed = line.trim();
    if (trimmed === '') return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.unknown++;
      return [];
    }
    if (!isRecord(parsed) || typeof parsed['type'] !== 'string') {
      this.unknown++;
      return [];
    }
    if (typeof parsed['version'] === 'string') this.claudeVersion = parsed['version'];

    const type = parsed['type'];
    const at = typeof parsed['timestamp'] === 'string' ? parsed['timestamp'] : undefined;

    if (type === 'ai-title') {
      const title = parsed['aiTitle'];
      return typeof title === 'string' && title.trim() !== ''
        ? [{ kind: 'title', text: this.redact(title) }]
        : [];
    }

    if (type !== 'user' && type !== 'assistant') {
      if (!KNOWN_DROPPED.has(type)) this.unknown++;
      return [];
    }

    if (parsed['isSidechain'] === true) {
      if (this.inSidechain) return [];
      this.inSidechain = true;
      return [{ kind: 'sidechain', at }];
    }
    this.inSidechain = false;

    // 하네스가 끼워 넣은 줄이다. 주인이 친 말이 아니고 CLAUDE.md나 명령 출력이 들어 있다
    if (parsed['isMeta'] === true) return [];
    // 압축 요약은 지난 대화 전체를 다시 적은 글이라 그 안에 무엇이 섞였는지 모른다
    if (parsed['isCompactSummary'] === true) return [{ kind: 'compacted', at }];

    const message = parsed['message'];
    if (!isRecord(message)) return [];
    const content = message['content'];

    return type === 'user' ? this.fromUser(content, at) : this.fromAssistant(content, at);
  }

  private fromUser(content: unknown, at: string | undefined): PeerEvent[] {
    if (typeof content === 'string') return this.prompt(content, at);
    if (!Array.isArray(content)) return [];

    const events: PeerEvent[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block['type'] === 'text' && typeof block['text'] === 'string') {
        events.push(...this.prompt(block['text'], at));
      } else if (block['type'] === 'tool_result') {
        events.push(this.toolResult(block, at));
      }
    }
    return events;
  }

  private fromAssistant(content: unknown, at: string | undefined): PeerEvent[] {
    if (typeof content === 'string') {
      const text = this.redact(content).trim();
      return text === '' ? [] : [{ kind: 'reply', text, at }];
    }
    if (!Array.isArray(content)) return [];

    const events: PeerEvent[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block['type'] === 'text' && typeof block['text'] === 'string') {
        const text = this.redact(block['text']).trim();
        if (text !== '') events.push({ kind: 'reply', text, at });
      } else if (block['type'] === 'tool_use') {
        events.push(this.toolCall(block, at));
      }
      // thinking, redacted_thinking, server_tool_use 등은 꺼내지 않는다
    }
    return events;
  }

  private prompt(raw: string, at: string | undefined): PeerEvent[] {
    const text = this.redact(stripSystemReminders(raw));
    return text === '' ? [] : [{ kind: 'prompt', text, at }];
  }

  private toolCall(block: Record<string, unknown>, at: string | undefined): PeerEvent {
    const id = typeof block['id'] === 'string' ? block['id'] : '';
    const name = typeof block['name'] === 'string' ? this.redact(block['name']) : '(이름 없음)';
    return toolCallEvent(id, name, block['input'] ?? {}, at, this.options);
  }

  private toolResult(block: Record<string, unknown>, at: string | undefined): PeerEvent {
    const toolUseId = typeof block['tool_use_id'] === 'string' ? block['tool_use_id'] : '';
    return toolResultEvent(
      toolUseId,
      () => resultText(block['content']),
      block['is_error'] === true,
      at,
      this.options,
    );
  }

  private redact(text: string): string {
    return redactText(text, this.options);
  }
}

/**
 * 도구 호출 이벤트. 입력은 가린 뒤 `--tools` 수준에 맞춰 자른다. 객체 입력은 키 이름으로도 가리고
 * 글자 입력(Codex의 custom_tool_call)은 글자 규칙으로만 가린다.
 */
export function toolCallEvent(
  id: string,
  name: string,
  rawInput: unknown,
  at: string | undefined,
  options: TransformOptions,
): PeerEvent {
  if (options.tools === 'none') return { kind: 'tool_call', id, name, at };
  const text =
    typeof rawInput === 'string'
      ? redactText(rawInput, options)
      : (JSON.stringify(redactValue(rawInput, options)) ?? '');
  const input =
    options.tools === 'full' ? text : truncateBytes(text, TOOL_INPUT_SUMMARY_BYTES).text;
  return { kind: 'tool_call', id, name, input, at };
}

/**
 * 도구 결과 이벤트. 글자는 가린 **뒤에** 자른다. `none`이면 글자를 꺼내지도 않도록 함수로 받는다.
 *
 * 이 세션이 남의 공유를 `ges_peer peek`으로 요약해 받은 결과는 `--tools` 수준과 상관없이 숨긴다. 그
 * 요약은 그 공유 주인이 이 세션의 에이전트에만 허락한 것이라 이 세션을 보는 사람에게 다시 나가면
 * 안 된다. 틀이 결과 어디에 있든 잡으려고 자르기 전 글자 전체에서 찾고 이스케이프된 틀도 잡는다. 그래서
 * 이 틀 글자가 든 결과는 무엇이든(문서나 소스를 읽은 결과도) 숨긴다. 새는 것보다 덜 보이는 쪽을 골랐다.
 */
export function toolResultEvent(
  toolUseId: string,
  rawText: () => string,
  isError: boolean,
  at: string | undefined,
  options: TransformOptions,
): PeerEvent {
  if (options.tools === 'none') {
    return { kind: 'tool_result', toolUseId, truncated: false, hidden: true, isError, at };
  }
  const raw = rawText();
  if (raw.includes(PEEK_FRAME)) {
    return { kind: 'tool_result', toolUseId, truncated: false, hidden: true, isError, at };
  }
  const full = redactText(raw, options);
  const cut =
    options.tools === 'full'
      ? { text: full, truncated: false }
      : truncateBytes(full, TOOL_RESULT_SUMMARY_BYTES);
  return {
    kind: 'tool_result',
    toolUseId,
    text: cut.text,
    truncated: cut.truncated,
    hidden: false,
    isError,
    at,
  };
}

/**
 * ges_peer peek이 돌려주는 요약 틀(peek.ts의 framePeek)을 알아보는 글자. 꺾쇠와 따옴표를 뺐다. 도구
 * 결과가 JSON 문자열로 한 번 더 싸여 `share=\\"`가 되거나 `<`가 `\\u003c`, `&lt;`로 이스케이프돼 와도
 * 잡으려는 것이다
 */
const PEEK_FRAME = 'peer-peek share=';

/** tool_result의 content는 문자열이거나 블록 배열이다. 텍스트 블록만 꺼낸다 */
function resultText(content: unknown): string {
  if (typeof content === 'string') return stripSystemReminders(content);
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      parts.push(stripSystemReminders(block['text']));
    } else if (block['type'] === 'image') {
      parts.push('[이미지]');
    }
  }
  return parts.join('\n');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
