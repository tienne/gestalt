import { pipeline, FeatureExtractionPipeline, Tensor } from '@xenova/transformers';
import { log } from '../core/log.js';

/**
 * @xenova/transformers 기반 로컬 임베딩 서비스.
 * 모델은 첫 호출 시 lazy 로딩된다.
 */
export class EmbeddingService {
  private pipelineInstance: FeatureExtractionPipeline | null = null;
  private readonly modelName = 'Xenova/all-MiniLM-L6-v2';

  private async getPipeline(): Promise<FeatureExtractionPipeline> {
    if (!this.pipelineInstance) {
      log(`embedding: loading model ${this.modelName}...`);
      this.pipelineInstance = await pipeline('feature-extraction', this.modelName);
      log('embedding: model loaded');
    }
    return this.pipelineInstance;
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
