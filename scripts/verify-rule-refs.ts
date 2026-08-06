#!/usr/bin/env tsx
/**
 * 룰북과 그걸 인용하는 에이전트 문서가 갈라지지 않았는지 검사한다.
 *
 * `ai-tell-quick-rules.md`가 기준인데, 에이전트 14곳이 룰 ID와 금지 어휘를 손으로 옮겨 적는다.
 * 거기서 ID를 지우거나 심각도를 바꿔도 그 사본들은 그대로 남아 아무도 모른 채 어긋난다.
 * 여기서 막는다.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { citedRuleIds, parseRuleBook, s1Ids, QUICK_RULES_PATH } from '../src/humanize/index.js';
import { DETECTABLE_RULE_IDS } from '../src/humanize/detectors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PLUGIN = join(ROOT, 'plugin');

/**
 * 룰 문서가 스스로 금지한 표현을 본문에 쓰면 산출물로 샌다.
 * 예시로 인용할 때는 백틱이나 따옴표로 감싼다 — 아래 bareProse가 그건 걷어낸다.
 */
const SELF_CONTAMINATION = ['결론적으로', '요약하자면', '정리하자면', '본질적으로', '핵심적으로'];

/**
 * B-3 대상 음차. 굳어진 음차 화이트리스트에 없는데 자꾸 들어오는 말들이다.
 * 명령어나 제품 기능 이름으로 쓸 때는 백틱으로 감싼다 (`orchestration gate-create`).
 */
const LOANWORDS: Record<string, string> = {
  SSOT: '기준 문서 / 기준값',
  SoT: '기준 문서 / 기준값',
  게이트: '승인 단계 / 검사',
  레이어: '계층 / 묶음 / 단계 / 역할',
};

/** 대체어가 여러 개인 건 자리마다 다르기 때문이다 — 하나 정해 일괄 치환하지 말 것 */
const LOANWORD_HINT = 'style-guide.md §음차를 옮길 때';

export interface RuleRefIssue {
  level: 'error' | 'warn';
  file: string;
  message: string;
}

function markdownFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** 예시로 인용한 금지어까지 잡으면 못 쓴다 — 표·코드·따옴표 안은 인용으로 본다 */
function bareProse(markdown: string): { line: string; number: number }[] {
  const out: { line: string; number: number }[] = [];
  let inFence = false;

  markdown.split('\n').forEach((raw, index) => {
    if (raw.trimStart().startsWith('```')) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    if (raw.trimStart().startsWith('|')) return;

    const stripped = raw
      .replace(/`[^`\n]*`/g, ' ')
      .replace(/"[^"\n]*"|“[^”\n]*”|'[^'\n]*'/g, ' ')
      .replace(/\([^)\n]*\)/g, ' ');
    out.push({ line: stripped, number: index + 1 });
  });

  return out;
}

export function verifyRuleRefs(): RuleRefIssue[] {
  const issues: RuleRefIssue[] = [];
  const book = parseRuleBook(QUICK_RULES_PATH);
  const rel = (path: string) => path.slice(ROOT.length + 1);

  if (book.rules.size === 0) {
    issues.push({
      level: 'error',
      file: rel(QUICK_RULES_PATH),
      message: '룰을 하나도 못 읽었습니다. 표 형식이 바뀌었는지 확인하세요.',
    });
    return issues;
  }

  const known = new Set(book.rules.keys());

  // 1. 에이전트 문서가 인용한 ID가 룰북에 실제로 있는가
  for (const file of markdownFiles(PLUGIN)) {
    if (file === QUICK_RULES_PATH) continue;
    const cited = citedRuleIds(readFileSync(file, 'utf-8'));
    const unknown = cited.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      issues.push({
        level: 'error',
        file: rel(file),
        message: `룰북에 없는 ID 인용: ${unknown.sort().join(', ')}`,
      });
    }
  }

  // 2. 자체검증 목록이 룰북 표와 맞는가
  const checklist = [...book.selfCheckS1, ...book.selfCheckChatS1];
  const strayInChecklist = checklist.filter((id) => !known.has(id));
  if (strayInChecklist.length > 0) {
    issues.push({
      level: 'error',
      file: rel(QUICK_RULES_PATH),
      message: `자체검증 5번이 없는 ID를 열거: ${strayInChecklist.sort().join(', ')}`,
    });
  }

  // 3. S1인데 자체검증 목록에서 빠진 룰 — S2로 흘러 강제되지 않는 자리다
  const declaredS1 = new Set([...s1Ids(book, 'doc'), ...s1Ids(book, 'chat')]);
  const listed = new Set(checklist);
  const detectable = new Set(DETECTABLE_RULE_IDS);
  const missing = [...declaredS1].filter((id) => !listed.has(id)).sort();

  for (const id of missing) {
    issues.push({
      level: detectable.has(id) ? 'error' : 'warn',
      file: rel(QUICK_RULES_PATH),
      message: `${id}은 S1인데 자체검증 5번 목록에 없습니다`,
    });
  }

  // 3b. 반대로 자체검증이 대화 S1이라 부르는데 표는 S2로 둔 룰 — 표를 고쳐야 강제된다
  for (const id of book.selfCheckChatS1) {
    const rule = book.rules.get(id);
    if (rule && rule.chatSeverity !== 'S1') {
      issues.push({
        level: 'error',
        file: rel(QUICK_RULES_PATH),
        message: `${id}은 자체검증이 대화 S1로 부르는데 표 심각도는 ${rule.chatSeverity}입니다`,
      });
    }
  }

  // 3c. 에이전트 문서가 "S1 패턴은 ~다"라고 재진술한 목록이 룰북과 맞는가.
  //     심각도를 내려도 이 사본들은 안 따라와서 낡은 목록이 그대로 강제된다.
  const declaredAnyS1 = new Set([...s1Ids(book, 'doc'), ...s1Ids(book, 'chat')]);
  for (const file of markdownFiles(PLUGIN)) {
    if (file === QUICK_RULES_PATH) continue;
    readFileSync(file, 'utf-8')
      .split('\n')
      .forEach((line, index) => {
        if (!line.includes('S1')) return;
        const stale = citedRuleIds(line).filter(
          (id) => known.has(id) && !declaredAnyS1.has(id),
        );
        if (stale.length > 0) {
          issues.push({
            level: 'error',
            file: `${rel(file)}:${index + 1}`,
            message: `S1 목록에 S1이 아닌 ID: ${stale.sort().join(', ')}`,
          });
        }
      });
  }

  // 4. 룰 문서가 자기가 금지한 표현을 본문에 쓰고 있는가
  for (const file of markdownFiles(join(PLUGIN, 'role-agents'))) {
    for (const { line, number } of bareProse(readFileSync(file, 'utf-8'))) {
      for (const banned of SELF_CONTAMINATION) {
        if (line.includes(banned)) {
          issues.push({
            level: 'error',
            file: `${rel(file)}:${number}`,
            message: `금지 표현을 본문에 사용: ${banned}`,
          });
        }
      }
    }
  }

  // 5. 화이트리스트에 없는 음차 (B-3) — 에이전트와 스킬 문서 전체가 대상
  for (const file of markdownFiles(PLUGIN)) {
    for (const { line, number } of bareProse(readFileSync(file, 'utf-8'))) {
      for (const [word, replacement] of Object.entries(LOANWORDS)) {
        if (line.includes(word)) {
          issues.push({
            level: 'error',
            file: `${rel(file)}:${number}`,
            message: `B-3 음차: ${word} → ${replacement} (${LOANWORD_HINT})`,
          });
        }
      }
    }
  }

  return issues;
}

const __filename = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1] !== undefined && resolve(process.argv[1]) === __filename;

if (isDirectRun) {
  const issues = verifyRuleRefs();
  const errors = issues.filter((i) => i.level === 'error');

  for (const issue of issues) {
    const tag = issue.level === 'error' ? 'ERROR' : 'WARN ';
    console.error(`${tag} ${issue.file} — ${issue.message}`);
  }

  if (errors.length > 0) {
    console.error(`\n룰 참조 정합 실패: ${errors.length}건`);
    process.exit(1);
  }
  console.log(`룰 참조 정합 통과 (경고 ${issues.length}건)`);
}
