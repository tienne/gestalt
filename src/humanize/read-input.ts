import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';

/** 스캔 대상 상한. 사람이 쓴 원고 한 벌은 이 근처에도 안 온다 */
export const MAX_INPUT_BYTES = 2_000_000;

export interface ReadInputFailure {
  /** 사람에게 보일 한 줄 */
  message: string;
}

/**
 * 검사 대상 파일을 fd 하나로 열어 종류와 크기를 확인하고 읽는다.
 *
 * statSync 로 재고 readFileSync 로 다시 열면 그 사이에 경로가 다른 대상을 가리킬 수 있어서
 * 종류 검사도 상한도 실제로 읽은 것에 안 걸린다. 크기를 0 으로 보고하는 특수 파일도 같은
 * 자리에서 막힌다.
 *
 * humanize-scan 과 humanize-check 가 같은 탐지기를 돌리므로 읽는 경계도 같아야 한다.
 * 한쪽만 막으면 다른 쪽으로 상한을 우회해 같은 정규식에 임의 크기를 먹일 수 있다.
 *
 * 실패는 던지지 않고 돌려준다 — 종료 코드는 부르는 명령이 정한다.
 */
export function readInput(path: string, label = ''): string | ReadInputFailure {
  const full = resolve(process.cwd(), path);
  const prefix = label ? `${label} ` : '';

  let fd: number;
  try {
    fd = openSync(full, 'r');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 권한이나 링크 순환을 파일 부재로 뭉개면 다음 사람이 엉뚱한 데를 고친다
    return {
      message:
        code === 'ENOENT'
          ? `${prefix}파일이 없습니다: ${full}`
          : `${prefix}읽을 수 없습니다: ${full} (${code})`,
    };
  }

  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { message: `${prefix}파일이 아닙니다: ${full}` };
    if (stat.size > MAX_INPUT_BYTES) {
      return { message: `${prefix}파일이 너무 큽니다: ${stat.size}B (상한 ${MAX_INPUT_BYTES}B)` };
    }
    const buffer = Buffer.allocUnsafe(stat.size);
    const read = readSync(fd, buffer, 0, stat.size, 0);
    return buffer.subarray(0, read).toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

export function isReadFailure(result: string | ReadInputFailure): result is ReadInputFailure {
  return typeof result !== 'string';
}
