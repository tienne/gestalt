import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { TickReport } from './engine.js';
import { withFileLock } from '../core/file-lock.js';
import { writeJsonAtomic } from '../core/json-file.js';
import { handoffCloseLine, type HandoffCloseResult } from './handoff-close.js';
import type { HandoffStatus } from './handoff.js';

/**
 * `gestalt conductor wait`의 본체.
 *
 * 지휘자 세션이 반복으로 깨어날 때마다 스킬 본문과 tick 결과가 대화에 쌓인다. 할 일 없는 주기에도 같다.
 * wait는 백그라운드에서 tick을 감시 간격마다 돌리다가 호스트가 판단해야 할 일이 생긴 tick에서만 끝난다.
 * 할 일 없는 tick은 아무것도 출력하지 않으니 대화에 아무것도 안 쌓인다.
 * 상한 시간이 지나면 할 일이 없어도 한 번 끝나 세션이 살아 있는지 확인할 기회를 준다.
 */

export interface WaitTickOutcome {
  report: TickReport;
  handoff?: HandoffStatus;
  handoffClose: HandoffCloseResult[];
  carriedHandoffs?: HandoffStatus[];
}

export type WaitEndReason = 'attention' | 'timeout' | 'superseded';

export interface WaitResult {
  reason: WaitEndReason;
  /** attention이면 어떤 이유로 끝났는지 */
  reasons: string[];
  ticks: number;
  elapsedMs: number;
  /** 마지막으로 돈 tick. attention이면 끝나게 한 tick이다 */
  last?: WaitTickOutcome;
  /**
   * 건너뛰지 않은 tick에 실린 경고와 오류, 이전 탭을 닫은 결과를 적은 문장. 본 목록에서 이미 풀린 문장을 빼는 데 쓴다.
   * 건너뛰지 않은 tick이 하나도 없으면 비워 둔다
   */
  observed?: string[];
}

export interface WaitLoopDeps {
  runTick: () => Promise<WaitTickOutcome>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** 다른 wait가 이어받았으면 false. 표식을 뺏긴 쪽은 tick을 더 돌리지 않고 끝난다 */
  stillOwner: () => boolean;
  hasCarry?: () => boolean;
  /** 앞서 wait가 이미 호스트에 보여 준 경고와 오류, 닫기 결과. 같은 문장만으로는 다시 끝나지 않는다 */
  seen?: ReadonlySet<string>;
  /**
   * wait를 띄울 때 열려 있던 확인 자리 수. 지라, 큐, PR 감시가 접수하다 연 게이트는 escalated에 안 실려서
   * 열린 수가 늘었는지로 알아본다
   */
  openGatesBefore?: number;
}

export interface WaitLoopOptions {
  maxWaitMs: number;
  intervalMs: number;
}

/** tick이 간격보다 오래 걸려도 이만큼은 쉰다. gh 호출이 쉬지 않고 이어지지 않게 한다 */
const MIN_SLEEP_MS = 10_000;

/**
 * 이 tick이 호스트를 깨워야 하는 이유. 비어 있으면 조용히 넘긴다.
 * rateLimited는 풀릴 때까지 tick마다 실리고 오래가면 tick이 게이트로 올리므로 이유로 안 친다.
 * 건너뛴 tick의 오류는 잠금에 막혔다는 말뿐이라 보지 않는다.
 */
export function attentionReasons(
  o: WaitTickOutcome,
  seen: ReadonlySet<string> = new Set(),
  openGatesBefore?: number,
): string[] {
  const r = o.report;
  const reasons: string[] = [];
  if (!r.skipped) {
    if (r.hostActions.length > 0) reasons.push('hostActions');
    if (r.escalated.length > 0) reasons.push('escalated');
    else if (openGatesBefore !== undefined && r.counts.openGates > openGatesBefore)
      reasons.push('gatesOpened');
    if (r.humanOwned.length > 0) reasons.push('humanOwned');
    if (r.errors.some((e) => !seen.has(e))) reasons.push('errors');
    if (r.warnings.some((w) => !seen.has(w))) reasons.push('warnings');
  }
  if (o.handoff?.due) reasons.push('handoff');
  // 닫기 실패는 풀릴 때까지 tick마다 다시 실린다. 오류처럼 이미 보여 준 문장이면 이유로 안 친다
  if (o.handoffClose.some((c) => !seen.has(handoffCloseLine(c)))) reasons.push('handoffClose');
  return reasons;
}

/** 호스트에 보여 줄 문장. 본 목록에 남기는 단위와 같다 */
export function shownLines(o: WaitTickOutcome): string[] {
  const own = o.report.skipped ? [] : [...o.report.errors, ...o.report.warnings];
  return [...own, ...o.handoffClose.map(handoffCloseLine)];
}

export async function waitForAttention(
  deps: WaitLoopDeps,
  opts: WaitLoopOptions,
): Promise<WaitResult> {
  const start = deps.now();
  let ticks = 0;
  let last: WaitTickOutcome | undefined;
  let openGates = deps.openGatesBefore;
  let observed: Set<string> | undefined;
  const result = (reason: WaitEndReason, reasons: string[] = []): WaitResult => ({
    reason,
    reasons,
    ticks,
    elapsedMs: deps.now() - start,
    ...(last ? { last } : {}),
    ...(observed ? { observed: [...observed] } : {}),
  });
  const floorMs = Math.min(MIN_SLEEP_MS, opts.intervalMs);
  for (;;) {
    if (!deps.stillOwner()) return result('superseded');
    if (deps.hasCarry?.()) return result('attention');
    const tickStart = deps.now();
    last = await deps.runTick();
    ticks++;
    const reasons = attentionReasons(last, deps.seen, openGates);
    if (!deps.stillOwner()) return result('superseded', reasons);
    const tickMs = deps.now() - tickStart;
    if (!last.report.skipped) {
      observed ??= new Set();
      for (const line of shownLines(last)) observed.add(line);
    }
    if (reasons.length > 0 || deps.hasCarry?.()) return result('attention', reasons);
    if (!last.report.skipped) openGates = last.report.counts.openGates;
    const left = opts.maxWaitMs - (deps.now() - start);
    if (left <= 0) return result('timeout');
    // 간격은 tick이 시작한 때부터 잰다. 소요 시간을 안 빼면 tick이 느린 만큼 주기가 늘어난다
    await deps.sleep(Math.min(Math.max(opts.intervalMs - tickMs, floorMs), left));
  }
}

const OWNER_FILE = 'wait.owner';
const CARRY_DIR = 'wait-carry';
const SEEN_FILE = 'wait-seen.json';
const SEEN_MAX = 200;
export const WAIT_REPORT_FILE = 'wait-last.json';

/**
 * 새 wait가 뜨면 소유 표식을 덮어쓴다. 앞서 뜬 wait(컴팩트 뒤 중복으로 띄웠거나 닫힌 세션에 남은 것)는
 * tick 앞뒤에서 표식이 바뀐 걸 보고 끝난다. 프로세스를 죽이지 않고 가장 나중에 뜬 쪽이 이어 간다.
 * 닫힌 세션에 남은 wait가 tick을 계속 돌리면 hostActions를 아무도 못 받기 때문이다.
 */
export function claimWaitOwner(
  stateDir: string,
  sessionId?: string,
): { stillOwner: () => boolean } {
  const path = join(stateDir, OWNER_FILE);
  const owner = { token: randomUUID(), sessionId: sessionId ?? null };
  const expected = JSON.stringify(owner);
  withWaitOwnerLock(stateDir, () => writeJsonAtomic(path, owner, { mode: 0o600, indent: 0 }));
  const read = () => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  };
  // 끝날 때 표식을 지우지 않는다. 확인하고 지우는 사이에 새 wait가 쓴 표식을 지울 수 있어서다. 남은 표식은 다음 wait가 덮어쓴다
  return { stillOwner: () => read() === expected };
}

export function withWaitOwnerLock<T>(stateDir: string, fn: () => T): T {
  return withFileLock(join(stateDir, `${OWNER_FILE}.lock`), fn);
}

interface WaitCarry {
  reasons: string[];
  outcome: WaitTickOutcome;
}

function carryFiles(stateDir: string): string[] {
  const dir = join(stateDir, CARRY_DIR);
  try {
    return readdirSync(dir)
      .filter((name) => /^\d{16}-[a-f0-9-]+\.json$/.test(name))
      .sort()
      .map((name) => join(dir, name));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

export function hasWaitCarry(stateDir: string): boolean {
  return carryFiles(stateDir).length > 0;
}

export function saveWaitCarry(
  stateDir: string,
  outcome: WaitTickOutcome,
  reasons: string[],
  seen: ReadonlySet<string>,
): void {
  if (reasons.length === 0) return;
  const prefix = String(Date.parse(outcome.report.at)).padStart(16, '0');
  const path = join(stateDir, CARRY_DIR, `${prefix}-${randomUUID()}.json`);
  const { report } = outcome;
  const fresh = {
    ...report,
    errors: report.errors.filter((line) => !seen.has(line)),
    warnings: report.warnings.filter((line) => !seen.has(line)),
  };
  writeJsonAtomic(path, { reasons, outcome: { ...outcome, report: fresh } } satisfies WaitCarry, {
    mode: 0o600,
    indent: 0,
  });
}

/** 결과를 쓰다 실패하면 다음 wait가 원래 순서대로 다시 가져갈 수 있게 돌려놓는다. */
export function consumeWaitCarry(stateDir: string, deliver: (carried: WaitCarry[]) => void): void {
  const claimed: { from: string; to: string }[] = [];
  try {
    for (const from of carryFiles(stateDir)) {
      const to = `${from}.claimed-${randomUUID()}`;
      try {
        renameSync(from, to);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw e;
      }
      claimed.push({ from, to });
    }
    deliver(claimed.map(({ to }) => JSON.parse(readFileSync(to, 'utf-8')) as WaitCarry));
  } catch (err) {
    for (const { from, to } of claimed) renameSync(to, from);
    throw err;
  }
  for (const { to } of claimed) rmSync(to);
}

export function mergeWaitCarry(
  result: WaitResult,
  carried: WaitCarry[],
  sessionId?: string,
): WaitResult {
  if (carried.length === 0) return result;
  const outcomes = carried.map(({ outcome }) => outcome);
  if (result.last) outcomes.push(result.last);
  const latest = outcomes.at(-1)!;
  const reports = outcomes.filter(({ report }) => !report.skipped).map(({ report }) => report);
  const reasons = new Set(carried.flatMap((item) => item.reasons).concat(result.reasons));
  // 인계 판단은 세션마다 달라서 다른 세션의 컨텍스트 사용량으로 다시 인계하면 안 된다.
  const handoff = outcomes
    .map((outcome) => outcome.handoff)
    .filter((status) => status?.sessionId === sessionId)
    .at(-1);
  if (!handoff?.due && reasons.delete('handoff')) reasons.add('carriedHandoff');
  const carriedHandoffs = carried.flatMap(({ outcome }) =>
    outcome.handoff && outcome.handoff !== handoff ? [outcome.handoff] : [],
  );
  const last: WaitTickOutcome = {
    report: {
      ...(reports.at(-1) ?? latest.report),
      created: reports.flatMap((r) => r.created),
      launched: reports.flatMap((r) => r.launched),
      escalated: reports.flatMap((r) => r.escalated),
      hostActions: reports.flatMap((r) => r.hostActions),
      slackPosted: reports.flatMap((r) => r.slackPosted),
      jira: reports.flatMap((r) => r.jira),
      humanOwned: reports.flatMap((r) => r.humanOwned),
      errors: [...new Set(reports.flatMap((r) => r.errors))],
      warnings: [...new Set(reports.flatMap((r) => r.warnings))],
    },
    ...(handoff ? { handoff } : {}),
    ...(carriedHandoffs.length ? { carriedHandoffs } : {}),
    handoffClose: outcomes.flatMap((o) => o.handoffClose),
  };
  return {
    ...result,
    reason: 'attention',
    reasons: [...reasons],
    last,
    ...(result.observed ? { observed: [...result.observed, ...shownLines(last)] } : {}),
  };
}

export function readSeen(stateDir: string): Set<string> {
  const path = join(stateDir, SEEN_FILE);
  if (!existsSync(path)) return new Set();
  try {
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return new Set(Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);
  } catch {
    return new Set();
  }
}

/**
 * 호스트에 보여 준 문장을 남긴다. 고쳐지지 않는 오류 하나로 wait가 매번 바로 끝나지 않게 한다.
 * 이번 wait의 tick에서 한 번도 안 나온 문장은 뺀다. 고쳐졌다가 같은 문장으로 다시 나면 다음 wait가 호스트를 깨운다.
 * 한 wait 안에서 풀렸다가 다시 난 문장은 못 알아본다. 띄엄띄엄 실리는 오류로 매번 깨우지 않으려는 것이다.
 * 그 오류는 실리는 간격보다 오래 돈 wait에서만 남는다. 일찍 끝난 wait 뒤에는 다시 깨울 수 있다
 */
export function writeSeen(
  stateDir: string,
  prev: ReadonlySet<string>,
  observed: readonly string[] | undefined,
  shown: readonly string[],
): void {
  const still = observed ? new Set(observed) : undefined;
  const kept = still ? [...prev].filter((s) => still.has(s)) : [...prev];
  const merged = [...kept, ...shown.filter((s) => !kept.includes(s))].slice(-SEEN_MAX);
  writeJsonAtomic(join(stateDir, SEEN_FILE), merged);
}
