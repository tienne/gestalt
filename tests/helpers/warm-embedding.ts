import { measureDrift } from '../../src/execute/drift-detector.js';
import type { AtomicTask, Spec, TaskExecutionResult } from '../../src/core/types.js';

/**
 * 완료 보고를 처음 제출하면 drift 측정이 로컬 임베딩 WASM 모델을 띄운다. 그 로딩이 macOS CI에서
 * 5초를 넘겨 그 파일의 첫 제출 테스트가 시간 초과로 죽는다. beforeAll에서 이 타임아웃으로 먼저 띄워 둔다.
 */
export const EMBEDDING_WARMUP_TIMEOUT = 60_000;

export async function warmDriftEmbedding(): Promise<void> {
  const spec = {
    goal: 'warm up',
    constraints: [],
    acceptanceCriteria: [],
    ontologySchema: { entities: [], relations: [] },
  } as unknown as Spec;
  const result = { taskId: 'warmup', status: 'completed', output: 'warm up', artifacts: [] };
  await measureDrift(spec, {} as AtomicTask, result as TaskExecutionResult, 1);
}
