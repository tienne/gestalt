/**
 * 룰 기준 문서인 ai-tell-quick-rules.md를 읽어 룰 목록으로 만든다.
 *
 * 룰은 사람이 읽는 마크다운이 기준이고, 코드는 그걸 읽기만 한다.
 * 반대로 코드에 룰을 복사해 두면 룰북과 코드가 조용히 갈라진다.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Severity = 'S1' | 'S2' | 'S3';

/** 산문(칼럼·리포트·문서) 기준과 대화·리뷰 코멘트 기준을 나눠 본다 */
export type Register = 'doc' | 'chat';

export interface Rule {
  id: string;
  category: string;
  categoryTitle: string;
  pattern: string;
  /** 문서 기준 심각도 */
  severity: Severity;
  /** 대화·리뷰에서 격상되는 룰은 여기가 S1이 된다 */
  chatSeverity: Severity;
  prescription: string;
}

export interface RuleBook {
  path: string;
  rules: Map<string, Rule>;
  /** 자체검증 5번이 열거한 잔존 금지 S1 목록 */
  selfCheckS1: string[];
  /** 자체검증 5번의 대화·리뷰 추가분 */
  selfCheckChatS1: string[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));

export const QUICK_RULES_PATH = resolve(
  __dirname,
  '../../plugin/role-agents/_shared/references/ai-tell-quick-rules.md',
);

const CATEGORY_HEADING = /^##\s+([A-J])\.\s+(.+?)\s*$/;
const TABLE_ROW = /^\|\s*([A-J]-\d{1,2})\s*\|(.+)$/;
const RULE_ID = /\b([A-J]-\d{1,2})\b/g;
const ID_RANGE = /\b([A-J])-(\d{1,2})\s*~\s*(?:[A-J]-)?(\d{1,2})\b/g;

function parseSeverity(cell: string): { severity: Severity; chatSeverity: Severity } {
  const found = cell.match(/\bS[123]\b/g) ?? [];
  const base = (found[0] ?? 'S2') as Severity;
  // "S2 / **대화·리뷰 S1**" 처럼 두 개가 적힌 칸은 뒤쪽이 대화 기준이다
  const chat = (found[1] ?? base) as Severity;
  return { severity: base, chatSeverity: chat };
}

/**
 * "D-1~D-7" 같은 범위 표기를 개별 ID로 편다.
 * 룰북이 사람 읽기 좋게 범위로 적어둔 자리를 코드가 그대로 이해하게 만든다.
 */
export function expandIdRanges(text: string): string[] {
  const ids = new Set<string>();
  let remaining = text;

  for (const match of text.matchAll(ID_RANGE)) {
    const letter = match[1]!;
    const from = Number(match[2]!);
    const to = Number(match[3]!);
    for (let n = Math.min(from, to); n <= Math.max(from, to); n += 1) {
      ids.add(`${letter}-${n}`);
    }
    remaining = remaining.replace(match[0]!, ' ');
  }

  for (const match of remaining.matchAll(RULE_ID)) {
    ids.add(match[1]!);
  }

  return [...ids];
}

/** 마크다운 본문에서 인용된 모든 룰 ID를 뽑는다 (범위 표기 포함) */
export function citedRuleIds(markdown: string): string[] {
  return expandIdRanges(markdown);
}

export function parseRuleBook(path: string = QUICK_RULES_PATH): RuleBook {
  const raw = readFileSync(path, 'utf-8');
  const lines = raw.split('\n');

  const rules = new Map<string, Rule>();
  let category = '';
  let categoryTitle = '';

  for (const line of lines) {
    const heading = line.match(CATEGORY_HEADING);
    if (heading) {
      category = heading[1]!;
      categoryTitle = heading[2]!;
      continue;
    }

    const row = line.match(TABLE_ROW);
    if (!row) continue;

    const id = row[1]!;
    const cells = row[2]!.split('|').map((cell) => cell.trim());
    const { severity, chatSeverity } = parseSeverity(cells[1] ?? '');

    rules.set(id, {
      id,
      category,
      categoryTitle,
      pattern: cells[0] ?? '',
      severity,
      chatSeverity,
      prescription: cells[2] ?? '',
    });
  }

  const selfCheckLine = lines.find((line) => line.includes('잔존 S1 패턴 0건')) ?? '';
  const chatSplit = selfCheckLine.indexOf('대화·리뷰 말투면');
  const docPart = chatSplit >= 0 ? selfCheckLine.slice(0, chatSplit) : selfCheckLine;
  const chatPart = chatSplit >= 0 ? selfCheckLine.slice(chatSplit) : '';

  return {
    path,
    rules,
    selfCheckS1: expandIdRanges(docPart),
    selfCheckChatS1: expandIdRanges(chatPart),
  };
}

/** 해당 말투 기준으로 S1인 룰 ID */
export function s1Ids(book: RuleBook, register: Register): string[] {
  return [...book.rules.values()]
    .filter((rule) => (register === 'chat' ? rule.chatSeverity : rule.severity) === 'S1')
    .map((rule) => rule.id)
    .sort();
}
