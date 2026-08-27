import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXIT_CODE, formatScan, parseRegister, scan } from '../../humanize/index.js';

export interface HumanizeScanOptions {
  file: string;
  register?: string;
  json?: boolean;
}

/**
 * 스캔 결과의 종료 코드.
 *
 * humanize-check 는 판정을 exit code 로 답하는데 scan 만 늘 0 이면 같은 CLI 안에서
 * 계약이 갈린다. AGENT.md 0단계가 "S1 0건이면 윤문하지 않는다"를 분기로 세워 뒀는데
 * 그걸 기계가 읽으려면 stdout 을 파싱해야 했다.
 *
 * scan 은 판정 도구가 아니라 자문 도구라 실패를 뜻하는 코드는 안 낸다. 걸린 게
 * 있나 없나만 갈라 준다.
 */
export const SCAN_EXIT = {
  /** 걸린 S1 이 있다. 윤문할 자리다 */
  found: 0,
  /** 탐지기가 가리는 범위에서는 0건이다. 비탐지 룰은 사람이 따로 본다 */
  clean: 10,
} as const;

export function humanizeScanCommand(options: HumanizeScanOptions): void {
  const full = resolve(process.cwd(), options.file);
  if (!existsSync(full)) {
    console.error(`파일이 없습니다: ${full}`);
    process.exit(EXIT_CODE.unknown);
  }

  const report = scan(readFileSync(full, 'utf-8'), { register: parseRegister(options.register) });

  console.log(options.json ? JSON.stringify(report, null, 2) : formatScan(report));
  process.exit(report.worthHumanizing ? SCAN_EXIT.found : SCAN_EXIT.clean);
}
