import { existsSync } from 'node:fs';
import { basename, sep } from 'node:path';
import type { CodeGraphStore } from '../storage.js';
import { NodeKind, type CodeGraphNode } from '../types.js';
import { scoreNodes, splitIdentifier, type PromptTokens, type RankedNode } from './rank.js';

/**
 * 프롬프트 하나를 파일 포인터 몇 개로 바꾼다. 훅과 평가 스크립트가 이 함수 하나를 같이 쓴다.
 *
 * 신호는 셋이다. 영문 식별자(심볼 이름과 경로), 한국어 bigram(주석과 커밋 메시지),
 * 티켓 키. 셋 다 파일 단위로 모아 점수를 더한다. 같은 파일을 가리키는 서로 다른 신호는
 * 서로를 보강해야 해서, 노드 단위로 따로 줄 세우면 그게 안 된다.
 */

/**
 * 관련성 게이트. 1위 점수가 이보다 낮으면 아무것도 안 넣는다.
 * 흔한 토큰 하나만 맞은 경우(idf 2~3)는 여기서 걸린다. 드문 토큰 하나나 흔한 토큰 둘은 넘는다.
 * 값은 hooks 테스트의 관련, 무관 프롬프트 쌍과 평가 스크립트로 정했다.
 */
export const MIN_POINTER_SCORE = 4;
/**
 * 한국어로만 걸린 포인터가 넘어야 하는 점수를 IDF 최댓값 ln(1+N)의 배수로 둔다.
 * "가장 드문 bigram 두 개 몫"이라는 뜻이다. 고정값으로 두면 커밋 수에 따라 뜻이 달라진다.
 * gestalt 시점 분할 평가(N≈430)에서 12 근처였다. 그 아래는 정밀도가 5%대, 위는 26%였다
 */
export const KOREAN_SCORE_IDF_MULTIPLE = 2;
/** 티켓 키가 맞으면 다른 신호 없이도 1위가 되게 준다 */
const TICKET_SCORE = 12;
/** 흔한 bigram 하나가 수만 행을 끌고 오지 않게 막는 조회 상한 */
const MAX_TERM_HITS = 20_000;
/** 한 어절의 bigram 중 이만큼은 맞아야 그 어절이 걸린 것으로 친다 */
const EOJEOL_COVERAGE = 0.5;
/** 커밋 메시지 길이 보정(BM25의 k1, b). 본문이 긴 커밋이 단어 수만으로 이기지 않게 */
const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** 프롬프트와 비슷한 커밋을 이만큼만 본다 */
const TOP_COMMITS = 20;
/** 한 파일에 걸린 커밋 점수를 더할 때 2등부터 깎는 비율 */
const COMMIT_DECAY = 0.5;

export interface Pointer {
  node: CodeGraphNode;
  relPath: string;
  score: number;
  /** 통째 일치 가산을 뺀 점수. 상대 컷은 이걸로 건다 */
  baseScore: number;
  /** 맞은 영문 토큰 */
  matched: string[];
  /** 맞은 한글 어절, 프롬프트에 적힌 그대로 (프롬프트 순서) */
  koWords: string[];
  koSource?: 'commit' | 'comment';
  /** 이 파일을 건드린 커밋 중 프롬프트와 비슷했던 수 */
  koCommits?: number;
  ticket?: { key: string; count: number };
}

export interface PointerOptions {
  /** 평가용. 끄면 영문 신호만 쓴다 */
  korean?: boolean;
  exists?: (filePath: string) => boolean;
}

function isTestPath(relPath: string): boolean {
  return /(^|\/)(tests?|__tests__)\//.test(relPath) || /\.(test|spec)\./.test(relPath);
}

function fileNode(filePath: string, relPath: string): CodeGraphNode {
  return {
    id: `file:${filePath}`,
    kind: NodeKind.File,
    name: basename(filePath),
    filePath,
    lineStart: 1,
    isTest: isTestPath(relPath),
    updatedAt: 0,
  };
}

interface KoHit {
  score: number;
  words: Set<number>;
  commits: number;
}

/** 어절마다 bigram 절반 이상이 맞아야 걸린 것으로 치고 걸린 어절의 IDF 합을 더한다 */
function matchEojeols(
  tokens: PromptTokens,
  has: (term: string) => boolean,
  idf: (term: string) => number,
): { score: number; words: Set<number> } {
  let score = 0;
  const words = new Set<number>();
  tokens.ko.forEach((e, i) => {
    const hits = e.terms.filter(has);
    if (hits.length === 0 || hits.length / e.terms.length < EOJEOL_COVERAGE) return;
    words.add(i);
    score += hits.reduce((sum, t) => sum + idf(t), 0) / Math.sqrt(e.terms.length);
  });
  return { score, words };
}

/** 조회 행을 문서(노드나 커밋)마다 맞은 term 집합으로 묶는다 */
function groupHits<R extends { term: string }>(
  rows: R[],
  key: (r: R) => string,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    const k = key(r);
    let set = out.get(k);
    if (!set) out.set(k, (set = new Set()));
    set.add(r.term);
  }
  return out;
}

/**
 * 한국어 신호를 노드(주석)와 파일(커밋) 단위 점수로 바꾼다.
 *
 * 어절마다 bigram의 절반 이상이 맞아야 그 어절이 걸린 것으로 친다. "해상도"의 bigram
 * 하나("상도")만 다른 낱말에서 맞는 우연을 거르려는 것이다. 걸린 어절의 점수는 맞은
 * bigram의 IDF 합을 bigram 수의 제곱근으로 나눈 값이다 — 긴 낱말이 짧은 낱말을 bigram
 * 개수만으로 이기지 않게 한다.
 *
 * 커밋은 커밋 하나가 문서 하나다. 어절 둘 이상이 한 커밋 메시지에서 같이 맞아야 그 커밋을
 * 쓴다. 비슷한 커밋을 몇 개 고른 뒤 그 커밋들이 건드린 파일에 점수를 나눠준다. 많은 파일을
 * 건드린 커밋일수록 파일 하나에 가는 몫이 작다.
 */
function scoreKorean(
  store: CodeGraphStore,
  tokens: PromptTokens,
): { byNode: Map<string, KoHit>; byFile: Map<string, KoHit>; minScore: number } {
  const byNode = new Map<string, KoHit>();
  const byFile = new Map<string, KoHit>();
  const allTerms = [...new Set(tokens.ko.flatMap((e) => e.terms))];
  if (allTerms.length === 0) return { byNode, byFile, minScore: Infinity };

  const st = store.getTextTermStats(allTerms);
  const minScore = Math.max(
    MIN_POINTER_SCORE,
    KOREAN_SCORE_IDF_MULTIPLE * Math.log(1 + Math.max(st.commits, st.docs)),
  );
  const idf = (n: number, df: number | undefined) => Math.log(1 + n / (1 + (df ?? 0)));

  const docIdf = (t: string) => idf(st.docs, st.docDf.get(t));
  const byDoc = groupHits(store.getDocTermHits(allTerms, MAX_TERM_HITS), (r) => r.nodeId);
  for (const [nodeId, terms] of byDoc) {
    const m = matchEojeols(tokens, (t) => terms.has(t), docIdf);
    if (m.words.size > 0) byNode.set(nodeId, { ...m, commits: 0 });
  }

  const commitIdf = (t: string) => idf(st.commits, st.commitDf.get(t));
  const bySha = groupHits(store.getCommitTermHits(allTerms, MAX_TERM_HITS), (r) => r.sha);
  const matched: { sha: string; score: number; words: Set<number> }[] = [];
  for (const [sha, terms] of bySha) {
    const m = matchEojeols(tokens, (t) => terms.has(t), commitIdf);
    if (m.words.size >= 2) matched.push({ sha, ...m });
  }
  matched.sort((a, b) => b.score - a.score);
  const top = matched.slice(0, TOP_COMMITS);
  const info = new Map(store.getTextCommits(top.map((c) => c.sha)).map((c) => [c.sha, c]));
  const shares = new Map<string, { scores: number[]; words: Set<number> }>();
  for (const c of top) {
    const meta = info.get(c.sha);
    if (!meta || meta.files.length === 0) continue;
    const lenNorm =
      (BM25_K1 + 1) / (1 + BM25_K1 * (1 - BM25_B + (BM25_B * meta.terms) / st.avgCommitTerms));
    const share = (c.score * lenNorm) / (1 + Math.log2(meta.files.length));
    for (const f of meta.files) {
      let s = shares.get(f);
      if (!s) shares.set(f, (s = { scores: [], words: new Set() }));
      s.scores.push(share);
      for (const w of c.words) s.words.add(w);
    }
  }
  for (const [file, s] of shares) {
    s.scores.sort((a, b) => b - a);
    const score = s.scores.reduce((sum, v, i) => sum + v * COMMIT_DECAY ** i, 0);
    byFile.set(file, { score, words: s.words, commits: s.scores.length });
  }
  return { byNode, byFile, minScore };
}

interface FileAgg {
  filePath: string;
  /** 영문과 주석 점수를 더한 노드 중 최고 */
  best?: {
    node: CodeGraphNode;
    score: number;
    base: number;
    matched: string[];
    koWords: Set<number>;
  };
  commit?: KoHit;
  ticket?: { key: string; count: number };
}

export function rankPointers(
  store: CodeGraphStore,
  repoRoot: string,
  tokens: PromptTokens,
  limit: number,
  opts: PointerOptions = {},
): Pointer[] {
  const korean = opts.korean ?? true;
  const exists = opts.exists ?? existsSync;
  const rel = (f: string) => (f.startsWith(repoRoot + sep) ? f.slice(repoRoot.length + 1) : f);

  // 영문: 노드 단위 점수
  const nodeScores = new Map<string, { node: CodeGraphNode; english?: RankedNode; ko?: KoHit }>();
  if (tokens.parts.length > 0) {
    const candidates = store.searchNodesByTokens(repoRoot, tokens.parts, 5000);
    if (candidates.length > 0) {
      for (const r of scoreNodes(repoRoot, candidates, tokens, store.getStats('').totalNodes)) {
        nodeScores.set(r.node.id, { node: r.node, english: r });
      }
    }
  }

  // 한국어: 주석은 노드에, 커밋은 파일에
  let byFileKo = new Map<string, KoHit>();
  let minKorean = Infinity;
  if (korean && tokens.ko.length > 0) {
    const { byNode, byFile, minScore } = scoreKorean(store, tokens);
    byFileKo = byFile;
    minKorean = minScore;
    const missing = [...byNode.keys()].filter((id) => !nodeScores.has(id));
    for (const node of store.getNodesByIds(missing)) nodeScores.set(node.id, { node });
    for (const [id, hit] of byNode) {
      const entry = nodeScores.get(id);
      if (entry) entry.ko = hit;
    }
  }

  const files = new Map<string, FileAgg>();
  const agg = (filePath: string) => {
    let a = files.get(filePath);
    if (!a) {
      a = { filePath };
      files.set(filePath, a);
    }
    return a;
  };

  for (const { node, english, ko } of nodeScores.values()) {
    let base = (english?.baseScore ?? 0) + (ko?.score ?? 0);
    if (ko && !english && node.isTest) base *= 0.7;
    const score = base + (english ? english.score - english.baseScore : 0);
    const a = agg(node.filePath);
    if (!a.best || score > a.best.score) {
      a.best = {
        node,
        score,
        base,
        matched: english?.matched ?? [],
        koWords: ko?.words ?? new Set(),
      };
    }
  }
  for (const [filePath, hit] of byFileKo) agg(filePath).commit = hit;
  if (tokens.tickets.length > 0) {
    for (const t of store.getTicketFiles(tokens.tickets)) {
      const a = agg(t.filePath);
      if (!a.ticket || t.count > a.ticket.count) a.ticket = { key: t.ticket, count: t.count };
    }
  }

  const ranked: Pointer[] = [];
  for (const a of files.values()) {
    const relPath = rel(a.filePath);
    const testMul = isTestPath(relPath) ? 0.7 : 1;
    const commitScore = (a.commit?.score ?? 0) * testMul;
    const ticketScore = a.ticket ? TICKET_SCORE + Math.log2(1 + a.ticket.count) : 0;
    const base = (a.best?.base ?? 0) + commitScore + ticketScore;
    const score = (a.best?.score ?? 0) + commitScore + ticketScore;
    const words = new Set([...(a.best?.koWords ?? []), ...(a.commit?.words ?? [])]);
    ranked.push({
      node: a.best?.node ?? fileNode(a.filePath, relPath),
      relPath,
      score,
      baseScore: base,
      matched: a.best?.matched ?? [],
      koWords: [...words].sort((x, y) => x - y).map((i) => tokens.ko[i]!.surface),
      koSource: a.commit ? 'commit' : a.best?.koWords.size ? 'comment' : undefined,
      koCommits: a.commit?.commits,
      ticket: a.ticket,
    });
  }
  ranked.sort((x, y) => y.score - x.score || x.relPath.localeCompare(y.relPath));

  // 영문 포인터는 1위가 MIN_POINTER_SCORE를 넘으면 나머지는 상대 컷으로만 거른다.
  // 한국어로만 걸린 포인터는 순위와 상관없이 따로 문턱을 넘어야 한다
  const koreanOnly = (p: Pointer) => p.matched.length === 0 && !p.ticket;
  const passes = (p: Pointer) =>
    (!koreanOnly(p) || p.score >= minKorean) && hasEnoughEvidence(p, tokens);
  const top = ranked[0];
  if (!top || top.score < MIN_POINTER_SCORE) return [];

  // 1위의 절반에 못 미치는 건 버린다. 이력에만 남고 지워진 파일도 여기서 거른다
  const picks: Pointer[] = [];
  for (const r of ranked) {
    if (r.baseScore < top.baseScore * 0.5) continue;
    if (!passes(r) || !exists(r.node.filePath)) continue;
    picks.push(r);
    if (picks.length >= limit) break;
  }
  return picks;
}

/**
 * 점수만으로는 못 거르는 경우를 막는 증거 조건. 포인터마다 따로 보고 하나는 맞아야 남는다.
 *
 * - 티켓 키가 맞았다
 * - 그 포인터에서 서로 다른 영문 토큰과 한글 어절을 합쳐 둘 이상 맞았다.
 *   한국어만으로 걸렸으면 서로 다른 어절 둘이 맞아야 한다는 뜻이다
 * - 프롬프트에 조각 둘 이상짜리 식별자가 통째로 적혔고 그게 고른 심볼 이름이다
 *
 * 포인터 셋을 합쳐 세면 "점심"이 한 파일에, "먹을지"가 다른 파일에 맞아도 통과한다.
 * `push`나 `summarize`처럼 짧은 함수 이름도 드물어서 idf가 높아, 토큰 하나로 들어가면
 * "push는 하지 마" 같은 프롬프트에 엉뚱한 파일이 붙는다.
 */
export function hasEnoughEvidence(p: Pointer, tokens: PromptTokens): boolean {
  if (p.ticket) return true;
  if (new Set(p.matched).size + p.koWords.length >= 2) return true;
  return (
    p.node.kind !== NodeKind.File &&
    splitIdentifier(p.node.name).length >= 2 &&
    tokens.wholeNames.has(p.node.name.toLowerCase())
  );
}

/** 주입 문구에 붙이는 "어떤 단어로 걸렸는지". 에이전트가 포인터를 얼마나 믿을지 가늠하게 한다 */
export function evidenceLabel(p: Pointer): string {
  const parts: string[] = [];
  if (p.ticket) parts.push(`티켓 ${p.ticket.key} ${p.ticket.count}건`);
  if (p.koWords.length > 0) {
    const words = `"${p.koWords.slice(0, 3).join(' ')}"`;
    parts.push(p.koSource === 'commit' ? `커밋 ${words} ${p.koCommits ?? 0}건` : `주석 ${words}`);
  }
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}
