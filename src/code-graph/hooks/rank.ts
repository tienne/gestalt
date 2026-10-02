import { NodeKind, type CodeGraphNode } from '../types.js';
import { extractTickets, koreanEojeols, type KoEojeol } from '../ko-text.js';

/**
 * 프롬프트와 이름이 겹치는 노드를 어휘만으로 고른다. 임베딩은 안 쓴다 — 모델을 올리는 데만
 * 프롬프트 하나 처리할 시간의 몇 배가 든다.
 */

/**
 * 문장 접착어와 요청 동사, 에이전트 도구 이름. 이름에 흔히 들어가도 프롬프트에선 대상을
 * 가리키지 않는다. "Edit 도구로 고쳐줘"가 `edit` 함수를 찾아가면 안 된다.
 */
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'from',
  'into',
  'about',
  'what',
  'when',
  'where',
  'which',
  'why',
  'how',
  'can',
  'could',
  'should',
  'would',
  'will',
  'are',
  'was',
  'were',
  'has',
  'have',
  'had',
  'not',
  'but',
  'you',
  'your',
  'our',
  'its',
  'any',
  'all',
  'please',
  'help',
  'want',
  'need',
  'make',
  'let',
  'use',
  'using',
  'just',
  'like',
  'also',
  'some',
  'more',
  'than',
  'then',
  'there',
  'here',
  'them',
  'they',
  'does',
  'did',
  'doing',
  'check',
  'look',
  'see',
  'show',
  'tell',
  'explain',
  'write',
  'add',
  'fix',
  'change',
  'update',
  'remove',
  'file',
  'files',
  'code',
  'line',
  'lines',
  'thing',
  'way',
  'new',
  'get',
  'set',
  'run',
  'try',
  'work',
  'works',
  'one',
  'two',
  'out',
  'now',
  'okay',
  'claude',
  'gestalt',
  'edit',
  'tool',
  'bash',
  'grep',
  'read',
  'multiedit',
]);

/** 프롬프트에서 뽑는 토큰 상한. 넘으면 SQL 조건이 길어져 질의가 느려진다 */
const MAX_TOKENS = 12;

function stem(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

/** camelCase, snake_case, kebab-case, 경로 구분자를 쪼개 소문자 조각으로 돌려준다 */
export function splitIdentifier(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((p) => p.toLowerCase())
    .filter((p) => p.length >= 2);
}

export interface PromptTokens {
  /** 조각 단위 토큰 (stem 적용) */
  parts: string[];
  /** 프롬프트에 식별자 통째로 적힌 이름 (소문자, 4자 이상) */
  wholeNames: Set<string>;
  /** 한글 어절. 줄기와 bigram */
  ko: KoEojeol[];
  /** `CT-31408` 꼴 티켓 키 */
  tickets: string[];
}

export function tokenizePrompt(prompt: string): PromptTokens {
  const parts: string[] = [];
  const seen = new Set<string>();
  const wholeNames = new Set<string>();
  for (const m of prompt.matchAll(/[A-Za-z_][A-Za-z0-9_.\-/]*/g)) {
    const word = m[0].replace(/[.\-/]+$/, '');
    if (word.length >= 4) wholeNames.add(word.toLowerCase());
    for (const p of splitIdentifier(word)) {
      if (p.length < 3 || STOPWORDS.has(p) || /^\d+$/.test(p)) continue;
      const s = stem(p);
      if (seen.has(s)) continue;
      seen.add(s);
      parts.push(s);
    }
  }
  return {
    parts: parts.slice(0, MAX_TOKENS),
    wholeNames,
    ko: koreanEojeols(prompt).slice(0, MAX_TOKENS),
    tickets: extractTickets(prompt),
  };
}

export interface RankedNode {
  node: CodeGraphNode;
  relPath: string;
  score: number;
  /** 통째 일치 가산을 뺀 점수. 상대 컷은 이걸로 건다 */
  baseScore: number;
  matched: string[];
}

function relative(repoRoot: string, filePath: string): string {
  return filePath.startsWith(repoRoot + '/') ? filePath.slice(repoRoot.length + 1) : filePath;
}

function partsOf(text: string): Set<string> {
  return new Set(splitIdentifier(text).map(stem));
}

/**
 * 후보 노드마다 점수를 매긴다. 점수는 맞은 토큰의 IDF 합이다.
 *
 * - 이름에서 맞은 토큰은 그대로, 경로에서만 맞은 토큰은 절반만 친다. 경로 조각은 같은
 *   디렉토리 파일 전부가 공유해서 그것만으로는 어느 파일인지 못 가린다
 * - 이름 조각을 많이 덮을수록 더 준다. `refresh`는 `refresh`에 `refreshIndexCache`보다 가깝다
 * - 프롬프트에 이름이 통째로 적혔으면 가산한다
 * - 테스트 파일은 깎는다. 사용자가 고치려는 건 대개 구현 쪽이다
 *
 * idf의 N은 전체 노드 수다. 후보 수로 잡으면 후보가 적은 질의일수록 흔한 토큰이 귀해 보인다.
 */
export function scoreNodes(
  repoRoot: string,
  candidates: CodeGraphNode[],
  tokens: PromptTokens,
  totalNodes: number,
): RankedNode[] {
  const enriched = candidates.map((node) => {
    const relPath = relative(repoRoot, node.filePath);
    const nameParts =
      node.kind === NodeKind.File ? partsOf(relPath.replace(/\.[^.]+$/, '')) : partsOf(node.name);
    const pathParts = partsOf(relPath.replace(/\.[^.]+$/, ''));
    return { node, relPath, nameParts, pathParts };
  });

  const df = new Map<string, number>();
  for (const t of tokens.parts) {
    let n = 0;
    for (const c of enriched) if (c.nameParts.has(t) || c.pathParts.has(t)) n++;
    df.set(t, n);
  }
  const idf = (t: string) => Math.log(1 + totalNodes / (1 + (df.get(t) ?? 0)));

  const ranked: RankedNode[] = [];
  for (const c of enriched) {
    let nameScore = 0;
    let pathScore = 0;
    let nameHits = 0;
    const matched: string[] = [];
    for (const t of tokens.parts) {
      if (c.nameParts.has(t)) {
        nameScore += idf(t);
        nameHits++;
        matched.push(t);
      } else if (c.pathParts.has(t)) {
        pathScore += idf(t) * 0.5;
        matched.push(t);
      }
    }
    if (matched.length === 0) continue;
    const coverage = c.nameParts.size > 0 ? nameHits / c.nameParts.size : 0;
    let baseScore = nameScore * (0.6 + 0.4 * coverage) + pathScore;
    if (c.node.isTest) baseScore *= 0.7;
    const exact =
      c.node.kind !== NodeKind.File && tokens.wholeNames.has(c.node.name.toLowerCase()) ? 3 : 0;
    ranked.push({ node: c.node, relPath: c.relPath, score: baseScore + exact, baseScore, matched });
  }
  return ranked.sort((a, b) => b.score - a.score);
}
