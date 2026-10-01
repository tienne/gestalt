import { pipeline, FeatureExtractionPipeline, Tensor } from '@xenova/transformers';
import { log } from '../core/log.js';

/**
 * @xenova/transformers 기반 로컬 임베딩 서비스.
 * 모델은 첫 호출 시 lazy 로딩된다.
 */
export class EmbeddingService {
  private pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;
  private readonly modelName = 'Xenova/all-MiniLM-L6-v2';

  // 로딩 중인 Promise를 들고 있어야 첫 로딩이 끝나기 전에 들어온 호출이 모델을 또 받지 않는다
  private getPipeline(): Promise<FeatureExtractionPipeline> {
    if (!this.pipelinePromise) {
      log(`embedding: loading model ${this.modelName}...`);
      this.pipelinePromise = pipeline('feature-extraction', this.modelName).then(
        (instance) => {
          log('embedding: model loaded');
          return instance;
        },
        (e: unknown) => {
          this.pipelinePromise = null;
          throw e;
        },
      );
    }
    return this.pipelinePromise;
  }

  /**
   * 텍스트 하나를 임베딩 벡터로 변환한다.
   * embedBatch에 위임한다.
   */
  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0] ?? [];
  }

  /**
   * 텍스트 배열을 batchSize 단위로 청크 처리한다.
   * mean pooling + normalize 옵션을 사용해 384차원 number[][] 를 반환한다.
   */
  async embedBatch(texts: string[], batchSize = 32): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.getPipeline();
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const chunk = texts.slice(i, i + batchSize);
      const output = (await extractor(chunk, { pooling: 'mean', normalize: true })) as Tensor;
      const flat = output.data as Float32Array;
      const dim = flat.length / chunk.length;
      for (let j = 0; j < chunk.length; j++) {
        results.push(Array.from(flat.slice(j * dim, (j + 1) * dim)));
      }
    }
    return results;
  }
}
