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
   * mean pooling + normalize 옵션을 사용해 384차원 number[]를 반환한다.
   */
  async embed(text: string): Promise<number[]> {
    const extractor = await this.getPipeline();
    const output = (await extractor(text, { pooling: 'mean', normalize: true })) as Tensor;
    return Array.from(output.data as Float32Array);
  }

  /**
   * 텍스트 배열을 순차적으로 임베딩한다.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      const vector = await this.embed(text);
      results.push(vector);
    }
    return results;
  }
}
