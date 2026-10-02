/**
 * 룰북 PR에서 룰끼리 겹치는 자리를 harness-reviewer 후보로 싣는다.
 *
 * 판정은 `src/humanize/overlap.ts`가 한다. 여기서는 base와 head의 룰북을 git에서 읽어
 * 이번 변경에서 새로 생긴 문장이 낀 것만 후보로 바꾼다. 룰북 전체를 늘 걸면 오래된
 * 겹침이 PR마다 다시 올라와서 리뷰어가 후보를 안 읽게 된다.
 */
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import {
  changedSentences,
  checkOverlap,
  hasRuleTable,
  parseRuleEntries,
  RULE_DETECTORS,
  type RuleEntry,
} from '../humanize/overlap.js';
import type { ReferenceCandidate } from './types.js';

/** 룰북이 사는 자리. 플러그인 공유 레퍼런스뿐이다 */
const RULEBOOK_DIR = /(?:^|\/)_shared\/references\/[^/]+\.md$/;

function rulebooksAt(
  git: (...args: string[]) => string,
  ref: string,
  dirs: ReadonlySet<string>,
): RuleEntry[] {
  const entries: RuleEntry[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = git('ls-tree', '--name-only', `${ref}:${dir}`).split('\n').filter(Boolean);
    } catch {
      // base에 없던 디렉토리면 그쪽 문장이 전부 새것이다
      continue;
    }
    for (const name of names.filter((n) => n.endsWith('.md'))) {
      const path = `${dir}/${name}`;
      const text = git('show', `${ref}:${path}`);
      if (hasRuleTable(text)) entries.push(...parseRuleEntries(text, path));
    }
  }
  return entries;
}

export function findRuleOverlapFromGit(
  repoRoot: string,
  base: string,
  head: string,
  repoName: string,
): ReferenceCandidate[] {
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

  const changedFiles = git('diff', '--name-only', base, head)
    .split('\n')
    .filter((p) => RULEBOOK_DIR.test(p));
  if (changedFiles.length === 0) return [];

  // 겹침은 파일을 넘나든다. 바뀐 룰북과 같은 디렉토리의 룰북을 함께 읽는다
  const dirs = new Set(changedFiles.map((p) => dirname(p)));
  const headEntries = rulebooksAt(git, head, dirs);
  if (headEntries.length === 0) return [];
  const changed = changedSentences(rulebooksAt(git, base, dirs), headEntries);
  if (changed.size === 0) return [];

  const report = checkOverlap(headEntries, RULE_DETECTORS, { changed });
  const fromMatrix: ReferenceCandidate[] = report.findings
    .filter((f) => f.level === 'error' && changed.has(f.example.sentence))
    .map((f) => ({
      kind: 'ruleOverlap',
      sourceFile: headEntries.find((e) => e.id === f.ruleId)?.file ?? '',
      sourceLine: f.example.line,
      targetRepo: repoName,
      targetPath: headEntries.find((e) => e.id === f.hitBy)?.file ?? '',
      matchedText: `[${f.code}] ${f.message}`,
      contextLines: [f.example.sentence],
      needsLlmJudgment: false,
    }));
  const fromText: ReferenceCandidate[] = report.candidates.map((c) => ({
    kind: 'ruleOverlap',
    sourceFile: c.file,
    sourceLine: c.line,
    targetRepo: repoName,
    targetPath: headEntries.find((e) => e.id === c.rules[1])?.file ?? c.file,
    matchedText: `[${c.code}] ${c.question}`,
    contextLines: c.evidence,
    needsLlmJudgment: true,
  }));
  return [...fromMatrix, ...fromText];
}
