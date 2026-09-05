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
 * `\b` 만 쓰면 `vitest.config.ts` 에서 `config.ts` 가 따로 걸려 한 번 쓴 말이 두 번으로 잡힌다.
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

/** 원문에 나온 전문용어 후보. 같은 말이 여러 꼴에 걸리면 먼저 걸린 갈래로 둔다 */
function candidates(source: string): Map<string, TermKind> {
  const found = new Map<string, TermKind>();

  for (const { kind, re, capture } of EXTRACTORS) {
    for (const match of source.matchAll(re)) {
      const raw = (capture === undefined ? match[0] : match[capture])!.trim();
      if (raw.length < 2) continue;
      if (!found.has(raw)) found.set(raw, kind);
    }
  }

  return found;
}

/**
 * 텍스트에서 용어가 실제로 쓰인 자리를 찾는다.
 *
 * 긴 용어부터 훑고 먹은 구간을 지운다. `ERR_MODULE_NOT_FOUND` 안의 `MODULE` 을 따로 세면
 * 한 번 쓴 말이 두 번으로 잡혀 밀도가 부풀기 때문이다.
 */
export function findTermUses(text: string, terms: readonly Term[]): TermUse[] {
  const sorted = [...terms].sort((a, b) => b.text.length - a.text.length);
  const taken = new Array<boolean>(text.length).fill(false);
  const spans = sentenceSpans(text);
  const uses: TermUse[] = [];

  for (const term of sorted) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(term.text, from);
      if (at === -1) break;
      from = at + 1;

      if (!boundaryOk(text, at, term.text)) continue;
      let overlaps = false;
      for (let i = at; i < at + term.text.length; i += 1) {
        if (taken[i]) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;
      for (let i = at; i < at + term.text.length; i += 1) taken[i] = true;

      const span = spans.find((s) => at >= s.start && at < s.end);
      uses.push({
        term: term.text,
        kind: term.kind,
        index: at,
        glossed: span ? isGlossed(span, at - span.start, term.text) : false,
        excerpt: excerptAt(text, at, term.text),
      });
    }
  }

  return uses.sort((a, b) => a.index - b.index);
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
