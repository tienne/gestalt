import {
  closeSync,
  cpSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join, sep } from 'node:path';
import { CLEANUP_FAILED } from './engine.js';
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

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH = /^\d{4}-\d{2}$/;

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

export type ArchiveResult =
  | ({ status: 'dry-run' } & ArchivePlan)
  | ({ status: 'archived'; fold: FoldResult['status']; warnings: string[] } & ArchivePlan)
  | { status: 'locked'; holder?: number };

/**
 * 보관할 주문을 고른다. 끝난 시각(`updatedAt`)이 기간보다 오래된 끝난 주문 중 `order remove`가 받아 주는
 * 주문만 옮긴다. 열린 게이트나 멈춘 워커가 남은 주문은 사람이 처리할 때까지 남긴다
 */
export function planArchive(s: ConductorSnapshot, now: Date, days: number): ArchivePlan {
  const cutoff = now.getTime() - days * DAY_MS;
  const plan: ArchivePlan = { orders: [], removed: [], blocked: [], gates: [] };
  for (const o of Object.values(s.orders)) {
    if (!TERMINAL_ORDER_STATUSES.has(o.status) || !olderThan(o.updatedAt, cutoff)) continue;
    const reason = SAFE_ORDER_ID.test(o.id)
      ? removalBlocker(s, o.id, 'archive')
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
 * 닫힌 컨덕터 게이트를 버리면 안 되는 경우.
 * - `sourceRef`가 있다: 같은 출처에 질문을 다시 안 열고(PR 감시, 접수) 승인 뒤 주문을 만드는 근거다
 * - 승인했는데 아직 슬랙에 안 올렸다: 게시가 그 게이트를 보고 돈다
 * - 정리 실패를 승인했는데 워커가 아직 released가 아니다: 다음 tick이 승인을 반영한다
 */
function keepsFollowUp(s: ConductorSnapshot, g: Gate): boolean {
  if (g.payload?.sourceRef !== undefined) return true;
  if (g.decision !== 'approved') return false;
  if (g.type === 'slack-post' && s.slackPosted[g.id] === undefined) return true;
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
  const warnings: string[] = [];
  const fold = await foldEvents(dir, {
    now,
    ...(opts.settleMs !== undefined ? { settleMs: opts.settleMs } : {}),
    beforeWrite: (state) => {
      warnings.push(...cleanupArchived(dir, state));
      const at = now();
      plan = planArchive(state, at, days);
      for (const { id, month } of plan.orders) {
        writeOrderArchive(dir, state, id, month, at.toISOString());
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
  return { status: 'archived', fold: fold.status, ...plan, warnings };
}

function writeOrderArchive(
  dir: string,
  s: ConductorSnapshot,
  id: string,
  month: string,
  archivedAt: string,
): void {
  const target = archiveTarget(dir, month, id);
  writeDurable(join(target, 'events.jsonl'), stagedEvents(dir, id));
  const copied = copyRefs(dir, id, target);

  const order = s.orders[id]!;
  const workers = Object.values(s.workers)
    .filter((w) => w.orderId === id)
    .sort((a, b) => a.attempt - b.attempt);
  const reports = (s.reports[id] ?? []).map((r) => (copied ? movedRefCopies(r, id, month) : r));
  const refs = [...new Set(reports.flatMap((r) => r.refs))];
  const gates = Object.values(s.gates).filter((g) => g.orderId === id);
  const bypasses = s.bypasses.filter((b) => b.orderId === id);
  // `order show --json`과 같은 꼴. stateDir 대신 보관한 시각을 둔다
  const shown = { order, workers, reports, refs, gates, bypasses, archivedAt };
  writeDurable(join(target, 'order.json'), `${JSON.stringify(shown, null, 2)}\n`);
  fsyncDir(target);
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
