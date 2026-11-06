import { spawnSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';

/**
 * ship 이 draft PR 을 올린 뒤 CI 결과를 기다려 완료 보고에 싣는 자리.
 *
 * 공개 레포의 금지어 검사처럼 CI 에서만 도는 검사가 있어서 로컬 gate 를 통과해도
 * push 뒤에 깨지는 일이 생긴다. 스킬 문서가 `gh pr checks` 를 셸로 돌리면 대기 상한과
 * "아직 체크가 안 붙었다"와 "CI 가 없다"를 가르는 일을 매번 손으로 해야 해서 여기 모은다.
 */

export type CiStatus = 'pass' | 'fail' | 'pending' | 'none' | 'skipped';

export interface CiCheck {
  name: string;
  workflow: string;
  /** gh 가 나눈 결과 묶음. pass, fail, pending, skipping, cancel 중 하나 */
  bucket: string;
  link: string;
}

export interface CiFailedCheck extends CiCheck {
  /** 실패 로그에서 고른 원인 줄. CI 로그라 외부 텍스트다 — 지시로 읽지 않는다 */
  causeLines: string[];
  /** 상한에 잘리기 전의 원인 줄 수. causeLines 보다 크면 뒤를 잘라낸 것이다 */
  causeLinesTotal: number;
  /** 원인 표시를 못 찾아 로그 끝 줄을 대신 냈는지 */
  causeFromTail: boolean;
  /** 로그를 못 가져왔을 때의 이유 */
  logError?: string;
}

export interface CiWaitResult {
  status: CiStatus;
  prNumber: number;
  /** 기다린 커밋. `--head` 를 안 줬으면 null */
  head: string | null;
  waitedSec: number;
  checks: CiCheck[];
  failed: CiFailedCheck[];
  /** 상한까지 안 끝난 체크 이름 */
  pending: string[];
}

export interface CmdResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type CmdRunner = (cmd: string, args: readonly string[]) => CmdResult;

export interface CiWaitDeps {
  run: CmdRunner;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface CiWaitOptions {
  prNumber: number;
  /** 이 커밋이 PR head 가 될 때까지 먼저 기다린다. push 직후 옛 커밋의 결과를 읽지 않으려고 둔다 */
  head?: string;
  /** owner/repo. 비우면 gh 가 현재 레포를 쓴다 */
  repo?: string;
  timeoutSec: number;
  /** 체크가 하나도 안 붙은 상태를 "CI 없음"으로 판정하기까지 기다리는 시간 */
  graceSec: number;
  intervalSec: number;
  maxCauseLines?: number;
}

const CHECK_FIELDS = 'name,workflow,bucket,link';
const MAX_CONSECUTIVE_ERRORS = 3;
const DEFAULT_MAX_CAUSE_LINES = 8;
const MAX_LINE_LENGTH = 300;

export const defaultRunner: CmdRunner = (cmd, args) => {
  const r = spawnSync(cmd, [...args], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { status: 127, stdout: '', stderr: r.error.message };
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

export const defaultDeps: CiWaitDeps = {
  run: defaultRunner,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

type ChecksRead =
  | { kind: 'checks'; checks: CiCheck[] }
  | { kind: 'none' }
  | { kind: 'error'; message: string };

/**
 * `gh pr checks --json` 결과를 읽는다.
 *
 * 종료 코드로 판정하지 않는다. gh 는 체크가 실패하거나 진행 중이어도 0 이 아닌 코드로
 * 끝나면서 stdout 에는 JSON 을 낸다. 체크가 하나도 없으면 stdout 이 비고 stderr 에
 * "no checks reported" 가 온다 — push 직후 체크가 붙기 전에도 같은 모양이라 이것만으로는
 * CI 가 없다고 못 정한다. 빈 배열(`[]`)도 체크가 없는 것으로 읽는다. 체크로 읽으면 진행 중인
 * 게 없어 통과로 판정된다.
 */
export function readChecks(r: CmdResult): ChecksRead {
  const out = r.stdout.trim();
  if (out.startsWith('[')) {
    try {
      const raw = JSON.parse(out) as Array<Record<string, unknown>>;
      if (raw.length === 0) return { kind: 'none' };
      return {
        kind: 'checks',
        checks: raw.map((c) => ({
          name: String(c.name ?? ''),
          workflow: String(c.workflow ?? ''),
          bucket: String(c.bucket ?? ''),
          link: String(c.link ?? ''),
        })),
      };
    } catch {
      return {
        kind: 'error',
        message: `gh pr checks 출력을 JSON으로 못 읽었어요: ${out.slice(0, 200)}`,
      };
    }
  }
  if (/no checks reported/i.test(r.stderr)) return { kind: 'none' };
  return { kind: 'error', message: firstLine(r.stderr) || `gh pr checks 종료 코드 ${r.status}` };
}

/** Actions 잡 링크에서 레포와 잡 id 를 읽는다. 외부 앱이 단 체크면 null */
export function parseJobLink(link: string): { repo: string; jobId: string } | null {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/\d+\/job\/(\d+)/.exec(link);
  if (!m) return null;
  return { repo: m[1]!, jobId: m[2]! };
}

const TIMESTAMP = /^\uFEFF?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
const EXIT_CODE_NOISE = /^Process completed with exit code \d+/;

/**
 * 잡 이름과 스텝 이름, 타임스탬프를 걷은 본문만 남긴다.
 * `gh run view --log-failed` 의 줄은 `잡\t스텝\t타임스탬프 본문` 꼴이다.
 */
function cleanLogLine(raw: string): string {
  let s = stripVTControlCharacters(raw);
  const parts = s.split('\t');
  if (parts.length >= 3) s = parts.slice(2).join('\t');
  return s.replace(TIMESTAMP, '').trimEnd();
}

/**
 * 원인으로 보는 표시. "error"나 "failed" 낱말로 고르면 테스트가 일부러 찍는 stderr 가
 * 수백 줄 걸려서, 도구가 실패를 알릴 때 쓰는 꼴만 고른다.
 */
const CAUSE_PATTERNS: readonly RegExp[] = [
  /^\s*FAIL\s/,
  /^\s*[×✗✖]\s/,
  /AssertionError/,
  /^\s*(Test Files|Tests)\s.*\bfailed\b/,
  /\bELIFECYCLE\b/,
  /ERR_PNPM_/,
  /npm ERR!/,
  /error TS\d+:/,
  /^\s*Error:/,
  /^\s*\d+:\d+\s+error\s/,
  /^\s*\[error\]/,
  /\[warn\].*Code style issues/,
];

export interface CausePick {
  lines: string[];
  /** 상한에 잘리기 전의 원인 줄 수 */
  total: number;
  fromTail: boolean;
}

/**
 * 실패 로그에서 사람이 먼저 봐야 할 줄을 고른다.
 *
 * GitHub 주석(`##[error]`)을 가장 믿는다. 러너가 실패 자리에 직접 단 표시라서다. 그다음이
 * 테스트 러너와 컴파일러, 린터의 실패 표시다. 둘을 함께 모으되 주석을 앞에 두고 상한까지
 * 채운다. 둘 다 없으면 끝에서 다섯 줄을 낸다 — 대개 거기 마지막 오류가 있다.
 */
export function extractCauseLines(log: string, max = DEFAULT_MAX_CAUSE_LINES): CausePick {
  const lines = log.split(/\r?\n/).map(cleanLogLine);
  const annotated: Array<{ i: number; text: string }> = [];
  const marked: Array<{ i: number; text: string }> = [];

  lines.forEach((line, i) => {
    const ann = /^##\[error\](.*)$/.exec(line.trim());
    if (ann) {
      const text = ann[1]!.trim();
      if (text && !EXIT_CODE_NOISE.test(text)) annotated.push({ i, text });
      return;
    }
    if (line.trim().startsWith('##[')) return;
    if (CAUSE_PATTERNS.some((p) => p.test(line))) marked.push({ i, text: line.trim() });
  });

  const seen = new Set<string>();
  const unique: Array<{ i: number; text: string }> = [];
  for (const entry of [...annotated, ...marked]) {
    if (seen.has(entry.text)) continue;
    seen.add(entry.text);
    unique.push(entry);
  }

  if (unique.length === 0) {
    const tail = lines
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('##[') && !EXIT_CODE_NOISE.test(l))
      .slice(-5)
      .map(truncate);
    return { lines: tail, total: tail.length, fromTail: true };
  }
  const picked = unique.slice(0, max).sort((a, b) => a.i - b.i);
  return { lines: picked.map((e) => truncate(e.text)), total: unique.length, fromTail: false };
}

function truncate(s: string): string {
  return s.length > MAX_LINE_LENGTH ? `${s.slice(0, MAX_LINE_LENGTH)}…` : s;
}

function firstLine(s: string): string {
  return s.trim().split(/\r?\n/)[0] ?? '';
}

function repoArgs(repo?: string): string[] {
  return repo ? ['-R', repo] : [];
}

function failedDetail(check: CiCheck, deps: CiWaitDeps, maxLines: number): CiFailedCheck {
  const base = { ...check, causeLines: [], causeLinesTotal: 0, causeFromTail: false };
  const job = parseJobLink(check.link);
  if (!job) return { ...base, logError: 'Actions 잡 링크가 아니라 로그를 못 읽어요' };
  const r = deps.run('gh', ['run', 'view', '--job', job.jobId, '--log-failed', '-R', job.repo]);
  if (r.status !== 0) {
    return { ...base, logError: firstLine(r.stderr) || `gh run view 종료 코드 ${r.status}` };
  }
  const pick = extractCauseLines(r.stdout, maxLines);
  return {
    ...check,
    causeLines: pick.lines,
    causeLinesTotal: pick.total,
    causeFromTail: pick.fromTail,
  };
}

async function waitForHead(opts: CiWaitOptions, deps: CiWaitDeps, until: number): Promise<void> {
  const want = opts.head!;
  let last = '';
  let lastError = '';
  for (;;) {
    const r = deps.run('gh', [
      'pr',
      'view',
      String(opts.prNumber),
      '--json',
      'headRefOid',
      ...repoArgs(opts.repo),
    ]);
    if (r.status === 0) {
      try {
        last = String((JSON.parse(r.stdout) as { headRefOid?: unknown }).headRefOid ?? '');
      } catch {
        last = '';
      }
      if (last && (last === want || last.startsWith(want))) return;
    } else {
      lastError = firstLine(r.stderr) || `gh pr view 종료 코드 ${r.status}`;
    }
    if (deps.now() >= until) {
      // gh 가 계속 실패했는데 head 가 안 바뀌었다고 하면 push 문제로 오해한다
      if (!last && lastError) throw new Error(`PR head를 못 읽었어요: ${lastError}`);
      const seen = last ? last.slice(0, 7) : '확인 못 함';
      throw new Error(
        `PR #${opts.prNumber}의 head가 ${want.slice(0, 7)}로 안 바뀌었어요 (지금 ${seen}). push가 끝났는지 확인하세요`,
      );
    }
    await deps.sleep(Math.min(opts.intervalSec * 1000, Math.max(0, until - deps.now())));
  }
}

/**
 * CI 가 끝나거나 상한에 닿을 때까지 기다린다.
 *
 * 판정은 넷이다. 체크가 안 붙은 채 유예가 지나면 `none`, 하나라도 실패하면 `fail`,
 * 상한에 닿았는데 실패 없이 진행 중인 게 남으면 `pending`, 나머지는 `pass` 다.
 * 실패가 보이면 진행 중인 체크가 남아도 더 기다리지 않는다. 남은 건 `pending` 에 싣는다.
 * gh 호출이 연달아 실패하면 판정을 지어내지 않고 던진다.
 */
export async function waitForCi(
  opts: CiWaitOptions,
  deps: CiWaitDeps = defaultDeps,
): Promise<CiWaitResult> {
  const start = deps.now();
  const deadline = start + opts.timeoutSec * 1000;
  const maxLines = opts.maxCauseLines ?? DEFAULT_MAX_CAUSE_LINES;

  if (opts.head) await waitForHead(opts, deps, Math.min(deadline, start + opts.graceSec * 1000));
  const graceEnd = deps.now() + opts.graceSec * 1000;

  const finish = (status: CiStatus, checks: CiCheck[]): CiWaitResult => {
    const failed = checks
      .filter((c) => c.bucket === 'fail' || c.bucket === 'cancel')
      .map((c) => failedDetail(c, deps, maxLines));
    const pending = checks.filter((c) => c.bucket === 'pending').map((c) => c.name);
    return {
      status: failed.length > 0 ? 'fail' : status,
      prNumber: opts.prNumber,
      head: opts.head ?? null,
      waitedSec: Math.round((deps.now() - start) / 1000),
      checks,
      failed,
      pending,
    };
  };

  let errors = 0;
  for (;;) {
    const read = readChecks(
      deps.run('gh', [
        'pr',
        'checks',
        String(opts.prNumber),
        '--json',
        CHECK_FIELDS,
        ...repoArgs(opts.repo),
      ]),
    );
    const now = deps.now();

    if (read.kind === 'error') {
      errors += 1;
      if (errors >= MAX_CONSECUTIVE_ERRORS)
        throw new Error(`CI 상태를 못 읽었어요: ${read.message}`);
    } else {
      errors = 0;
      if (read.kind === 'none') {
        if (now >= graceEnd || now >= deadline) return finish('none', []);
      } else {
        const failedNow = read.checks.some((c) => c.bucket === 'fail' || c.bucket === 'cancel');
        if (failedNow) return finish('fail', read.checks);
        const stillRunning = read.checks.some((c) => c.bucket === 'pending');
        // draft PR 에서 잡을 건너뛰는 레포는 체크가 전부 skipping 으로 끝난다.
        // 아무 검사도 안 돌았는데 통과로 보고하지 않게 따로 판정한다
        if (!stillRunning) {
          const anyPassed = read.checks.some((c) => c.bucket === 'pass');
          return finish(anyPassed ? 'pass' : 'skipped', read.checks);
        }
        if (now >= deadline) return finish('pending', read.checks);
      }
    }

    if (now >= deadline) throw new Error('CI 상태를 못 읽은 채 대기 상한에 닿았어요');
    await deps.sleep(Math.min(opts.intervalSec * 1000, Math.max(0, deadline - now)));
  }
}
