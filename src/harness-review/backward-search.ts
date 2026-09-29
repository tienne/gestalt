/**
 * 역방향 참조 검색.
 *
 * 이 변경이 지우거나 바꾼 식별자를 관련 레포에서 찾는다. 하네스 경로에서 걸린 것만 backwardRef로 남기고
 * 레포 이름이나 식별자가 하네스 밖 문서에 설명으로 나오는 건 knowledgeDoc으로 따로 모은다.
 * 조회하지 못한 레포는 skipped에 그대로 실어, 후보가 비었을 때 "참조 없음"과 구분되게 한다.
 */
import { githubSlug } from './forward-search.js';
import { isHarnessPath } from './identifiers.js';
import type { CodeSearchBackend, SearchHit, SkippedRepo } from './search-backend.js';
import type { Identifier, ReferenceCandidate } from './types.js';

export interface BackwardSearchInput {
  /** extractIdentifiers 결과. extractedBy가 llm인 것은 검색하지 않고 needsLlmJudgment로 넘긴다 */
  identifiers: Identifier[];
  /** 찾을 관련 레포 (owner/name). selfRepo와 같은 항목은 빠진다 */
  repos: string[];
  backend: CodeSearchBackend;
  /** 리뷰 중인 레포 (owner/name). 주면 이 레포 이름을 설명으로 적은 지식 문서도 찾는다 */
  selfRepo?: string;
  maxHitsPerRepo?: number;
}

export interface BackwardRefCandidate extends ReferenceCandidate {
  kind: 'backwardRef';
  identifier: Identifier;
  /** 실제로 검색한 문자열. 헤딩이면 앵커(#slug)일 수 있다 */
  searchTerm: string;
}

export interface KnowledgeDocCandidate extends ReferenceCandidate {
  kind: 'knowledgeDoc';
  /** 문서에서 처음 걸린 것. 레포 이름이거나 식별자 값이다 */
  searchTerm: string;
}

export interface LlmJudgmentTarget {
  identifier: Identifier;
  reason: string;
}

export interface SkippedIdentifier {
  identifier: Identifier;
  reason: string;
}

export interface BackwardSearchResult {
  backwardRefs: BackwardRefCandidate[];
  /** 코드가 바뀌면 낡을 수 있는 문서. 결함 후보가 아니라 리포트의 다른 절에 싣는다 */
  knowledgeDocs: KnowledgeDocCandidate[];
  /** 패턴으로 검색어를 못 만든 식별자. 파일 경로가 value에 들어 있어 LLM이 읽고 판정한다 */
  needsLlmJudgment: LlmJudgmentTarget[];
  /** 검색하지 못한 레포. 한 레포가 여러 검색에서 빠져도 한 번만 싣는다 */
  skipped: SkippedRepo[];
  /** 너무 짧아 검색어로 쓰지 않은 식별자 */
  skippedIdentifiers: SkippedIdentifier[];
}

/** 이보다 짧은 값은 흔한 낱말과 겹쳐 온 조직이 걸리므로 검색하지 않는다 */
export const MIN_SEARCH_TERM_LENGTH = 3;

const DOC_EXT_RE = /\.(md|mdx|mdc|txt|rst|adoc)$/i;
// 식별자에 쓰이는 글자가 앞뒤에 붙어 있으면 다른 이름의 일부다. widget-audit가 widget-audit-v2에 걸리는 경우
const NAME_CHAR_RE = /[A-Za-z0-9_-]/;

function isDocPath(path: string): boolean {
  return DOC_EXT_RE.test(path);
}

function hasBoundedMatch(text: string, term: string): boolean {
  let from = 0;
  for (;;) {
    const i = text.indexOf(term, from);
    if (i < 0) return false;
    const before = text[i - 1];
    const after = text[i + term.length];
    const openStart = !NAME_CHAR_RE.test(term[0]!) || !before || !NAME_CHAR_RE.test(before);
    const openEnd = !NAME_CHAR_RE.test(term.at(-1)!) || !after || !NAME_CHAR_RE.test(after);
    if (openStart && openEnd) return true;
    from = i + 1;
  }
}

function termsOf(id: Identifier): string[] {
  const terms = [id.value];
  if (id.kind === 'heading') {
    const slug = githubSlug(id.value);
    if (slug && slug !== id.value) terms.push(`#${slug}`);
  }
  return terms;
}

function nameOf(repo: string): string {
  const slash = repo.lastIndexOf('/');
  return slash < 0 ? repo : repo.slice(slash + 1);
}

function locationKey(hit: SearchHit): string {
  return `${hit.repo}\u0000${hit.path}\u0000${hit.line}`;
}

/**
 * 식별자를 관련 레포에서 찾아 하네스 경로의 참조(backwardRef)와 지식 문서(knowledgeDoc)로 나눈다.
 * 하네스 문서 PR이 아니어도 MCP 도구 이름이나 패키지 이름 같은 식별자가 들어오면 검색이 돈다.
 */
export async function backwardSearch(input: BackwardSearchInput): Promise<BackwardSearchResult> {
  const repos = [...new Set(input.repos)].filter((r) => r !== input.selfRepo);
  const opts = input.maxHitsPerRepo ? { maxHitsPerRepo: input.maxHitsPerRepo } : undefined;

  const result: BackwardSearchResult = {
    backwardRefs: [],
    knowledgeDocs: [],
    needsLlmJudgment: [],
    skipped: [],
    skippedIdentifiers: [],
  };
  const skippedRepos = new Map<string, string>();
  const noteSkipped = (list: SkippedRepo[]) => {
    for (const s of list) if (!skippedRepos.has(s.repo)) skippedRepos.set(s.repo, s.reason);
  };

  const searchable: Identifier[] = [];
  for (const id of input.identifiers) {
    if (id.extractedBy === 'llm') {
      result.needsLlmJudgment.push({
        identifier: id,
        reason:
          '패턴으로 이름을 뽑지 못해 value가 파일 경로다. 파일을 읽고 바뀐 이름을 판정해야 한다',
      });
    } else if (id.value.length < MIN_SEARCH_TERM_LENGTH) {
      result.skippedIdentifiers.push({
        identifier: id,
        reason: `${MIN_SEARCH_TERM_LENGTH}자보다 짧아 검색어로 쓰지 않았다`,
      });
    } else {
      searchable.push(id);
    }
  }
  // 한 줄이 경로와 파일 이름에 함께 걸리면 더 구체적인 긴 값 쪽으로 한 번만 싣는다
  searchable.sort((a, b) => b.value.length - a.value.length);

  const seenRefs = new Set<string>();
  const docHits = new Map<string, { hit: SearchHit; term: string }>();
  const noteDoc = (hit: SearchHit, term: string) => {
    const key = `${hit.repo}\u0000${hit.path}`;
    if (!docHits.has(key)) docHits.set(key, { hit, term });
  };

  if (repos.length > 0) {
    for (const id of searchable) {
      for (const term of termsOf(id)) {
        const { hits, skipped } = await input.backend.search(term, repos, opts);
        noteSkipped(skipped);
        for (const hit of hits) {
          const bounded = hasBoundedMatch(hit.text, term);
          if (isHarnessPath(hit.path)) {
            const key = locationKey(hit);
            if (seenRefs.has(key)) continue;
            seenRefs.add(key);
            result.backwardRefs.push({
              kind: 'backwardRef',
              sourceFile: hit.path,
              sourceLine: hit.line,
              targetRepo: hit.repo,
              targetPath: hit.path,
              matchedText: id.value,
              contextLines: [hit.text],
              needsLlmJudgment: !bounded,
              identifier: id,
              searchTerm: term,
            });
          } else if (bounded && isDocPath(hit.path)) {
            noteDoc(hit, term);
          }
        }
      }
    }

    if (input.selfRepo) {
      const name = nameOf(input.selfRepo);
      const { hits, skipped } = await input.backend.search(name, repos, opts);
      noteSkipped(skipped);
      for (const hit of hits) {
        if (!isHarnessPath(hit.path) && isDocPath(hit.path) && hasBoundedMatch(hit.text, name)) {
          noteDoc(hit, name);
        }
      }
    }
  }

  for (const { hit, term } of docHits.values()) {
    result.knowledgeDocs.push({
      kind: 'knowledgeDoc',
      sourceFile: hit.path,
      sourceLine: hit.line,
      targetRepo: hit.repo,
      targetPath: hit.path,
      matchedText: term,
      contextLines: [hit.text],
      // 설명 문장 안에 따르라는 지시가 섞였는지는 글자로 못 가른다
      needsLlmJudgment: true,
      searchTerm: term,
    });
  }
  result.skipped = [...skippedRepos].map(([repo, reason]) => ({ repo, reason }));
  return result;
}
