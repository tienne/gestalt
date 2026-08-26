/**
 * 윤문 전에 원문을 훑어 "이번에 볼 룰"만 추린다.
 *
 * 룰북은 59개까지 자랐다. 매번 전부 펼치면 모델이 나눠 쓰는 주의가 룰마다 얇아진다.
 * 실제로 걸린 서너 개는 안 걸린 쉰 개에 묻힌다. 스캔은 그 반대로 간다 —
 * 걸린 룰만 처방과 함께 내놓는다. 나머지는 아예 말하지 않는다.
 *
 * 탐지기가 없는 S1은 목록으로만 넘긴다. 코드가 못 가리는 자리를 가린다고 하면
 * 그게 더 나쁜 거짓말이다.
 */
import { detect, DETECTABLE_RULE_IDS } from './detectors.js';
import { parseRuleBook, ruleLabel, s1Ids, type Register, type RuleBook } from './rules.js';

export interface ScanHit {
  ruleId: string;
  label: string;
  count: number;
  samples: string[];
  prescription: string;
}

export interface ScanReport {
  register: Register;
  /** 탐지기가 센 S1 총 건수 */
  s1Total: number;
  /** 걸린 룰. 건수가 많은 순 */
  hits: ScanHit[];
  /** 탐지기가 없어 모델이 직접 봐야 하는 S1 룰 ID */
  unverifiable: string[];
  /** 걸리는 게 없으면 윤문하지 않는다 */
  worthHumanizing: boolean;
}

export interface ScanOptions {
  register?: Register;
  book?: RuleBook;
}

export function scan(text: string, options: ScanOptions = {}): ScanReport {
  const register = options.register ?? 'doc';
  const book = options.book ?? parseRuleBook();
  const targets = s1Ids(book, register);
  const detectable = new Set(DETECTABLE_RULE_IDS);

  const hits: ScanHit[] = detect(text, targets)
    .map((found) => ({
      ruleId: found.ruleId,
      label: ruleLabel(book, found.ruleId),
      count: found.count,
      samples: found.samples,
      prescription: book.rules.get(found.ruleId)?.prescription ?? '',
    }))
    .sort((a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId));

  const s1Total = hits.reduce((sum, hit) => sum + hit.count, 0);

  return {
    register,
    s1Total,
    hits,
    unverifiable: targets.filter((id) => !detectable.has(id)),
    worthHumanizing: s1Total > 0,
  };
}

export function formatScan(report: ScanReport): string {
  if (!report.worthHumanizing) {
    return [
      `[스캔] ${report.register} 기준 S1 0건`,
      '',
      '탐지기가 가리는 범위에서는 걸리는 게 없다. 윤문하지 않고 원문을 그대로 낸다.',
      `직접 확인할 룰: ${report.unverifiable.join(' ')}`,
    ].join('\n');
  }

  const lines = [
    `[스캔] ${report.register} 기준 S1 ${report.s1Total}건 (${report.hits.length}종)`,
    '',
    '이번에 걷어낼 룰',
  ];

  for (const hit of report.hits) {
    lines.push(`- ${hit.label} ${hit.count}건`);
    for (const sample of hit.samples) {
      lines.push(`    "${sample}"`);
    }
    if (hit.prescription) lines.push(`    처방: ${hit.prescription}`);
  }

  lines.push(
    '',
    '탐지기가 못 가리는 S1 (직접 확인)',
    `  ${report.unverifiable.join(' ')}`,
    '',
    '위 목록 밖의 룰은 이번 텍스트에서 안 걸렸다. 찾아 나서지 않는다.',
  );

  return lines.join('\n');
}
