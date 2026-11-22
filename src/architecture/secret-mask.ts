/**
 * 아키텍처 산출물(본인용 HTML, 저장 IR, 공유본, delta)에 실을 글자에서 비밀값을 가린다.
 * 멀쩡한 값을 가리는 손해보다 비밀값을 흘리는 손해가 커서 애매하면 가린다.
 * 정규식은 전부 길이 상한을 두거나 한 글자 묶음만 반복해서 입력이 길어도 역추적이 터지지 않는다.
 */

import type { SecretMaskedWarning, ValidatedIr } from './validator.js';
import type {
  ArchitectureEdge,
  ArchitectureFlow,
  ArchitectureIr,
  ArchitectureNode,
  ArchitectureProjection,
  DocInfo,
  Evidence,
  UnresolvedQuestion,
} from './types.js';

/** 가린 자리에 넣는 표식. 어느 규칙에도 안 걸리는 글자라 두 번 돌려도 결과가 같다 */
export const SECRET_MASK = '[비밀값]';

export interface MaskResult {
  text: string;
  /** 가린 자리 수 */
  masked: number;
}

/** 글자당 섀넌 엔트로피(비트). 무작위 키는 4 넘게, 낱말과 안내 문구는 2~3 정도가 나온다 */
function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const count = (s: string, re: RegExp): number => s.match(re)?.length ?? 0;

// 안내 문구 낱말. 무작위 키 속에 같은 글자가 박힌 경우는 가려야 하므로 낱말 경계로만 본다
const PLACEHOLDER_WORDS = [
  'your',
  'yours',
  'here',
  'example',
  'sample',
  'dummy',
  'fake',
  'placeholder',
  'replace',
  'redacted',
  'insert',
  'todo',
  'tbd',
  'changeme',
  'generate',
  // 포르투갈어, 스페인어, 프랑스어, 독일어 "여기 키 넣기"
  'sua',
  'seu',
  'aqui',
  'troque',
  'altere',
  'defina',
  'mude',
  'gere',
  'exemplo',
  'clave',
  'cambia',
  'votre',
  'ici',
  'changez',
  'deine',
  'geheime',
  'hier',
  'beispiel',
];
const PLACEHOLDER = new RegExp(
  String.raw`xxxx|change[-_]?me|<[^<>\n]{0,100}>|\$\{|\{\{|%\(|\*\*\*|0{8,}|1234567|abcdef|여기|입력|넣[어으기]|예시|ここ|入力` +
    String.raw`|(?<![\p{L}\d])(?:${PLACEHOLDER_WORDS.join('|')})(?![\p{L}\d])`,
  'iu',
);

/** 다른 곳에서 값을 읽어 오는 참조. 글자 자체는 비밀이 아니다 */
const ENV_REFERENCE =
  /process\.env|import\.meta\.env|os\.environ|os\.getenv|getenv\(|env\(|System\.getenv|ENV\[|secrets\.|^\$[A-Za-z_(]|^%[A-Za-z_]+%$|^#\{/;

/** 웹 페이지에 그대로 박으라고 만든 공개 키 */
const PUBLIC_KEY = /^(?:pk_|pk\.|sb_publishable_|phc_)/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_HASH = /^[0-9a-f]{7,64}$/i;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
/** 브라우저 자동 완성 값처럼 이름만 비밀 같은 고정 낱말 */
const NOT_A_VALUE =
  /^(?:password|passwd|pass|secret|token|null|none|nil|true|false|undefined|required|optional|string|current-password|new-password|one-time-code)$/i;

/** 소문자 낱말 토막을 슬래시로 이은 프로젝트 파일 경로. 확장자로 끝난다 */
function looksLikeFilePath(v: string): boolean {
  const parts = v.split('/').filter((p) => p !== '');
  return (
    parts.length >= 2 &&
    /\.[a-z][a-z0-9]{0,5}$/.test(v) &&
    parts.every((p) => /^[a-z0-9_.@[\]-]+$/.test(p) && /[a-z]{2,}/.test(p))
  );
}

/** 슬래시로 나뉜 낱말 묶음. 파일 경로나 URL 경로다 */
function looksLikePath(v: string): boolean {
  if (!v.includes('/')) return false;
  if (looksLikeFilePath(v)) return true;
  const parts = v.split('/').filter((p) => p !== '');
  return (
    parts.length >= 2 && parts.every((p) => /^[a-z][a-z0-9_.-]*$/.test(p) || /^\[[\w.]+\]$/.test(p))
  );
}

/** 알파벳이나 숫자를 차례로 늘어놓은 지어낸 키 */
function hasSequence(v: string): boolean {
  return /abcdefgh|bcdefghi|0123456789|1234567890|ABCDEFGH/.test(v);
}

// 이름은 끝 토막만 본다. routeToken처럼 앞이 무엇이든 token으로 끝나면 비밀 이름이다
const SECRET_NAME =
  /(?:^|_)(?:api_?key|apikey|secret(?:_?key)?|client_?secret|app_?secret|token|access_?token|refresh_?token|auth_?token|bearer_?token|id_?token|passw(?:or)?d|pwd|pass|private_?key|secret_?access_?key|access_?key|signing_?(?:key|secret)|webhook_?secret|encryption_?key|auth(?:orization)?(?:_?key)?|master_?key|credentials?|session_?key|cookie_?secret|dsn)$/i;
const PASSWORD_NAME = /(?:^|_)(?:passw(?:or)?d|pwd|pass)$/i;
const ACCESS_TOKEN_NAME = /(?:^|_)(?:access|refresh|auth|bearer|id|api)_?token$/i;

/** camelCase, kebab-case, 점 표기를 snake_case로 */
function snake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-.\s]+/g, '_')
    .toLowerCase();
}

/** 비밀 이름에 붙은 값이 정말 값인지. 참조나 안내 문구, 공개 키, 경로면 아니다 */
function assignedValueIsSecret(name: string, value: string): boolean {
  const v = value.trim();
  if (v.length < 4 || v.includes(SECRET_MASK) || /\s/.test(v)) return false;
  if (NOT_A_VALUE.test(v) || ENV_REFERENCE.test(v) || PLACEHOLDER.test(v)) return false;
  const n = snake(name);
  const password = PASSWORD_NAME.test(n);
  // 비밀번호는 사람이 고르므로 pk_로 시작해도 봐주지 않는다. 다만 화면 파일 경로를 가리키는 표는 흔하다
  if (password) return !looksLikeFilePath(v);
  if (PUBLIC_KEY.test(v) || looksLikePath(v) || /^https?:\/\//.test(v)) return false;
  if (UUID.test(v)) return false;
  // 레코드 id로 흔한 ULID는 접근 토큰 이름이 아닐 때만 봐준다
  if (ULID.test(v) && !ACCESS_TOKEN_NAME.test(n)) return false;
  if (hasSequence(v)) return false;
  return true;
}

/**
 * 따옴표 없는 대입 값이 비밀값인지. 코드 근거의 `token = getToken()`, `token = this.token`,
 * `token={session.accessToken}`, `token: [a, b]`는 값이 아니다. 괄호는 호출이나 인덱싱처럼 닫는 괄호로 끝날 때만
 * 코드로 본다. `Hunter(2)abc9` 같은 비밀번호에도 괄호가 들어간다.
 * 이름이 비밀번호 꼴이고 값에 숫자가 있으면 닫는 괄호로 끝나도 `Hunter(2)` 같은 값으로 본다. 조건은 셋 중 하나다.
 * .env 대문자 이름, 대문자로 시작하는 값, 첫 괄호 앞에 숫자가 있는 값. `getToken(user1)`, `argv[1]`은 코드로 남는다.
 * 점으로 이은 꼴도 .env 대문자 이름에 붙었거나 숫자가 섞이면 `Summer2024.Corp1` 같은 값으로 본다.
 * `:`는 `auth: Keycloak`, `Authorization: Bearer`처럼 산문과 타입 선언에 흔해서 생성 값처럼 보일 때만 가린다
 */
function bareValueIsSecret(name: string, op: string, value: string): boolean {
  if (/^[=>{[]/.test(value)) return false;
  if (CALL_OR_INDEX.test(value) && !passwordLikeCall(name, value)) return false;
  if (MEMBER_CHAIN.test(value) && !(ENV_NAME.test(name) || /\d/.test(value))) return false;
  // 숫자 없는 낱말 하나는 코드의 변수 이름일 때가 많다. .env처럼 대문자 이름에 붙었을 때만 값으로 본다
  if (IDENTIFIER.test(value) && !/\d/.test(value) && !ENV_NAME.test(name)) return false;
  if (!assignedValueIsSecret(name, value)) return false;
  if (op.trim() !== ':') return true;
  return (/\d/.test(value) && /[A-Za-z]/.test(value)) || looksRandom(value);
}

function passwordLikeCall(name: string, value: string): boolean {
  return (
    PASSWORD_NAME.test(snake(name)) &&
    /\d/.test(value) &&
    (ENV_NAME.test(name) || /^[A-Z]|^[^([]*\d/.test(value))
  );
}

const CLOSER_PAIRS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

function splitUnmatchedClosers(raw: string): { value: string; tail: string } {
  let value = raw;
  let tail = '';
  const count = (c: string) => value.split(c).length - 1;
  for (;;) {
    const last = value.slice(-1);
    const open = CLOSER_PAIRS[last];
    if (open === undefined || count(last) <= count(open)) break;
    value = value.slice(0, -1);
    tail = `${last}${tail}`;
  }
  return { value, tail };
}

function urlParamIsSecret(key: string, value: string): boolean {
  if (!SECRET_NAME.test(snake(key)) && !URL_SECRET_KEY.test(key)) return false;
  return !value.includes(SECRET_MASK) && !PLACEHOLDER.test(value) && !ENV_REFERENCE.test(value);
}

/** 이름은 대충 생겼어도 무작위로 만든 값처럼 보이는지. 숫자와 글자가 섞이고 엔트로피가 높다 */
function looksRandom(v: string): boolean {
  if (!/\d/.test(v) || !/[A-Za-z]/.test(v)) return false;
  if (UUID.test(v) || HEX_HASH.test(v) || looksLikePath(v) || PUBLIC_KEY.test(v)) return false;
  if (PLACEHOLDER.test(v) || hasSequence(v)) return false;
  return entropy(v) >= 4;
}

/** 산문 속 따옴표 없는 글자가 생성 키 꼴인지. 대소문자와 숫자가 고루 섞이고 낱말(CamelCase)이 아니다 */
function looksGenerated(v: string): boolean {
  if (looksLikePath(v) || PUBLIC_KEY.test(v) || hasSequence(v)) return false;
  return (
    count(v, /\d+/g) >= 3 &&
    count(v, /\d/g) >= 4 &&
    count(v, /[A-Z]/g) >= 4 &&
    count(v, /[a-z]/g) >= 4 &&
    count(v, /[A-Z][a-z]{3,}/g) < 3 &&
    entropy(v) >= 4
  );
}

interface KnownFormat {
  name: string;
  re: RegExp;
}

// 뒤에 키 글자가 더 이어지지 않는 자리에서 끝낸다
const END = String.raw`(?![A-Za-z0-9_-])`;
const START = String.raw`(?<![A-Za-z0-9_-])`;
const fmt = (name: string, body: string): KnownFormat => ({
  name,
  re: new RegExp(START + body + END, 'g'),
});

/** 서비스가 정한 꼴이 뚜렷한 키. 길이 상한을 둔다 */
const KNOWN_FORMATS: KnownFormat[] = [
  fmt('GitHub', String.raw`(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}`),
  fmt('GitHub fine-grained', String.raw`github_pat_[A-Za-z0-9_]{50,255}`),
  fmt('GitLab', String.raw`glpat-[A-Za-z0-9_-]{20,64}`),
  fmt('Slack', String.raw`xox[abposr]-[A-Za-z0-9-]{10,250}`),
  {
    name: 'Slack webhook',
    re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/-]{20,200}/g,
  },
  {
    name: 'Discord webhook',
    re: /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,30}\/[A-Za-z0-9_-]{30,100}/g,
  },
  fmt('AWS access key', String.raw`(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}`),
  fmt('Google API key', String.raw`AIza[0-9A-Za-z_-]{35}`),
  fmt('Google OAuth', String.raw`ya29\.[0-9A-Za-z_-]{20,500}`),
  fmt('Stripe', String.raw`(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,247}`),
  fmt('Anthropic', String.raw`sk-ant-[A-Za-z0-9_-]{20,300}`),
  fmt('OpenAI', String.raw`sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,300}`),
  fmt('npm', String.raw`npm_[A-Za-z0-9]{36}`),
  fmt('PyPI', String.raw`pypi-[A-Za-z0-9_-]{50,300}`),
  fmt('SendGrid', String.raw`SG\.[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{30,64}`),
  fmt('Twilio', String.raw`SK[0-9a-fA-F]{32}`),
  fmt('Mailgun', String.raw`key-[0-9a-zA-Z]{32}`),
  fmt('Shopify', String.raw`shp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}`),
  fmt('Hugging Face', String.raw`hf_[A-Za-z0-9]{30,64}`),
  fmt('DigitalOcean', String.raw`do[por]_v1_[a-f0-9]{64}`),
  fmt('Doppler', String.raw`dp\.(?:pt|st|sa|ct|scim|audit)\.[A-Za-z0-9]{40,64}`),
  fmt('Linear', String.raw`lin_(?:api|oauth)_[A-Za-z0-9]{40}`),
  fmt('Postman', String.raw`PMAK-[a-f0-9]{24}-[a-f0-9]{34}`),
  fmt('Atlassian', String.raw`ATATT[A-Za-z0-9_=-]{50,300}`),
  fmt('Square', String.raw`(?:sq0atp|sq0csp)-[0-9A-Za-z_-]{22,60}`),
  fmt('Telegram bot', String.raw`\d{8,10}:AA[0-9A-Za-z_-]{33}`),
  fmt('Supabase secret', String.raw`sb_secret_[A-Za-z0-9_-]{20,100}`),
  fmt('Notion', String.raw`(?:secret_|ntn_)[A-Za-z0-9]{40,50}`),
  fmt('Databricks', String.raw`dapi[a-f0-9]{32}(?:-\d)?`),
];

const AZURE_ACCOUNT_KEY = /(AccountKey=)([A-Za-z0-9+/]{40,100}={0,2})/g;
const JWT =
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,2000}\.eyJ[A-Za-z0-9_-]{8,4000}\.[A-Za-z0-9_-]{0,2000}(?![A-Za-z0-9_-])/g;
// scheme://user:pw@ 의 pw만 가린다. 사용자 이름과 호스트는 그림에 필요하다
const DB_URL = /\b([a-z][a-z0-9+.-]{1,30}:\/\/[^\s:/@'"`<>]{0,256}:)([^\s@/'"`<>]{1,256})@/gi;
// name = "value", "name": 'value', name: `value` 같은 대입. 이름 앞뒤 따옴표는 같아야 한다
const QUOTED_ASSIGN =
  /(?<![\w.-])(["']?)([A-Za-z_][\w.-]{0,100})\1(\s{0,10}(?::=|=>|=|:)\s{0,10})(["'`])([^"'`\n]{0,2000})\4/g;
// name=value, NAME:=value, key: value 같은 따옴표 없는 대입. 값은 공백과 따옴표, 구분 문자에서 끊는다.
// `)`에서 끊으면 `Hunter(2)abc9`가 `Hunter(2`로 잘려 호출 꼴로 보이므로 값에 넣고 짝 없는 꼬리만 콜백에서 뗀다.
// 앞의 `-`는 막지 않는다. `--password=값` 같은 명령행 인자가 흔하고 `reset-password`는 맨 앞부터 이름으로 잡힌다
const BARE_ASSIGN =
  /(?<![\w.])([A-Za-z_][\w.-]{0,100})(\s{0,10}(?::=|=|:)\s{0,10})([^\s"'`,;]{4,256})/g;
// URL 쿼리와 fragment 안 키=값. 키와 값 없는 `#절` 앵커는 안 걸린다
const URL_PARAM = /([?&#])([A-Za-z_][\w.-]{0,100})=([^&#\s"'`<>]{1,512})/g;
const URL_SECRET_KEY = /^(?:sig|signature|x-amz-signature|x-amz-credential|code|key)$/i;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const MEMBER_CHAIN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const CALL_OR_INDEX = /^[A-Za-z_$][\w$.]*[([].*[)\]]$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const QUOTED_RANDOM = /(["'`])([A-Za-z0-9+/=_-]{32,8192})\1/g;
const BARE_RANDOM = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{32,8192}={0,2}(?![A-Za-z0-9+/=_-])/g;

const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/;

/** BEGIN부터 END까지. END가 없으면 글 끝까지 가린다. 블록 길이에 상관없이 indexOf로만 찾는다 */
function maskPrivateKeys(text: string): MaskResult {
  let out = '';
  let rest = text;
  let masked = 0;
  for (;;) {
    const begin = PRIVATE_KEY_BEGIN.exec(rest);
    if (begin === null) break;
    out += rest.slice(0, begin.index) + SECRET_MASK;
    masked += 1;
    const after = rest.slice(begin.index + begin[0].length);
    const end = PRIVATE_KEY_END.exec(after);
    rest = end === null ? '' : after.slice(end.index + end[0].length);
  }
  return { text: out + rest, masked };
}

/** 숫자가 하나도 없거나 알파벳, 숫자를 차례로 늘어놓은 지어낸 값은 형식이 맞아도 놔둔다 */
function knownFormatIsReal(match: string): boolean {
  return /\d/.test(match) && !/EXAMPLE|xxxx|XXXX|0{10,}/.test(match) && !hasSequence(match);
}

/**
 * 따옴표 없는 대입을 가린다. 바깥 대입이 값으로 나머지를 통째로 삼키면 replace가 그 안을 다시 훑지 않으므로
 * 바깥을 가리지 않은 경우 값 안의 `NAME=값`을 같은 규칙으로 다시 본다. 값은 256자 상한이고 매번 짧아진다
 */
function maskBare(text: string): MaskResult {
  let masked = 0;
  const out = text.replace(BARE_ASSIGN, (m, name: string, op: string, raw: string) => {
    // `login(password=…)`, `[password=…]`처럼 대입을 감싼 닫는 괄호가 값 끝에 붙어 온다
    const { value, tail } = splitUnmatchedClosers(raw);
    const last = name.split('.').pop() ?? name;
    if (value.length >= 4 && SECRET_NAME.test(snake(last)) && bareValueIsSecret(last, op, value)) {
      masked += 1;
      return `${name}${op}${SECRET_MASK}${tail}`;
    }
    if (!/[=:]/.test(raw)) return m;
    const inner = maskBare(raw);
    if (inner.masked === 0) return m;
    masked += inner.masked;
    return `${name}${op}${inner.text}`;
  });
  return { text: out, masked };
}

/**
 * 글자에서 비밀값을 가린다. 비밀값이 없으면 같은 글자를 돌려준다.
 * 가리는 순서: 개인 키 블록, 알려진 키 형식, JWT, 접속 주소 비밀번호, 비밀 이름에 대입한 따옴표 값,
 * URL 쿼리와 fragment의 비밀 키 값, 비밀 이름에 대입한 따옴표 없는 값, 따옴표 안 무작위 긴 글자, 산문 속 따옴표 없는 생성 키 꼴
 */
export function maskSecrets(text: string): MaskResult {
  if (text.length === 0) return { text, masked: 0 };
  const pk = maskPrivateKeys(text);
  let out = pk.text;
  let masked = pk.masked;

  for (const { re } of KNOWN_FORMATS) {
    out = out.replace(re, (m) => {
      if (!knownFormatIsReal(m)) return m;
      masked += 1;
      return SECRET_MASK;
    });
  }
  out = out.replace(AZURE_ACCOUNT_KEY, (_m, head: string) => {
    masked += 1;
    return head + SECRET_MASK;
  });
  out = out.replace(JWT, () => {
    masked += 1;
    return SECRET_MASK;
  });
  out = out.replace(DB_URL, (m, head: string, pw: string) => {
    if (pw === SECRET_MASK || NOT_A_VALUE.test(pw) || PLACEHOLDER.test(pw) || /^[$%{<:]/.test(pw))
      return m;
    masked += 1;
    return `${head}${SECRET_MASK}@`;
  });
  out = out.replace(
    QUOTED_ASSIGN,
    (m, q: string, name: string, op: string, q2: string, value: string) => {
      const last = name.split('.').pop() ?? name;
      if (!SECRET_NAME.test(snake(last)) || !assignedValueIsSecret(last, value)) return m;
      masked += 1;
      return `${q}${name}${q}${op}${q2}${SECRET_MASK}${q2}`;
    },
  );
  out = out.replace(URL_PARAM, (m, sep: string, key: string, value: string) => {
    if (!urlParamIsSecret(key, value)) return m;
    masked += 1;
    return `${sep}${key}=${SECRET_MASK}`;
  });
  const bare = maskBare(out);
  out = bare.text;
  masked += bare.masked;
  out = out.replace(QUOTED_RANDOM, (m, q: string, v: string) => {
    if (!looksRandom(v)) return m;
    masked += 1;
    return `${q}${SECRET_MASK}${q}`;
  });
  out = out.replace(BARE_RANDOM, (v) => {
    if (!looksGenerated(v)) return v;
    masked += 1;
    return SECRET_MASK;
  });
  return { text: masked === 0 ? text : out, masked };
}

/** 가린 자리 하나. 위치만 담고 값이나 값의 일부는 담지 않는다 */
export interface SecretHit {
  nodeId?: string;
  edgeId?: string;
  flowId?: string;
  projectionId?: string;
  questionId?: string;
  stageId?: string;
  groupId?: string;
  repoId?: string;
  /** 그 대상 안의 필드 경로. 예: `description`, `evidence[0].excerpt`, `steps[s1].label` */
  field: string;
}

type Owner = Omit<SecretHit, 'field'>;

class IrMasker {
  readonly hits: SecretHit[] = [];

  text(value: string, owner: Owner, field: string): string {
    const r = maskSecrets(value);
    if (r.masked > 0) this.hits.push({ ...owner, field });
    return r.text;
  }

  opt<K extends string>(
    key: K,
    value: string | undefined,
    owner: Owner,
    field = key as string,
  ): Partial<Record<K, string>> {
    return value === undefined
      ? {}
      : ({ [key]: this.text(value, owner, field) } as Partial<Record<K, string>>);
  }

  evidence(list: Evidence[], owner: Owner, prefix = ''): Evidence[] {
    return list.map((ev, i) => ({
      ...ev,
      // code 근거 위치는 `<repo>:<경로>:<줄>`이라 비밀값이 없고 가리면 코드로 못 간다.
      // 공유본은 private과 live 근거의 위치를 지운 뒤에 오므로 위치가 없을 수 있다
      ...(ev.type === 'code'
        ? {}
        : this.opt('location', ev.location, owner, `${prefix}evidence[${i}].location`)),
      ...this.opt('excerpt', ev.excerpt, owner, `${prefix}evidence[${i}].excerpt`),
      ...this.opt('command', ev.command, owner, `${prefix}evidence[${i}].command`),
    }));
  }

  node(n: ArchitectureNode): ArchitectureNode {
    const o: Owner = { nodeId: n.id };
    return {
      ...n,
      label: this.text(n.label, o, 'label'),
      ...this.opt('displayName', n.displayName, o),
      ...this.opt('description', n.description, o),
      ...this.opt('summary', n.summary, o),
      evidence: this.evidence(n.evidence, o),
      ...(n.columns !== undefined
        ? {
            columns: n.columns.map((c, i) => ({
              ...c,
              name: this.text(c.name, o, `columns[${i}].name`),
              ...this.opt('type', c.type, o, `columns[${i}].type`),
              ...(c.evidence !== undefined
                ? { evidence: this.evidence(c.evidence, o, `columns[${i}].`) }
                : {}),
            })),
          }
        : {}),
      ...(n.doc !== undefined ? { doc: this.doc(n.doc, o) } : {}),
    };
  }

  doc(d: DocInfo, o: Owner): DocInfo {
    return {
      ...d,
      ...(d.sections !== undefined
        ? { sections: d.sections.map((s, i) => this.text(s, o, `doc.sections[${i}]`)) }
        : {}),
      ...(d.keywords !== undefined
        ? { keywords: d.keywords.map((s, i) => this.text(s, o, `doc.keywords[${i}]`)) }
        : {}),
      ...(d.gaps !== undefined
        ? {
            gaps: d.gaps.map((g, i) => ({
              ...g,
              ...this.opt('text', g.text, o, `doc.gaps[${i}].text`),
            })),
          }
        : {}),
    };
  }

  edge(e: ArchitectureEdge): ArchitectureEdge {
    return { ...e, evidence: this.evidence(e.evidence, { edgeId: e.id }) };
  }

  flow(f: ArchitectureFlow): ArchitectureFlow {
    const o: Owner = { flowId: f.id };
    return {
      ...f,
      title: this.text(f.title, o, 'title'),
      ...this.opt('description', f.description, o),
      ...(f.stateLabels !== undefined
        ? {
            stateLabels: Object.fromEntries(
              Object.entries(f.stateLabels).map(([k, v]) => [
                k,
                this.text(v, o, `stateLabels.${k}`),
              ]),
            ),
          }
        : {}),
      actors: f.actors.map((a) => ({
        ...a,
        label: this.text(a.label, o, `actors[${a.id}].label`),
      })),
      steps: f.steps.map((st) => ({
        ...st,
        label: this.text(st.label, o, `steps[${st.id}].label`),
        ...this.opt('description', st.description, o, `steps[${st.id}].description`),
        evidence: this.evidence(st.evidence, o, `steps[${st.id}].`),
      })),
      transitions: f.transitions.map((t) => ({
        ...t,
        ...this.opt('trigger', t.trigger, o, `transitions[${t.id}].trigger`),
        ...this.opt('condition', t.condition, o, `transitions[${t.id}].condition`),
        ...this.opt('label', t.label, o, `transitions[${t.id}].label`),
        evidence: this.evidence(t.evidence, o, `transitions[${t.id}].`),
      })),
    };
  }

  projection(p: ArchitectureProjection): ArchitectureProjection {
    const o: Owner = { projectionId: p.id };
    return {
      ...p,
      title: this.text(p.title, o, 'title'),
      question: this.text(p.question, o, 'question'),
      messages: p.messages.map((m) => ({
        ...m,
        label: this.text(m.label, o, `messages[${m.id}].label`),
        ...this.opt('branch', m.branch, o, `messages[${m.id}].branch`),
        evidence: this.evidence(m.evidence, o, `messages[${m.id}].`),
      })),
      ...(p.blocks !== undefined
        ? {
            blocks: p.blocks.map((b) => ({
              ...b,
              label: this.text(b.label, o, `blocks[${b.id}].label`),
            })),
          }
        : {}),
      ...(p.sides !== undefined
        ? {
            sides: p.sides.map((s) => ({
              ...s,
              label: this.text(s.label, o, `sides[${s.id}].label`),
            })),
          }
        : {}),
      ...(p.phases !== undefined
        ? {
            phases: p.phases.map((ph) => ({
              ...ph,
              label: this.text(ph.label, o, `phases[${ph.id}].label`),
            })),
          }
        : {}),
    };
  }

  question(q: UnresolvedQuestion): UnresolvedQuestion {
    const o: Owner = { questionId: q.id };
    return {
      ...q,
      question: this.text(q.question, o, 'question'),
      ...this.opt('answer', q.answer, o),
    };
  }
}

/**
 * IR의 LLM 글자 칸 전부에서 비밀값을 가린 사본. 입력은 바꾸지 않는다.
 * 선택 칸이 없는 예전 IR은 그 칸 없이 그대로 지나간다
 */
export function maskIrSecrets(ir: ArchitectureIr): { ir: ArchitectureIr; hits: SecretHit[] } {
  const m = new IrMasker();
  const masked: ArchitectureIr = {
    ...ir,
    repos: ir.repos.map((r) => ({
      ...r,
      ...m.opt('remote', r.remote, { repoId: r.id }),
    })),
    nodes: ir.nodes.map((n) => m.node(n)),
    edges: ir.edges.map((e) => m.edge(e)),
    unresolved: ir.unresolved.map((q) => m.question(q)),
    sourcesUsed: ir.sourcesUsed.map((s, i) => ({
      ...s,
      identifier: m.text(s.identifier, {}, `sourcesUsed[${i}].identifier`),
    })),
    ...m.opt('summary', ir.summary, {}),
    ...m.opt('note', ir.note, {}),
    ...(ir.flows !== undefined ? { flows: ir.flows.map((f) => m.flow(f)) } : {}),
    ...(ir.projections !== undefined
      ? { projections: ir.projections.map((p) => m.projection(p)) }
      : {}),
    ...(ir.stages !== undefined
      ? {
          stages: ir.stages.map((s) => ({
            ...s,
            label: m.text(s.label, { stageId: s.id }, 'label'),
          })),
        }
      : {}),
    ...(ir.groups !== undefined
      ? {
          groups: ir.groups.map((g) => ({
            ...g,
            name: m.text(g.name, { groupId: g.id }, 'name'),
          })),
        }
      : {}),
  };
  return { ir: m.hits.length === 0 ? ir : masked, hits: m.hits };
}

/** 그릴 때 만든 자동 질문처럼 IR 밖에 있는 질문 목록을 같은 규칙으로 가린다 */
export function maskQuestionSecrets(questions: UnresolvedQuestion[]): {
  questions: UnresolvedQuestion[];
  hits: SecretHit[];
} {
  const m = new IrMasker();
  const out = questions.map((q) => m.question(q));
  return { questions: m.hits.length === 0 ? questions : out, hits: m.hits };
}

const HIT_OWNERS = [
  'nodeId',
  'edgeId',
  'flowId',
  'projectionId',
  'questionId',
  'stageId',
  'groupId',
  'repoId',
] as const;

/** 가린 자리를 SECRET_MASKED 경고로 바꾼다. 같은 자리는 한 번만 싣고 값은 싣지 않는다 */
export function secretMaskedWarnings(hits: readonly SecretHit[]): SecretMaskedWarning[] {
  const seen = new Set<string>();
  const out: SecretMaskedWarning[] = [];
  for (const hit of hits) {
    const owner = HIT_OWNERS.find((k) => hit[k] !== undefined);
    const key = `${owner ?? ''}\u0000${owner ? hit[owner] : ''}\u0000${hit.field}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const where = owner ? `${owner} "${hit[owner]}"의 ${hit.field}` : hit.field;
    out.push({
      code: 'SECRET_MASKED',
      message: `${where}에서 비밀값으로 보이는 글자를 ${SECRET_MASK}로 가렸다. 원본 자료에서도 지우는 게 좋다.`,
      ...(owner ? { [owner]: hit[owner] } : {}),
      field: hit.field,
    });
  }
  return out;
}

/**
 * 검증을 마친 IR과 자동 질문을 가린 사본. 그릴 대상 id 집합은 그대로다.
 * 근거 excerpt를 코드와 대조하는 검증보다 뒤에 불러야 가린 글자 때문에 대조가 어긋나지 않는다
 */
export function maskValidatedIr(v: ValidatedIr): { validated: ValidatedIr; hits: SecretHit[] } {
  const ir = maskIrSecrets(v.ir);
  const questions = maskQuestionSecrets(v.autoUnresolved);
  const hits = [...ir.hits, ...questions.hits];
  if (hits.length === 0) return { validated: v, hits };
  return { validated: { ...v, ir: ir.ir, autoUnresolved: questions.questions }, hits };
}

/** 경고 문구에 label이나 제목이 그대로 들어가는 것이 있어 문구도 같은 규칙으로 가린다 */
export function maskWarningMessages<W extends { message: string }>(warnings: readonly W[]): W[] {
  return warnings.map((w) => {
    const r = maskSecrets(w.message);
    return r.masked === 0 ? w : { ...w, message: r.text };
  });
}
