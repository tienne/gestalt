import { execFileSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  cpSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join, sep } from 'node:path';
import { ACTIVITY_DIR, safeId } from './activity.js';
import { CLEANUP_FAILED, acquireLock } from './engine.js';
import { HANDOFF_DIR } from './handoff.js';
import { ORDER_LOGS_DIR, foldEvents, fsyncDir, writeDurable, type FoldResult } from './fold.js';
import { REFS_DIR, SAFE_ORDER_ID, removeOrderRefCopies } from './ref-copy.js';
import { ConductorStore, detachOrder, removalBlocker, replayStore } from './store.js';
import {
  TERMINAL_ORDER_STATUSES,
  type ConductorSnapshot,
  type Gate,
  type OrderStatus,
  type StoredReport,
} from './types.js';

/** 끝난 주문을 옮겨 두는 자리. `archive/<YYYY-MM>/<주문 id>/` 아래 이벤트와 끝 상태, refs 사본을 둔다 */
export const ARCHIVE_DIR = 'archive';
/** 끝나고 이만큼 지난 주문을 옮긴다. 최근 2주 결과는 `order show`로 바로 본다 */
export const DEFAULT_ARCHIVE_DAYS = 14;

/** 워커 첫 지시 파일 자리. 런처가 `<워커 id>.md`로 쓴다 */
export const PROMPTS_DIR = 'prompts';
/** tick이 마지막으로 보관을 돌린 시각. 하루 한 번만 돌리는 데 쓴다 */
const LAST_RUN_FILE = 'last-run.json';

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
/** 묶기와 풀기에 쓰는 tar 한 번의 상한. 한 달치 보관소가 이보다 오래 걸리면 다음 보관 때 다시 한다 */
const TAR_TIMEOUT_MS = 10 * 60 * 1000;
/** 한 번 보관에서 묶는 달 수. 밀린 달은 다음 보관 때 이어서 묶어 잠금을 오래 쥐지 않는다 */
const MAX_COMPRESS_MONTHS = 2;
/** 잠금을 잡고 이만큼 지났으면 새 달을 시작하지 않는다. 잠금이 걷히는 6시간 근처까지 가지 않게 한다 */
const MAX_COMPRESS_MS = 60 * 60 * 1000;

export interface ArchivePlan {
  orders: { id: string; month: string; status: OrderStatus }[];
  /** `order remove`로 지운 주문. 상태에는 이미 없고 모아 둔 이벤트만 옮긴다 */
  removed: { id: string; month: string }[];
  /** 끝났고 기간도 지났지만 못 옮기는 주문. 사람이 게이트나 워커를 처리해야 옮긴다 */
  blocked: { id: string; reason: string }[];
  /**
   * 주문에 안 붙는 컨덕터 게이트 중 닫히고 기간이 지나 상태에서 버리는 것.
   * 후속 동작이 그 게이트가 있다는 사실에 기대면 남긴다(`keepsFollowUp`)
   */
  gates: string[];
}

export interface ArchiveOptions {
  /** 끝나고 며칠 지난 주문을 옮길지 */
  days?: number;
  dryRun?: boolean;
  now?: () => Date;
  /** 떼어 내기와 같다. 테스트만 줄인다 */
  settleMs?: number;
}

/** 지운 운영 파일 수 */
export interface SweepCounts {
  prompts: number;
  activity: number;
  handoffs: number;
}

export type ArchiveResult =
  | ({ status: 'dry-run' } & ArchivePlan)
  | ({
      status: 'archived';
      fold: FoldResult['status'];
      swept: SweepCounts;
      warnings: string[];
    } & ArchivePlan)
  | { status: 'locked'; holder?: number };

/**
 * 보관할 주문을 고른다. 끝난 시각(`updatedAt`)이 기간보다 오래된 끝난 주문 중 `order remove`가 받아 주는
 * 주문만 옮긴다. 열린 게이트나 멈춘 워커가 남은 주문은 사람이 처리할 때까지 남긴다. 보관은 사람이 고르지
 * 않으므로 tick이 아직 할 일이 남은 주문도 남긴다(`archiveBlocker`)
 */
export function planArchive(s: ConductorSnapshot, now: Date, days: number): ArchivePlan {
  const cutoff = now.getTime() - days * DAY_MS;
  const plan: ArchivePlan = { orders: [], removed: [], blocked: [], gates: [] };
  for (const o of Object.values(s.orders)) {
    if (!TERMINAL_ORDER_STATUSES.has(o.status) || !olderThan(o.updatedAt, cutoff)) continue;
    const reason = SAFE_ORDER_ID.test(o.id)
      ? (removalBlocker(s, o.id, 'archive') ?? archiveBlocker(s, o.id))
      : `주문 id 꼴이 이상해 안 옮겨요: ${o.id.slice(0, 80)}`;
    if (reason) plan.blocked.push({ id: o.id, reason });
    else plan.orders.push({ id: o.id, month: monthOf(o.updatedAt, now), status: o.status });
  }
  for (const [id, r] of Object.entries(s.removedOrders)) {
    if (r.archived || !olderThan(r.removedAt, cutoff) || !SAFE_ORDER_ID.test(id)) continue;
    plan.removed.push({ id, month: monthOf(r.removedAt, now) });
  }
  for (const g of Object.values(s.gates)) {
    if (g.orderId !== undefined || g.status !== 'resolved') continue;
    if (!olderThan(g.resolvedAt ?? '', cutoff) || keepsFollowUp(s, g)) continue;
    plan.gates.push(g.id);
  }
  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  plan.orders.sort(byId);
  plan.removed.sort(byId);
  plan.blocked.sort(byId);
  plan.gates.sort();
  return plan;
}

/**
 * tick이 그 주문으로 아직 할 일이 남았는지. 옮기면 워커와 게이트가 상태에서 빠져 그 일이 사라진다.
 * - 끝났지만 아직 released가 아닌 워커: 정리가 워크트리를 거둔다
 * - 그 주문 워커의 정리 실패 게이트가 열려 있다: 게이트가 주문을 `payload`에만 들고 있다
 * - 승인했는데 아직 슬랙에 안 올린 게이트: 게시가 그 게이트를 보고 돈다
 */
function archiveBlocker(s: ConductorSnapshot, orderId: string): string | undefined {
  const workers = Object.values(s.workers).filter((w) => w.orderId === orderId);
  if (workers.some((w) => w.status === 'finished' || w.status === 'failed'))
    return `아직 정리 안 된 워커가 있어서 못 옮겨요: ${orderId}`;
  const gates = Object.values(s.gates);
  if (
    gates.some(
      (g) =>
        g.status === 'open' && g.payload?.kind === CLEANUP_FAILED && g.payload.orderId === orderId,
    )
  )
    return `워커 정리 실패 게이트가 열려 있어서 못 옮겨요: ${orderId}`;
  if (gates.some((g) => g.orderId === orderId && unposted(s, g)))
    return `아직 안 올린 슬랙 게시가 있어서 못 옮겨요: ${orderId}`;
  return undefined;
}

function unposted(s: ConductorSnapshot, g: Gate): boolean {
  return g.type === 'slack-post' && g.decision === 'approved' && s.slackPosted[g.id] === undefined;
}

/**
 * 닫힌 컨덕터 게이트를 버리면 안 되는 경우.
 * - `sourceRef`가 있다: 같은 출처에 질문을 다시 안 열고(PR 감시, 접수) 승인 뒤 주문을 만드는 근거다
 * - 승인했는데 아직 슬랙에 안 올렸다: 게시가 그 게이트를 보고 돈다
 * - 정리 실패를 승인했는데 워커가 아직 released가 아니다: 다음 tick이 승인을 반영한다
 */
function keepsFollowUp(s: ConductorSnapshot, g: Gate): boolean {
  if (g.payload?.sourceRef !== undefined) return true;
  if (g.decision !== 'approved') return false;
  if (unposted(s, g)) return true;
  if (g.payload?.kind === CLEANUP_FAILED) {
    const w = g.payload.workerId ? s.workers[g.payload.workerId] : undefined;
    return w !== undefined && w.status !== 'released';
  }
  return false;
}

/**
 * 끝난 주문을 `archive/<YYYY-MM>/<주문 id>/`로 옮기고 상태에서 뺀다.
 *
 * 떼어 내기(`foldEvents`)와 한 번에 돈다. 잠금을 잡고 `events.jsonl`을 떼어 반영한 뒤 base.json을 쓰기 전에
 * 보관 파일을 쓰고 상태에서 주문을 뺀다. 주문별로 모아 둔 이벤트와 refs 사본은 base.json을 fsync한 뒤에
 * 지운다. base.json을 쓰기 전에 죽으면 모아 둔 이벤트가 그대로라 다음 보관이 같은 자리에 같은 내용을
 * 덮어쓴다. base.json까지 쓰고 죽으면 남은 이벤트와 사본은 다음 보관이 보관 기록을 보고 지운다.
 */
export async function archiveOrders(
  dir: string,
  opts: ArchiveOptions = {},
): Promise<ArchiveResult> {
  const now = opts.now ?? (() => new Date());
  const days = opts.days ?? DEFAULT_ARCHIVE_DAYS;
  if (opts.dryRun) return { status: 'dry-run', ...planArchive(replayStore(dir), now(), days) };

  let plan: ArchivePlan = { orders: [], removed: [], blocked: [], gates: [] };
  let swept: SweepCounts = { prompts: 0, activity: 0, handoffs: 0 };
  const warnings: string[] = [];
  const fold = await foldEvents(dir, {
    now,
    ...(opts.settleMs !== undefined ? { settleMs: opts.settleMs } : {}),
    beforeWrite: (state) => {
      warnings.push(...cleanupArchived(dir, state));
      const at = now();
      // 이번에 옮길 주문의 워커는 아직 상태에 남아 있으므로 다음 보관 때 지운다
      swept = sweepOpsFiles(dir, state, at, days);
      plan = planArchive(state, at, days);
      for (const { id, month } of plan.orders) {
        if (!writeOrderArchive(dir, state, id, month, at.toISOString()))
          warnings.push(`모아 둔 이벤트가 없어 빈 events.jsonl을 썼어요: ${id}`);
        const o = detachOrder(state, id);
        state.archivedOrders[id] = {
          sourceRef: o.sourceRef,
          ...(o.parentOrderId ? { parentOrderId: o.parentOrderId } : {}),
          archivedAt: at.toISOString(),
          month,
          ...(o.status === 'parked' && o.prRef ? { humanPr: o.prRef } : {}),
        };
      }
      // 지운 주문은 이벤트만 옮기고 옮긴 달을 남긴다. 모아 둔 이벤트가 없으면 표시만 한다
      for (const { id, month } of plan.removed) {
        const events = stagedEvents(dir, id);
        if (events) {
          const target = archiveTarget(dir, month, id);
          writeDurable(join(target, 'events.jsonl'), events);
          fsyncDir(target);
        }
        state.removedOrders[id] = { ...state.removedOrders[id]!, archived: month };
      }
      for (const id of plan.gates) {
        delete state.gates[id];
        delete state.slackPosted[id];
      }
      return plan.orders.length + plan.removed.length + plan.gates.length > 0;
    },
    afterWrite: (state) => {
      warnings.push(...cleanupArchived(dir, state));
      if (plan.orders.length + plan.removed.length + plan.gates.length === 0) return;
      // 조회용 사본도 잠금 안에서 쓴다. 반영한 state에는 떼어 낸 뒤 events.jsonl에 붙은 줄이 없어서
      // 그대로 쓰면 조회가 그 줄만큼 뒤로 간다. 그래서 다시 재생한다
      try {
        ConductorStore.open(dir).flushSnapshot();
      } catch (e) {
        warnings.push(`snapshot.json을 못 썼어요: ${(e as Error).message}`);
      }
    },
  });
  if (fold.status === 'locked') return fold;
  return { status: 'archived', fold: fold.status, ...plan, swept, warnings };
}

/** 모아 둔 이벤트가 있었으면 true. 없으면 빈 events.jsonl을 쓰고 false다 */
function writeOrderArchive(
  dir: string,
  s: ConductorSnapshot,
  id: string,
  month: string,
  archivedAt: string,
): boolean {
  const target = archiveTarget(dir, month, id);
  const events = stagedEvents(dir, id);
  writeDurable(join(target, 'events.jsonl'), events);
  const copied = copyRefs(dir, id, target);

  const order = s.orders[id]!;
  const workers = Object.values(s.workers)
    .filter((w) => w.orderId === id)
    .sort((a, b) => a.attempt - b.attempt);
  copySummaries(
    dir,
    workers.map((w) => w.id),
    target,
  );
  const reports = (s.reports[id] ?? []).map((r) => (copied ? movedRefCopies(r, id, month) : r));
  const refs = [...new Set(reports.flatMap((r) => r.refs))];
  const gates = Object.values(s.gates).filter((g) => g.orderId === id);
  const bypasses = s.bypasses.filter((b) => b.orderId === id);
  // `order show --json`과 같은 꼴. stateDir 대신 보관한 시각을 둔다
  const shown = { order, workers, reports, refs, gates, bypasses, archivedAt };
  writeDurable(join(target, 'order.json'), `${JSON.stringify(shown, null, 2)}\n`);
  fsyncDir(target);
  return events.length > 0;
}

/** 보관 디렉토리를 만들고 새로 생긴 디렉토리 엔트리까지 fsync한다. 그 뒤에 base.json이 원본을 지운다 */
function archiveTarget(dir: string, month: string, id: string): string {
  const target = join(dir, ARCHIVE_DIR, month, id);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  fsyncDir(dir);
  fsyncDir(join(dir, ARCHIVE_DIR));
  fsyncDir(join(dir, ARCHIVE_DIR, month));
  return target;
}

/** 모아 둔 이벤트를 로그 순서로 잇는다. 모으기 전에 반영한 이벤트는 없다 */
function stagedEvents(dir: string, id: string): string {
  const orderDir = join(dir, ORDER_LOGS_DIR, id);
  let names: string[];
  try {
    names = readdirSync(orderDir).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return '';
  }
  return names
    .sort()
    .map((n) => readFileSync(join(orderDir, n), 'utf-8'))
    .join('');
}

/**
 * `refs/<주문 id>/`를 보관 자리로 복사한다. 원본은 base.json을 쓴 뒤에 지운다.
 * 심링크나 디렉토리가 아닌 자리는 누가 바꿔 둔 것이라 따라가지 않는다
 */
function copyRefs(dir: string, id: string, target: string): boolean {
  const refs = join(dir, REFS_DIR);
  const src = join(refs, id);
  if (!lstatSync(refs, { throwIfNoEntry: false })?.isDirectory()) return false;
  if (!lstatSync(src, { throwIfNoEntry: false })?.isDirectory()) return false;
  const dest = join(target, REFS_DIR);
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
  fsyncTree(dest);
  return true;
}

/**
 * 끝난 워커의 타임라인 요약을 `workers/<워커 id>.summary.json`으로 복사한다. 원본은 워커가 상태에서 빠진 뒤
 * 다음 보관이 지운다. 원본이 없으면 앞서 복사해 둔 것을 그대로 둔다
 */
function copySummaries(dir: string, workerIds: string[], target: string): void {
  const dest = join(target, 'workers');
  for (const id of workerIds) {
    const name = `${safeId(id)}.summary.json`;
    const src = join(dir, ACTIVITY_DIR, name);
    if (!lstatSync(src, { throwIfNoEntry: false })?.isFile()) continue;
    // 워커가 상태에 남은 동안 보관이 여러 번 돌 수 있어 크기가 같은 사본은 다시 안 쓴다
    const copied = lstatSync(join(dest, name), { throwIfNoEntry: false });
    if (copied?.isFile() && copied.size === lstatSync(src).size) continue;
    mkdirSync(dest, { recursive: true, mode: 0o700 });
    copyFileSync(src, join(dest, name));
    fsyncFile(join(dest, name));
  }
  if (lstatSync(dest, { throwIfNoEntry: false })?.isDirectory()) fsyncDir(dest);
}

/** 복사한 사본은 base.json을 쓴 뒤 원본이 지워지므로 그 전에 디스크에 둔다 */
function fsyncTree(path: string): void {
  for (const e of readdirSync(path, { withFileTypes: true })) {
    const p = join(path, e.name);
    if (e.isDirectory()) fsyncTree(p);
    else if (e.isFile()) fsyncFile(p);
  }
  fsyncDir(path);
}

function fsyncFile(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** 보고의 사본 경로를 옮긴 자리로 바꾼다. 이벤트 줄은 원래 값 그대로 둔다 */
function movedRefCopies(
  r: StoredReport & { at: string },
  id: string,
  month: string,
): StoredReport & { at: string } {
  if (!r.refCopies) return r;
  const prefix = join(REFS_DIR, id) + sep;
  return {
    ...r,
    refCopies: r.refCopies.map((c) =>
      c.path?.startsWith(prefix)
        ? { ...c, path: join(ARCHIVE_DIR, month, id, REFS_DIR, c.path.slice(prefix.length)) }
        : c,
    ),
  };
}

/**
 * 옮긴 주문에 남은 모아 둔 이벤트와 refs 사본을 지운다. base.json에 적힌 보관만 보므로 지워도 된다.
 * 보관 기록은 늘기만 하므로 디렉토리에 남은 이름만 본다
 */
function cleanupArchived(dir: string, s: ConductorSnapshot): string[] {
  const done = (id: string) =>
    SAFE_ORDER_ID.test(id) && (id in s.archivedOrders || !!s.removedOrders[id]?.archived);
  for (const id of listDir(join(dir, ORDER_LOGS_DIR)).filter(done))
    rmSync(join(dir, ORDER_LOGS_DIR, id), { recursive: true, force: true });
  const warnings: string[] = [];
  for (const id of listDir(join(dir, REFS_DIR)).filter((id) => id in s.archivedOrders)) {
    if (!SAFE_ORDER_ID.test(id)) continue;
    const warning = removeOrderRefCopies(dir, id);
    if (warning) warnings.push(warning);
  }
  return warnings;
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function olderThan(iso: string, cutoff: number): boolean {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t <= cutoff;
}

function monthOf(iso: string, fallback: Date): string {
  const m = iso.slice(0, 7);
  return MONTH.test(m) ? m : fallback.toISOString().slice(0, 7);
}

/** 상태에서 빠진 워커의 파일도 이만큼은 둔다. 잠금 밖에서 막 쓴 파일을 지우지 않게 한다 */
const ORPHAN_GRACE_MS = DAY_MS;

/**
 * `handoff` 명령이 쓰는 인계 파일 이름(`handoff.ts`의 `<시각>-<세션 id>.md`). 그 꼴이 바뀌면 여기도 고친다.
 * 사람이 같은 디렉토리에 둔 다른 파일은 안 지운다
 */
const HANDOFF_FILE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-.+\.md$/;

/**
 * 운영 파일을 지운다. `prompts/`와 `activity/`는 워커가 상태에 없고 하루 넘게 안 바뀐 파일만,
 * `handoffs/`는 보관 기간보다 오래된 파일만 지운다. 파일 이름에서 워커 id를 읽으므로 심링크나
 * 디렉토리는 건드리지 않는다
 */
function sweepOpsFiles(dir: string, s: ConductorSnapshot, now: Date, days: number): SweepCounts {
  const known = new Set(Object.keys(s.workers).flatMap((id) => [id, safeId(id)]));
  const orphan = (name: string, suffix: RegExp) => !known.has(name.replace(suffix, ''));
  const grace = now.getTime() - ORPHAN_GRACE_MS;
  return {
    prompts: removeOldFiles(
      join(dir, PROMPTS_DIR),
      grace,
      (n) => n.endsWith('.md') && orphan(n, /\.md$/),
    ),
    // `<워커 id>.json`, `.transcript.json`, `.summary.json`. safeId가 점을 걷으므로 첫 점 앞이 워커 id다
    activity: removeOldFiles(join(dir, ACTIVITY_DIR), grace, (n) => orphan(n, /\..*$/)),
    // `--older-than 0`이어도 막 넘긴 인계 파일은 새 세션이 읽기 전이라 하루는 둔다
    handoffs: removeOldFiles(
      join(dir, HANDOFF_DIR),
      Math.min(now.getTime() - days * DAY_MS, grace),
      (n) => HANDOFF_FILE.test(n),
    ),
  };
}

function removeOldFiles(path: string, cutoff: number, pick: (name: string) => boolean): number {
  let removed = 0;
  for (const name of listDir(path)) {
    if (!pick(name)) continue;
    const st = lstatSync(join(path, name), { throwIfNoEntry: false });
    if (!st?.isFile() || st.mtimeMs > cutoff) continue;
    rmSync(join(path, name), { force: true });
    removed++;
  }
  return removed;
}

/**
 * 이 달보다 앞선 달은 끝나고 한 달이 지났다. 압축과 지우기는 그 달만 받는다.
 * 11월 23일이면 `2026-10`을 돌려주고 9월까지가 대상이다
 */
export function settledMonthCutoff(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
}

export type CompressResult =
  | { status: 'compressed'; months: string[]; warnings: string[] }
  | { status: 'locked'; holder?: number };

/**
 * 끝나고 한 달 지난 달의 `archive/<YYYY-MM>/`을 `archive/<YYYY-MM>.tar.gz`로 묶고 디렉토리를 지운다.
 * 끝난 지 오래된 주문이 늦게 보관되면 묶은 달에 디렉토리가 다시 생긴다. 그때는 묶음을 풀어 합친 뒤
 * 다시 묶는다. 새 묶음을 fsync하고 이름을 바꾼 뒤에 디렉토리를 지우므로 어디서 죽어도 다시 부르면 끝난다.
 * 오래된 달부터 묶고 한 번에 2개를 묶었거나 1시간이 지났으면 멈춘다. 못 묶은 달은 이 개수에 안 넣는다
 */
export function compressArchive(
  dir: string,
  now: Date,
  limits: { maxMonths?: number; maxMs?: number } = {},
): CompressResult {
  const lock = acquireLock(dir);
  if (!lock.ok) return { status: 'locked', holder: lock.holder };
  const started = Date.now();
  const maxMonths = limits.maxMonths ?? MAX_COMPRESS_MONTHS;
  const maxMs = limits.maxMs ?? MAX_COMPRESS_MS;
  try {
    const root = join(dir, ARCHIVE_DIR);
    const cutoff = settledMonthCutoff(now);
    const months: string[] = [];
    const warnings: string[] = [];
    const names = listDir(root).sort();
    const due: string[] = [];
    for (const name of names) {
      // 디렉토리가 이미 없는 달의 임시 파일. 디렉토리가 남은 달은 compressMonth가 먼저 치운다
      const left = leftoverMonth(name);
      if (left && !names.includes(left)) rmSync(join(root, name), { recursive: true, force: true });
      if (!MONTH.test(name) || name >= cutoff) continue;
      if (lstatSync(join(root, name)).isDirectory()) due.push(name);
    }
    let i = 0;
    for (; i < due.length; i++) {
      if (months.length >= maxMonths || Date.now() - started >= maxMs) break;
      const name = due[i]!;
      try {
        compressMonth(root, name);
        months.push(name);
      } catch (e) {
        warnings.push(`archive/${name}을 못 묶었어요: ${(e as Error).message}`);
      }
    }
    if (i < due.length)
      warnings.push(`못 묶은 달 ${due.length - i}개는 다음 보관 때 이어서 묶어요`);
    return { status: 'compressed', months, warnings };
  } finally {
    lock.release();
  }
}

/** 묶다 죽으면 남는 `<YYYY-MM>.tar.gz.tmp`와 `.<YYYY-MM>.merge`에서 달을 꺼낸다 */
function leftoverMonth(name: string): string | undefined {
  const m = /^(?:\.(.+)\.merge|(.+)\.tar\.gz\.tmp)$/.exec(name);
  const month = m?.[1] ?? m?.[2];
  return month !== undefined && MONTH.test(month) ? month : undefined;
}

/** 실패하면 tar의 stderr 앞 몇 줄을 메시지에 싣는다. 경고만 보고 원인을 알 수 있게 한다 */
function tar(args: string[], env: Record<string, string> = {}): string {
  try {
    return execFileSync('tar', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: TAR_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      // macOS tar가 확장 속성을 `._` 파일로 끼워 넣지 않게 한다
      env: { ...process.env, COPYFILE_DISABLE: '1', ...env },
    });
  } catch (e) {
    const err = e as Error & { stderr?: string };
    const detail = (err.stderr ?? '').trim().split('\n').slice(0, 3).join(' / ');
    throw new Error(`tar ${args[0]} 실패: ${detail || err.message}`, { cause: e });
  }
}

/**
 * 묶음 안 이름이 전부 `<month>/` 아래인지 본다. 첫 칸이 그 달이 아니면(절대 경로 포함) 또는 `..` 칸이
 * 있으면 풀지 않는다. 링크 항목은 대상도 본다
 */
function assertTarEntries(tarball: string, month: string): void {
  for (const name of tar(['-tzf', tarball]).split('\n').filter(Boolean)) {
    const parts = name.replace(/\/$/, '').split('/');
    if (parts[0] !== month || parts.includes('..'))
      throw new Error(`${month}.tar.gz에 ${month}/ 밖을 가리키는 항목이 있어요: ${name}`);
  }
  // 문구가 로캘을 타지 않게 C로 돌린다. 구분자는 GNU tar와 bsdtar가 같다
  for (const line of tar(['-tzvf', tarball], { LC_ALL: 'C' }).split('\n').filter(Boolean)) {
    const bad = tarLinkViolation(line, month);
    if (bad) throw new Error(`${month}.tar.gz에 ${bad}: ${line}`);
  }
}

/**
 * `tar -tzvf` 한 줄이 묶음 밖을 가리키는 링크면 이유를 돌려준다. 심링크는 대상이 절대 경로거나 `..` 칸이
 * 있으면, 하드링크는 그에 더해 대상 첫 칸이 그 달이 아니면 막는다. 구분자가 없거나 여러 번이면 모호해서 막는다
 */
export function tarLinkViolation(line: string, month: string): string | undefined {
  const sep = line[0] === 'l' ? ' -> ' : line[0] === 'h' ? ' link to ' : undefined;
  if (sep === undefined) return undefined;
  const pieces = line.split(sep);
  if (pieces.length !== 2) return '대상을 가를 수 없는 링크가 있어요';
  const target = pieces[1]!;
  const parts = target.replace(/\/$/, '').split('/');
  if (target.startsWith('/') || parts.includes('..') || (sep === ' link to ' && parts[0] !== month))
    return `${month}/ 밖을 가리키는 링크가 있어요`;
  return undefined;
}

/** 새 묶음에 디렉토리의 항목이 다 들어갔는지 본다. 빠졌으면 이름을 안 바꾸고 디렉토리도 둔다 */
function assertTarCovers(tmp: string, root: string, month: string): void {
  const listed = new Set(
    tar(['-tzf', tmp])
      .split('\n')
      .filter(Boolean)
      .map((n) => n.replace(/\/$/, '')),
  );
  const missing = readdirSync(join(root, month), { recursive: true, encoding: 'utf-8' })
    .map((rel) => join(month, rel).split(sep).join('/'))
    .filter((n) => !listed.has(n));
  if (missing.length > 0)
    throw new Error(
      `새 묶음에 빠진 항목이 ${missing.length}개예요: ${missing.slice(0, 3).join(', ')}`,
    );
}

function compressMonth(root: string, month: string): void {
  const tarball = join(root, `${month}.tar.gz`);
  const tmp = `${tarball}.tmp`;
  const merge = join(root, `.${month}.merge`);
  rmSync(tmp, { force: true });
  rmSync(merge, { recursive: true, force: true });
  if (lstatSync(tarball, { throwIfNoEntry: false })?.isFile()) {
    // 디렉토리에 있는 쪽이 더 새로 쓴 것이라 겹치는 파일은 디렉토리 쪽을 남긴다
    assertTarEntries(tarball, month);
    mkdirSync(merge, { mode: 0o700 });
    tar(['-xzf', tarball, '-C', merge]);
    const old = join(merge, month);
    if (lstatSync(old, { throwIfNoEntry: false })?.isDirectory())
      cpSync(old, join(root, month), {
        recursive: true,
        force: false,
        errorOnExist: false,
        verbatimSymlinks: true,
      });
    rmSync(merge, { recursive: true, force: true });
  }
  tar(['-czf', tmp, '-C', root, month]);
  assertTarCovers(tmp, root, month);
  fsyncFile(tmp);
  renameSync(tmp, tarball);
  fsyncDir(root);
  rmSync(join(root, month), { recursive: true, force: true });
  fsyncDir(root);
}

export type PruneResult =
  | { status: 'dry-run' | 'pruned'; months: string[]; paths: string[] }
  | { status: 'locked'; holder?: number };

/**
 * `before`보다 앞선 달의 보관소를 지운다. 사람이 부르는 자리다. 끝나고 한 달이 안 지난 달은 받지 않는다.
 * 상태의 보관 기록(`archivedOrders`)은 그대로 둬서 같은 출처를 다시 받지 않는다
 */
export function pruneArchive(
  dir: string,
  before: string,
  opts: { now?: Date; dryRun?: boolean } = {},
): PruneResult {
  if (!MONTH.test(before)) throw new Error(`--before는 YYYY-MM 꼴로 주세요: ${before}`);
  const cutoff = settledMonthCutoff(opts.now ?? new Date());
  if (before > cutoff)
    throw new Error(`끝나고 한 달이 안 지난 달은 못 지워요. --before는 ${cutoff}까지 받아요`);
  const root = join(dir, ARCHIVE_DIR);
  const pick = () => {
    const months = new Set<string>();
    const paths: string[] = [];
    for (const name of listDir(root).sort()) {
      const month = leftoverMonth(name) ?? name.replace(/\.tar\.gz$/, '');
      if (!MONTH.test(month) || month >= before) continue;
      months.add(month);
      paths.push(join(ARCHIVE_DIR, name));
    }
    return { months: [...months], paths };
  };
  if (opts.dryRun) return { status: 'dry-run', ...pick() };
  const lock = acquireLock(dir);
  if (!lock.ok) return { status: 'locked', holder: lock.holder };
  try {
    const picked = pick();
    for (const p of picked.paths) rmSync(join(dir, p), { recursive: true, force: true });
    fsyncDir(root);
    return { status: 'pruned', ...picked };
  } finally {
    lock.release();
  }
}

/**
 * 보관한 주문이 있는 자리. 묶은 달이면 묶음 파일을 가리키고 `archive prune`으로 지웠으면 `deleted`다.
 * 경로는 저장소 기준 상대 경로다
 */
export function archiveLocation(
  dir: string,
  month: string,
  id: string,
): { status: 'dir' | 'tarball'; path: string } | { status: 'deleted' } {
  const plain = join(ARCHIVE_DIR, month, id);
  if (lstatSync(join(dir, plain), { throwIfNoEntry: false })?.isDirectory())
    return { status: 'dir', path: plain };
  const tarball = join(ARCHIVE_DIR, `${month}.tar.gz`);
  if (lstatSync(join(dir, tarball), { throwIfNoEntry: false })?.isFile())
    return { status: 'tarball', path: `${tarball} 안의 ${month}/${id}` };
  return { status: 'deleted' };
}

/**
 * 보관하고 이어서 지난 달을 묶는다. `archive` 명령과 tick이 같이 쓴다. 묶기는 잠금을 따로 잡으므로
 * 그사이 다른 프로세스가 잡았으면 묶은 달 없이 돌아오고 다음 보관 때 묶는다
 */
export async function archiveAndCompress(
  dir: string,
  opts: ArchiveOptions & { now: () => Date },
): Promise<
  | Exclude<ArchiveResult, { status: 'archived' }>
  | (Extract<ArchiveResult, { status: 'archived' }> & { compressed: string[] })
> {
  const result = await archiveOrders(dir, opts);
  if (result.status !== 'archived') return result;
  const compressed = compressArchive(dir, opts.now());
  return {
    ...result,
    compressed: compressed.status === 'compressed' ? compressed.months : [],
    warnings: [
      ...result.warnings,
      ...(compressed.status === 'compressed' ? compressed.warnings : []),
    ],
  };
}

export interface DailyArchiveReport {
  orders: string[];
  removed: string[];
  gates: number;
  blocked: { id: string; reason: string }[];
  compressed: string[];
  swept: SweepCounts;
  warnings: string[];
}

/** 보관이 던진 뒤 다시 해 보기까지 기다리는 시간. 같은 실패가 tick마다 되풀이되지 않게 한다 */
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;

/**
 * tick이 잠금을 놓은 뒤 부른다. 마지막으로 돌린 지 하루가 안 됐거나 잠금을 못 잡으면 아무것도 안 하고
 * undefined다. 보관과 운영 파일 정리, 지난 달 묶기를 차례로 하고 돌린 시각을 남긴다. 던지면 실패 시각을
 * 남기고 다시 던져서 한 시간 동안은 다시 안 한다
 */
export async function runDailyArchive(
  dir: string,
  opts: { now: Date; days?: number; settleMs?: number },
): Promise<DailyArchiveReport | undefined> {
  // 시계가 뒤로 가 미래로 남은 시각은 없는 값으로 본다. 그대로 두면 그 시각까지 보관이 멈춘다
  const now = opts.now.getTime();
  const read = readLastRun(dir);
  const last = {
    ...(read.at !== undefined && read.at <= now ? { at: read.at } : {}),
    ...(read.failedAt !== undefined && read.failedAt <= now ? { failedAt: read.failedAt } : {}),
  };
  if (last.at !== undefined && opts.now.getTime() - last.at < DAY_MS) return undefined;
  if (last.failedAt !== undefined && opts.now.getTime() - last.failedAt < RETRY_AFTER_FAILURE_MS)
    return undefined;
  let result: Awaited<ReturnType<typeof archiveAndCompress>>;
  try {
    result = await archiveAndCompress(dir, {
      now: () => opts.now,
      ...(opts.days !== undefined ? { days: opts.days } : {}),
      ...(opts.settleMs !== undefined ? { settleMs: opts.settleMs } : {}),
    });
  } catch (e) {
    try {
      writeLastRun(dir, {
        ...(last.at !== undefined ? { at: new Date(last.at).toISOString() } : {}),
        failedAt: opts.now.toISOString(),
      });
    } catch {
      // 실패 시각을 못 남겨도 보고할 것은 보관이 던진 오류다
    }
    throw e;
  }
  if (result.status !== 'archived') return undefined;
  writeLastRun(dir, { at: opts.now.toISOString() });
  return {
    orders: result.orders.map((o) => o.id),
    removed: result.removed.map((r) => r.id),
    gates: result.gates.length,
    blocked: result.blocked,
    compressed: result.compressed,
    swept: result.swept,
    warnings: result.warnings,
  };
}

/**
 * tick에 넘길 하루 한 번 보관. 사용자 전역 설정의 `archive.enabled`가 false면 undefined라 tick이 보관을 안 한다.
 * 레포 gestalt.json의 값은 설정을 읽을 때 이미 버려진다
 */
export function dailyArchiveFor(
  config: { archive?: { enabled: boolean } | undefined },
  dir: string,
): ((now: Date) => Promise<DailyArchiveReport | undefined>) | undefined {
  if (config.archive?.enabled === false) return undefined;
  return (now) => runDailyArchive(dir, { now });
}

function writeLastRun(dir: string, value: { at?: string; failedAt?: string }): void {
  mkdirSync(join(dir, ARCHIVE_DIR), { recursive: true, mode: 0o700 });
  writeDurable(join(dir, ARCHIVE_DIR, LAST_RUN_FILE), `${JSON.stringify(value)}\n`);
}

function readLastRun(dir: string): { at?: number; failedAt?: number } {
  try {
    const raw = JSON.parse(readFileSync(join(dir, ARCHIVE_DIR, LAST_RUN_FILE), 'utf-8')) as {
      at?: unknown;
      failedAt?: unknown;
    };
    const parse = (v: unknown) => {
      const t = typeof v === 'string' ? Date.parse(v) : NaN;
      return Number.isFinite(t) ? t : undefined;
    };
    const at = parse(raw.at);
    const failedAt = parse(raw.failedAt);
    return { ...(at !== undefined ? { at } : {}), ...(failedAt !== undefined ? { failedAt } : {}) };
  } catch {
    return {};
  }
}
