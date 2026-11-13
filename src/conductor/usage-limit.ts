/**
 * 워커 출력 끝에 세션 리밋이나 사용량 한도 표시가 있는지 판별한다.
 *
 * 오르카는 구조화 세션 워커가 한도에 걸리면 시스템 메시지에 `failure.kind: "usageLimitReached"`를
 * 남긴다(2026-11-13 ord-41ac4a18 앞 워커 기록에서 확인). 그 표식을 먼저 보고 터미널 워커처럼
 * 표식이 없는 출력은 문구로 가른다.
 */

export interface UsageLimitHit {
  /** 사람이 읽을 한 줄. 오르카가 준 안내 문구나 걸린 문구다 */
  text: string;
  /** 오르카가 알려 준 한도가 풀리는 시각(ISO). 모르면 없다 */
  resetsAt?: string;
}

// 평소 출력에 "limit"만 나와도 걸리지 않게 한도에 걸렸다는 꼴만 받는다
const USAGE_LIMIT_PATTERNS: readonly RegExp[] = [
  /\bhit (?:its|your) (?:[\w-]+ )?limit\b/i,
  /\busage limit\b/i,
  /\b(?:5-hour|five-hour|weekly|session|daily|opus|sonnet) limit\b/i,
  /\blimit (?:reached|exceeded|will reset)\b/i,
  /\busage_limit_reached\b/,
  /\brate_limit_error\b/,
  /\bAPI Error: 429\b/i,
];

/** 문구가 세션 리밋이나 사용량 한도에 걸렸다는 뜻인지 */
export function isUsageLimitText(text: string): boolean {
  return USAGE_LIMIT_PATTERNS.some((p) => p.test(text));
}

/** worker-read가 돌려준 마지막 메시지들에서 한도 표시를 찾는다. 없으면 undefined */
export function usageLimitIn(messages: readonly unknown[]): UsageLimitHit | undefined {
  for (const m of [...messages].reverse()) {
    const hit = usageLimitInMessage(m);
    if (hit) return hit;
  }
  return undefined;
}

function usageLimitInMessage(message: unknown): UsageLimitHit | undefined {
  const blocks = record(message)?.['blocks'];
  if (!Array.isArray(blocks)) return textHit(stringsIn(message));
  for (const b of blocks) {
    const failure = record(record(b)?.['failure']);
    if (failure && /usage.?limit|rate.?limit/i.test(String(failure['kind'] ?? ''))) {
      const detail = record(failure['detail'])?.['text'];
      const resetsAt = record(failure['usageLimit'])?.['resetsAt'];
      const at = typeof resetsAt === 'number' ? new Date(resetsAt) : undefined;
      return {
        text: typeof detail === 'string' && detail ? detail : String(failure['kind']),
        ...(at && !Number.isNaN(at.getTime()) ? { resetsAt: at.toISOString() } : {}),
      };
    }
  }
  // 도구 호출 입력과 결과는 워커가 다루는 코드나 문서라 한도 문구가 섞여도 한도에 걸린 게 아니다
  const texts = blocks
    .filter((b) => record(b)?.['type'] === 'text')
    .map((b) => record(b)?.['text'])
    .filter((t): t is string => typeof t === 'string');
  return textHit(texts);
}

/** 터미널 출력처럼 메시지 꼴이 아닌 응답은 끝부분 글만 본다 */
export function usageLimitInText(text: string, tailChars = 2000): UsageLimitHit | undefined {
  return textHit([text.slice(-tailChars)]);
}

function textHit(texts: readonly string[]): UsageLimitHit | undefined {
  for (const t of texts) {
    const line = t
      .split('\n')
      .reverse()
      .find((l) => isUsageLimitText(l));
    if (line) return { text: line.trim().slice(0, 200) };
  }
  return undefined;
}

function stringsIn(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(stringsIn);
  const r = record(v);
  return r ? Object.values(r).flatMap(stringsIn) : [];
}

function record(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}
