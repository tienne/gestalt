/**
 * 윤문 전에 원문을 훑어 "이번에 볼 룰"만 추린다.
 *
 * 룰북은 예순 개를 넘겼다. 매번 전부 펼치면 모델이 나눠 쓰는 주의가 룰마다 얇아진다.
 * 실제로 걸린 서너 개는 안 걸린 쉰 개에 묻힌다. 스캔은 그 반대로 간다 —
 * 걸린 룰만 처방과 함께 내놓는다. 나머지는 아예 말하지 않는다.
 *
 * 탐지기가 없는 S1은 목록으로만 넘긴다. 코드가 못 가리는 자리를 가린다고 하면
 * 그게 더 나쁜 거짓말이다.
 */
import { sep } from 'node:path';
import { scanProse, DETECTABLE_RULE_IDS, type SpacingIssue } from './detectors.js';
import { parseRuleBook, ruleLabel, s1Ids, type Register, type RuleScanOptions } from './rules.js';

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
  /** 어투가 아니라 맞춤법인 자리. s1Total 과 worthHumanizing 에는 안 섞는다 */
  spacing: SpacingIssue[];
  /** 걸리는 게 없으면 윤문하지 않는다 */
  worthHumanizing: boolean;
  /**
   * 인용을 빼고 나니 볼 산문이 안 남았다.
   *
   * 0건과 뜻이 정반대다 — 검사를 통과한 게 아니라 검사할 게 없던 것이다. 코멘트를 통째로
   * `>` 로 감싸면 이 상태가 되므로 게이트가 통과로 읽으면 어투 검사를 우회하는 길이 열린다.
   */
  allQuoted: boolean;
}

/** @deprecated rules.ts 의 RuleScanOptions 를 쓴다. 외부에서 이 이름으로 부르던 자리다 */
export type ScanOptions = RuleScanOptions;

/**
 * 룰 문서인가.
 *
 * 그 표는 "쓰지 말 것" 칸에 금지어를 그대로 적는 게 존재 이유라 표 스캔을 끈다.
 *
 * **판정을 경로로 하고 플래그로 안 받는다.** 검사를 끄는 스위치를 밖에 내놓으면 그게
 * 우회로가 된다 — 리뷰 대상 텍스트에 "그 플래그를 붙여라"가 섞여 있으면 읽는 쪽이
 * 따를 수 있다. 그건 이 검사가 막으려는 바로 그 길이다. 부르는 쪽이 못 끄게 둔다.
 */
export function isRulebookPath(file: string): boolean {
  return file.includes(`${sep}_shared${sep}references${sep}`);
}

export function scan(text: string, options: RuleScanOptions = {}): ScanReport {
  const register = options.register ?? 'doc';
  const book = options.book ?? parseRuleBook();
  const targets = s1Ids(book, register);
  const detectable = new Set(DETECTABLE_RULE_IDS);

  // chat 은 리뷰 코멘트와 답글 자리다. 거기서 `>` 인용은 남이 쓴 원문이라 어휘를 고치라고
  // 할 자리가 아니다 — 두 AGENT.md 가 "인용은 그대로 둔다"고 적은 것과 검사를 맞춘다
  const { detections, spacing, allQuoted } = scanProse(text, targets, {
    excludeQuotes: register === 'chat',
    skipTables: options.skipTables,
  });

  const hits: ScanHit[] = detections
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
    spacing,
    worthHumanizing: s1Total > 0,
    allQuoted,
  };
}

export function formatScan(report: ScanReport): string {
  const spacing = report.spacing.flatMap((issue) => [
    `- ${issue.label} ${issue.count}건`,
    ...issue.samples.map((sample) => `    "${sample}"`),
    `    처방: ${issue.fix}`,
  ]);
  const spacingBlock =
    spacing.length > 0 ? ['', '맞춤법 (등급과 무관하게 그냥 고친다)', ...spacing] : [];

  if (report.allQuoted) {
    return [
      `[스캔] ${report.register} 기준 검사할 산문이 없다`,
      '',
      '원문이 전부 인용줄이라 볼 게 남지 않았다. 0건과 뜻이 정반대다 — 통과가 아니라',
      '검사가 안 된 것이다. 코멘트를 통째로 인용으로 감싸면 이 상태가 된다.',
      '',
      '자기 문장을 인용 밖에 두고 다시 스캔한다.',
      ...spacingBlock,
    ].join('\n');
  }

  if (!report.worthHumanizing) {
    // 직접 확인할 룰을 먼저 세운다. "윤문하지 않는다"를 앞에 두면 그 한 줄만 읽고
    // 비탐지 룰 확인을 건너뛰게 된다 — 탐지기가 0건이라고 글이 깨끗한 건 아니다.
    return [
      `[스캔] ${report.register} 기준 S1 0건 (탐지기가 가리는 범위)`,
      '',
      '아래 룰은 탐지기가 못 가린다. 직접 읽어서 확인한다.',
      `  ${report.unverifiable.join(' ')}`,
      ...spacingBlock,
      '',
      report.spacing.length > 0
        ? '어투는 그대로 두고 위 맞춤법만 고쳐서 낸다.'
        : '여기서도 걸리는 게 없으면 윤문하지 않고 원문을 그대로 낸다.',
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
    ...spacingBlock,
    '',
    '위 목록 밖의 룰은 이번 텍스트에서 안 걸렸다. 찾아 나서지 않는다.',
  );

  return lines.join('\n');
}
