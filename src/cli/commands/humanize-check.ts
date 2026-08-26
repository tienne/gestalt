import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decide, formatReport, prescan, runCheck, EXIT_CODE } from '../../humanize/index.js';
import type { Register } from '../../humanize/index.js';

export interface HumanizeCheckOptions {
  before: string;
  after: string;
  register?: string;
  json?: boolean;
  /** 몇 번째 윤문인지. 재시도를 소진하면 원문을 채택하라고 지시한다 */
  attempt?: string | number;
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
  const register: Register =
    options.register === 'chat' ? 'chat' : options.register === 'report' ? 'report' : 'doc';
  const before = read('원문', options.before);
  const after = read('윤문본', options.after);

  if (before.trim().length === 0) {
    console.error('원문이 비어 있어 판정할 수 없습니다.');
    process.exit(EXIT_CODE.unknown);
  }

  const attempt = Math.max(1, Number(options.attempt ?? 1) || 1);
  // 원문 S1 기준선은 윤문 전에 확정된 값이라야 제거율이 판정 근거가 된다.
  // CLI는 두 파일을 한꺼번에 받으니 여기서 센다. 세는 대상은 언제나 원문이다.
  const baseline = prescan(before, { register });
  const report = runCheck(before, after, { register, prescanned: baseline.s1ByRule });
  const decision = decide(report, attempt);

  if (options.json) {
    console.log(JSON.stringify({ ...report, attempt, decision }, null, 2));
  } else {
    console.log(formatReport(report, attempt));
  }

  process.exit(report.exitCode);
}
