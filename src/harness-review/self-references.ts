/**
 * 자기 레포 안의 옛 이름 참조를 찾는다.
 *
 * 역방향 검색은 관련 레포만 본다. 그런데 하네스 PR이 가장 자주 남기는 문제는 같은 레포에 있다.
 * 디렉토리나 파일을 옮기거나 헤딩, 스킬 이름을 바꾸면 diff에 안 든 다른 스킬이 옛 이름을
 * 계속 부른다. 이 PR이 지우거나 바꾼 식별자를 head 트리의 하네스 파일에서 찾아 backwardRef로 낸다.
 * 이번 diff가 추가한 줄은 리뷰어가 diff에서 이미 읽으므로 뺀다.
 */
import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import { isHarnessPath, isRuleDocPath, parseUnifiedDiff } from './identifiers.js';
import type { Identifier, IdentifierKind, ReferenceCandidate } from './types.js';

export interface SelfReferenceInput {
  repoRoot: string;
  base: string;
  head: string;
  /** 후보의 targetRepo에 싣는 자기 레포 표기 */
  repo: string;
  identifiers: Identifier[];
}

/** 식별자 하나가 낼 수 있는 후보 수. 흔한 이름이면 레포 전체가 걸려 판정할 수 없게 된다 */
export const MAX_HITS_PER_IDENTIFIER = 20;
const MIN_TERM_LENGTH = 4;

// 내용만 바뀐 파일(modified path)은 그대로 있으니 옛 이름이 아니다
const STALE_KINDS = new Set<IdentifierKind>([
  'path',
  'heading',
  'ruleId',
  'skillName',
  'agentName',
  'uniqueFileName',
  'pluginName',
  'mcpToolName',
]);

type Git = (args: string[]) => string;

function makeGit(repoRoot: string): Git {
  return (args) =>
    execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
}

function dirsOf(paths: Iterable<string>): Set<string> {
  const dirs = new Set<string>();
  for (const p of paths) {
    for (let d = posix.dirname(p); d !== '.' && d !== '/'; d = posix.dirname(d)) dirs.add(d);
  }
  return dirs;
}

/** base에 있다가 head에서 통째로 사라진 디렉토리. 조상도 사라졌으면 조상만 남긴다 */
export function vanishedDirs(baseFiles: string[], headFiles: string[]): string[] {
  const headDirs = dirsOf(headFiles);
  const gone = [...dirsOf(baseFiles)].filter((d) => !headDirs.has(d));
  const goneSet = new Set(gone);
  return gone
    .filter((d) => {
      for (let p = posix.dirname(d); p !== '.' && p !== '/'; p = posix.dirname(p)) {
        if (goneSet.has(p)) return false;
      }
      return true;
    })
    .sort();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 경로가 더 긴 경로의 꼬리로 걸린 건 버린다. `kit/components/a.md` 안의 `components/a.md`가 그렇다.
 * `./components`처럼 현재 디렉토리 표기로 시작하는 건 같은 경로다.
 */
export function pathMatcher(value: string): RegExp {
  const body = escapeRe(value.replace(/\/$/, ''));
  return new RegExp(`(?<![\\w./-])(?:\\./)?${body}(?![\\w.-])`);
}

interface Term {
  identifier: Identifier;
  grep: string;
  test: (line: string) => boolean;
  needsLlmJudgment: boolean;
}

function termsOf(id: Identifier, isDir: boolean): Term[] {
  if (id.value.replace(/\/$/, '').length < MIN_TERM_LENGTH) return [];
  if (id.kind === 'path' || id.kind === 'uniqueFileName') {
    const re = pathMatcher(id.value);
    const grep = id.value.replace(/\/$/, '');
    // 디렉토리 이름은 산문의 흔한 낱말과 겹칠 수 있어 문맥 판정으로 넘긴다
    return [{ identifier: id, grep, test: (l) => re.test(l), needsLlmJudgment: isDir }];
  }
  const re = new RegExp(`(?<![\\w-])${escapeRe(id.value)}(?![\\w-])`);
  return [{ identifier: id, grep: id.value, test: (l) => re.test(l), needsLlmJudgment: true }];
}

interface GrepHit {
  path: string;
  line: number;
  text: string;
}

function grepHead(git: Git, head: string, term: string): GrepHit[] {
  let out: string;
  try {
    out = git(['grep', '-n', '-I', '-F', '--null', '--no-color', '-e', term, head, '--']);
  } catch {
    // 매치가 없으면 git grep이 1로 끝난다
    return [];
  }
  const prefix = `${head}:`;
  const hits: GrepHit[] = [];
  for (const row of out.split('\n')) {
    if (!row) continue;
    const [rawPath, lineNo, ...rest] = row.split('\0');
    if (!rawPath || !lineNo) continue;
    const path = rawPath.startsWith(prefix) ? rawPath.slice(prefix.length) : rawPath;
    hits.push({ path, line: Number(lineNo), text: rest.join('\0') });
  }
  return hits;
}

export function findSelfReferences(input: SelfReferenceInput): ReferenceCandidate[] {
  const git = makeGit(input.repoRoot);
  const listTree = (ref: string) =>
    git(['ls-tree', '-r', '--name-only', ref]).split('\n').filter(Boolean);

  const stale = input.identifiers.filter(
    (id) =>
      id.extractedBy === 'pattern' && id.changeType !== 'modified' && STALE_KINDS.has(id.kind),
  );
  const dirIds: Identifier[] = vanishedDirs(listTree(input.base), listTree(input.head)).map(
    (d) => ({ kind: 'path', value: `${d}/`, changeType: 'removed', extractedBy: 'pattern' }),
  );
  if (stale.length === 0 && dirIds.length === 0) return [];

  const addedLines = new Map<string, Set<number>>();
  for (const f of parseUnifiedDiff(git(['diff', '--no-color', input.base, input.head]))) {
    if (!f.newPath) continue;
    const set = new Set<number>();
    for (const h of f.hunks) for (const l of h.lines) if (l.type === 'added') set.add(l.lineNumber);
    addedLines.set(f.newPath, set);
  }

  const terms = [
    ...stale.flatMap((id) => termsOf(id, false)),
    ...dirIds.flatMap((id) => termsOf(id, true)),
  ];
  const seen = new Set<string>();
  const out: ReferenceCandidate[] = [];
  for (const term of terms) {
    let taken = 0;
    for (const hit of grepHead(git, input.head, term.grep)) {
      if (taken >= MAX_HITS_PER_IDENTIFIER) break;
      if (!isHarnessPath(hit.path) && !isRuleDocPath(hit.path)) continue;
      if (addedLines.get(hit.path)?.has(hit.line)) continue;
      if (!term.test(hit.text)) continue;
      const key = `${hit.path}:${hit.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      taken++;
      out.push({
        kind: 'backwardRef',
        sourceFile: hit.path,
        sourceLine: hit.line,
        targetRepo: input.repo,
        targetPath: hit.path,
        matchedText: term.identifier.value,
        contextLines: [hit.text.trim()],
        needsLlmJudgment: term.needsLlmJudgment,
      });
    }
  }
  return out;
}
