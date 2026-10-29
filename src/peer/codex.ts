import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { redactText } from './redact.js';
import type { PeerEvent, TransformOptions } from './transform.js';
import { isRecord, toolCallEvent, toolResultEvent } from './transform.js';

/**
 * Codex 대화 기록(rollout) 읽기. codex-cli 0.147.0에서 확인한 형식이다.
 *
 * 기록은 `$CODEX_HOME/sessions/<연>/<월>/<일>/rollout-<시각>-<thread id>.jsonl`에 남는다.
 * `state_5.sqlite`의 threads 테이블은 이 경로를 가리키는 색인이고 본문은 jsonl에만 있다.
 * 줄은 모두 `{timestamp, type, payload}`다. 문서화되지 않은 형식이라 허용 목록에 있는 것만 꺼낸다.
 */

/** Codex 설정 디렉토리. 오르카처럼 `CODEX_HOME`으로 옮겨 둔 경우가 있다 */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env['CODEX_HOME'];
  if (raw && isAbsolute(raw)) return raw;
  return join(homedir(), '.codex');
}

/** thread id. 파일 이름 조각으로 쓰이므로 `..`이나 `/`가 들어오면 안 된다 */
const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

export type CodexLocateResult =
  | { ok: true; path: string; home: string }
  | { ok: false; reason: string; home: string };

/**
 * `--codex`에 준 값으로 rollout 파일을 찾는다. `.jsonl`로 끝나면 경로로 보고 아니면 thread id로
 * `sessions/` 아래에서 파일 이름이 `-<id>.jsonl`로 끝나는 rollout을 찾는다. SQLite 색인은 안
 * 읽는다. 스키마 번호가 바뀌어도 파일 이름 규칙은 그대로라 새 의존성 없이 찾을 수 있다.
 */
export function locateCodexRollout(
  value: string,
  home = codexHome(),
  cwd = process.cwd(),
): CodexLocateResult {
  if (value.endsWith('.jsonl')) {
    const path = isAbsolute(value) ? value : resolve(cwd, value);
    return isFile(path)
      ? { ok: true, path, home }
      : { ok: false, reason: `rollout 파일이 없어요: ${path}`, home };
  }
  if (!THREAD_ID.test(value)) {
    return { ok: false, reason: 'thread id나 rollout 경로(.jsonl)를 주세요', home };
  }
  const root = join(home, 'sessions');
  let names: string[];
  try {
    names = readdirSync(root, { recursive: true, encoding: 'utf8' });
  } catch {
    return { ok: false, reason: 'sessions 디렉토리를 못 읽었어요', home };
  }
  const suffix = `-${value}.jsonl`;
  const hits = names
    .filter((n) => basename(n).startsWith('rollout-') && n.endsWith(suffix))
    .map((n) => join(root, n))
    .filter(isFile);
  if (hits.length === 0) return { ok: false, reason: '그 id의 rollout을 못 찾았어요', home };
  // 같은 id가 둘이면 이름이 뒤인(나중에 만든) 것을 쓴다. 파일 이름이 시각으로 시작한다
  hits.sort();
  return { ok: true, path: hits[hits.length - 1]!, home };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * 내용을 안 보내는 줄 종류. 0.147.0 기록에서 본 것이다. 여기 있는 건 조용히 버리고 여기에도 허용
 * 목록에도 없는 종류만 "모르는 줄"로 센다. 차단 목록이 아니다 — 지워도 새는 게 없다.
 *
 * - session_meta: 시스템 프롬프트 원문(base_instructions)이 들어 있다
 * - world_state: AGENTS.md 원문(agents_md)과 환경 정보가 들어 있다
 * - turn_context: 턴마다 cwd, 권한, 모델 설정
 * - compacted: 압축 요약. 지난 대화 전체를 다시 적은 글이다
 */
const KNOWN_DROPPED = new Set(['session_meta', 'world_state', 'turn_context', 'compacted']);

/**
 * 안 보내는 event_msg 종류. 앞의 넷은 기록에서 봤고 추론 셋은 기록에는 안 남았지만 바이너리에
 * 있는 이름이다. 추론 원문은 허용 목록 밖이라 이 목록에서 빠져도 안 나간다.
 */
const KNOWN_DROPPED_EVENTS = new Set([
  'task_started',
  'task_complete',
  'token_count',
  'thread_settings_applied',
  'agent_reasoning',
  'agent_reasoning_raw_content',
  'agent_reasoning_section_break',
]);

/**
 * 안 보내는 response_item 종류. message는 role과 무관하게 버린다. role user 메시지에는 사람이 친
 * 말과 함께 AGENTS.md 전문과 `<environment_context>`가 들어 있고 developer 메시지는 시스템 지시다.
 * 프롬프트와 답은 event_msg의 user_message, agent_message에서 꺼낸다. reasoning은 추론 원문이다.
 */
const KNOWN_DROPPED_ITEMS = new Set(['message', 'reasoning']);

/**
 * Codex rollout 한 줄씩 받아 허용 목록에 있는 것만 `PeerEvent`로 바꾼다. Claude Code 기록의
 * TranscriptTransformer와 같은 자리에 끼우고 가리기도 같은 규칙을 탄다.
 */
export class CodexTransformer {
  private unknown = 0;
  private failed = 0;
  private cliVersion: string | undefined;

  constructor(private readonly options: TransformOptions) {}

  get unknownLines(): number {
    return this.unknown;
  }

  get failedLines(): number {
    return this.failed;
  }

  /** 마지막으로 본 codex-cli 버전. 모르는 줄이 생겼을 때 감사 로그에 남긴다 */
  get version(): string | undefined {
    return this.cliVersion;
  }

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
    if (!isRecord(parsed) || typeof parsed['type'] !== 'string' || !isRecord(parsed['payload'])) {
      this.unknown++;
      return [];
    }
    const type = parsed['type'];
    const payload = parsed['payload'];
    const at = typeof parsed['timestamp'] === 'string' ? parsed['timestamp'] : undefined;

    if (type === 'session_meta' && typeof payload['cli_version'] === 'string') {
      this.cliVersion = payload['cli_version'];
    }
    if (type === 'event_msg') return this.fromEvent(payload, at);
    if (type === 'response_item') return this.fromItem(payload, at);
    if (!KNOWN_DROPPED.has(type)) this.unknown++;
    return [];
  }

  private fromEvent(payload: Record<string, unknown>, at: string | undefined): PeerEvent[] {
    const kind = payload['type'];
    if (kind === 'user_message' || kind === 'agent_message') {
      const raw = payload['message'];
      if (typeof raw !== 'string') return [];
      const text = this.redact(raw).trim();
      if (text === '') return [];
      return [{ kind: kind === 'user_message' ? 'prompt' : 'reply', text, at }];
    }
    if (typeof kind !== 'string' || !KNOWN_DROPPED_EVENTS.has(kind)) this.unknown++;
    return [];
  }

  private fromItem(payload: Record<string, unknown>, at: string | undefined): PeerEvent[] {
    const kind = payload['type'];
    const callId = typeof payload['call_id'] === 'string' ? payload['call_id'] : '';
    switch (kind) {
      case 'function_call':
        return [this.call(callId, payload['name'], parseArguments(payload['arguments']), at)];
      case 'custom_tool_call':
        return [this.call(callId, payload['name'], payload['input'] ?? '', at)];
      case 'local_shell_call': {
        const action = isRecord(payload['action']) ? payload['action'] : {};
        return [this.call(callId, 'local_shell', { command: action['command'] }, at)];
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const output = payload['output'];
        const failed = isRecord(output) && output['success'] === false;
        return [toolResultEvent(callId, () => outputText(output), failed, at, this.options)];
      }
      default:
        if (typeof kind !== 'string' || !KNOWN_DROPPED_ITEMS.has(kind)) this.unknown++;
        return [];
    }
  }

  private call(id: string, rawName: unknown, input: unknown, at: string | undefined): PeerEvent {
    const name = typeof rawName === 'string' ? this.redact(rawName) : '(이름 없음)';
    return toolCallEvent(id, name, input, at, this.options);
  }

  private redact(text: string): string {
    return redactText(text, this.options);
  }
}

/** function_call의 arguments는 JSON 글자다. 객체로 읽히면 키 이름 가리기도 타게 객체로 넘긴다 */
function parseArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * 도구 결과 글자. 글자이거나 `{content}` 객체이거나 `{type: 'input_text', text}` 블록 배열이다.
 * 이미지 블록은 표시만 남긴다.
 */
function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (isRecord(output)) return outputText(output['content']);
  if (!Array.isArray(output)) return '';
  const parts: string[] = [];
  for (const block of output) {
    if (!isRecord(block)) continue;
    if (typeof block['text'] === 'string') parts.push(block['text']);
    else if (block['type'] === 'input_image') parts.push('[이미지]');
  }
  return parts.join('');
}
