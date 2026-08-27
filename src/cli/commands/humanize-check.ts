import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  decide,
  formatReport,
  parseRegister,
  parseRuleBook,
  prescan,
  runCheck,
  EXIT_CODE,
} from '../../humanize/index.js';

export interface HumanizeCheckOptions {
  before: string;
  after: string;
  register?: string;
  json?: boolean;
  /** 몇 번째 윤문인지. 재시도를 소진하면 원문을 채택하라고 지시한다 */
  attempt?: string | number;
  /** 탐지기가 못 가리는 자리에서 고친 룰 ID. 쉼표로 잇는다 */
  fixed?: string;
}

function read(label: string, path: string): string {
  const full = resolve(process.cwd(), path);
  if (!existsSync(full)) {
    console.error(`${label} 파일이 없습니다: ${full}`);
    process.exit(EXIT_CODE.unknown);
  }
  return readFileSync(full, 'utf-8');
}

export function humanizeCheckCommand(options: HumanizeCheckOptions): void {
  const register = parseRegister(options.register);
  const before = read('원문', options.before);
  const after = read('윤문본', options.after);

  if (before.trim().length === 0) {
    console.error('원문이 비어 있어 판정할 수 없습니다.');
    process.exit(EXIT_CODE.unknown);
  }

  const attempt = Math.max(1, Number(options.attempt ?? 1) || 1);
  // 룰북은 한 번만 읽어 두 호출이 나눠 쓴다. 각자 부르면 같은 마크다운을 두 번 파싱한다.
  const book = parseRuleBook();
  // 세는 대상은 언제나 원문이다. CLI는 두 파일을 한꺼번에 받아 기준선이 갈릴 일이 없다.
  const baseline = prescan(before, { register, book });
  const unverifiableFixes = (options.fixed ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const report = runCheck(before, after, {
    register,
    book,
    prescanned: baseline.s1ByRule,
    evidence: { unverifiableFixes },
  });
  const decision = decide(report, attempt);

  if (options.json) {
    console.log(JSON.stringify({ ...report, attempt, decision }, null, 2));
  } else {
    console.log(formatReport(report, attempt));
  }

  process.exit(report.exitCode);
}
