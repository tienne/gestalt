export interface ScoredFile {
  filePath: string;
  score: number;
}

/**
 * Reciprocal Rank Fusion — 여러 랭킹 리스트를 하나로 합산한다.
 *
 * 각 리스트의 각 항목에 대해 1/(k + rank) 점수를 누적하고,
 * 내림차순으로 정렬하여 반환한다.
 *
 * @param lists  - ScoredFile 랭킹 리스트 배열 (0-based index가 rank로 사용됨)
 * @param k      - RRF 상수 (default: 60). 높을수록 하위 랭크의 영향이 줄어든다.
 */
export function reciprocalRankFusion(lists: ScoredFile[][], k = 60): ScoredFile[] {
  const scoreMap = new Map<string, number>();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      if (item === undefined) continue;
      const prev = scoreMap.get(item.filePath) ?? 0;
      scoreMap.set(item.filePath, prev + 1 / (k + rank));
    }
  }

  return [...scoreMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([filePath, score]) => ({ filePath, score }));
}
