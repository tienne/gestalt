import type { ProjectMemory, SpecHistoryEntry } from '../core/types.js';

/**
 * cosine similarity 계산
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// EmbeddingService의 all-MiniLM-L6-v2는 영어로만 학습됐다. 한글 문장끼리는 주제가 달라도
// 0.6~0.8이 나와 엉뚱한 스펙이 상위로 올라온다. 틀린 맥락을 넣느니 아예 안 넣는다
const UNSUPPORTED_SCRIPT = /[\u1100-\u11FF\u3040-\u30FF\u3130-\u318F\u4E00-\u9FFF\uAC00-\uD7AF]/;

/**
 * EmbeddingService lazy-load 래퍼.
 * 모델 로드가 무거우므로 첫 호출 시에만 import한다.
 */
let embeddingServiceInstance: import('../knowledge-base/embedding.js').EmbeddingService | null =
  null;

async function getEmbeddingService(): Promise<
  import('../knowledge-base/embedding.js').EmbeddingService
> {
  if (!embeddingServiceInstance) {
    const { EmbeddingService } = await import('../knowledge-base/embedding.js');
    embeddingServiceInstance = new EmbeddingService();
  }
  return embeddingServiceInstance;
}

/**
 * ProjectMemory의 specHistory에서 query와 시맨틱으로 유사한 상위 K개를 반환한다.
 *
 * @param query  검색 쿼리 문자열
 * @param memory ProjectMemory 인스턴스
 * @param topK   반환할 최대 항목 수 (기본값: 3)
 * @param minScore 이 값보다 유사도가 낮은 항목은 버린다 (기본값: 0)
 * @returns      cosine similarity 내림차순으로 정렬된 SpecHistoryEntry[]
 */
export async function searchSimilarSpecs(
  query: string,
  memory: ProjectMemory,
  topK = 3,
  minScore = 0,
): Promise<SpecHistoryEntry[]> {
  if (UNSUPPORTED_SCRIPT.test(query)) return [];
  const entries = memory.specHistory.filter((e) => !UNSUPPORTED_SCRIPT.test(e.goal));
  if (entries.length === 0) return [];

  const service = await getEmbeddingService();

  // query + 각 항목의 goal을 한 번에 배치 임베딩
  const texts = [query, ...entries.map((e) => e.goal)];
  const vectors = await service.embedBatch(texts);

  const queryVec = vectors[0]!;
  const scored = entries.map((entry, idx) => ({
    entry,
    score: cosineSimilarity(queryVec, vectors[idx + 1]!),
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored
    .filter((s) => s.score >= minScore)
    .slice(0, topK)
    .map((s) => s.entry);
}
