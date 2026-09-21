import {
  EXIT_CODE,
  formatScan,
  formatScanBatch,
  isRulebookPath,
  parseRegister,
  scan,
  type ScanReport,
} from '../../humanize/index.js';
import { isReadFailure, readInput } from '../../humanize/read-input.js';

export interface HumanizeScanOptions {
  file: string | string[];
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

/** 파일 한 건의 스캔 결과. 읽기 실패면 report 가 없고 error 에 메시지가 담긴다 */
export interface FileScanResult {
  file: string;
  report: ScanReport | null;
  exitCode: number;
  error?: string;
}

/**
 * 파일 하나를 독립적으로 읽고 스캔한다.
 *
 * 여러 파일을 이어붙이면 인용 판정(allQuoted)이 파일 경계를 넘어 섞인다 — 한 파일이
 * 통째로 인용이고 다른 파일이 산문이어도 합치면 "볼 산문이 있다"로 읽힌다. 그래서
 * 파일마다 readInput 과 scan 을 따로 돌린다.
 */
function scanOneFile(file: string, register?: string): FileScanResult {
  const input = readInput(file);
  if (isReadFailure(input)) {
    return { file, report: null, exitCode: EXIT_CODE.unknown, error: input.message };
  }

  // 표 스캔을 끌지는 경로로 정한다. 플래그로 받으면 검사를 끄는 스위치가 밖에 생겨
  // 리뷰 대상 텍스트가 그걸 붙이라고 시키는 자리가 열린다
  const report = scan(input, {
    register: parseRegister(register),
    skipTables: isRulebookPath(file),
  });

  // 맞춤법만 걸린 원고를 clean 으로 닫으면 "윤문하지 않는다"로 읽혀 그대로 나간다.
  // 어투 0건과 맞춤법만 있는 상태는 다음 할 일이 달라서 코드를 가른다
  const exitCode = report.worthHumanizing
    ? SCAN_EXIT.found
    : report.allQuoted
      ? SCAN_EXIT.allQuoted
      : report.spacing.length > 0
        ? SCAN_EXIT.spacingOnly
        : SCAN_EXIT.clean;

  return { file, report, exitCode };
}

/** 파일 목록을 각각 독립적으로 스캔한다. task-1 의 배치 포맷터가 이 배열을 그대로 받는다 */
export function scanFiles(files: string[], register?: string): FileScanResult[] {
  return files.map((file) => scanOneFile(file, register));
}

/**
 * 파일별 종료 코드를 하나로 합친다.
 *
 * 우선순위는 단일 파일 판정과 같은 순서다 — found > allQuoted > spacingOnly > clean.
 * 여러 파일 중 하나라도 걸리면 배치 전체를 "윤문할 자리가 있다"로 본다.
 */
function aggregateExitCode(codes: number[]): number {
  if (codes.includes(SCAN_EXIT.found)) return SCAN_EXIT.found;
  if (codes.includes(SCAN_EXIT.allQuoted)) return SCAN_EXIT.allQuoted;
  if (codes.includes(SCAN_EXIT.spacingOnly)) return SCAN_EXIT.spacingOnly;
  return SCAN_EXIT.clean;
}

export function humanizeScanCommand(options: HumanizeScanOptions): void {
  const files = Array.isArray(options.file) ? options.file : [options.file];

  // 단일 파일은 오늘의 출력과 종료 코드가 바이트 단위로 같아야 한다 — 배치 경로를
  // 태우면 미묘하게 갈릴 여지가 생겨 이 분기를 그대로 남긴다
  if (files.length === 1) {
    const result = scanOneFile(files[0]!, options.register);
    if (result.error) {
      console.error(result.error);
      process.exit(EXIT_CODE.unknown);
    }
    console.log(options.json ? JSON.stringify(result.report, null, 2) : formatScan(result.report!));
    process.exit(result.exitCode);
  }

  const results = scanFiles(files, options.register);
  const exitCode = aggregateExitCode(results.map((result) => result.exitCode));

  if (options.json) {
    const payload = {
      files: results.map(({ file, exitCode: fileExitCode, report }) => ({
        file,
        exitCode: fileExitCode,
        report,
      })),
      exitCode,
    };
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(formatScanBatch(results));
  }

  process.exit(exitCode);
}
