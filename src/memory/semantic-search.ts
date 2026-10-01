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
// 0.6~0.8이 나와 엉뚱한 스펙이 상위로 올라온다. 한글로 확인했고 같은 이유로 가나와 한자도 뺀다.
// 틀린 맥락을 넣느니 아예 안 넣는다
const UNSUPPORTED_SCRIPT = /[\u1100-\u11FF\u3040-\u30FF\u3130-\u318F\u4E00-\u9FFF\uAC00-\uD7AF]/;

// 모델을 못 받는 환경에서 start마다 다시 받으려 들지 않게, 로딩에 실패하면 이 시간 동안 재시도하지 않는다
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;

type EmbeddingService = import('../knowledge-base/embedding.js').EmbeddingService;

let servicePromise: Promise<EmbeddingService> | null = null;
let modelReady = false;
let modelLoading = false;
let lastFailureAt = 0;
// goal 벡터는 스펙이 바뀌지 않는 한 같으므로 start마다 다시 임베딩하지 않는다
const goalVectors = new Map<string, number[]>();

function getEmbeddingService(): Promise<EmbeddingService> {
  servicePromise ??= import('../knowledge-base/embedding.js').then(
    ({ EmbeddingService }) => new EmbeddingService(),
    (e: unknown) => {
      servicePromise = null;
      throw e;
    },
  );
  return servicePromise;
}

// 모델이 아직 안 올라왔으면 한 번에 하나만 받게 한다. 로딩 중에 들어온 호출은 기다리지 않고
// 실패로 돌려 호출부가 바로 폴백하게 한다 — 기다려 봐야 호출부 제한 시간에 걸린다.
// 재시도 대기(RETRY_AFTER_FAILURE_MS)는 로딩 실패에만 건다. 올라온 뒤의 임베딩 실패는 다음 호출에서 그냥 다시 해본다
async function embedTexts(texts: string[]): Promise<number[][]> {
  const service = await getEmbeddingService();
  if (!modelReady) {
    if (modelLoading) throw new Error('embedding model is still loading');
    if (Date.now() - lastFailureAt < RETRY_AFTER_FAILURE_MS) {
      throw new Error('embedding model failed to load recently');
    }
    modelLoading = true;
    try {
      await service.ensureLoaded();
      modelReady = true;
    } catch (e) {
      lastFailureAt = Date.now();
      throw e;
    } finally {
      modelLoading = false;
    }
  }
  return service.embedBatch(texts);
}

/** @internal 테스트에서 모듈 상태를 비운다 */
export function resetSemanticSearchState(): void {
  servicePromise = null;
  modelReady = false;
  modelLoading = false;
  lastFailureAt = 0;
  goalVectors.clear();
}

const vectorKey = (e: SpecHistoryEntry): string => `${e.specId}\0${e.goal}`;

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

  const uncached = entries.filter((e) => !goalVectors.has(vectorKey(e)));
  const vectors = await embedTexts([query, ...uncached.map((e) => e.goal)]);
  uncached.forEach((e, idx) => goalVectors.set(vectorKey(e), vectors[idx + 1]!));

  const queryVec = vectors[0]!;
  const scored = entries.map((entry) => ({
    entry,
    score: cosineSimilarity(queryVec, goalVectors.get(vectorKey(entry))!),
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored
    .filter((s) => s.score >= minScore)
    .slice(0, topK)
    .map((s) => s.entry);
}
