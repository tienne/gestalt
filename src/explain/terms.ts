/**
 * 원문에서 전문용어를 뽑고 설명본이 그 말을 어떻게 썼는지 센다.
 *
 * 사전을 미리 만들지 않는다. 도메인마다 다르고 손으로 채우면 유지가 안 된다. 대신 원문에서
 * 꼴로 뽑는다 — 백틱 코드, 대문자 약어, 카멜케이스와 스네이크케이스 식별자, 파일 경로.
 * 그래서 이 검사는 원문이 무슨 분야든 따라간다.
 *
 * 꼴로 뽑으니 놓치는 게 있다. "가비지 컬렉션"처럼 한글로 적힌 전문어는 안 걸린다. 반대로
 * 코드가 아닌 영문 고유명사가 식별자로 걸리기도 한다. 이 경계는 사람이 다시 본다 —
 * 걸린 밀도가 상한을 넘었을 때 무엇이 걸렸는지 함께 내보내는 이유다.
 */

export type TermKind = 'code' | 'path' | 'identifier' | 'acronym';

export interface Term {
  text: string;
  kind: TermKind;
  /** 원문에 몇 번 나왔나 */
  count: number;
}

export interface TermUse {
  term: string;
  kind: TermKind;
  index: number;
  /** 그 자리에서 바로 풀어줬나 */
  glossed: boolean;
  /** 사람이 읽을 앞뒤 조각 */
  excerpt: string;
}

/**
 * 왼쪽 경계를 후행 부정으로 막는 건 파일명이 잘려 두 용어가 되기 때문이다.
 *
 * 막는 자리는 앞에 경로 구분자나 `@`, 점이 붙은 꼴이다. `a/config.ts` 에서 `config.ts` 만
 * 따로 걸리면 한 파일이 두 용어가 된다. `vitest.config.ts` 는 아래 정규식이 파일명 중간
 * 점을 넘어서 이 장치가 없어도 통째로 잡히니 그 예시로 이 줄을 설명하면 안 된다.
 */
const NOT_TOKEN_TAIL = '(?<![\\w.@/-])';
const FILE_EXT = 'ts|tsx|js|jsx|mjs|cjs|json|ya?ml|md|py|go|rs|java|kt|sh|sql|toml|lock';

const EXTRACTORS: Array<{ kind: TermKind; re: RegExp; capture?: number }> = [
  { kind: 'code', re: /`([^`\n]{2,80})`/g, capture: 1 },
  // 앞의 슬래시는 선택이다. 절대 경로에서 첫 마디를 잘라먹지 않으려고 매치 안에 넣는다
  { kind: 'path', re: new RegExp(`(?<![\\w.@-])/?(?:[\\w.@-]+/)+[\\w.@-]*\\w`, 'g') },
  {
    kind: 'path',
    re: new RegExp(`${NOT_TOKEN_TAIL}[\\w-]+(?:\\.[\\w-]+)*\\.(?:${FILE_EXT})\\b`, 'g'),
  },
  { kind: 'identifier', re: /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g },
  { kind: 'identifier', re: /\b[A-Za-z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+\b/g },
  { kind: 'acronym', re: /\b[A-Z][A-Z0-9]+\b/g },
];

/**
 * 핵심어 순위에서 갈래가 갖는 무게.
 *
 * 건수가 같을 때 경로를 뒤로 미룬다. 스택 트레이스는 같은 경로를 여러 줄에 흘리는데 그게
 * 그 글의 주제인 경우는 드물다. 사람이 붙잡는 건 대개 에러 이름이나 함수 이름 쪽이다.
 */
const KIND_RANK: Record<TermKind, number> = { code: 0, acronym: 1, identifier: 2, path: 3 };

/**
 * 풀이 표지. 하나라도 그 문장에 있으면 같은 문장의 용어를 풀어준 것으로 본다.
 *
 * 문장 단위로 보는 건 용어와 풀이의 거리를 글자로 재봐야 어차피 임의의 숫자가 되기 때문이다.
 * 문장 경계는 사람이 읽을 때 실제로 멈추는 자리라 그걸 쓴다.
 */
const GLOSS_MARKERS = [
  '쉽게 말하면',
  '쉽게 말해',
  '말하자면',
  '다시 말해',
  '다시 말하면',
  '풀어 쓰면',
  '풀어서 말하면',
  '무엇이냐면',
  '뭐냐면',
  '라는 건',
  '이라는 건',
  '라는 뜻',
  '이라는 뜻',
  '라는 말',
  '이라는 말',
];

/** 괄호 안에 한글이 있으면 풀이로 본다 — `캐시(한 번 받아온 걸 저장해두는 자리)` */
const HANGUL_PAREN = /[(（][^)）\n]*[가-힣][^)）\n]*[)）]/g;

const WORD_CHAR = /[A-Za-z0-9_]/;

export interface Span {
  start: number;
  end: number;
  text: string;
}

/** 문장을 위치와 함께 자른다. 풀이 표지를 어느 문장에서 찾을지 정하려면 위치가 필요하다 */
export function sentenceSpans(text: string): Span[] {
  const spans: Span[] = [];
  const separator = /(?<=[.!?…])\s+|\n+/g;
  let start = 0;

  for (const match of text.matchAll(separator)) {
    const end = match.index + match[0].length;
    const slice = text.slice(start, end);
    if (slice.trim().length > 0) spans.push({ start, end, text: slice });
    start = end;
  }
  const tail = text.slice(start);
  if (tail.trim().length > 0) spans.push({ start, end: text.length, text: tail });

  return spans;
}

function boundaryOk(text: string, start: number, term: string): boolean {
  const before = text[start - 1];
  const after = text[start + term.length];
  if (WORD_CHAR.test(term[0]!) && before !== undefined && WORD_CHAR.test(before)) return false;
  if (WORD_CHAR.test(term[term.length - 1]!) && after !== undefined && WORD_CHAR.test(after)) {
    return false;
  }
  return true;
}

/**
 * 후보 수 상한.
 *
 * readInput 이 막는 건 바이트 수지 유니크 후보 수가 아니다. 생성된 타입 파일이나 락파일은
 * 2MB 안에서도 식별자가 수만 개 나오는데, 그만큼을 교대 정규식 하나로 합치면 패턴이
 * 커져 컴파일 자체가 비싸진다. 자주 나온 것부터 남긴다 — 그 글이 붙들고 있는 말이 앞에 온다.
 */
const MAX_CANDIDATES = 1000;

/**
 * 원문에 나온 전문용어 후보. 같은 말이 여러 꼴에 걸리면 먼저 걸린 갈래로 둔다.
 *
 * 여기서 세는 건 정규식이 걸린 횟수라 실제 출현 수와 다를 수 있다 — 긴 용어에 먹히는
 * 자리를 아직 안 걸렀기 때문이다. 상한을 넘겼을 때 무엇을 남길지 고르는 데만 쓰고
 * 정확한 건수는 findTermUses 가 다시 센다.
 */
function candidates(source: string): Map<string, TermKind> {
  const found = new Map<string, { kind: TermKind; rough: number }>();

  for (const { kind, re, capture } of EXTRACTORS) {
    for (const match of source.matchAll(re)) {
      const raw = (capture === undefined ? match[0] : match[capture])!.trim();
      if (raw.length < 2) continue;
      const seen = found.get(raw);
      if (seen) seen.rough += 1;
      else found.set(raw, { kind, rough: 1 });
    }
  }

  if (found.size <= MAX_CANDIDATES) {
    return new Map([...found].map(([text, { kind }]) => [text, kind]));
  }
  return new Map(
    [...found]
      .sort((a, b) => b[1].rough - a[1].rough || a[0].localeCompare(b[0]))
      .slice(0, MAX_CANDIDATES)
      .map(([text, { kind }]) => [text, kind]),
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 그 위치를 품는 문장을 이분 탐색으로 찾는다.
 *
 * sentenceSpans 가 이미 위치 순으로 정렬된 배열을 주므로 앞에서부터 훑을 이유가 없다.
 * 선형으로 찾으면 매치 수에 문장 수가 곱해진다.
 */
function spanAt(spans: readonly Span[], index: number): Span | undefined {
  let low = 0;
  let high = spans.length - 1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const span = spans[mid]!;
    if (index < span.start) high = mid - 1;
    else if (index >= span.end) low = mid + 1;
    else return span;
  }
  return undefined;
}

/**
 * 텍스트에서 용어가 실제로 쓰인 자리를 찾는다.
 *
 * 용어 전부를 하나의 교대 정규식으로 합쳐 한 번만 훑는다. 용어마다 따로 전체를 재훑으면
 * 용어 수에 텍스트 길이가 곱해지는데, 후보 수는 텍스트가 길수록 함께 늘어서 제곱으로
 * 붕괴한다. 그 꼴을 재보니 1.9MB 입력에서 수십 초가 걸렸다 — readInput 이 허용하는 크기다.
 *
 * 긴 용어를 교대 앞에 두는 건 정규식이 왼쪽부터 시도하기 때문이다. 그래서 같은 자리에서
 * `ERR_MODULE_NOT_FOUND` 가 `MODULE` 보다 먼저 잡힌다. 매치가 소비되므로 안쪽 짧은 용어가
 * 따로 세어지지 않는다. `src/explain/check.ts` 와 `explain/check.ts` 처럼 한쪽이 다른 쪽을
 * 품는 경로도 같은 이유로 한 번만 걸린다.
 *
 * 포함이 아니라 앞뒤가 어긋나게 겹치는 두 용어(`abc` 와 `bcdef`)는 앞선 쪽이 이긴다.
 * 여기서 뽑는 용어는 식별자와 경로라 그렇게 겹치는 짝이 안 나온다.
 */
export function findTermUses(text: string, terms: readonly Term[]): TermUse[] {
  if (terms.length === 0) return [];

  const sorted = [...terms].sort((a, b) => b.text.length - a.text.length);
  const byText = new Map(sorted.map((term) => [term.text, term]));
  const spans = sentenceSpans(text);
  const uses: TermUse[] = [];

  const re = new RegExp(sorted.map((term) => escapeRegExp(term.text)).join('|'), 'g');

  for (let match = re.exec(text); match !== null; match = re.exec(text)) {
    const found = match[0];
    const at = match.index;

    if (!boundaryOk(text, at, found)) {
      // 경계에 안 맞은 자리를 통째로 건너뛰면 거기서 시작하는 다른 용어를 놓친다
      re.lastIndex = at + 1;
      continue;
    }

    const term = byText.get(found)!;
    const span = spanAt(spans, at);
    uses.push({
      term: found,
      kind: term.kind,
      index: at,
      glossed: span ? isGlossed(span, at - span.start, found) : false,
      excerpt: excerptAt(text, at, found),
    });
  }

  return uses;
}

/**
 * 괄호는 양쪽 다 본다.
 *
 * 뒤에 오는 `캐시(한 번 받아온 걸 저장해두는 자리)` 만 보면 순서를 뒤집은
 * `설정 파일(vitest.config.ts, 테스트 돌릴 때 읽는 설정)` 이 안 걸린다. 둘 다 풀어준 것이라
 * 한쪽만 인정하면 글쓴이가 어느 어순을 골랐느냐로 판정이 갈린다.
 */
function isGlossed(span: Span, offset: number, term: string): boolean {
  if (GLOSS_MARKERS.some((marker) => span.text.includes(marker))) return true;

  const end = offset + term.length;
  for (const paren of span.text.matchAll(HANGUL_PAREN)) {
    const from = paren.index;
    const to = from + paren[0].length;
    if (from >= end) return true;
    if (from <= offset && to >= end) return true;
  }
  return false;
}

function excerptAt(text: string, at: number, term: string): string {
  return text
    .slice(Math.max(0, at - 20), at + term.length + 20)
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractTerms(source: string): Term[] {
  const found = candidates(source);
  const stubs: Term[] = [...found].map(([text, kind]) => ({ text, kind, count: 0 }));
  const counts = new Map<string, number>();

  for (const use of findTermUses(source, stubs)) {
    counts.set(use.term, (counts.get(use.term) ?? 0) + 1);
  }

  return stubs
    .map((term) => ({ ...term, count: counts.get(term.text) ?? 0 }))
    .filter((term) => term.count > 0)
    .sort(byWeight);
}

function byWeight(a: Term, b: Term): number {
  if (b.count !== a.count) return b.count - a.count;
  if (KIND_RANK[a.kind] !== KIND_RANK[b.kind]) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
  // 같은 갈래면 짧은 쪽이 개념 이름일 확률이 높다. 긴 쪽은 대개 그 개념이 놓인 자리다
  if (a.text.length !== b.text.length) return a.text.length - b.text.length;
  return a.text.localeCompare(b.text);
}

/** 자주 나오는 말부터 핵심어로 본다. 원문이 무엇을 계속 붙들고 있는지가 그 글의 주제다 */
export function coreTerms(terms: readonly Term[], limit: number): Term[] {
  return [...terms].sort(byWeight).slice(0, limit);
}
