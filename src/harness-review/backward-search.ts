/**
 * 역방향 참조 검색.
 *
 * 이 변경이 지우거나 바꾼 식별자를 관련 레포에서 찾는다. 하네스 경로에서 걸린 것만 backwardRef로 남기고
 * 레포 이름이나 식별자가 하네스 밖 문서에 설명으로 나오는 건 knowledgeDoc으로 따로 모은다.
 * 조회하지 못한 레포는 skipped에 그대로 실어, 후보가 비었을 때 "참조 없음"과 구분되게 한다.
 */
import { githubSlug } from './forward-search.js';
import { isOrgWildcard } from './github-code-search.js';
import { isHarnessPath } from './identifiers.js';
import type {
  BackendCounts,
  CodeSearchBackend,
  SearchHit,
  SearchOptions,
  SkippedRepo,
} from './search-backend.js';
import type { Identifier, ReferenceCandidate, SearchBackendKind } from './types.js';

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

/** 질의를 몇 개 계획했고 몇 개를 다 찾았는지. 막힌 라운드가 얼마나 봤는지 보여 준다 */
export interface BackwardSearchCoverage {
  planned: number;
  /** 넘긴 레포를 하나도 안 빠뜨리고 찾은 질의 수 */
  searched: number;
  byBackend: Partial<Record<SearchBackendKind, BackendCounts>>;
  /** 조직 와일드카드를 실은 질의. 관련 레포 밖을 얼마나 봤는지다 */
  orgWide?: { planned: number; searched: number };
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
  coverage: BackwardSearchCoverage;
}

/** 이보다 짧은 값은 흔한 낱말과 겹쳐 온 조직이 걸리므로 검색하지 않는다 */
export const MIN_SEARCH_TERM_LENGTH = 3;

const DOC_EXT_RE = /\.(md|mdx|mdc|txt|rst|adoc)$/i;
// 식별자에 쓰이는 글자가 앞뒤에 붙어 있으면 다른 이름의 일부다. widget-audit가 widget-audit-v2에 걸리는 경우
const NAME_CHAR_RE = /[A-Za-z0-9_-]/;

const NAME_KINDS = new Set<Identifier['kind']>(['skillName', 'agentName', 'pluginName']);

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

/**
 * INDEX.md나 plugin.json처럼 흔한 파일 이름은 다른 레포에도 제 파일이 있다. 그 레포에 같은 파일이 있고
 * 줄에 이 레포 이름이 안 나오면 제 파일을 가리킨 줄이라 이번 PR과 무관하다
 */
function pointsAtOwnFile(
  backend: CodeSearchBackend,
  hit: SearchHit,
  id: Identifier,
  term: string,
  selfRepo: string | undefined,
): boolean {
  if (id.kind !== 'path' && id.kind !== 'uniqueFileName') return false;
  if (selfRepo && hit.text.includes(nameOf(selfRepo))) return false;
  return backend.hasFile?.(hit.repo, term) === true;
}

/**
 * "플러그인", "환경 변수" 같은 헤딩은 흔한 말이라 다른 레포에 낱말로만 나와도 걸린다. 다른 레포가
 * 이 레포의 절을 부르면 `#앵커`로 걸거나 레포 이름을 함께 적는다. 둘 다 없는 헤딩 글자 매치는 뺀다
 */
function isBareHeadingMention(
  hit: SearchHit,
  id: Identifier,
  term: string,
  selfRepo: string | undefined,
): boolean {
  if (id.kind !== 'heading' || term.startsWith('#')) return false;
  return !(selfRepo && hit.text.includes(nameOf(selfRepo)));
}

/**
 * GitHub 한도 안에서 먼저 보낼 순서. 이름은 다른 레포가 그대로 적어 부르므로 걸리면 거의 참조다.
 * 헤딩 원문은 레포 이름이 같이 적힌 줄만 남기므로(isBareHeadingMention) 건지는 게 가장 적다
 */
const enum QueryRank {
  Name = 0,
  HeadingAnchor = 1,
  RepoName = 2,
  HeadingText = 3,
}

interface PlannedQuery {
  rank: QueryRank;
  term: string;
  /** 없으면 레포 이름 질의다 */
  id?: Identifier;
  repos: string[];
  opts: SearchOptions;
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
    coverage: { planned: 0, searched: 0, byBackend: {} },
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

  const queries = repos.length > 0 ? planQueries(searchable, repos, input.selfRepo, opts) : [];
  input.backend.plan?.(queries.map((q) => q.repos));

  let searched = 0;
  const orgWide = { planned: 0, searched: 0 };
  for (const q of queries) {
    const { hits, skipped } = await input.backend.search(q.term, q.repos, q.opts);
    noteSkipped(skipped);
    if (skipped.length === 0) searched++;
    if (q.repos.some(isOrgWildcard)) {
      orgWide.planned++;
      if (!skipped.some((x) => isOrgWildcard(x.repo))) orgWide.searched++;
    }

    const { id, term } = q;
    if (!id) {
      for (const hit of hits) {
        if (!isHarnessPath(hit.path) && isDocPath(hit.path) && hasBoundedMatch(hit.text, term)) {
          noteDoc(hit, term);
        }
      }
      continue;
    }
    for (const hit of hits) {
      const bounded = hasBoundedMatch(hit.text, term);
      if (pointsAtOwnFile(input.backend, hit, id, term, input.selfRepo)) continue;
      if (isBareHeadingMention(hit, id, term, input.selfRepo)) continue;
      // 이름은 더 긴 이름의 일부로 걸리면 다른 이름이다. widget-audit와 widget-audit-v2
      if (!bounded && NAME_KINDS.has(id.kind)) continue;
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
  result.coverage = {
    planned: queries.length,
    searched,
    byBackend: input.backend.counts?.() ?? {},
    ...(orgWide.planned > 0 ? { orgWide } : {}),
  };

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

/**
 * 식별자와 검색어를 질의 목록으로 펼쳐 GitHub에 보낼 순서로 줄 세운다.
 *
 * 헤딩 질의에서는 조직 와일드카드를 뺀다. 관련 레포 밖에서 남의 레포 절을 부르는 일은 드물고
 * 헤딩이 이름보다 훨씬 많아서(17개 파일 PR에 91개) 와일드카드에 실으면 한도를 혼자 다 쓴다.
 */
function planQueries(
  identifiers: Identifier[],
  repos: string[],
  selfRepo: string | undefined,
  opts: SearchOptions | undefined,
): PlannedQuery[] {
  const scoped = repos.filter((r) => !isOrgWildcard(r));
  const selfName = selfRepo ? nameOf(selfRepo) : undefined;
  const base = opts ?? {};
  const out: PlannedQuery[] = [];
  for (const id of identifiers) {
    if (id.kind !== 'heading') {
      out.push({ rank: QueryRank.Name, term: id.value, id, repos, opts: base });
      continue;
    }
    for (const term of termsOf(id)) {
      const anchor = term.startsWith('#');
      out.push({
        rank: anchor ? QueryRank.HeadingAnchor : QueryRank.HeadingText,
        term,
        id,
        repos: scoped,
        // 앵커 없이 헤딩 글자만 걸린 줄은 레포 이름이 같이 있어야 남긴다. GitHub에는 그 조건을 질의로 건다
        opts: !anchor && selfName ? { ...base, requireAlso: selfName } : base,
      });
    }
  }
  if (selfName) out.push({ rank: QueryRank.RepoName, term: selfName, repos, opts: base });
  // sort는 안정 정렬이라 같은 순위 안에서는 긴 값이 먼저인 기존 순서가 남는다
  return out.filter((q) => q.repos.length > 0).sort((a, b) => a.rank - b.rank);
}
