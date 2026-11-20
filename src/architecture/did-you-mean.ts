/**
 * 오타 하나에 제안 하나를 붙인다. 후보를 여럿 늘어놓으면 세션 LLM이 어느 쪽으로 고칠지 다시 골라야 해서
 * 가장 가까운 후보 하나만 돌려주고 문턱을 넘으면 아무것도 돌려주지 않는다.
 */

/** 대소문자를 무시한 Damerau-Levenshtein(인접 글자 맞바꿈 1회 비용) 거리 */
export function editDistance(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  if (s === t) return 0;
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;
  const cols = t.length + 1;
  // 맞바꿈 항이 두 줄 위를 읽어서 세 줄만 돌려 쓴다
  let twoUp = new Array<number>(cols).fill(0);
  let up = Array.from({ length: cols }, (_, j) => j);
  let cur = new Array<number>(cols).fill(0);
  for (let i = 1; i <= s.length; i += 1) {
    cur[0] = i;
    for (let j = 1; j < cols; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      let best = Math.min(up[j]! + 1, cur[j - 1]! + 1, up[j - 1]! + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
        best = Math.min(best, twoUp[j - 2]! + 1);
      }
      cur[j] = best;
    }
    [twoUp, up, cur] = [up, cur, twoUp];
  }
  return up[cols - 1]!;
}

/** 입력 길이의 1/3까지 틀려도 같은 말로 본다. 짧은 키는 1글자, 긴 키도 3글자까지만 */
export function suggestionThreshold(input: string): number {
  return Math.min(3, Math.max(1, Math.floor(input.length / 3)));
}

/**
 * 후보 중 가장 가까운 하나를 돌려준다. 입력과 같은 후보는 제안이 아니라서 건너뛴다.
 * 거리가 같으면 후보 배열 순서로 정한다(호출할 때마다 같은 답).
 */
export function suggestOne(input: string, candidates: Iterable<string>): string | undefined {
  const limit = suggestionThreshold(input);
  const inputLength = input.toLowerCase().length;
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate === input) continue;
    // 거리는 길이 차보다 작을 수 없다. editDistance가 소문자로 비교하니 길이도 소문자로 잰다
    if (Math.abs(candidate.toLowerCase().length - inputLength) > limit) continue;
    const distance = editDistance(input, candidate);
    if (distance > limit) continue;
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
