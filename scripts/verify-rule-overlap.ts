#!/usr/bin/env tsx
/**
 * 룰북 룰끼리 겹치는 자리를 찾는다. 설계와 재현 결과는
 * docs/experiments/2026-10-rule-overlap-check.md에 있다.
 *
 *   pnpm verify:rule-overlap               룰북 전체. 탐지기 행렬의 error만 실패로 친다
 *   pnpm verify:rule-overlap --base main   이번 변경에서 새로 생긴 문장이 낀 겹침 후보까지 낸다
 *   --json                                 리뷰 단계가 읽을 JSON
 *
 * 검사를 끄는 플래그는 일부러 없다. 걸린 자리가 맞는 판정이면 룰북 문장을 고친다.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  changedSentences,
  checkOverlap,
  hasRuleTable,
  parseRuleEntries,
  RULE_DETECTORS,
  type OverlapReport,
  type RuleEntry,
} from '../src/humanize/overlap.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const REFERENCES = join(ROOT, 'plugin/role-agents/_shared/references');

function rulebookFiles(): string[] {
  return readdirSync(REFERENCES)
    .filter((name) => name.endsWith('.md'))
    .map((name) => join(REFERENCES, name))
    .filter((path) => hasRuleTable(readFileSync(path, 'utf-8')));
}

function entriesOf(read: (path: string) => string | null): RuleEntry[] {
  return rulebookFiles().flatMap((path) => {
    const text = read(path);
    return text === null ? [] : parseRuleEntries(text, relative(ROOT, path));
  });
}

function showAt(ref: string, path: string): string | null {
  try {
    return execFileSync('git', ['show', `${ref}:${relative(ROOT, path)}`], {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // base에 없던 룰북이면 문장 전부가 새것이다
    return null;
  }
}

export function run(base?: string): OverlapReport {
  const head = entriesOf((path) => readFileSync(path, 'utf-8'));
  const changed = base
    ? changedSentences(
        entriesOf((path) => showAt(base, path)),
        head,
      )
    : undefined;
  return checkOverlap(head, RULE_DETECTORS, { changed });
}

function format(report: OverlapReport, withCandidates: boolean): string {
  const out: string[] = [];
  const errors = report.findings.filter((f) => f.level === 'error');
  const infos = report.findings.filter((f) => f.level === 'info');

  out.push(`탐지기 행렬: error ${errors.length}, info ${infos.length}`);
  for (const f of errors) out.push(`  ✗ [${f.code}] ${f.example.line}행 ${f.message}`);
  for (const f of infos) out.push(`  · [${f.code}] ${f.example.line}행 ${f.message}`);

  const names = report.undecidable.map((u) => u.ruleId);
  out.push(`판정 불가 (탐지기 없음) ${names.length}개: ${names.join(' ')}`);

  if (withCandidates) {
    out.push(`겹침 후보 ${report.candidates.length}개 — 판정이 아니라 리뷰어에게 넘길 질문이다`);
    for (const c of report.candidates) {
      out.push(`  ? [${c.code}] ${c.file}:${c.line} ${c.question}`);
    }
  }
  return out.join('\n');
}

const __filename = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1] !== undefined && resolve(process.argv[1]) === __filename;

if (isDirectRun) {
  const args = process.argv.slice(2);
  const baseIndex = args.indexOf('--base');
  const base = baseIndex >= 0 ? args[baseIndex + 1] : undefined;
  const report = run(base);

  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${format(report, base !== undefined)}\n`);
  }
  process.exit(report.findings.some((f) => f.level === 'error') ? 1 : 0);
}
