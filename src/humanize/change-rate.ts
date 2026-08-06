/**
 * 변경률 — 원문과 윤문본이 얼마나 달라졌는지.
 *
 * 어절 단위 LCS로 측정한다. 문자 단위 DP는 1만자만 넘어가도 셀이 억 단위라 못 쓰고,
 * 어절 단위면 같은 글이 수천 토큰이라 DP가 그대로 돈다.
 * 공식은 1 - 2·LCS / (len(a) + len(b)) — difflib.SequenceMatcher.ratio()와 같다.
 */

/** 어절이 이 수를 넘으면 DP를 포기하고 순서를 무시한 겹침 비율로 떨어뜨린다 */
const TOKEN_DP_CAP = 6000;

const SUMMARY_BLOCK = /<!--\s*HUMANIZE-SUMMARY[\s\S]*?-->/g;
const MARKUP = /^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s?)|[*_`~]|^\s*\|.*\|\s*$/gm;

export interface ChangeRateOptions {
  /** 헤딩·불릿 산문화로 부풀려진 변경률을 걷어내고 본문만 비교 */
  ignoreMarkup?: boolean;
}

function normalize(text: string, ignoreMarkup: boolean): string {
  let out = text.replace(SUMMARY_BLOCK, ' ');
  if (ignoreMarkup) out = out.replace(MARKUP, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

function tokenize(text: string): string[] {
  return text.split(' ').filter(Boolean);
}

function lcsLength(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;

  // 앞뒤로 그대로인 구간은 DP에 넣을 이유가 없다
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const common = head + tail;
  if (midA.length === 0 || midB.length === 0) return common;

  const rows = midA.length + 1;
  const cols = midB.length + 1;
  let prev = new Uint32Array(cols);
  let curr = new Uint32Array(cols);

  for (let i = 1; i < rows; i += 1) {
    const ai = midA[i - 1]!;
    for (let j = 1; j < cols; j += 1) {
      curr[j] = ai === midB[j - 1]! ? prev[j - 1]! + 1 : Math.max(prev[j]!, curr[j - 1]!);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
    curr.fill(0);
  }

  return common + prev[cols - 1]!;
}

/**
 * 순서를 버리고 어절 다중집합의 겹침만 센다.
 * DP를 돌릴 수 없는 크기에서 쓰는 근사치라 실제보다 변경률을 낮게 본다 — 검사가
 * 놓칠지언정 없는 과윤문을 만들어내지는 않는 쪽으로 틀렸다.
 */
function overlapCount(a: readonly string[], b: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const token of a) counts.set(token, (counts.get(token) ?? 0) + 1);

  let common = 0;
  for (const token of b) {
    const left = counts.get(token) ?? 0;
    if (left > 0) {
      counts.set(token, left - 1);
      common += 1;
    }
  }
  return common;
}

export function changeRate(before: string, after: string, options: ChangeRateOptions = {}): number {
  const ignoreMarkup = options.ignoreMarkup ?? false;
  const a = tokenize(normalize(before, ignoreMarkup));
  const b = tokenize(normalize(after, ignoreMarkup));

  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0 || b.length === 0) return 1;

  const tooBig = a.length > TOKEN_DP_CAP || b.length > TOKEN_DP_CAP;
  const common = tooBig ? overlapCount(a, b) : lcsLength(a, b);
  return 1 - (2 * common) / (a.length + b.length);
}
