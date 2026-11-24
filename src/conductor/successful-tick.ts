import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = 'successful-ticks.log';

/**
 * 보관이 끝난 뒤에도 다음 tick과 잠금을 다투지 않고 성공 근거를 남긴다.
 * 주문 로그를 접는 보관과 별개라 두 tick이 동시에 남긴 기록도 유지된다.
 */
export function recordSuccessfulTick(dir: string, at: string): void {
  appendFileSync(join(dir, FILE), `\n${at}\n`, { mode: 0o600, flush: true });
}

/** 보관에서 돌아온 순서와 tick 시각 순서가 다를 수 있어 가장 늦은 시각을 고른다. */
export function readLastSuccessfulTick(dir: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(dir, FILE), 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  lines.pop();
  let latest: string | null = null;
  for (const line of lines) {
    if (line.length !== 24 || (latest && line <= latest)) continue;
    const time = Date.parse(line);
    if (Number.isFinite(time) && new Date(time).toISOString() === line) latest = line;
  }
  return latest;
}
