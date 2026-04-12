import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { log } from '../core/log.js';
import type { EmbeddingIndex } from './types.js';

const EMBEDDINGS_FILENAME = 'embeddings.json';

/**
 * EmbeddingIndex를 {kbPath}/embeddings.json에 저장한다.
 */
export async function saveEmbeddingIndex(
  index: EmbeddingIndex,
  outputPath: string,
): Promise<void> {
  const filePath = join(outputPath, EMBEDDINGS_FILENAME);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(index, null, 2), 'utf-8');
  log(`embedding-index: saved ${index.entries.length} entries to ${filePath}`);
}

/**
 * {kbPath}/embeddings.json을 읽어 EmbeddingIndex를 반환한다.
 * 파일이 없으면 null을 반환한다 (에러가 아님).
 */
export async function loadEmbeddingIndex(kbPath: string): Promise<EmbeddingIndex | null> {
  const filePath = join(kbPath, EMBEDDINGS_FILENAME);
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as EmbeddingIndex;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}
