import { homedir } from 'node:os';

export const REDACTED = '[가림]';

/** `--tools summary`일 때 도구 결과를 자르는 길이 */
export const TOOL_RESULT_SUMMARY_BYTES = 4 * 1024;

export type ToolsLevel = 'full' | 'summary' | 'none';

export const TOOLS_LEVELS: readonly ToolsLevel[] = ['full', 'summary', 'none'];

export function isToolsLevel(value: unknown): value is ToolsLevel {
  return typeof value === 'string' && (TOOLS_LEVELS as readonly string[]).includes(value);
}

export interface RedactOptions {
  /** `~`로 바꿀 홈 디렉토리. 테스트가 가짜 홈을 넣는다 */
  home?: string;
}

/**
 * 비밀값 패턴. 순서가 의미 있다 — PEM 블록을 먼저 통째로 지워야 그 안의 줄이
 * 다른 패턴에 반쯤 걸려 조각이 남지 않는다.
 *
 * 다 잡지는 못한다. 그래서 공유를 열 때와 뷰어 상단에 같은 경고를 띄운다.
 */
const PATTERNS: readonly RegExp[] = [
  // 끝 표시가 없으면(잘린 출력) 끝까지 지운다. 본문 일부가 남는 것보다 낫다
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bAIza[A-Za-z0-9_-]{35}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
];

/**
 * `https://user:pass@host`. 누구로 붙는지는 남기고 비밀번호만 지운다. Redis 접속 문자열에
 * 흔한 `redis://:pass@host`처럼 이름 없이 비밀번호만 둔 꼴도 잡으려고 이름 자리를 비워도 받는다.
 */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]{0,20}:\/\/[^\s:/@]{0,256}:)[^\s/@]{1,256}@/gi;

/** `Authorization: Bearer xxx` 같은 헤더. 이름은 남기고 값만 지운다 */
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * `curl -v`가 찍는 `> Cookie: …`나 `< Set-Cookie: …` 줄. 값에 정해진 꼴이 없어서 콜론 뒤를
 * 줄 끝까지 가린다. `Bearer`나 `Basic`은 머리에 넣어 BEARER가 남긴 `Bearer [가림]`을 그대로 둔다.
 */
const HEADER_LINE =
  /^([ \t]*(?:[<>][ \t]*)?(?:set-cookie|cookie|x-api-key|(?:proxy-)?authorization)[ \t]*:[ \t]*(?:(?:Bearer|Basic)[ \t]+)?)[^\n]{1,8192}/gim;

/**
 * `curl -H "X-Api-Key: …" https://…`처럼 따옴표 안에 든 헤더. 줄 끝까지 가리면 뒤 URL과
 * 옵션까지 사라지므로 닫는 따옴표 앞에서 멈춘다.
 */
const HEADER_QUOTED =
  /(["'])([ \t]*(?:set-cookie|cookie|x-api-key|(?:proxy-)?authorization)[ \t]*:[ \t]*(?:(?:Bearer|Basic)[ \t]+)?)[^"'\n]{1,8192}/gi;

/**
 * `API_KEY=…`, `export GH_TOKEN=…`처럼 이름에 KEY/TOKEN/SECRET/PASSWORD가 든 대입.
 * 이름은 남겨야 무엇이 가려졌는지 읽힌다. `=` 앞 공백은 안 받는다. 코드의
 * `key = value`까지 걸면 도구 출력이 거의 다 가려진다.
 *
 * 매치는 이름 속 KEY 같은 낱말에서 시작한다. 그 앞의 이름 조각은 매치 밖이라 그대로
 * 남는다. 이름 앞부분까지 정규식에 넣으면 `a.a.a.…`나 `KEYKEY…` 같은 입력에서 시작점마다
 * 앞뒤 조합을 다 훑느라 역추적이 터진다. 낱말 뒤 조각은 64자까지 미리보기로 한 번에
 * 잡고 되돌아가지 않는다(`(?=(…))\2`).
 *
 * 값은 닫힌 따옴표, 따옴표 안 줄바꿈(닫는 따옴표를 4096자 안에서 찾는다), JSON 문자열
 * 안에 이스케이프된 따옴표, 못 닫힌 따옴표(줄 끝까지), 맨 값 순서로 본다.
 *
 * 이스케이프된 따옴표 값은 백슬래시 개수로 갈라 읽는다. 한 번 더 감싸인 글자에서 값 안의
 * 따옴표는 백슬래시 셋과 따옴표가 되고 값 끝 백슬래시는 닫는 따옴표 앞에 백슬래시 넷을
 * 더 붙인다. 이 둘을 닫는 따옴표로 잘못 읽으면 뒷부분이 그대로 나가거나 다음 따옴표까지
 * 넘어가 이웃 값이 새므로 넷, 셋과 따옴표, 둘, 하나를 서로 겹치지 않게 나눈다.
 */
const ASSIGNMENT =
  /((?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)(?=([A-Za-z0-9_.-]{0,64}))\2)=(?:"(?:[^"\\]|\\[\s\S]){0,4096}"|'[^']{0,4096}'|\\"(?:[^"\\\n]|\\[^"\\\n]|\\\\\\\\|\\\\\\"|\\\\[^"\\\n]){0,4096}\\"|\\?["'][^\n]*|[^\s"'\\]+)/gi;

/**
 * JSON이나 YAML 꼴 `"api_key": "…"`. 따옴표 친 키만 본다. 대화 기록 안에서 JSON이
 * 문자열로 한 번 더 감싸이면 `\"api_key\": \"…\"`가 되므로 이스케이프된 따옴표도 받는다.
 * 감싼 값은 ASSIGNMENT와 같이 백슬래시 개수로 갈라 읽는다.
 *
 * 낱말 목록은 isSensitiveKey와 따로 간다. 여기는 키 이름의 부분 문자열로 맞추므로
 * `auth`를 그대로 두면 `"author"`가 걸리고 `pass`를 넣으면 `"passed"`나 `"bypass"`도 걸린다.
 */
const QUOTED_FIELD =
  /(\\?"[A-Za-z0-9_.-]{0,64}(?:key|token|secret|password|passwd|pwd|cookie|credential|authorization|auth(?![a-z]))[A-Za-z0-9_.-]{0,64}\\?"\s*:\s*)(?:"(?:[^"\\\n]|\\.){0,4096}"|\\"(?:[^"\\\n]|\\[^"\\\n]|\\\\\\\\|\\\\\\"|\\\\[^"\\\n]){0,4096}\\"|\\?"[^\n]*)/gi;

export function redactText(text: string, options: RedactOptions = {}): string {
  let out = text;
  for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(URL_PASSWORD, (_m, head: string) => `${head}${REDACTED}@`);
  out = out.replace(BEARER, (_m, scheme: string) => `${scheme} ${REDACTED}`);
  out = out.replace(HEADER_LINE, (_m, head: string) => `${head}${REDACTED}`);
  out = out.replace(
    HEADER_QUOTED,
    (_m, quote: string, head: string) => `${quote}${head}${REDACTED}`,
  );
  out = out.replace(ASSIGNMENT, (_m, name: string) => `${name}=${REDACTED}`);
  out = out.replace(QUOTED_FIELD, (_m, head: string) => {
    const q = head.startsWith('\\') ? '\\"' : '"';
    return `${head}${q}${REDACTED}${q}`;
  });
  return replaceHome(out, options.home ?? homedir());
}

function replaceHome(text: string, home: string): string {
  const trimmed = home.replace(/\/+$/, '');
  // `/`나 빈 홈이면 모든 경로가 `~`로 바뀌어 읽을 수 없게 된다
  if (trimmed.length < 2) return text;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `/Users/alice`가 `/Users/alice2`까지 먹지 않게 뒤를 경로 경계로 묶는다
  return text.replace(new RegExp(`${escaped}(?=[/\\s"'\`:;,)\\]}]|$)`, 'g'), '~');
}

/**
 * 이름만 봐도 값이 비밀인 키. 낱말 단위로 맞춘다. `keyword`나 `author`처럼 낱말 일부만
 * 겹치는 키는 안 건드린다.
 *
 * 소문자로 붙여 쓴 `accesstoken`이나 `privatekey` 같은 낱말은 SENSITIVE_KEY_SUFFIX로 낱말
 * 끝을 본다. `key`와 `pass`는 끝으로 맞추면 `monkey`나 `bypass`가 걸려서 낱말이 똑같을 때만
 * 건다. token은 복수형을 안 받는다. `max_tokens`나 `input_tokens`가 흔한 도구 입력 키다.
 */
const SENSITIVE_KEY_WORDS = new Set([
  'key',
  'apikey',
  'token',
  'secret',
  'password',
  'passwd',
  'pass',
  'pwd',
  'auth',
  'authorization',
  'credential',
  'credentials',
  'cookie',
  'cookies',
]);

const SENSITIVE_KEY_SUFFIX = /(?:token|(?:secret|password|passwd|passphrase|apikey|privatekey)s?)$/;

/** 키를 `_`, `-`, `.`, camelCase 경계로 나눠 민감한 낱말이 있는지 본다 */
export function isSensitiveKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_.-]+/);
  return words.some((w) => {
    const lower = w.toLowerCase();
    return SENSITIVE_KEY_WORDS.has(lower) || SENSITIVE_KEY_SUFFIX.test(lower);
  });
}

/**
 * 도구 입력처럼 모양을 모르는 값을 가린다. 문자열은 패턴으로 가리고 민감한 키 아래
 * 값은 패턴과 상관없이 가린다. `{ password: "hunter2" }`의 값은 어떤 패턴에도 안 걸린다.
 *
 * 민감한 키 아래가 평범한 객체면 안으로 들어가고 원시값이나 배열이면 통째로 가린다.
 * 배열까지 들어가면 `cookies: ["sid=abc"]`의 원소가 그대로 나간다.
 */
export function redactValue(value: unknown, options: RedactOptions = {}): unknown {
  if (typeof value === 'string') return redactText(value, options);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, options));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const hide = isSensitiveKey(k) && !isPlainObject(v);
      out[redactText(k, options)] = hide ? REDACTED : redactValue(v, options);
    }
    return out;
  }
  return value;
}

function isPlainObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * UTF-8 바이트 기준으로 앞부분만 남긴다. 반드시 가린 **뒤에** 자른다 — 먼저 자르면
 * PEM 끝 표시가 잘려 나가거나 토큰 앞부분만 남아 패턴에 안 걸린다.
 */
export function truncateBytes(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false };
  // 멀티바이트 글자 중간에서 끊기면 깨진 글자가 남는다. 이어지는 바이트(10xxxxxx)를 건너뛴다
  let end = maxBytes;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true };
}
