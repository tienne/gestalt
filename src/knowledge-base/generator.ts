import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CodeGraphEngine } from '../code-graph/engine.js';
import { NodeKind } from '../code-graph/types.js';
import { log } from '../core/log.js';
import type { KnowledgeEntry, KnowledgeEntryType } from './types.js';

interface GenerateOptions {
  types?: KnowledgeEntryType[];
}

/**
 * File 노드에 CONTAINS 관계로 연결된 자식 노드(함수·클래스·타입)의 이름 목록을 추출해
 * content 본문을 구성한다.
 */
function buildFileContent(
  filePath: string,
  engine: CodeGraphEngine,
  repoRoot: string,
): string {
  const queryResult = engine.query(repoRoot, 'callees_of', filePath);
  const childNodes = queryResult.nodes.filter(
    (n) => n.kind === NodeKind.Function || n.kind === NodeKind.Class || n.kind === NodeKind.Type,
  );

  const lines: string[] = [`## ${filePath}`, ''];

  if (childNodes.length > 0) {
    const functions = childNodes.filter((n) => n.kind === NodeKind.Function).map((n) => n.name);
    const classes = childNodes.filter((n) => n.kind === NodeKind.Class).map((n) => n.name);
    const types = childNodes.filter((n) => n.kind === NodeKind.Type).map((n) => n.name);

    if (functions.length > 0) {
      lines.push('### Functions', ...functions.map((f) => `- ${f}`), '');
    }
    if (classes.length > 0) {
      lines.push('### Classes', ...classes.map((c) => `- ${c}`), '');
    }
    if (types.length > 0) {
      lines.push('### Types', ...types.map((t) => `- ${t}`), '');
    }
  } else {
    // CONTAINS 엣지가 없는 파일은 직접 파일 내용 앞 20줄을 요약으로 사용한다
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const preview = raw.split('\n').slice(0, 20).join('\n');
      lines.push('```', preview, '```', '');
    } catch {
      lines.push('_No preview available_', '');
    }
  }

  return lines.join('\n');
}

/**
 * CodeGraphEngine 결과를 KnowledgeEntry[] 로 변환한다.
 * DB에서 File 노드를 전부 읽어 code-graph 타입 엔트리로 만든다.
 */
export async function generateFromCodeGraph(
  repoRoot: string,
  options: GenerateOptions = {},
): Promise<KnowledgeEntry[]> {
  const { types } = options;

  // types 필터가 있고 code-graph가 포함되지 않으면 빈 배열 반환
  if (types && !types.includes('code-graph')) {
    return [];
  }

  const engine = new CodeGraphEngine();

  if (!engine.dbExists(repoRoot)) {
    log('knowledge-base generator: code-graph.db not found, building...');
    engine.build(repoRoot);
  }

  const stats = engine.stats(repoRoot);
  log(
    `knowledge-base generator: ${stats.totalFiles} files, ${stats.totalNodes} nodes in graph`,
  );

  // CodeGraphEngine 내부 store에 직접 접근하는 대신 searchByKeywords('') 우회로를
  // 사용하면 API 변경에 취약하므로, 엔진을 통해 stats를 얻은 뒤
  // getStore().getAllNodes()에 해당하는 public searchByKeywords를 활용한다.
  // File 노드만 필요하므로 빈 키워드 검색 대신 전체 노드를 얻는 방법이 없기 때문에
  // blast_radius 없이 engine.build() 시 생성된 File 노드만 직접 조회한다.
  // → private store에 접근하지 않고, searchByKeywords([''])로 모든 파일경로를 수집한다.
  const allFilePaths = engine.searchByKeywords(repoRoot, ['']);

  // searchByKeywords가 match 없으면 빈 배열을 반환하므로, stats.totalFiles > 0 이지만
  // 키워드가 공백이면 결과가 없을 수 있다. 이 경우 모든 File 노드를 가져오는
  // 대안: 빈 문자열 하나짜리 검색 대신 단일 공통 확장자 패턴 목록을 사용한다.
  // 실제로는 `searchByKeywords`가 includes('')로 모든 경로에 매칭되므로 동작한다.
  log(`knowledge-base generator: ${allFilePaths.length} file paths collected`);

  const now = new Date().toISOString();
  const entries: KnowledgeEntry[] = [];

  for (const fp of allFilePaths) {
    const rel = fp.startsWith(repoRoot) ? fp.slice(repoRoot.length + 1) : fp;
    const content = buildFileContent(fp, engine, repoRoot);
    const id = randomUUID();
    const kbFilePath = `.gestalt-kb/code-graph/${id}.md`;

    entries.push({
      id,
      type: 'code-graph',
      title: rel,
      content,
      filePath: kbFilePath,
      createdAt: now,
      tags: ['code-graph', rel.split('/')[0] ?? 'root'],
    });
  }

  engine.close();
  log(`knowledge-base generator: generated ${entries.length} entries`);
  return entries;
}
