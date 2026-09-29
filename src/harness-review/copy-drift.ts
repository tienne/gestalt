import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';
import { queryCoChange, type GitRunner } from '../code-graph/cochange.js';
import { CodeGraphStore } from '../code-graph/storage.js';
import type { CoChangeTuning } from '../code-graph/types.js';
import { parseUnifiedDiff } from './identifiers.js';
import type { ReferenceCandidate } from './types.js';

export const COPY_DRIFT_SOURCES = [
  'identicalBlob',
  'coChange',
  'hiddenCopy',
  'syncDeclared',
] as const;

export type CopyDriftSource = (typeof COPY_DRIFT_SOURCES)[number];

export interface CopyDriftOptions {
  repoRoot: string;
  base: string;
  head: string;
  /** 후보의 targetRepo에 싣는 자기 레포 표기(owner/name). 기본값 '.' */
  repo?: string;
  /** 기본값 `<repoRoot>/.gestalt/code-graph.db`. 파일이 없으면 co-change 경로만 건너뛴다 */
  codeGraphDbPath?: string;
  coChange?: CoChangeTuning;
  /** 숨은 사본과 같게 유지 선언 후보에 붙일 앞뒤 줄 수 */
  contextLines?: number;
  runGit?: GitRunner;
}

export interface CopyDriftResult {
  /** 네 경로 후보를 합친 목록. 같은 파일 쌍은 한 경로에만 남는다 */
  candidates: ReferenceCandidate[];
  bySource: Record<CopyDriftSource, ReferenceCandidate[]>;
  coChange: { checked: boolean; reason?: string };
  /** 건너뛰거나 실패한 경로. 후보가 비었다고 "어긋남 없음"으로 읽지 않게 따로 싣는다 */
  limitations: string[];
}

export const DEFAULT_CONTEXT_LINES = 2;
export const MAX_DIFF_CONTEXT_LINES = 6;
export const MAX_HIDDEN_COPY_PHRASES = 40;
export const MAX_HITS_PER_PHRASE = 20;
/** 이보다 짧은 구절은 흔한 말이라 다른 문서에 우연히 겹친다 */
export const MIN_PHRASE_CHARS = 10;

/**
 * 문서에서 두 파일을 같게 유지하라고 적은 자리를 찾는 표현. "동일하게"는
 * "규칙은 동일하게 지킨다"처럼 사본과 무관한 문장에도 흔하게 나오므로
 * 이 표현만으로는 후보를 내지 않고 같은 줄에 파일 경로가 둘 있어야 낸다.
 */
export const SYNC_DECLARATION_PATTERNS = [
  '같게 유지',
  '동일하게 유지',
  '똑같이 유지',
  '동일하게',
  '내용 동일',
  '내용이 같',
  'keep in sync',
  'kept in sync',
  'in sync with',
  'keep identical',
  'stay identical',
] as const;

const SELF_REFERENCE_RE = /이 파일|이 문서|this file|this document/i;
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
const SYMLINK_MODE = '120000';

function defaultRunGit(root: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: root,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

interface TreeEntry {
  mode: string;
  sha: string;
}

function readTree(runGit: GitRunner, root: string, ref: string): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  for (const record of runGit(root, ['ls-tree', '-r', '-z', ref]).split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const [mode, type, sha] = record.slice(0, tab).split(' ');
    // 서브모듈은 commit 항목이라 blob 비교 대상이 아니다
    if (type !== 'blob' || !mode || !sha) continue;
    out.set(record.slice(tab + 1), { mode, sha });
  }
  return out;
}

interface SummaryLine {
  line: number;
  text: string;
}

export interface FileDiffSummary {
  /** head 쪽 첫 hunk 시작 줄. 파일이 지워졌으면 base 쪽 줄 */
  firstLine: number;
  /** base 기준 줄 번호 */
  removed: SummaryLine[];
  /** head 기준 줄 번호 */
  added: SummaryLine[];
}

/** 파일별로 지워진 줄과 추가된 줄만 추린다. 지워진 파일은 base 경로를 키로 쓴다 */
export function summarizeDiff(raw: string): Map<string, FileDiffSummary> {
  const files = new Map<string, FileDiffSummary>();
  for (const f of parseUnifiedDiff(raw)) {
    const path = f.newPath ?? f.oldPath;
    const first = f.hunks[0];
    if (path === null || !first) continue;
    const summary: FileDiffSummary = {
      firstLine: Math.max(first.newStart, 1),
      removed: [],
      added: [],
    };
    for (const hunk of f.hunks) {
      for (const l of hunk.lines) {
        if (l.type === 'removed') summary.removed.push({ line: l.lineNumber, text: l.text });
        else if (l.type === 'added') summary.added.push({ line: l.lineNumber, text: l.text });
      }
    }
    files.set(path, summary);
  }
  return files;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\t${b}` : `${b}\t${a}`;
}

function diffPreview(diff: FileDiffSummary | undefined): string[] {
  if (!diff) return [];
  return [...diff.removed.map((l) => `-${l.text}`), ...diff.added.map((l) => `+${l.text}`)].slice(
    0,
    MAX_DIFF_CONTEXT_LINES,
  );
}

function contextAround(lines: string[], lineNo: number, n: number): string[] {
  const start = Math.max(0, lineNo - 1 - n);
  return lines.slice(start, lineNo + n);
}

interface GrepHit {
  path: string;
  line: number;
  text: string;
}

/** `git grep <ref>`의 `ref:path:line:text` 출력을 푼다. 매치가 없으면 git이 1로 끝나므로 빈 결과로 본다 */
function gitGrep(
  runGit: GitRunner,
  root: string,
  ref: string,
  args: string[],
  pathspec: string[] = [],
): GrepHit[] {
  let raw: string;
  try {
    raw = runGit(root, ['grep', '-n', '-I', '--no-color', ...args, ref, '--', ...pathspec]);
  } catch (e) {
    if ((e as { status?: number }).status === 1) return [];
    throw e;
  }
  const prefix = `${ref}:`;
  const hits: GrepHit[] = [];
  for (const row of raw.split('\n')) {
    if (!row.startsWith(prefix)) continue;
    const m = /^(.*?):(\d+):(.*)$/.exec(row.slice(prefix.length));
    if (!m) continue;
    hits.push({ path: m[1]!, line: Number(m[2]!), text: m[3]! });
  }
  return hits;
}

/**
 * 삭제되거나 바뀐 규칙 줄에서 다른 문서에 그대로 남았을 법한 구절 하나를 뽑는다.
 * 서식 기호에서 끊는 이유는 사본마다 백틱이나 굵게 표시가 달라서 서식을 낀 구절로는
 * 고정 문자열 검색이 안 맞기 때문이다.
 */
export function extractKeyPhrase(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('```') || /^\|?[\s:|-]+\|?$/.test(trimmed)) return null;
  const body = trimmed.replace(/^(?:[-*+>#]+|\d+[.)])\s*/, '');
  const segments = body
    .split(/[`*_|"“”‘’()[\]{}<>.,;:!?。—]|\s-\s/)
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter((s) => s.replace(/\s/g, '').length >= MIN_PHRASE_CHARS && s.includes(' '));
  if (segments.length === 0) return null;
  return segments.reduce((a, b) => (b.length > a.length ? b : a));
}

/** 줄에 적힌 경로 꼴 토큰. 한글 조사가 붙어도 ASCII 구간에서 끊겨 경로만 남는다 */
function pathTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[A-Za-z0-9_./-]+/g)) {
    const token = m[0].replace(/^\.\/|[./]+$/g, '');
    if (token.includes('/') || /\.[A-Za-z0-9]+$/.test(token)) out.push(token);
  }
  return out;
}

function resolveDocPath(token: string, docPath: string, tree: Set<string>): string | null {
  if (tree.has(token)) return token;
  const rel = posix.normalize(posix.join(posix.dirname(docPath), token));
  return tree.has(rel) ? rel : null;
}

/**
 * base와 head 사이에서 사본 한쪽만 바뀐 자리를 후보로 모은다. 네 경로를 따로 돌리고
 * 한 경로가 실패해도 나머지 결과는 살린다. 판정은 하지 않는다 — 후보만 낸다.
 */
export function findCopyDrift(opts: CopyDriftOptions): CopyDriftResult {
  const root = resolve(opts.repoRoot);
  const runGit = opts.runGit ?? defaultRunGit;
  const repo = opts.repo ?? '.';
  const ctxN = opts.contextLines ?? DEFAULT_CONTEXT_LINES;

  const limitations: string[] = [];
  const bySource: Record<CopyDriftSource, ReferenceCandidate[]> = {
    identicalBlob: [],
    coChange: [],
    hiddenCopy: [],
    syncDeclared: [],
  };
  const coChange: CopyDriftResult['coChange'] = { checked: false };

  const baseTree = readTree(runGit, root, opts.base);
  const headTree = readTree(runGit, root, opts.head);
  const headPaths = new Set(headTree.keys());
  const changed = new Set<string>();
  for (const [p, e] of baseTree) if (headTree.get(p)?.sha !== e.sha) changed.add(p);
  for (const p of headTree.keys()) if (!baseTree.has(p)) changed.add(p);

  const diffs = summarizeDiff(
    runGit(root, ['diff', '--no-color', '--no-renames', '-U0', opts.base, opts.head]),
  );

  const headContent = new Map<string, string[]>();
  const readHead = (path: string): string[] => {
    let lines = headContent.get(path);
    if (!lines) {
      lines = runGit(root, ['show', `${opts.head}:${path}`]).split('\n');
      headContent.set(path, lines);
    }
    return lines;
  };

  const make = (
    sourceFile: string,
    targetPath: string,
    fields: Partial<ReferenceCandidate>,
  ): ReferenceCandidate => ({
    kind: 'copyDrift',
    sourceFile,
    sourceLine: diffs.get(sourceFile)?.firstLine ?? 1,
    targetRepo: repo,
    targetPath,
    matchedText: '',
    contextLines: diffPreview(diffs.get(sourceFile)),
    needsLlmJudgment: false,
    ...fields,
  });

  // (1) base에서 blob이 같던 파일 묶음 가운데 head에서 갈라진 쌍
  try {
    const groups = new Map<string, string[]>();
    for (const [p, e] of baseTree) {
      if (e.sha === EMPTY_BLOB || e.mode === SYMLINK_MODE) continue;
      const g = groups.get(e.sha);
      if (g) g.push(p);
      else groups.set(e.sha, [p]);
    }
    for (const [sha, members] of groups) {
      if (members.length < 2) continue;
      // 지워진 쪽은 이동이나 폐기라서 어긋남으로 보지 않는다
      const alive = members.filter((p) => headPaths.has(p));
      for (const source of alive.filter((p) => changed.has(p))) {
        const sourceSha = headTree.get(source)!.sha;
        for (const target of alive) {
          if (target === source || headTree.get(target)!.sha === sourceSha) continue;
          if (changed.has(target) && target < source) continue;
          bySource.identicalBlob.push(
            make(source, target, {
              matchedText: `base에서 blob ${sha.slice(0, 12)}이 같던 파일이 head에서 갈라짐`,
            }),
          );
        }
      }
    }
  } catch (e) {
    limitations.push(`blob 비교 실패: ${errMessage(e)}`);
  }

  // (2) co-change로 함께 바뀌던 이웃 중 이번에 안 바뀐 파일
  const dbPath = opts.codeGraphDbPath ?? join(root, '.gestalt', 'code-graph.db');
  if (!existsSync(dbPath)) {
    coChange.reason = `코드 그래프 DB가 없어 co-change 경로를 건너뛰었다 (${relOrAbs(root, dbPath)})`;
    limitations.push(coChange.reason);
  } else {
    let store: CodeGraphStore | null = null;
    try {
      store = new CodeGraphStore(dbPath);
      const seeds = [...changed].filter((p) => headPaths.has(p));
      const exists = (abs: string): boolean => headPaths.has(toRel(root, abs));
      if (!store.getCoChangeMeta()) {
        coChange.reason = '코드 그래프 DB에 co-change 이력이 수집되지 않았다';
        limitations.push(coChange.reason);
      } else {
        coChange.checked = true;
        for (const seed of seeds) {
          // seed별로 따로 묻는다. 합쳐 물으면 어느 파일의 이웃인지가 사라진다
          const r = queryCoChange(store, root, { ...opts.coChange, target: seed, exists });
          if (r.matchedCapped)
            limitations.push(`co-change 질의가 천장에 걸려 일부만 봤다: ${seed}`);
          for (const n of r.neighbors) {
            const target = toRel(root, n.filePath);
            if (changed.has(target)) continue;
            bySource.coChange.push(
              make(seed, target, {
                matchedText: `co-change ${n.pairCount}회, confidence ${n.confidence}, lift ${n.lift}`,
                contextLines: [],
              }),
            );
          }
        }
      }
    } catch (e) {
      coChange.reason = `co-change 조회 실패: ${errMessage(e)}`;
      limitations.push(coChange.reason);
    } finally {
      store?.close();
    }
  }

  // (3) 바뀐 규칙 문장의 핵심 구절이 다른 파일에 그대로 남은 숨은 사본
  try {
    const seen = new Set<string>();
    let phrases = 0;
    outer: for (const [source, diff] of diffs) {
      if (!source.endsWith('.md')) continue;
      const sourceNow = headPaths.has(source) ? readHead(source).join('\n') : '';
      for (const removed of diff.removed) {
        const phrase = extractKeyPhrase(removed.text);
        // head의 같은 파일에 구절이 아직 있으면 문장을 옮긴 것일 뿐이다
        if (!phrase || seen.has(phrase) || sourceNow.includes(phrase)) continue;
        seen.add(phrase);
        if (++phrases > MAX_HIDDEN_COPY_PHRASES) {
          limitations.push(
            `숨은 사본 검색 구절이 ${MAX_HIDDEN_COPY_PHRASES}개를 넘어 뒤쪽은 건너뛰었다`,
          );
          break outer;
        }
        const hits = gitGrep(runGit, root, opts.head, ['-F', '-e', phrase]).filter(
          (h) => h.path !== source,
        );
        for (const hit of hits.slice(0, MAX_HITS_PER_PHRASE)) {
          bySource.hiddenCopy.push(
            make(source, hit.path, {
              sourceLine: removed.line,
              matchedText: phrase,
              contextLines: contextAround(readHead(hit.path), hit.line, ctxN),
            }),
          );
        }
      }
    }
  } catch (e) {
    limitations.push(`숨은 사본 검색 실패: ${errMessage(e)}`);
  }

  // (4) 문서가 같게 유지하라고 적은 쌍. 어느 쪽이 기준인지, 이번 변경이 그 약속을
  // 깨는지는 문장을 읽어야 알 수 있어 LLM 판정으로 넘긴다
  try {
    const args = ['-i', '-E', ...SYNC_DECLARATION_PATTERNS.flatMap((p) => ['-e', p])];
    for (const decl of gitGrep(runGit, root, opts.head, args, ['*.md'])) {
      const paths = [
        ...new Set(
          pathTokens(decl.text)
            .map((t) => resolveDocPath(t, decl.path, headPaths))
            .filter((p): p is string => p !== null),
        ),
      ];
      if (paths.length === 1 && SELF_REFERENCE_RE.test(decl.text)) paths.push(decl.path);
      const sources = paths.filter((p) => changed.has(p));
      const targets = paths.filter((p) => !changed.has(p));
      for (const source of sources) {
        for (const target of targets) {
          bySource.syncDeclared.push(
            make(source, target, {
              matchedText: `${decl.path}:${decl.line}: ${decl.text.trim()}`,
              contextLines: contextAround(readHead(decl.path), decl.line, ctxN),
              needsLlmJudgment: true,
            }),
          );
        }
      }
    }
  } catch (e) {
    limitations.push(`같게 유지 선언 검색 실패: ${errMessage(e)}`);
  }

  // 같은 쌍이 여러 경로에 걸리면 판정 근거가 가장 뚜렷한 경로 하나에만 남긴다.
  // 선언이 있는 쌍은 LLM 판정으로 분리하기로 했으므로 맨 앞이다
  const claimed = new Set<string>();
  for (const source of ['syncDeclared', 'identicalBlob', 'hiddenCopy', 'coChange'] as const) {
    const kept = bySource[source].filter((c) => !claimed.has(pairKey(c.sourceFile, c.targetPath)));
    for (const c of kept) claimed.add(pairKey(c.sourceFile, c.targetPath));
    bySource[source] = kept;
  }

  return {
    candidates: COPY_DRIFT_SOURCES.flatMap((s) => bySource[s]),
    bySource,
    coChange,
    limitations,
  };
}

function toRel(root: string, abs: string): string {
  return relative(root, abs).split('\\').join('/');
}

function relOrAbs(root: string, p: string): string {
  const abs = resolve(p);
  return abs.startsWith(root) ? toRel(root, abs) : abs;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
