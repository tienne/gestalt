import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../core/log.js';
import { renderMarkdown } from './templates.js';
import type { KnowledgeEntry } from './types.js';

/**
 * KnowledgeEntry 배열을 .gestalt-kb/ 하위 MD 파일로 저장한다.
 * 경로: {outputPath}/{entry.type}/{entry.id}.md
 */
export async function writeKnowledgeBase(
  entries: KnowledgeEntry[],
  outputPath: string,
): Promise<void> {
  log(`knowledge-base: writing ${entries.length} entries to ${outputPath}`);

  for (const entry of entries) {
    const dir = join(outputPath, entry.type);
    await mkdir(dir, { recursive: true });

    const filePath = join(dir, `${entry.id}.md`);
    const content = renderMarkdown(entry);
    await writeFile(filePath, content, 'utf-8');

    log(`knowledge-base: wrote ${filePath}`);
  }

  log(`knowledge-base: done`);
}
