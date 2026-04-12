import * as path from 'node:path';
import { generateFromCodeGraph } from '../../knowledge-base/generator.js';
import { writeKnowledgeBase } from '../../knowledge-base/writer.js';
import { EmbeddingService } from '../../knowledge-base/embedding.js';
import { saveEmbeddingIndex } from '../../knowledge-base/embedding-index.js';
import { log } from '../../core/log.js';
import type { KnowledgeEntryType, EmbeddingEntry, EmbeddingIndex } from '../../knowledge-base/types.js';

export interface GenerateKbInput {
  repoRoot?: string;
  outputPath?: string;
  types?: KnowledgeEntryType[];
}

export async function handleGenerateKb(input: GenerateKbInput, cwd: string): Promise<string> {
  const repoRoot = input.repoRoot ?? cwd;
  const outputPath = input.outputPath ?? path.join(cwd, '.gestalt-kb');

  log(`generate-kb: repoRoot=${repoRoot}, outputPath=${outputPath}`);

  try {
    // 1. 코드 그래프에서 KnowledgeEntry 생성
    const entries = await generateFromCodeGraph(repoRoot, { types: input.types });
    log(`generate-kb: ${entries.length} entries generated`);

    // 2. MD 파일 저장
    await writeKnowledgeBase(entries, outputPath);

    // 3. 임베딩 계산
    const embeddingService = new EmbeddingService();
    const embeddingEntries: EmbeddingEntry[] = [];
    const now = new Date().toISOString();

    for (const entry of entries) {
      const text = `${entry.title}\n${entry.content}`;
      const vector = await embeddingService.embed(text);
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
      dimension: embeddingEntries.length > 0 ? (embeddingEntries[0]!.vector.length) : 384,
      entries: embeddingEntries,
      createdAt: now,
    };
    await saveEmbeddingIndex(index, outputPath);

    return JSON.stringify(
      {
        entriesGenerated: entries.length,
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
