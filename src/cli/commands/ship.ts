import { waitForCi, type CiWaitResult } from '../../ship/ci.js';

/**
 * `gestalt ship` — ship 스킬이 셸로 하던 대기를 맡는 명령.
 *
 * 실패하면 stderr 에 이유를 쓰고 1 로 끝나며 stdout 은 비운다. 스킬이 JSON 을 파일로
 * 받아 읽는데, 반쯤 쓴 출력이 남으면 판정을 지어낸 것과 같아진다.
 */

export interface ShipCiWaitOptions {
  pr: string;
  head?: string;
  repo?: string;
  timeout?: string;
  grace?: string;
  interval?: string;
  json?: boolean;
}

export async function shipCiWaitCommand(opts: ShipCiWaitOptions): Promise<void> {
  await runAsync(async () => {
    const result = await waitForCi({
      prNumber: positiveInt(opts.pr, '--pr'),
      head: opts.head || undefined,
      repo: opts.repo || undefined,
      timeoutSec: positiveInt(opts.timeout ?? '900', '--timeout'),
      graceSec: positiveInt(opts.grace ?? '120', '--grace'),
      intervalSec: positiveInt(opts.interval ?? '30', '--interval'),
    });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    printCi(result);
  });
}

function printCi(r: CiWaitResult): void {
  const mins = Math.round(r.waitedSec / 60);
  const label =
    r.status === 'pass'
      ? '통과'
      : r.status === 'none'
        ? 'CI 없음'
        : r.status === 'pending'
          ? `진행 중 (${r.pending.length}개 안 끝남)`
          : `실패 ${r.failed.length}개`;
  console.log(`CI: ${label} — ${mins}분 기다림`);
  for (const f of r.failed) {
    console.log(`- ${f.name} ${f.link}`);
    if (f.logError) console.log(`    (로그 못 읽음: ${f.logError})`);
    for (const line of f.causeLines) console.log(`    ${line}`);
  }
}

function positiveInt(v: string, flag: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} 는 양의 정수여야 해요: ${v}`);
  return n;
}

async function runAsync(body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
