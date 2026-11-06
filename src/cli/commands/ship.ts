import {
  assertDir,
  BRANCH_NAME_RE,
  checkCheckpoint,
  defaultObserveDeps,
  isShipPhase,
  LOCAL_PR_ID_RE,
  PR_URL_RE,
  saveCheckpoint,
  type CheckpointPatch,
  type StopKind,
} from '../../ship/checkpoint.js';
import { waitForCi, type CiWaitResult } from '../../ship/ci.js';

/**
 * `gestalt ship` — ship 스킬이 셸로 하던 대기와 상태 기록을 맡는 명령.
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
  try {
    const result = await waitForCi({
      prNumber: positiveInt(opts.pr, '--pr'),
      head: matching(opts.head, /^[0-9a-f]{7,64}$/i, '--head'),
      repo: matching(
        opts.repo,
        // host 와 owner 는 영숫자로 시작하고 repo 는 `.github` 처럼 `.` 으로 시작해도 받는다
        /^(?:[A-Za-z0-9][\w.-]*\/)?[A-Za-z0-9][\w.-]*\/(?!\.\.?$)[\w.][\w.-]*$/,
        '--repo',
      ),
      timeoutSec: positiveInt(opts.timeout ?? '900', '--timeout'),
      graceSec: positiveInt(opts.grace ?? '120', '--grace'),
      intervalSec: positiveInt(opts.interval ?? '30', '--interval'),
    });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    printCi(result);
  } catch (e) {
    exitWithError(e);
  }
}

export interface ShipCheckpointSaveOptions {
  dir?: string;
  phase: string;
  next: string;
  round?: string;
  localPr?: string;
  pr?: string;
  prUrl?: string;
  base?: string;
  verifyCmd?: string;
  issues?: string;
  stopped?: string;
}

export function shipCheckpointSaveCommand(opts: ShipCheckpointSaveOptions): void {
  run(() => {
    const dir = assertDir(opts.dir);
    if (!isShipPhase(opts.phase)) throw new Error(`--phase 를 모르겠어요: ${opts.phase}`);
    if (!opts.next.trim()) throw new Error('--next 가 비었어요');
    const patch: CheckpointPatch = { phase: opts.phase, next: opts.next.trim() };
    if (opts.round !== undefined) patch.round = nonNegativeInt(opts.round, '--round');
    if (opts.issues !== undefined) patch.issues = nonNegativeInt(opts.issues, '--issues');
    if (opts.pr !== undefined) patch.prNumber = positiveInt(opts.pr, '--pr');
    const localPr = matching(opts.localPr, LOCAL_PR_ID_RE, '--local-pr');
    if (localPr) patch.localPrId = localPr;
    const prUrl = matching(opts.prUrl, PR_URL_RE, '--pr-url');
    if (prUrl) patch.prUrl = prUrl;
    const base = matching(opts.base, BRANCH_NAME_RE, '--base');
    if (base) patch.base = base;
    if (opts.verifyCmd) patch.verifyCmd = opts.verifyCmd;
    if (opts.stopped !== undefined) patch.stopped = stopKind(opts.stopped);
    saveCheckpoint(dir, patch);
    console.log(`${dir}/checkpoint.json`);
  });
}

export function shipCheckpointCheckCommand(opts: { dir?: string; json?: boolean }): void {
  run(() => {
    const report = checkCheckpoint(assertDir(opts.dir), defaultObserveDeps());
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (report.status === 'none') {
      console.log('체크포인트 없음');
      return;
    }
    const cp = report.checkpoint;
    if (cp)
      console.log(
        `체크포인트: ${cp.phase}단계${cp.round !== null ? ` ${cp.round}라운드` : ''} — 다음: ${cp.next}`,
      );
    if (report.status === 'match') {
      console.log('git과 PR 상태가 체크포인트와 맞아요');
      return;
    }
    for (const m of report.mismatches) console.log(`- ${m.detail}`);
  });
}

function printCi(r: CiWaitResult): void {
  const mins = Math.round(r.waitedSec / 60);
  const label =
    r.status === 'pass'
      ? '통과'
      : r.status === 'none'
        ? 'CI 없음'
        : r.status === 'skipped'
          ? `전부 건너뜀 (${r.checks.length}개)`
          : r.status === 'pending'
            ? `진행 중 (${r.pending.length}개 안 끝남)`
            : `실패 ${r.failed.length}개`;
  console.log(`CI: ${label} — ${mins}분 기다림`);
  for (const f of r.failed) {
    console.log(`- ${f.name} ${f.link}`);
    if (f.logError) console.log(`    (로그 못 읽음: ${f.logError})`);
    if (f.causeFromTail) console.log('    (원인 표시를 못 찾아 로그 끝 줄을 대신 보여요)');
    for (const line of f.causeLines) console.log(`    ${line}`);
    const rest = f.causeLinesTotal - f.causeLines.length;
    if (rest > 0) console.log(`    … 외 ${rest}줄`);
  }
}

function positiveInt(v: string, flag: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} 는 양의 정수여야 해요: ${v}`);
  return n;
}

function nonNegativeInt(v: string, flag: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} 는 0 이상의 정수여야 해요: ${v}`);
  return n;
}

/** gh, git, gestalt pr 인자로 넘기는 값이라 `-` 로 시작하는 값이 옵션으로 읽히지 않게 형식을 본다 */
function matching(v: string | undefined, re: RegExp, flag: string): string | undefined {
  if (!v) return undefined;
  if (!re.test(v)) throw new Error(`${flag} 값이 형식에 안 맞아요: ${v}`);
  return v;
}

function stopKind(v: string): StopKind {
  if (v === 'blocked' || v === 'escalated') return v;
  throw new Error(`--stopped 는 blocked, escalated 중 하나예요: ${v}`);
}

function run(body: () => void): void {
  try {
    body();
  } catch (e) {
    exitWithError(e);
  }
}

function exitWithError(e: unknown): never {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
