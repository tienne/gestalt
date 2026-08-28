import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
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
} as const;

/** 스캔 대상 상한. 사람이 쓴 원고 한 벌은 이 근처에도 안 온다 */
const MAX_SCAN_BYTES = 2_000_000;

export function humanizeScanCommand(options: HumanizeScanOptions): void {
  const full = resolve(process.cwd(), options.file);

  // fd 를 잡고 그 위에서 검사와 읽기를 끝낸다. statSync 로 재고 readFileSync 로 다시 열면
  // 그 사이에 경로가 다른 대상을 가리킬 수 있어서 종류 검사도 상한도 실제로 읽은 것에
  // 안 걸린다. 크기를 0 으로 보고하는 특수 파일도 같은 자리에서 막힌다
  let text: string;
  let fd: number;
  try {
    fd = openSync(full, 'r');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 권한이나 링크 순환을 파일 부재로 뭉개면 다음 사람이 엉뚱한 데를 고친다
    console.error(
      code === 'ENOENT' ? `파일이 없습니다: ${full}` : `읽을 수 없습니다: ${full} (${code})`,
    );
    process.exit(EXIT_CODE.unknown);
  }

  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      console.error(`파일이 아닙니다: ${full}`);
      process.exit(EXIT_CODE.unknown);
    }
    if (stat.size > MAX_SCAN_BYTES) {
      console.error(`파일이 너무 큽니다: ${stat.size}B (상한 ${MAX_SCAN_BYTES}B)`);
      process.exit(EXIT_CODE.unknown);
    }
    const buffer = Buffer.allocUnsafe(stat.size);
    const read = readSync(fd, buffer, 0, stat.size, 0);
    text = buffer.subarray(0, read).toString('utf-8');
  } finally {
    closeSync(fd);
  }

  const report = scan(text, { register: parseRegister(options.register) });

  console.log(options.json ? JSON.stringify(report, null, 2) : formatScan(report));
  // 맞춤법만 걸린 원고를 clean 으로 닫으면 "윤문하지 않는다"로 읽혀 그대로 나간다.
  // 어투 0건과 맞춤법만 있는 상태는 다음 할 일이 달라서 코드를 가른다
  if (report.worthHumanizing) process.exit(SCAN_EXIT.found);
  process.exit(report.spacing.length > 0 ? SCAN_EXIT.spacingOnly : SCAN_EXIT.clean);
}
