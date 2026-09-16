/**
 * MCP 도구 입력 검증을 부르는 쪽이 고칠 수 있는 형태로 돌려주는 자리.
 *
 * MCP SDK는 도구를 부르기 전에 등록된 zod 스키마로 인자를 검증한다. 실패하면
 * 첫 이슈의 message 한 줄만 뽑아 `Invalid arguments for tool ...`로 던진다. 우리
 * 핸들러는 그 전에 못 끼어든다. 그래서 고칠 수 있는 자리는 스키마 자체다.
 *
 * 세 가지를 심는다.
 * 1. 객체나 배열을 기대하는 파라미터에 문자열이 오면 `JSON.parse`를 먼저 시도한다.
 *    호스트가 JSON 문자열을 못 풀고 원본을 그대로 넘기는 일이 있는데, 그때 나오는
 *    `Expected object, received string`은 진짜 원인(문자열이 깨졌다)을 덮어버린다.
 * 2. 파싱이 실패하면 파서의 원본 에러와 깨진 지점 주변을 함께 싣는다. 수만 자짜리
 *    페이로드에서 위치 숫자만으론 어디가 깨졌는지 못 찾는다.
 * 3. 타입이 어긋나면 실제로 받은 값의 샘플과 경로를 메시지에 붙인다. SDK가 첫 이슈
 *    message만 꺼내가므로 경로까지 message 안에 넣어야 살아남는다.
 */
import { z } from 'zod';

const Kind = z.ZodFirstPartyTypeKind;

/** 깨진 지점 앞뒤로 보여줄 글자 수. */
const SNIPPET_RADIUS = 40;
/** 에러 메시지에 실을 값 샘플의 최대 길이. */
const SAMPLE_LIMIT = 120;

/** 문자열 대신 구조를 기대하는 스키마 — 여기에만 JSON 문자열을 허용한다. */
const STRUCTURED_KINDS = new Set<z.ZodFirstPartyTypeKind>([
  Kind.ZodObject,
  Kind.ZodArray,
  Kind.ZodRecord,
  Kind.ZodTuple,
]);

function typeNameOf(schema: z.ZodTypeAny): z.ZodFirstPartyTypeKind | undefined {
  return (schema._def as { typeName?: z.ZodFirstPartyTypeKind }).typeName;
}

function formatPath(path: ReadonlyArray<string | number>): string {
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') return `${acc}[${segment}]`;
    return acc === '' ? String(segment) : `${acc}.${segment}`;
  }, '');
}

/** 실제로 받은 값을 에러 메시지에 실을 수 있게 줄여 찍는다. */
export function formatReceived(value: unknown): string {
  if (typeof value === 'function') return 'function';
  let rendered: string;
  try {
    rendered = JSON.stringify(value) ?? String(value);
  } catch {
    rendered = String(value);
  }
  return rendered.length > SAMPLE_LIMIT ? `${rendered.slice(0, SAMPLE_LIMIT)}…` : rendered;
}

/** JSON 파서 에러 문구에서 위치를 뽑는다. 런타임마다 문구가 달라 없을 수도 있다. */
function extractPosition(reason: string): number | null {
  const match = /at position (\d+)/.exec(reason);
  if (!match) return null;
  const position = Number(match[1]!);
  return Number.isFinite(position) ? position : null;
}

/** 깨진 지점 주변만 잘라 보여준다. 개행은 눈에 보이게 바꾼다. */
export function snippetAround(text: string, position: number, radius = SNIPPET_RADIUS): string {
  const start = Math.max(0, position - radius);
  const end = Math.min(text.length, position + radius);
  const body = text.slice(start, end).replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

/** JSON 파싱 실패를 부르는 쪽이 바로 고칠 수 있는 한 줄로 만든다. */
export function describeJsonParseFailure(label: string, raw: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  const head = `${label}: 문자열로 왔는데 JSON으로 안 풀립니다 — ${reason}`;
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

  if (
    issue.code === z.ZodIssueCode.invalid_enum_value ||
    issue.code === z.ZodIssueCode.invalid_literal ||
    issue.code === z.ZodIssueCode.unrecognized_keys
  ) {
    return { message: `${ctx.defaultError}${at} (received: ${formatReceived(ctx.data)})` };
  }

  return { message: `${ctx.defaultError}${at}` };
};

/**
 * 스키마 트리 전체에 errorMap을 심는다.
 *
 * 제자리에서 고친다. 중첩 배열 요소까지 닿아야 `mergedIssues[0].reportedBy` 같은
 * 자리의 에러에도 경로와 샘플이 붙는다. 이미 errorMap이 걸린 스키마는 건너뛴다.
 */
export function attachErrorMap<S extends z.ZodTypeAny>(
  schema: S,
  seen: WeakSet<object> = new WeakSet(),
): S {
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
    case Kind.ZodSet:
      attachErrorMap(raw['type'] as z.ZodTypeAny, seen);
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
    default:
      break;
  }

  return schema;
}

type Wrapper =
  | { kind: 'optional' }
  | { kind: 'nullable' }
  | { kind: 'default'; value: () => unknown };

/** optional, nullable, default 껍질을 벗겨 안쪽 스키마와 껍질 순서를 돌려준다. */
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
      wrappers.push({ kind: 'default', value: raw['defaultValue'] as () => unknown });
      current = raw['innerType'] as z.ZodTypeAny;
    } else {
      return { inner: current, wrappers };
    }
  }
}

/**
 * 객체나 배열 파라미터에 JSON 문자열을 허용한다.
 *
 * 껍질(optional/default)은 벗겼다가 그대로 다시 씌운다. `preprocess`를 바깥에 두면
 * SDK가 필수 파라미터로 잘못 노출하고 `describe()`도 날아간다.
 */
export function tolerateJsonString<S extends z.ZodTypeAny>(schema: S, label: string): z.ZodTypeAny {
  const { inner, wrappers } = peel(schema);
  if (!STRUCTURED_KINDS.has(typeNameOf(inner) as z.ZodFirstPartyTypeKind)) return schema;

  let rebuilt: z.ZodTypeAny = z.preprocess((value, ctx) => {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value) as unknown;
    } catch (error) {
      // fatal 이 없으면 zod 가 뒤 검증을 계속 돌려 `Required at ...` 잡음을 덧붙인다.
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
    else rebuilt = rebuilt.default(wrapper.value() as never);
  }

  const description = (schema._def as { description?: string }).description;
  return description === undefined ? rebuilt : rebuilt.describe(description);
}

/** 도구 등록에 넘길 raw shape에 방어를 입힌다. */
export function guardShape<S extends z.ZodRawShape>(shape: S): S {
  const guarded: z.ZodRawShape = {};
  for (const key of Object.keys(shape)) {
    guarded[key] = attachErrorMap(tolerateJsonString(attachErrorMap(shape[key]!), key));
  }
  return guarded as S;
}

/** 핸들러가 직접 `.parse()`하는 스키마에도 같은 방어를 입힌다. */
export function guardObject<S extends z.AnyZodObject>(schema: S): S {
  return attachErrorMap(schema.extend(guardShape(schema.shape)) as S);
}
