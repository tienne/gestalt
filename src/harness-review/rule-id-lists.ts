/**
 * 코드 속 룰 ID 목록에서 빠진 ID를 찾는다.
 *
 * 룰북에서 룰을 새로 정의하거나 정의 줄을 고치면, 그 룰을 골라 담는 코드 목록(금지 목록 펼칠
 * 룰, 자가점검 항목 같은 것)도 함께 봐야 할 때가 있다. 이런 누락은 남아 있는 문자열이 아니라
 * 빠진 문자열이라 금지어 grep으로는 원리상 안 잡힌다. 그래서 같은 룰북의 ID를 여럿 나열한
 * 목록을 찾고 바뀐 ID가 그 목록에 없으면 후보로 낸다.
 *
 * 목록은 대개 룰 일부만 일부러 고른 것이라 빠진 게 곧 결함은 아니다. 후보는 전부
 * needsLlmJudgment로 넘기고 harness-reviewer가 목록 위 설명을 읽고 판정한다.
 */
import { execFileSync } from 'node:child_process';
import { ruleIdOfDefinitionLine, parseUnifiedDiff } from './identifiers.js';
import type { ReferenceCandidate } from './types.js';

export interface RuleIdListGapInput {
  diff: string;
  /** head 트리의 파일 경로 */
  files: string[];
  readFile: (path: string) => string | undefined;
  /** 후보의 targetRepo에 싣는 자기 레포 표기. 기본값 '.' */
  repoName?: string;
}

/** 이보다 적게 나열한 자리는 목록이 아니라 설명 속 언급으로 본다 */
export const MIN_LIST_IDS = 3;
/** 룰 ID 사이가 이 줄 수보다 벌어지면 다른 목록으로 나눈다 */
export const MAX_LIST_GAP_LINES = 2;
export const MAX_LIST_CONTEXT_LINES = 8;

const CODE_EXT_RE = /\.(?:[cm]?[jt]sx?|json|ya?ml|py)$/;
// 테스트와 fixture는 룰 일부만 골라 검사하는 게 정상이라 빠진 ID가 결함이 아니다
const TEST_PATH_RE = /(?:^|\/)(?:tests?|__tests__|fixtures?)\/|\.(?:test|spec)\.[^/]+$/;
const QUOTED_RULE_ID_RE = /(['"`])([A-Z]{1,2}-\d{1,3})\1/g;

export interface RuleIdList {
  file: string;
  startLine: number;
  endLine: number;
  ids: Set<string>;
  /** 나온 차례대로. 같은 ID가 두 번 나오면 둘 다 있다 */
  entries: Array<{ id: string; line: number }>;
}

function isMarkdown(path: string): boolean {
  return /\.mdx?$/i.test(path);
}

/** diff의 추가 줄에서 정의된 룰 ID를 룰북 경로별로 모은다 */
export function changedRuleIds(diff: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const f of parseUnifiedDiff(diff)) {
    const path = f.newPath;
    if (!path || !isMarkdown(path)) continue;
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.type !== 'added') continue;
        const id = ruleIdOfDefinitionLine(l.text);
        if (!id) continue;
        if (!out.has(path)) out.set(path, new Set());
        out.get(path)!.add(id);
      }
    }
  }
  return out;
}

function definedRuleIds(markdown: string): Set<string> {
  const ids = new Set<string>();
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const id = ruleIdOfDefinitionLine(line);
    if (id) ids.add(id);
  }
  return ids;
}

/** 따옴표로 감싼 룰 ID가 줄 간격 MAX_LIST_GAP_LINES 안에서 이어지는 구간을 목록 하나로 묶는다 */
export function findRuleIdLists(file: string, content: string): RuleIdList[] {
  const lists: RuleIdList[] = [];
  let current: RuleIdList | null = null;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const ids = [...lines[i]!.matchAll(QUOTED_RULE_ID_RE)].map((m) => m[2]!);
    if (ids.length === 0) continue;
    const lineNo = i + 1;
    if (!current || lineNo - current.endLine > MAX_LIST_GAP_LINES) {
      current = { file, startLine: lineNo, endLine: lineNo, ids: new Set(), entries: [] };
      lists.push(current);
    }
    current.endLine = lineNo;
    for (const id of ids) {
      current.ids.add(id);
      current.entries.push({ id, line: lineNo });
    }
  }
  return lists.filter((l) => l.ids.size >= MIN_LIST_IDS);
}

function compareRuleIds(a: string, b: string): number {
  const [pa, na] = a.split('-') as [string, string];
  const [pb, nb] = b.split('-') as [string, string];
  return pa === pb ? Number(na) - Number(nb) : pa < pb ? -1 : 1;
}

/**
 * 빠진 ID가 들어갈 줄. ID 순으로 정렬된 목록이면 순서상 자리를, 아니면 목록 끝 다음 줄을 준다.
 * 리뷰어가 코멘트를 달 자리이고 목록 첫 줄을 주면 긴 목록에서 어디를 보라는 건지 흐려진다.
 */
export function insertionLine(list: RuleIdList, id: string): number {
  const { entries } = list;
  const sorted = entries.every((e, i) => i === 0 || compareRuleIds(entries[i - 1]!.id, e.id) <= 0);
  if (!sorted) return list.endLine + 1;
  const before = entries.filter((e) => compareRuleIds(e.id, id) < 0);
  return before.length === 0 ? list.startLine : before[before.length - 1]!.line + 1;
}

function contextOf(content: string, list: RuleIdList): string[] {
  const lines = content.split('\n').slice(list.startLine - 1, list.endLine);
  if (lines.length <= MAX_LIST_CONTEXT_LINES) return lines;
  return [...lines.slice(0, MAX_LIST_CONTEXT_LINES - 1), `… (${list.endLine}줄까지)`];
}

export function findRuleIdListGaps(input: RuleIdListGapInput): ReferenceCandidate[] {
  const changed = changedRuleIds(input.diff);
  if (changed.size === 0) return [];

  const rulebooks = [...changed.entries()].flatMap(([path, ids]) => {
    const content = input.readFile(path);
    return content === undefined ? [] : [{ path, ids, defined: definedRuleIds(content) }];
  });

  const candidates: ReferenceCandidate[] = [];
  for (const file of input.files) {
    if (!CODE_EXT_RE.test(file) || TEST_PATH_RE.test(file)) continue;
    const content = input.readFile(file);
    if (content === undefined) continue;
    const quotedHere = new Set([...content.matchAll(QUOTED_RULE_ID_RE)].map((m) => m[2]!));
    for (const list of findRuleIdLists(file, content)) {
      for (const book of rulebooks) {
        // 다른 룰북의 ID 목록은 같은 접두 글자를 써도 이 룰과 무관하다
        const shared = [...list.ids].filter((id) => book.defined.has(id)).length;
        if (shared < MIN_LIST_IDS) continue;
        for (const id of book.ids) {
          // 한 파일에서 여러 줄로 흩어진 목록(탐지기 등록부 같은 것)은 이미 그 ID를 다른 구간에 들고 있다
          if (quotedHere.has(id)) continue;
          candidates.push({
            kind: 'ruleIdListGap',
            sourceFile: file,
            sourceLine: insertionLine(list, id),
            targetRepo: input.repoName ?? '.',
            targetPath: book.path,
            matchedText: id,
            contextLines: contextOf(content, list),
            needsLlmJudgment: true,
          });
        }
      }
    }
  }
  return candidates;
}

/** base와 head 사이 diff로 검사한다. 파일은 head 트리에서 읽는다 */
export function findRuleIdListGapsFromGit(
  repoRoot: string,
  base: string,
  head: string,
  repoName?: string,
): ReferenceCandidate[] {
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  const diff = git('diff', '--no-color', base, head);
  if (changedRuleIds(diff).size === 0) return [];
  // 파일마다 git show를 부르면 느려서 따옴표 친 룰 ID가 있는 파일만 먼저 추린다
  let grepped = '';
  try {
    grepped = git('grep', '-l', '-E', `['"\`][A-Z]{1,2}-[0-9]{1,3}['"\`]`, head);
  } catch {
    // 걸린 파일이 없으면 git grep이 1로 끝난다
  }
  const prefix = `${head}:`;
  const files = grepped
    .split('\n')
    .filter(Boolean)
    .map((l) => (l.startsWith(prefix) ? l.slice(prefix.length) : l));
  return findRuleIdListGaps({
    diff,
    files,
    readFile: (p) => {
      try {
        return git('show', `${head}:${p}`);
      } catch {
        return undefined;
      }
    },
    repoName,
  });
}
