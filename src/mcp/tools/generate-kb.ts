import * as path from 'node:path';
import { generateFromCodeGraph } from '../../knowledge-base/generator.js';
import { writeKnowledgeBase } from '../../knowledge-base/writer.js';
import { summarizeEntries } from '../../knowledge-base/summarizer.js';
import { EmbeddingService } from '../../knowledge-base/embedding.js';
import { saveEmbeddingIndex } from '../../knowledge-base/embedding-index.js';
import { log } from '../../core/log.js';
import { createTierAdapter } from '../../llm/factory.js';
import type { GestaltConfig } from '../../core/config.js';
import type {
  KnowledgeEntryType,
  EmbeddingEntry,
  EmbeddingIndex,
} from '../../knowledge-base/types.js';

export interface GenerateKbInput {
  repoRoot?: string;
  outputPath?: string;
  types?: KnowledgeEntryType[];
  /**
   * 파일별 한 줄 요약을 붙일지. 기본은 끔이다.
   *
   * 요약은 LLM이 만든 문장을 KB 본문과 임베딩에 함께 남기는데, 그 둘은 되돌리려면
   * KB를 다시 만들어야 한다. 품질을 재는 수단도 아직 없다. 켤지 말지는 부르는 쪽이
   * 정한다 — llm.frugal을 설정했다는 사실만으로 켜지지 않는다.
   */
  summarize?: boolean;
}

export async function handleGenerateKb(
  input: GenerateKbInput,
  cwd: string,
  config?: GestaltConfig,
): Promise<string> {
  const repoRoot = input.repoRoot ?? cwd;
  const outputPath = input.outputPath ?? path.join(cwd, '.gestalt-kb');

  log(`generate-kb: repoRoot=${repoRoot}, outputPath=${outputPath}`);

  try {
    // 1. 코드 그래프에서 KnowledgeEntry 생성
    const entries = await generateFromCodeGraph(repoRoot, { types: input.types });
    log(`generate-kb: ${entries.length} entries generated`);

    // 1.5. summarize를 켰고 frugal tier가 있으면 파일별 한 줄 요약을 붙인다.
    //      요약문은 아래 임베딩 텍스트에도 함께 실려 검색 품질에 반영된다.
    //      둘 중 하나라도 없으면 건너뛴다 — 요약은 KB의 덤이지 전제가 아니다.
    let summarized = 0;
    const frugalLlm =
      input.summarize && config ? createTierAdapter(config.llm, 'frugal') : undefined;
    if (frugalLlm && entries.length > 0) {
      const result = await summarizeEntries(entries, frugalLlm);
      summarized = result.summarized;
    } else if (input.summarize && !frugalLlm) {
      // 켜달라고 했는데 못 켠 경우다. 조용히 건너뛰면 응답의 0이 "요약이 다 실패했나"로 읽힌다.
      log('generate-kb: summarize was requested but llm.frugal is not configured — skipping');
    }

    // 2. MD 파일 저장
    await writeKnowledgeBase(entries, outputPath);

    // 3. 임베딩 계산
    const embeddingService = new EmbeddingService();
    const embeddingEntries: EmbeddingEntry[] = [];
    const now = new Date().toISOString();

    const texts = entries.map((e) => `${e.title}\n${e.content}`);
    const vectors = await embeddingService.embedBatch(texts);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const vector = vectors[i] ?? [];
      embeddingEntries.push({
        entryId: entry.id,
        filePath: path.join(outputPath, entry.type, `${entry.id}.md`),
        vector,
        createdAt: now,
      });
    }

    log(`generate-kb: ${embeddingEntries.length} embeddings computed`);

    // 4. EmbeddingIndex 저장
    const index: EmbeddingIndex = {
      model: 'Xenova/all-MiniLM-L6-v2',
      dimension: embeddingEntries.length > 0 ? embeddingEntries[0]!.vector.length : 384,
      entries: embeddingEntries,
      createdAt: now,
    };
    await saveEmbeddingIndex(index, outputPath);

    return JSON.stringify(
      {
        entriesGenerated: entries.length,
        entriesSummarized: summarized,
        embeddingsComputed: embeddingEntries.length,
        outputPath,
      },
      null,
      2,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log(`generate-kb error: ${message}`);
    return JSON.stringify({ error: message }, null, 2);
  }
}
