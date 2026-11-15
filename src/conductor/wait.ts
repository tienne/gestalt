import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TickReport } from './engine.js';
import type { HandoffCloseResult } from './handoff-close.js';
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
}

export type WaitEndReason = 'attention' | 'timeout' | 'superseded';

export interface WaitResult {
  reason: WaitEndReason;
  /** attention이면 어떤 칸 때문에 끝났는지 */
  reasons: string[];
  ticks: number;
  elapsedMs: number;
  /** 마지막으로 돈 tick. attention이면 끝나게 한 tick이다 */
  last?: WaitTickOutcome;
}

export interface WaitLoopDeps {
  runTick: () => Promise<WaitTickOutcome>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** 다른 wait가 이어받았으면 false. 이어받긴 쪽은 tick을 더 돌리지 않고 끝난다 */
  stillOwner: () => boolean;
  /** 앞서 wait가 이미 호스트에 보여 준 오류와 경고. 같은 문장만으로는 다시 끝나지 않는다 */
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
  if (o.handoffClose.length > 0) reasons.push('handoffClose');
  return reasons;
}

export async function waitForAttention(
  deps: WaitLoopDeps,
  opts: WaitLoopOptions,
): Promise<WaitResult> {
  const start = deps.now();
  let ticks = 0;
  let last: WaitTickOutcome | undefined;
  let openGates = deps.openGatesBefore;
  const result = (reason: WaitEndReason, reasons: string[] = []): WaitResult => ({
    reason,
    reasons,
    ticks,
    elapsedMs: deps.now() - start,
    ...(last ? { last } : {}),
  });
  for (;;) {
    if (!deps.stillOwner()) return result('superseded');
    last = await deps.runTick();
    ticks++;
    const reasons = attentionReasons(last, deps.seen, openGates);
    if (reasons.length > 0) return result('attention', reasons);
    if (!last.report.skipped) openGates = last.report.counts.openGates;
    const left = opts.maxWaitMs - (deps.now() - start);
    if (left <= 0) return result('timeout');
    await deps.sleep(Math.min(opts.intervalMs, left));
  }
}

const OWNER_FILE = 'wait.owner';
const SEEN_FILE = 'wait-seen.json';
const SEEN_MAX = 200;
export const WAIT_REPORT_FILE = 'wait-last.json';

/**
 * 새 wait가 뜨면 소유 표식을 덮어쓴다. 앞서 뜬 wait(컴팩트 뒤 중복으로 띄웠거나 닫힌 세션에 남은 것)는
 * 다음 tick 앞에서 표식이 바뀐 걸 보고 끝난다. 프로세스를 죽이지 않고 가장 나중에 뜬 쪽이 이어 간다.
 * 닫힌 세션에 남은 wait가 tick을 계속 돌리면 hostActions를 아무도 못 받기 때문이다.
 */
export function claimWaitOwner(stateDir: string): {
  stillOwner: () => boolean;
  release: () => void;
} {
  const path = join(stateDir, OWNER_FILE);
  const token = `${process.pid}:${randomUUID()}`;
  mkdirSync(stateDir, { recursive: true });
  const tmp = `${path}.${token.replace(':', '-')}.tmp`;
  writeFileSync(tmp, token);
  renameSync(tmp, path);
  const read = () => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  };
  return {
    stillOwner: () => read() === token,
    release: () => {
      if (read() === token) rmSync(path, { force: true });
    },
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

/** 호스트에 보여 준 오류와 경고를 남긴다. 고쳐지지 않는 오류 하나로 wait가 매번 바로 끝나지 않게 한다 */
export function writeSeen(stateDir: string, prev: ReadonlySet<string>, shown: string[]): void {
  const merged = [...prev, ...shown.filter((s) => !prev.has(s))].slice(-SEEN_MAX);
  writeFileSync(join(stateDir, SEEN_FILE), JSON.stringify(merged));
}
