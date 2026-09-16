/**
 * MCP 도구 입력 검증을 부르는 쪽이 고칠 수 있는 형태로 돌려주는 자리.
 *
 * MCP SDK는 도구를 부르기 전에 등록된 zod 스키마로 인자를 검증한다. 실패하면
 * 첫 이슈의 message 한 줄만 뽑아 `Invalid arguments for tool ...`로 던진다. 우리
 * 핸들러는 그 전에 못 끼어든다. 그래서 고칠 수 있는 자리는 스키마 자체다.
 *
 * 심는 방어는 이렇다.
 * - 객체나 배열을 기대하는 파라미터에 문자열이 오면 `JSON.parse`를 먼저 시도한다.
 *   호스트가 JSON 문자열을 못 풀고 원본을 그대로 넘기는 일이 있는데, 그때 나오는
 *   `Expected object, received string`은 진짜 원인(문자열이 깨졌다)을 덮어버린다.
 * - 파싱이 실패하면 파서의 원본 에러와 깨진 지점 주변을 함께 싣는다. 수만 자짜리
 *   페이로드에서 위치 숫자만으론 어디가 깨졌는지 못 찾는다.
 * - 타입이 어긋나면 실제로 받은 값의 샘플과 경로를 메시지에 붙인다. SDK가 첫 이슈
 *   message만 꺼내가므로 경로까지 message 안에 넣어야 살아남는다.
 *
 * **JSON 문자열 관용은 도구 파라미터(최상위 키)에만 걸린다.** `guardShape`가 shape의
 * 키만 돌기 때문이다. `reviewConsensus`는 문자열로 보내도 풀리지만 그 안의
 * `mergedIssues`를 문자열로 보내면 여전히 타입 에러로 떨어진다 — 대신 경로와 받은
 * 값이 붙어 원인은 읽힌다. 중첩까지 넓히려면 배열 요소 스키마를 재구성해야 하는데,
 * 실제로 문자열이 오는 자리는 최상위 파라미터라 거기까지 가지 않았다.
 *
 * **이 파일은 zod v3 내부 구조(`_def`)에 기댄다.** 파일 끝 `probeZodInternals()`가 그
 * 의존을 감시한다 — 근거는 그 함수 주석에 있다. zod 버전을 올리면
 * `tests/unit/mcp/input-guard.test.ts`를 반드시 다시 돌린다.
 */
import { z } from 'zod';
import { log } from '../core/log.js';

const Kind = z.ZodFirstPartyTypeKind;

/** 깨진 지점 앞뒤로 보여줄 글자 수. */
const SNIPPET_RADIUS = 40;
/** 에러 메시지에 실을 값 샘플의 최대 길이. */
const SAMPLE_LIMIT = 120;
// 한 줄 메시지에 실을 샘플이라 깊이 2와 앞 몇 개면 어느 필드가 틀렸는지는 읽힌다.
// 더 들어가도 어차피 SAMPLE_LIMIT 에서 잘린다.
const SAMPLE_DEPTH = 2;
const SAMPLE_ARRAY_ITEMS = 5;
const SAMPLE_OBJECT_KEYS = 10;

/**
 * 이보다 긴 문자열은 파싱을 안 해보고 거절한다.
 *
 * Node는 싱글 스레드라 거대한 문자열 하나의 `JSON.parse`가 이벤트 루프를 붙잡으면
 * 같은 서버의 다른 세션 요청까지 멈춘다. 파싱에 실패하는 자리가 아니라 파싱 자체를
 * 안 하는 자리다.
 */
const MAX_JSON_STRING_LENGTH = 1_000_000;

/** 문자열 대신 구조를 기대하는 스키마 — 여기에만 JSON 문자열을 허용한다. */
const STRUCTURED_KINDS = new Set<z.ZodFirstPartyTypeKind>([
  Kind.ZodObject,
  Kind.ZodArray,
  Kind.ZodRecord,
  Kind.ZodTuple,
]);

/**
 * 에러 문구에 실리기 전에 가릴 토큰.
 *
 * 이 메시지는 MCP 클라이언트로 내려가 호스트 로그에 남는다. 검증에 실패한 값이
 * 사용자 콘텐츠를 담는 필드면 거기 섞인 자격증명이 로그에 영구히 남는다. 접두어는
 * 남겨서 무엇이 가려졌는지는 읽히게 한다.
 *
 * **알려진 접두어만 가린다.** 접두어가 없는 값(AWS 시크릿 액세스 키 같은 40자 난수)은
 * 못 잡는다. 완전히 막는 장치가 아니라 흔한 실수를 줄이는 자리다.
 *
 * 끄는 수단은 두지 않았다. 이 값은 에러 문구에 실려 로그로 나가는 데이터라, 가리기를
 * 끄는 스위치를 두면 그게 노출 경로가 된다.
 */
const SECRET_PATTERNS: RegExp[] = [
  // `Bearer` 뒤는 공백류뿐 아니라 이스케이프된 개행(`\n` 두 글자)도 받는다.
  // `formatReceived` 는 `JSON.stringify` 를 먼저 거치므로 그 자리에 실제 개행이 안 남는다.
  /(sk-|sk_live_|sk_test_|ghp_|gho_|ghs_|github_pat_|xox[baprs]-|AIza|npm_|AKIA|Bearer(?:\s|\\n|\\r)+)[A-Za-z0-9_-]{8,}/g,
  // 헤더만 잡으면 정작 키 본문이 남는다. END 까지 묶는다. 잘려서 END 가 없으면 뒤를 전부 가린다.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|[\s\S]*)/g,
];

interface SecretSpan {
  start: number;
  end: number;
  /** 있으면 가린 뒤에도 남겨 무엇이 가려졌는지 읽히게 한다. */
  prefix: string | undefined;
}

/**
 * 토큰 구간을 **원본 좌표로** 모은다.
 *
 * 잘라낸 조각에 정규식을 따로 걸면 안 된다. 접두어와 몸통이 서로 다른 조각에 놓이면
 * 어느 쪽도 패턴에 안 걸려 토큰이 통째로 남는다. 문자열을 안 닫은 JSON 이 그 자리다 —
 * V8 이 보고하는 위치가 문자열 끝이라 접두어가 스니펫 윈도우 앞으로 밀려난다.
 */
function collectSecretSpans(text: string): SecretSpan[] {
  const spans: SecretSpan[] = [];
  for (const pattern of SECRET_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined) continue;
      spans.push({
        start: match.index,
        end: match.index + match[0].length,
        prefix: match[1],
      });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * 토큰을 가린다. `keepAt` 이 어느 토큰 안을 가리키면 그 토큰만 원문으로 남긴다.
 *
 * `window` 를 주면 그 구간만 잘라 돌려주되 판정은 원본 전체로 한 결과를 쓴다.
 */
function maskSecrets(
  text: string,
  options: { keepAt?: number; window?: { start: number; end: number } } = {},
): string {
  const { keepAt = -1, window } = options;
  const from = window?.start ?? 0;
  const to = window?.end ?? text.length;

  let out = '';
  let cursor = from;
  for (const span of collectSecretSpans(text)) {
    if (span.end <= cursor || span.start >= to) continue;
    const visibleStart = Math.max(span.start, cursor);
    const visibleEnd = Math.min(span.end, to);
    out += text.slice(cursor, visibleStart);

    // 깨진 지점이 이 토큰 안이면 원문을 남긴다. 원인 바이트가 별표에 묻히면 스니펫을
    // 붙이는 이유가 없어진다. 노출은 그 토큰 하나로 묶인다.
    if (keepAt >= span.start && keepAt < span.end) {
      out += text.slice(visibleStart, visibleEnd);
    } else {
      // 접두어가 윈도우 안에 남아 있으면 그것까지는 보여준다.
      const prefixEnd = span.start + (span.prefix?.length ?? 0);
      if (visibleStart < prefixEnd)
        out += text.slice(visibleStart, Math.min(prefixEnd, visibleEnd));
      out += '***';
    }
    cursor = visibleEnd;
  }
  return out + text.slice(cursor, to);
}

function redactSecrets(text: string): string {
  return maskSecrets(text);
}

/** 한 줄 메시지에 실으므로 줄바꿈은 눈에 보이게 바꾼다. */
function escapeNewlines(text: string): string {
  return text.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

function typeNameOf(schema: z.ZodTypeAny): z.ZodFirstPartyTypeKind | undefined {
  return (schema._def as { typeName?: z.ZodFirstPartyTypeKind }).typeName;
}

function formatPath(path: ReadonlyArray<string | number>): string {
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') return `${acc}[${segment}]`;
    return acc === '' ? String(segment) : `${acc}.${segment}`;
  }, '');
}

/**
 * 직렬화 전에 값을 얕게 잘라낸다.
 *
 * 메시지에 실리는 건 120자뿐인데 거대한 배열을 통째로 문자열로 만들면 그 비용을 다
 * 문다. 잘릴 것을 미리 버리고 직렬화한다.
 */
function shallowSample(value: unknown, depth = 0): unknown {
  if (depth > SAMPLE_DEPTH) return '…';
  if (Array.isArray(value)) {
    const head = value.slice(0, SAMPLE_ARRAY_ITEMS).map((item) => shallowSample(item, depth + 1));
    return value.length > SAMPLE_ARRAY_ITEMS ? [...head, '…'] : head;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const source = value as Record<string, unknown>;
    for (const key of Object.keys(source).slice(0, SAMPLE_OBJECT_KEYS)) {
      out[key] = shallowSample(source[key], depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > SAMPLE_LIMIT) {
    return `${value.slice(0, SAMPLE_LIMIT)}…`;
  }
  return value;
}

/** 실제로 받은 값을 에러 메시지에 실을 수 있게 줄여 찍는다. */
export function formatReceived(value: unknown): string {
  if (typeof value === 'function') return 'function';
  let rendered: string;
  try {
    rendered = JSON.stringify(shallowSample(value)) ?? String(value);
  } catch {
    rendered = String(value);
  }
  if (rendered.length > SAMPLE_LIMIT) rendered = `${rendered.slice(0, SAMPLE_LIMIT)}…`;
  // 마스킹을 먼저 건다. 개행이 `\n` 두 글자로 바뀐 뒤에는 `Bearer\s+` 가 그 자리를 못 잡는다.
  return escapeNewlines(redactSecrets(rendered));
}

/** JSON 파서 에러 문구에서 위치를 뽑는다. 런타임마다 문구가 달라 없을 수도 있다. */
function extractPosition(reason: string): number | null {
  const match = /at position (\d+)/.exec(reason);
  if (!match) return null;
  const position = Number(match[1]!);
  return Number.isFinite(position) ? position : null;
}

/**
 * 깨진 지점 주변만 잘라 보여준다.
 *
 * 마스킹 판정은 원본 전체에서 하고 그 결과를 윈도우에 맞춰 자른다. 깨진 지점을 품은
 * 토큰 하나만 원문으로 남고 나머지는 가려진다 — 윈도우가 접두어를 잘라낸 경우에는
 * `***` 만 보인다.
 */
export function snippetAround(text: string, position: number, radius = SNIPPET_RADIUS): string {
  const start = Math.max(0, position - radius);
  const end = Math.min(text.length, position + radius);
  const body = maskSecrets(text, { keepAt: position, window: { start, end } });
  return `${start > 0 ? '…' : ''}${escapeNewlines(body)}${end < text.length ? '…' : ''}`;
}

/** JSON 파싱 실패를 부르는 쪽이 바로 고칠 수 있는 한 줄로 만든다. */
export function describeJsonParseFailure(label: string, raw: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  // 파서 문구도 부르는 쪽 바이트에서 나온다. 최신 V8 은 깨진 지점 원문을 그 안에
  // 인용하므로 가려야 한다. 스니펫과 달리 여기는 전량 마스킹이다 — 원인을 보여주는
  // 자리를 스니펫 한 곳으로 몰아뒀다.
  const head = `${label}: 문자열로 왔는데 JSON으로 안 풀립니다 — ${escapeNewlines(redactSecrets(reason))}`;
  const position = extractPosition(reason);
  if (position === null) return `${head} (길이 ${raw.length}자)`;
  return `${head}. 깨진 지점 주변: ${snippetAround(raw, position)}`;
}

/**
 * 타입이 어긋났을 때 무엇이 왔는지까지 말해주는 errorMap.
 *
 * SDK가 첫 이슈의 message만 꺼내 쓰므로 경로(`a.b[0].c`)도 여기 넣는다. 안 넣으면
 * 어느 필드가 틀렸는지가 통째로 사라진다.
 */
export const verboseErrorMap: z.ZodErrorMap = (issue, ctx) => {
  const path = formatPath(issue.path ?? []);
  const at = path === '' ? '' : ` at ${path}`;

  if (issue.code === z.ZodIssueCode.invalid_type) {
    // 값을 아예 안 보낸 경우다. 샘플 대신 무슨 타입이 필요한지를 알려준다.
    if (issue.received === z.ZodParsedType.undefined) {
      return { message: `Required${at} (expected: ${issue.expected})` };
    }
    return {
      message: `Expected ${issue.expected}, received ${issue.received}${at} (received: ${formatReceived(ctx.data)})`,
    };
  }

  // 어느 키가 남았는지는 이슈가 이미 들고 있다. 객체 전체를 찍으면 문제와 무관한
  // 옆 필드 값까지 메시지와 로그에 함께 실린다.
  if (issue.code === z.ZodIssueCode.unrecognized_keys) {
    return { message: `${ctx.defaultError}${at} (unrecognized: ${issue.keys.join(', ')})` };
  }

  // 코드를 가려 뽑지 않는다. 허용 목록으로 두면 나중에 union 이나 date 필드가 붙었을
  // 때 그 자리만 조용히 샘플을 잃는다. 메시지가 이미 정해진 이슈(`.refine()` 의 커스텀
  // 문구, 이 파일이 던지는 파싱 실패 문구)는 zod 가 errorMap 을 아예 안 태우므로 여기서
  // 걸러낼 필요도 없다.
  return { message: `${ctx.defaultError}${at} (received: ${formatReceived(ctx.data)})` };
};

/**
 * 스키마 트리 전체에 errorMap을 심는다.
 *
 * 제자리에서 고친다. 중첩 배열 요소까지 닿아야 `mergedIssues[0].reportedBy` 같은
 * 자리의 에러에도 경로와 샘플이 붙는다.
 *
 * 가드가 둘이고 하는 일이 다르다.
 * - `seen`에 있는 스키마 인스턴스는 **노드 전체를 건너뛴다** (자식 순회까지 중단).
 *   순환 참조와 공유 참조 대비다.
 * - errorMap이 이미 있는 스키마는 **값 재할당만 건너뛰고** 자식 순회는 계속한다.
 *   같은 shape에 두 번 걸려도 안쪽이 빠짐없이 덮인다.
 */
export function attachErrorMap<S extends z.ZodTypeAny>(
  schema: S,
  seen: WeakSet<object> = new WeakSet(),
): S {
  // 순회가 집는 필드 이름이 어긋나면 undefined 가 온다. 그 자리는 `probeGuardReach()` 가
  // 잡으므로 여기서는 조용히 물러난다 — 스키마 하나 때문에 기동을 세우지 않는다.
  if (schema === undefined || schema === null) return schema;
  if (seen.has(schema)) return schema;
  seen.add(schema);

  const def = schema._def as { errorMap?: z.ZodErrorMap };
  if (def.errorMap === undefined) def.errorMap = verboseErrorMap;

  const kind = typeNameOf(schema);
  const raw = schema._def as Record<string, unknown>;

  switch (kind) {
    case Kind.ZodObject: {
      const shape = (schema as unknown as z.AnyZodObject).shape;
      for (const key of Object.keys(shape)) attachErrorMap(shape[key]!, seen);
      break;
    }
    case Kind.ZodArray:
      attachErrorMap(raw['type'] as z.ZodTypeAny, seen);
      break;
    // ZodSet 은 배열과 달리 자식을 `valueType` 에 둔다. 같은 분기에 묶으면 undefined 가 넘어간다.
    case Kind.ZodSet:
      attachErrorMap(raw['valueType'] as z.ZodTypeAny, seen);
      break;
    case Kind.ZodOptional:
    case Kind.ZodNullable:
    case Kind.ZodDefault:
    case Kind.ZodCatch:
    case Kind.ZodPromise:
    case Kind.ZodBranded:
    case Kind.ZodReadonly:
      attachErrorMap(raw['innerType'] as z.ZodTypeAny, seen);
      break;
    case Kind.ZodEffects:
      attachErrorMap(raw['schema'] as z.ZodTypeAny, seen);
      break;
    case Kind.ZodUnion:
    case Kind.ZodDiscriminatedUnion: {
      const options = raw['options'];
      const list = Array.isArray(options)
        ? options
        : [...(options as Map<unknown, z.ZodTypeAny>).values()];
      for (const option of list) attachErrorMap(option as z.ZodTypeAny, seen);
      break;
    }
    case Kind.ZodIntersection:
      attachErrorMap(raw['left'] as z.ZodTypeAny, seen);
      attachErrorMap(raw['right'] as z.ZodTypeAny, seen);
      break;
    case Kind.ZodRecord:
      attachErrorMap(raw['keyType'] as z.ZodTypeAny, seen);
      attachErrorMap(raw['valueType'] as z.ZodTypeAny, seen);
      break;
    case Kind.ZodTuple: {
      for (const item of (raw['items'] as z.ZodTypeAny[]) ?? []) attachErrorMap(item, seen);
      const rest = raw['rest'];
      if (rest) attachErrorMap(rest as z.ZodTypeAny, seen);
      break;
    }
    // ZodLazy 같은 재귀 스키마는 getter가 부를 때마다 새 인스턴스를 낼 수 있어
    // `seen`으로 못 막는다. 여기서 안 따라가므로 그 서브트리는 방어 없이 남는다.
    default:
      break;
  }

  return schema;
}

type Wrapper =
  | { kind: 'optional' }
  | { kind: 'nullable' }
  | { kind: 'default'; factory: () => unknown };

/**
 * optional, nullable, default 껍질을 벗겨 안쪽 스키마와 껍질 순서를 돌려준다.
 *
 * ZodEffects(`.refine()`, `.transform()`)는 안 벗긴다. 그 검사는 JSON을 푼 뒤에 그대로
 * 돌아야 하므로 preprocess가 그 바깥을 감싼다.
 */
function peel(schema: z.ZodTypeAny): { inner: z.ZodTypeAny; wrappers: Wrapper[] } {
  const wrappers: Wrapper[] = [];
  let current = schema;
  for (;;) {
    const kind = typeNameOf(current);
    const raw = current._def as Record<string, unknown>;
    if (kind === Kind.ZodOptional) {
      wrappers.push({ kind: 'optional' });
      current = raw['innerType'] as z.ZodTypeAny;
    } else if (kind === Kind.ZodNullable) {
      wrappers.push({ kind: 'nullable' });
      current = raw['innerType'] as z.ZodTypeAny;
    } else if (kind === Kind.ZodDefault) {
      wrappers.push({ kind: 'default', factory: raw['defaultValue'] as () => unknown });
      current = raw['innerType'] as z.ZodTypeAny;
    } else {
      return { inner: current, wrappers };
    }
  }
}

/**
 * 이 스키마가 결국 구조를 기대하는지 본다.
 *
 * `.refine()`이 하나 얹히면 최상위가 ZodEffects가 된다. 그것만 보고 판정하면 그 필드는
 * JSON 문자열 관용을 조용히 잃는다 — 에러도 안 나서 알아채기 어렵다.
 */
function expectsStructured(schema: z.ZodTypeAny, depth = 0): boolean {
  if (depth > 10) return false;
  const kind = typeNameOf(schema);
  if (kind === Kind.ZodEffects) {
    return expectsStructured((schema._def as { schema: z.ZodTypeAny }).schema, depth + 1);
  }
  return STRUCTURED_KINDS.has(kind as z.ZodFirstPartyTypeKind);
}

/**
 * 객체나 배열 파라미터에 JSON 문자열을 허용한다.
 *
 * 껍질(optional/default)은 벗겼다가 그대로 다시 씌운다. `preprocess`를 바깥에 두면
 * SDK가 필수 파라미터로 잘못 노출하고 `describe()`도 날아간다.
 */
export function tolerateJsonString<S extends z.ZodTypeAny>(schema: S, label: string): z.ZodTypeAny {
  const { inner, wrappers } = peel(schema);
  if (!expectsStructured(inner)) return schema;

  let rebuilt: z.ZodTypeAny = z.preprocess((value, ctx) => {
    if (typeof value !== 'string') return value;

    if (value.length > MAX_JSON_STRING_LENGTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        fatal: true,
        message: `${label}: 문자열이 너무 깁니다 (${value.length}자, 상한 ${MAX_JSON_STRING_LENGTH}자). 파싱을 시도하지 않았습니다.`,
      });
      return z.NEVER;
    }

    try {
      return JSON.parse(value) as unknown;
    } catch (error) {
      // fatal이 없으면 zod가 뒤 검증을 계속 돌려 `Required at ...` 잡음을 덧붙인다.
      // 부르는 쪽이 고쳐야 할 건 파싱 하나뿐이다.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        fatal: true,
        message: describeJsonParseFailure(label, value, error),
      });
      return z.NEVER;
    }
  }, inner);

  for (const wrapper of [...wrappers].reverse()) {
    if (wrapper.kind === 'optional') rebuilt = rebuilt.optional();
    else if (wrapper.kind === 'nullable') rebuilt = rebuilt.nullable();
    // 팩토리를 그대로 넘긴다. 여기서 호출해 결과를 박으면 모든 요청이 같은 객체
    // 인스턴스를 나눠 쓰게 된다.
    else rebuilt = rebuilt.default(wrapper.factory as never);
  }

  const description = (schema._def as { description?: string }).description;
  return description === undefined ? rebuilt : rebuilt.describe(description);
}

/**
 * 도구 등록에 넘길 raw shape에 방어를 입힌다.
 *
 * 두 번 지나도 결과가 같다. 다만 구조가 그대로 남는다는 뜻은 아니다. `attachErrorMap`은
 * 값이 비었을 때만 대입하므로 손대는 게 없지만 `tolerateJsonString`은 두 번째 통과에서
 * `preprocess`를 한 겹 더 씌운다. 바깥 겹이 문자열을 풀면 안쪽 겹에는 문자열이 아닌 값이
 * 와서 그대로 지나간다. 상한 검사와 파싱 실패 문구도 한 번만 실린다.
 *
 * `schemas.ts`에서 `guardObject`를 지난 스키마가 `server.ts`의 `guardedTool`에서 한 번
 * 더 지나는 게 그 경로다. 등록 채널을 하나로 남기는 것이 이 설계의 전제라, 레이어를
 * 갈라 그 채널을 다시 여는 쪽으로는 안 간다.
 */
export function guardShape<S extends z.ZodRawShape>(shape: S): S {
  const guarded: z.ZodRawShape = {};
  for (const key of Object.keys(shape)) {
    guarded[key] = tolerateJsonString(attachErrorMap(shape[key]!), key);
  }
  return guarded as S;
}

/** 핸들러가 직접 `.parse()`하는 스키마에도 같은 방어를 입힌다. */
export function guardObject<S extends z.AnyZodObject>(schema: S): S {
  return attachErrorMap(schema.extend(guardShape(schema.shape)) as S);
}

/**
 * 방어가 실제로 자식까지 닿는지 종단으로 본다.
 *
 * 필드 이름 목록을 따로 들고 비교하면 순회 코드의 오타를 못 잡는다 — zod 쪽 이름은
 * 그대로인데 우리가 다른 이름을 집고 있어도 목록끼리는 맞아 통과한다. 그래서 스키마를
 * 실제로 `attachErrorMap` 에 통과시켜 안쪽 잎에 errorMap 이 심겼는지 확인한다. 이러면
 * zod 의 필드 개명과 이 파일의 오타가 같은 자리에서 걸린다.
 *
 * 돌려주는 건 안 닿은 자리의 목록이다. 비어 있으면 정상이다. 순수 함수로 둔 이유는
 * 테스트가 이 판정 자체를 검증할 수 있게 했다 — 기동 경로에만 있으면 이 감시 장치가
 * 깨졌을 때 잡을 방법이 없다.
 */
export function probeGuardReach(): string[] {
  const gaps: string[] = [];

  // 컨테이너 종류마다 잎을 하나 심어 순회가 그 잎에 닿았는지 본다.
  const cases: Array<[string, () => { root: z.ZodTypeAny; leaves: z.ZodTypeAny[] }]> = [
    [
      'object',
      () => {
        const leaf = z.string();
        return { root: z.object({ a: leaf }), leaves: [leaf] };
      },
    ],
    [
      'array',
      () => {
        const leaf = z.string();
        return { root: z.array(leaf), leaves: [leaf] };
      },
    ],
    [
      'optional',
      () => {
        const leaf = z.string();
        return { root: leaf.optional(), leaves: [leaf] };
      },
    ],
    [
      'nullable',
      () => {
        const leaf = z.string();
        return { root: leaf.nullable(), leaves: [leaf] };
      },
    ],
    [
      'default',
      () => {
        const leaf = z.string();
        return { root: leaf.default('x'), leaves: [leaf] };
      },
    ],
    [
      'catch',
      () => {
        const leaf = z.string();
        return { root: leaf.catch('x'), leaves: [leaf] };
      },
    ],
    [
      'effects',
      () => {
        const leaf = z.string();
        return { root: leaf.refine(() => true), leaves: [leaf] };
      },
    ],
    [
      'union',
      () => {
        const leaf = z.string();
        const other = z.number();
        return { root: z.union([leaf, other]), leaves: [leaf, other] };
      },
    ],
    [
      'intersection',
      () => {
        const left = z.object({ a: z.string() });
        const right = z.object({ b: z.string() });
        return { root: z.intersection(left, right), leaves: [left, right] };
      },
    ],
    [
      'record',
      () => {
        const key = z.string();
        const value = z.number();
        return { root: z.record(key, value), leaves: [key, value] };
      },
    ],
    [
      'tuple',
      () => {
        const item = z.string();
        const rest = z.number();
        return { root: z.tuple([item]).rest(rest), leaves: [item, rest] };
      },
    ],
    [
      'set',
      () => {
        const leaf = z.string();
        return { root: z.set(leaf), leaves: [leaf] };
      },
    ],
  ];

  for (const [label, build] of cases) {
    const { root, leaves } = build();
    attachErrorMap(root);
    const missed = leaves.filter(
      (leaf) => (leaf._def as { errorMap?: z.ZodErrorMap }).errorMap !== verboseErrorMap,
    );
    if (missed.length > 0) gaps.push(label);
  }

  // errorMap 주입 자체가 먹는지. 위 판정은 우리가 심었는지만 보므로 zod 가 그 값을
  // 실제로 읽는지는 따로 확인한다.
  const mark = 'gestalt-input-guard-self-check';
  const probe = z.string();
  (probe._def as { errorMap?: z.ZodErrorMap }).errorMap = () => ({ message: mark });
  const parsed = probe.safeParse(123);
  if (parsed.success || parsed.error.issues[0]?.message !== mark) gaps.push('errorMap(주입)');

  // 껍질 복원이 이 값을 그대로 다시 넘긴다. 값이면 모든 요청이 한 인스턴스를 나눠 쓴다.
  const withDefault = z.array(z.string()).default([]);
  const defaultDef = withDefault._def as unknown as Record<string, unknown>;
  if (typeof defaultDef['defaultValue'] !== 'function') gaps.push('defaultValue(팩토리)');

  // `describe()` 가 preprocess 재조립에서 살아남아야 도구 설명이 안 사라진다.
  const described = tolerateJsonString(
    z.object({ a: z.string() }).optional().describe('설명'),
    'probe',
  );
  if ((described._def as { description?: string }).description !== '설명') {
    gaps.push('description(재조립)');
  }

  return gaps;
}

/**
 * 어긋난 자리가 있으면 stderr 로 알린다. 기동은 막지 않는다.
 *
 * 여기서 죽이면 폭발 반경이 MCP 서버 전체다. 사용자가 보는 건 `Connection closed`
 * 한 줄이라, 원인을 알려주자는 모듈이 자기 실패에서는 원인을 감추는 꼴이 된다. 막고
 * 싶은 건 조용한 퇴행인데 그건 `pnpm gate` 가 `probeGuardReach()` 를 직접 불러 잡는다.
 */
const guardGaps = probeGuardReach();
if (guardGaps.length > 0) {
  log(
    `input-guard: 입력 검증 방어가 안 걸리는 자리가 있습니다 — ${guardGaps.join(', ')}. ` +
      '에러 메시지가 실패 원인을 안 알려주는 상태로 돌아갑니다. ' +
      'zod 버전을 올렸다면 src/mcp/input-guard.ts를 그에 맞춰 고치세요.',
  );
}
