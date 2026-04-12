import matter from 'gray-matter';
import type { KnowledgeEntry, KnowledgeEntryType } from './types.js';

function buildFrontmatter(entry: KnowledgeEntry): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: entry.id,
    type: entry.type,
    title: entry.title,
    tags: entry.tags,
  };

  const byType: Partial<Record<KnowledgeEntryType, Record<string, unknown>>> = {
    'code-graph': { ...base, filePath: entry.filePath },
    'business-logic': base,
    'api-spec': base,
    adr: { ...base, date: entry.createdAt },
    policy: base,
  };

  return byType[entry.type] ?? base;
}

/**
 * KnowledgeEntry를 gray-matter 형식 frontmatter + content body 마크다운으로 직렬화한다.
 */
export function renderMarkdown(entry: KnowledgeEntry): string {
  const frontmatter = buildFrontmatter(entry);
  // gray-matter의 stringify는 두 번째 인자로 data를 받고 세 번째 인자로 content를 받는다.
  // matter.stringify(content, data) 형식으로 사용한다.
  return matter.stringify(entry.content, frontmatter);
}
