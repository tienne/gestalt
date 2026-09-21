/**
 * `--file` 를 여러 번 받는 배치 스캔의 존재 이유는 프로세스 기동 비용이다.
 *
 * 판정 자체는 밀리초 단위인데, `pnpm tsx` 로 한 번 스캔하는 데 2.1초, `node dist/`
 * 로도 1.1초가 걸린다. review 스킬이 코멘트마다 CLI 를 새로 띄우면 그 기동 비용을
 * 코멘트 수만큼 반복해서 문다. 이 테스트는 열 개 파일을 한 프로세스에서 스캔하는
 * 쪽이 열 개 프로세스를 따로 띄우는 쪽보다 빠르다는 것만 고정한다.
 *
 * detector-perf.test.ts 처럼 여러 번 재서 최솟값을 쓰는 대신 한 번만 잰다. 거기서는
 * 반복 한 번이 마이크로초 단위라 GC 잡음이 배수를 흔들었다. 여기서는 반복 한 번이
 * 프로세스 기동을 포함해 초 단위다. 순차 열 번을 세 번 돌리면 30초 넘게 걸려 전체
 * 테스트 스위트를 끈다. 배치와 순차의 격차가 열 배 가까이라 한 번만 재도 잡음에
 * 묻히지 않는다.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../../..');
const cliBin = join(repoRoot, 'dist/bin/gestalt.js');

const FILE_COUNT = 10;

/** 순차 열 번이 프로세스 기동만으로 10초 안팎이다. vitest 기본 5초로는 못 끝낸다 */
const TEST_TIMEOUT_MS = 30_000;

/**
 * CLI 는 "걸림"이면 0, "0건"이면 10으로 종료한다. 둘 다 정상 실행이다.
 * execFileSync 는 0이 아닌 종료 코드에서 던지므로, 여기서는 실행 성공 여부가 아니라
 * 걸린 시간만 필요해서 예외를 삼키고 시간만 취한다.
 */
function timeExec(args: string[]): number {
  const started = process.hrtime.bigint();
  try {
    execFileSync('node', [cliBin, 'humanize-scan', ...args], { stdio: 'ignore' });
  } catch {
    // 종료 코드는 무시한다. 측정 대상은 실행 시간이지 판정 결과가 아니다
  }
  return Number(process.hrtime.bigint() - started) / 1e6;
}

describe('humanize-scan 배치 성능', () => {
  it(
    '파일 열 개를 한 프로세스에서 스캔하는 쪽이 프로세스 열 개를 띄우는 쪽보다 빠르다',
    () => {
      const dir = join(repoRoot, '.gestalt-test', randomUUID());
      mkdirSync(dir, { recursive: true });

      try {
        const files: string[] = [];
        for (let i = 0; i < FILE_COUNT; i++) {
          const file = join(dir, `f${i}.md`);
          writeFileSync(file, `이 문제에 대해 검토했다. 결론적으로 캐시가 원인이다. 번호 ${i}.\n`);
          files.push(file);
        }

        const batchArgs = files.flatMap((file) => ['--file', file]);
        const batchMs = timeExec(batchArgs);

        let sequentialMs = 0;
        for (const file of files) {
          sequentialMs += timeExec(['--file', file]);
        }

        console.log(
          `[scan-batch-perf] batch=${batchMs.toFixed(1)}ms sequential=${sequentialMs.toFixed(1)}ms ratio=${(sequentialMs / batchMs).toFixed(2)}x`,
        );

        expect(batchMs).toBeLessThan(sequentialMs);
      } finally {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
