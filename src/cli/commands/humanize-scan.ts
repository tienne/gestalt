import {
  EXIT_CODE,
  formatScan,
  isRulebookPath,
  parseRegister,
  scan,
} from '../../humanize/index.js';
import { isReadFailure, readInput } from '../../humanize/read-input.js';

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
 * scan 은 판정 도구가 아니라 자문 도구라 실패를 뜻하는 코드는 안 낸다. 걸림, 맞춤법만
 * 걸림, 아무것도 안 걸림 셋을 갈라 준다 — 뒤 둘은 다음에 할 일이 다르다.
 */
export const SCAN_EXIT = {
  /** 걸린 S1 이 있다. 윤문할 자리다 */
  found: 0,
  /** 탐지기가 가리는 범위에서는 0건이다. 비탐지 룰은 사람이 따로 본다 */
  clean: 10,
  /** 어투는 안 걸렸고 맞춤법만 걸렸다. 어투를 건드리지 말고 그것만 고치는 자리다 */
  spacingOnly: 11,
  /**
   * 인용을 빼고 나니 검사할 산문이 안 남았다.
   *
   * clean 과 갈라 둔다. 코멘트를 통째로 인용으로 감싸면 이 상태가 되는데, 그걸 10으로
   * 내면 게이트가 통과로 읽어 어투 검사를 우회하는 길이 열린다
   */
  allQuoted: 12,
} as const;

export function humanizeScanCommand(options: HumanizeScanOptions): void {
  const input = readInput(options.file);
  if (isReadFailure(input)) {
    console.error(input.message);
    process.exit(EXIT_CODE.unknown);
  }
  const text = input;

  // 표 스캔을 끌지는 경로로 정한다. 플래그로 받으면 검사를 끄는 스위치가 밖에 생겨
  // 리뷰 대상 텍스트가 그걸 붙이라고 시키는 자리가 열린다
  const report = scan(text, {
    register: parseRegister(options.register),
    skipTables: isRulebookPath(options.file),
  });

  console.log(options.json ? JSON.stringify(report, null, 2) : formatScan(report));
  // 맞춤법만 걸린 원고를 clean 으로 닫으면 "윤문하지 않는다"로 읽혀 그대로 나간다.
  // 어투 0건과 맞춤법만 있는 상태는 다음 할 일이 달라서 코드를 가른다
  if (report.worthHumanizing) process.exit(SCAN_EXIT.found);
  if (report.allQuoted) process.exit(SCAN_EXIT.allQuoted);
  process.exit(report.spacing.length > 0 ? SCAN_EXIT.spacingOnly : SCAN_EXIT.clean);
}
