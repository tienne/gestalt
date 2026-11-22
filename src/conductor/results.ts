import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';
import { isControlChar } from './intake.js';
import { orcaWorktreeName } from './launcher.js';
import { BASE_FILE, EVENTS_FILE, replayStore } from './store.js';
import type {
  BypassRecord,
  ConductorSnapshot,
  Gate,
  Order,
  StoredReport,
  Worker,
} from './types.js';

/**
 * 컨덕터 결과 뷰어의 데이터 계층. 터미널 명령과 웹 뷰어가 같이 쓴다.
 *
 * 저장소에는 아무것도 쓰지 않는다. `ConductorStore.open()`은 디렉토리를 만들고
 * tick과 같은 파일을 만지므로 쓰지 않고 이벤트 로그를 직접 재생한다.
 * 워커 보고의 refs와 그 파일 본문은 워커가 적은 값이라 신뢰하지 않는다. 읽을 수 있는 자리를
 * 허용 루트 아래로 묶고 확장자와 크기도 제한한다.
 */

/** 본문을 읽어도 되는 확장자. 그 밖은 경로만 보여준다 */
export const READABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.log',
  '.json',
  '.diff',
  '.patch',
]);

/** 이보다 큰 파일은 앞부분만 읽는다 */
export const MAX_FULL_READ_BYTES = 1024 * 1024;
export const TRUNCATED_READ_BYTES = 256 * 1024;
/** 디렉토리 ref 하나에서 보여줄 파일 수 상한 */
export const MAX_DIR_ENTRIES = 50;
/** 본문 캐시 상한. 서버가 오래 떠 있어도 읽은 본문이 메모리에 끝없이 쌓이지 않게 한다 */
export const BODY_CACHE_MAX_ENTRIES = 256;
export const BODY_CACHE_MAX_CHARS = 32 * 1024 * 1024;

/** "주문 없음" 묶음을 모으는 저장소 하위 디렉토리. 프롬프트나 인계 파일 같은 운영 파일 자리는 뺀다 */
export const UNLINKED_DIRS = [
  'reports',
  'refs',
  'results',
  'artifacts',
  'notes',
  'drafts',
] as const;

/** 저장소 최상위에서 이 이름으로 시작하는 디렉토리도 "주문 없음" 수집 대상이다 */
export const UNLINKED_DIR_PREFIX_RE = /^(?:ord|wrk)-/;
const ORDER_ID_RE = /ord-[0-9a-f]{8}/g;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

export type RefKind = 'file' | 'dir' | 'url' | 'outside' | 'missing' | 'unsupported' | 'reference';

export interface DirEntry {
  name: string;
  path: string;
  size: number;
}

export interface ClassifiedRef {
  kind: RefKind;
  /** 워커가 적은 원래 값 */
  ref: string;
  /** file, dir이면 실제 경로 */
  path?: string;
  /** 화면에 보일 값. url이면 정규화한 주소 */
  display: string;
  size?: number;
  entries?: DirEntry[];
  /** dir이면 자르기 전 읽을 수 있는 파일 수. entries는 앞 MAX_DIR_ENTRIES개뿐이다 */
  entriesTotal?: number;
}

export interface RefContext {
  /** 실제 경로로 푼 허용 루트 */
  roots: readonly string[];
  /** 그 주문 오르카 워커의 워크트리 디렉토리 이름. 이 이름이 경로 조각에 있으면 그 아래를 허용한다 */
  worktreeNames: readonly string[];
}

export interface FileBody {
  text: string;
  truncated: boolean;
  size: number;
}

export interface ResultFile {
  /** 웹 뷰어가 파일을 가리킬 때 쓰는 불투명 키. 경로를 요청으로 받지 않으려고 둔다 */
  key: string;
  path: string;
  /** 저장소 기준 상대 경로 */
  rel: string;
  size: number;
  mtime: string;
  /** 이름에 주문 id가 있어 그 주문에 붙인 파일이면 그 id */
  orderId?: string;
}

export type IndexedReport = StoredReport & { at: string; index: number };

export interface OrderRefs {
  refs: ClassifiedRef[];
  /** refs 항목마다 처음 적힌 보고 번호(1부터) */
  firstReport: number[];
}

export interface LoadedResults {
  stateDir: string;
  snapshot: ConductorSnapshot;
  /** repoPaths를 실제 경로로 푼 값 */
  repoRoots: string[];
  orderRefs: Map<string, OrderRefs>;
  /** 어떤 주문 refs에도 안 걸린 저장소 파일. orderId가 있으면 이름으로 붙인 관련 파일이다 */
  files: ResultFile[];
  fileByKey: Map<string, ResultFile>;
  /** 주문 id별 관련 파일. files에서 orderId가 있는 것만 */
  filesByOrder: Map<string, ResultFile[]>;
  bodies: BodyCache;
}

/**
 * 읽은 본문 캐시. 키는 경로와 mtime, 크기라 파일이 바뀌면 다음 읽기에서 새로 읽는다.
 * 개수와 글자 수 상한을 넘으면 가장 오래 안 쓴 것부터 버린다
 */
export class BodyCache {
  private readonly map = new Map<string, FileBody>();
  private chars = 0;

  constructor(
    private readonly maxEntries = BODY_CACHE_MAX_ENTRIES,
    private readonly maxChars = BODY_CACHE_MAX_CHARS,
  ) {}

  get size(): number {
    return this.map.size;
  }

  get(key: string): FileBody | undefined {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, body: FileBody): void {
    const old = this.map.get(key);
    if (old) {
      this.chars -= old.text.length;
      this.map.delete(key);
    }
    this.map.set(key, body);
    this.chars += body.text.length;
    for (const [k, v] of this.map) {
      if (this.map.size <= this.maxEntries && this.chars <= this.maxChars) break;
      if (k === key) break;
      this.map.delete(k);
      this.chars -= v.text.length;
    }
  }
}

export interface LoadOptions {
  stateDir: string;
  repoPaths?: Record<string, string>;
  /** 다시 로드해도 본문 캐시를 이어 쓰려면 넘긴다. 키에 mtime과 크기가 있어 바뀐 파일은 새로 읽는다 */
  bodies?: BodyCache;
}

export function loadResults(opts: LoadOptions): LoadedResults {
  if (!existsSync(opts.stateDir) || !statSync(opts.stateDir).isDirectory()) {
    throw new Error(`상태 저장소가 없어요: ${opts.stateDir}`);
  }
  const eventsPath = join(opts.stateDir, EVENTS_FILE);
  if (!existsSync(eventsPath) && !existsSync(join(opts.stateDir, BASE_FILE))) {
    throw new Error(`${eventsPath}가 없어요. 받은 주문이 아직 없어요`);
  }
  const stateDir = realpathSync(opts.stateDir);
  const snapshot = replayStore(stateDir);
  const repoRoots = realRoots(Object.values(opts.repoPaths ?? {}));

  const orderRefs = new Map<string, OrderRefs>();
  for (const id of Object.keys(snapshot.orders)) {
    const ctx = refContext(snapshot, id, stateDir, repoRoots);
    const seen = new Map<string, number>();
    const firstReport: number[] = [];
    const refs: ClassifiedRef[] = [];
    (snapshot.reports[id] ?? []).forEach((r, i) => {
      for (const ref of r.refs) {
        if (seen.has(ref)) continue;
        seen.set(ref, refs.length);
        refs.push(classifyRef(ref, ctx));
        firstReport.push(i + 1);
      }
    });
    orderRefs.set(id, { refs, firstReport });
  }

  const linked = new Set<string>();
  const linkedDirs: string[] = [];
  for (const { refs } of orderRefs.values()) {
    for (const r of refs) {
      if (r.kind === 'file' && r.path) linked.add(r.path);
      if (r.kind === 'dir' && r.path) linkedDirs.push(r.path);
    }
  }
  const files = collectUnlinkedFiles(
    stateDir,
    linked,
    linkedDirs,
    new Set(Object.keys(snapshot.orders)),
  );
  const filesByOrder = new Map<string, ResultFile[]>();
  for (const f of files) {
    if (!f.orderId) continue;
    const list = filesByOrder.get(f.orderId);
    if (list) list.push(f);
    else filesByOrder.set(f.orderId, [f]);
  }
  return {
    stateDir,
    snapshot,
    repoRoots,
    orderRefs,
    files,
    fileByKey: new Map(files.map((f) => [f.key, f])),
    filesByOrder,
    bodies: opts.bodies ?? new BodyCache(),
  };
}

function realRoots(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (!isAbsolute(p)) continue;
    try {
      out.push(realpathSync(p));
    } catch {
      // 지금 없는 레포 경로는 허용 루트에서 뺀다
    }
  }
  return out;
}

export function refContext(
  snapshot: ConductorSnapshot,
  orderId: string,
  stateDir: string,
  repoRoots: readonly string[],
): RefContext {
  const workers = Object.values(snapshot.workers).filter((w) => w.orderId === orderId);
  const worktrees = realRoots(
    workers.filter((w) => w.kind === 'git-worktree' && w.handle).map((w) => w.handle!),
  );
  return {
    roots: [stateDir, ...repoRoots, ...worktrees],
    worktreeNames: workers.filter((w) => w.kind === 'orca-worktree').map(orcaWorktreeName),
  };
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function allowed(real: string, ctx: RefContext): boolean {
  if (ctx.roots.some((r) => within(real, r))) return true;
  // 오르카 워커의 워크트리 경로는 저장소에 안 남는다. 워크트리 디렉토리 이름이 주문 id와 회차라 그 이름으로 가린다
  const parts = real.split(sep);
  return ctx.worktreeNames.some((n) => parts.slice(0, -1).includes(n));
}

/**
 * refs 항목 하나를 분류한다. 본문은 읽지 않는다.
 * 파일 후보는 절대 경로뿐이다. 심링크와 `..`는 실제 경로로 푼 뒤 허용 루트와 비교해 막는다.
 */
export function classifyRef(ref: string, ctx: RefContext): ClassifiedRef {
  const value = ref.trim();
  const base = { ref, display: value };
  if (URL_SCHEME_RE.test(value) && !isAbsolute(value)) {
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return { ...base, kind: 'url', display: url.href };
      }
    } catch {
      // 주소 꼴이 아니면 글자로 보여준다
    }
    return { ...base, kind: 'reference' };
  }
  if (!isAbsolute(value) || value.includes('\0')) return { ...base, kind: 'reference' };

  let real: string;
  try {
    real = realpathSync(value);
  } catch {
    return { ...base, kind: 'missing' };
  }
  if (!allowed(real, ctx)) return { ...base, kind: 'outside' };
  let st;
  try {
    st = statSync(real);
  } catch {
    return { ...base, kind: 'missing' };
  }
  if (st.isDirectory()) {
    const { entries, total } = dirEntries(real);
    return { ...base, kind: 'dir', path: real, entries, entriesTotal: total };
  }
  if (!st.isFile() || !READABLE_EXTENSIONS.has(extname(real).toLowerCase())) {
    return { ...base, kind: 'unsupported' };
  }
  return { ...base, kind: 'file', path: real, size: st.size };
}

/** 디렉토리 바로 아래 읽을 수 있는 파일. 심링크는 Dirent가 파일로 안 쳐서 빠진다 */
function dirEntries(dir: string): { entries: DirEntry[]; total: number } {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && READABLE_EXTENSIONS.has(extname(d.name).toLowerCase()))
      .map((d) => d.name)
      .sort();
  } catch {
    return { entries: [], total: 0 };
  }
  const out: DirEntry[] = [];
  for (const name of names.slice(0, MAX_DIR_ENTRIES)) {
    const path = join(dir, name);
    try {
      out.push({ name, path, size: statSync(path).size });
    } catch {
      // 목록을 읽은 사이 지워진 파일은 뺀다
    }
  }
  return { entries: out, total: names.length };
}

/**
 * 허용 루트 아래 텍스트 파일을 읽는다. 분류한 뒤에 파일이 심링크로 바뀌었을 수 있어 읽기 직전에 다시 확인한다.
 * 확인한 뒤 여는 사이의 교체는 두 경우만 막는다. 마지막 경로 요소가 심링크로 바뀌면 O_NOFOLLOW로 열기가 실패한다.
 * 다른 파일로 바뀌면 연 fd의 dev, ino가 확인한 파일과 달라 버린다. 중간 디렉토리가 바뀌는 경우는 막지 않는다.
 * 조건에 안 맞거나 읽다 실패하면 null.
 */
export function readTextFile(path: string, roots: readonly string[]): FileBody | null {
  let real: string;
  try {
    if (lstatSync(path).isSymbolicLink()) return null;
    real = realpathSync(path);
  } catch {
    return null;
  }
  if (!roots.some((r) => within(real, r))) return null;
  if (!READABLE_EXTENSIONS.has(extname(real).toLowerCase())) return null;
  let fd: number;
  let checked;
  try {
    checked = statSync(real);
    // FIFO를 열면 쓰는 쪽이 올 때까지 멈춘다. 열기 전에 일반 파일만 남기고 O_NONBLOCK도 건다
    if (!checked.isFile()) return null;
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.dev !== checked.dev || st.ino !== checked.ino) return null;
    const truncated = st.size > MAX_FULL_READ_BYTES;
    const want = truncated ? TRUNCATED_READ_BYTES : st.size;
    const buf = Buffer.alloc(want);
    let read = 0;
    while (read < want) {
      const n = readSync(fd, buf, read, want - read, read);
      if (n === 0) break;
      read += n;
    }
    return { text: buf.subarray(0, read).toString('utf-8'), truncated, size: st.size };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** 분류된 ref의 본문. file이 아니면 null. 디렉토리 항목은 `entry`(0부터)로 고른다 */
export function readRefBody(
  results: LoadedResults,
  orderId: string,
  ref: ClassifiedRef,
  entry?: number,
): FileBody | null {
  const ctx = refContext(results.snapshot, orderId, results.stateDir, results.repoRoots);
  const fresh = classifyRef(ref.ref, ctx);
  if (entry !== undefined) {
    if (fresh.kind !== 'dir' || !fresh.path) return null;
    const e = fresh.entries?.[entry];
    return e ? cachedBody(results, e.path, [fresh.path], { store: true }) : null;
  }
  if (fresh.kind !== 'file' || !fresh.path) return null;
  return cachedBody(results, fresh.path, [dirOf(fresh.path)], { store: true });
}

/**
 * 검색용. 로드 때 분류한 경로를 다시 분류하지 않고 읽는다. 바뀐 파일은 readTextFile이 읽기 직전에 다시 막는다
 */
function loadedRefBody(
  results: LoadedResults,
  ref: ClassifiedRef,
  entry?: number,
): FileBody | null {
  if (!ref.path) return null;
  if (entry !== undefined) {
    const e = ref.kind === 'dir' ? ref.entries?.[entry] : undefined;
    return e ? cachedBody(results, e.path, [ref.path], NO_STORE) : null;
  }
  return ref.kind === 'file' ? cachedBody(results, ref.path, [dirOf(ref.path)], NO_STORE) : null;
}

/** 저장소 파일 본문. 키로만 고른다. 검색은 `cache: false`로 불러 캐시를 채우지 않는다 */
export function readResultFile(
  results: LoadedResults,
  key: string,
  opts: { cache?: boolean } = {},
): FileBody | null {
  const file = results.fileByKey.get(key);
  if (!file) return null;
  return cachedBody(results, file.path, [results.stateDir], { store: opts.cache !== false });
}

function dirOf(path: string): string {
  const i = path.lastIndexOf(sep);
  return i <= 0 ? sep : path.slice(0, i);
}

const NO_STORE = { store: false } as const;

/**
 * 못 읽은 결과는 캐시하지 않는다. 잠깐 난 권한 오류가 파일이 바뀔 때까지 남지 않게 한다.
 * 검색은 파일을 한 번씩 훑기만 해서 `store`를 끈다. 켜 두면 검색 한 번이 상세 화면에서 연 본문을 밀어낸다.
 * 심링크는 캐시 키가 같아 보여도 가리키는 대상이 바뀔 수 있어서 캐시를 보기 전에 막는다
 */
function cachedBody(
  results: LoadedResults,
  path: string,
  roots: string[],
  { store }: { store: boolean },
): FileBody | null {
  let st;
  try {
    st = lstatSync(path, { throwIfNoEntry: false });
  } catch {
    // 파일 아래를 가리키는 경로는 throwIfNoEntry를 꺼도 ENOTDIR로 던진다
    return null;
  }
  if (!st || st.isSymbolicLink()) return null;
  const key = `${path}\0${st.mtimeMs}\0${st.size}`;
  const hit = results.bodies.get(key);
  if (hit) return hit;
  const body = readTextFile(path, roots);
  if (body && store) results.bodies.set(key, body);
  return body;
}

/**
 * 어느 주문 refs에도 안 걸린 저장소 파일을 모은다.
 * 파일 이름이나 상위 디렉토리 이름에 있는 주문 id로 그 주문의 관련 파일로 붙인다. 못 붙이면 주문 없음이다.
 */
export function collectUnlinkedFiles(
  stateDir: string,
  linked: ReadonlySet<string>,
  linkedDirs: readonly string[],
  orderIds: ReadonlySet<string>,
): ResultFile[] {
  const paths: string[] = [];
  const top = readdirSync(stateDir, { withFileTypes: true });
  const dirs: string[] = [...UNLINKED_DIRS];
  // 워커가 저장소 최상위에 주문이나 워커 id로 만든 결과 디렉토리도 모은다. Dirent가 심링크는 디렉토리로 안 친다
  for (const d of top)
    if (d.isDirectory() && UNLINKED_DIR_PREFIX_RE.test(d.name)) dirs.push(d.name);
  for (const name of dirs) {
    const dir = join(stateDir, name);
    if (!existsSync(dir) || lstatSync(dir).isSymbolicLink()) continue;
    for (const d of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (d.isFile()) paths.push(join(d.parentPath, d.name));
    }
  }
  for (const d of top) {
    const ext = extname(d.name).toLowerCase();
    if (d.isFile() && (ext === '.md' || ext === '.markdown')) paths.push(join(stateDir, d.name));
  }

  const out: ResultFile[] = [];
  for (const path of paths) {
    if (!READABLE_EXTENSIONS.has(extname(path).toLowerCase())) continue;
    if (linked.has(path) || linkedDirs.some((dir) => within(path, dir))) continue;
    const rel = relative(stateDir, path);
    const st = statSync(path);
    const orderId = [...rel.matchAll(ORDER_ID_RE)].map((m) => m[0]).find((id) => orderIds.has(id));
    out.push({
      key: fileKey(rel),
      path,
      rel,
      size: st.size,
      mtime: st.mtime.toISOString(),
      ...(orderId ? { orderId } : {}),
    });
  }
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime) || a.rel.localeCompare(b.rel));
}

function fileKey(rel: string): string {
  return createHash('sha256').update(rel).digest('hex').slice(0, 16);
}

export interface ResultFilters {
  repo?: string;
  status?: string;
  /** 이 시각 뒤에 갱신된 것만. Date.parse가 읽는 값 */
  since?: string;
  issueKey?: string;
}

export interface OrderSummary {
  id: string;
  title: string;
  repo: string;
  status: string;
  issueKey?: string;
  prRef?: string;
  createdAt: string;
  updatedAt: string;
  reportCount: number;
  refCount: number;
  relatedCount: number;
  lastReportAt?: string;
}

/** `--since` 값. 날짜만 적으면 화면의 날짜와 맞게 로컬 자정으로 읽는다. 날짜로 못 읽으면 던진다 */
export function parseSince(v: string): number {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (day) {
    const [y, m, d] = [Number(day[1]!), Number(day[2]!), Number(day[3]!)];
    const local = new Date(y, m - 1, d);
    if (local.getFullYear() === y && local.getMonth() === m - 1 && local.getDate() === d) {
      return local.getTime();
    }
    throw new Error(`--since는 2026-11-01 같은 날짜여야 해요: ${v}`);
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`--since는 2026-11-01 같은 날짜여야 해요: ${v}`);
  return t;
}

function matchesFilters(o: Order, f: ResultFilters, since: number | undefined): boolean {
  if (f.repo && o.repo !== f.repo) return false;
  if (f.status && o.status !== f.status) return false;
  if (f.issueKey && o.issueKey !== f.issueKey) return false;
  if (since !== undefined && Date.parse(o.updatedAt) < since) return false;
  return true;
}

function filteredOrders(results: LoadedResults, f: ResultFilters): Order[] {
  const since = f.since ? parseSince(f.since) : undefined;
  return Object.values(results.snapshot.orders)
    .filter((o) => matchesFilters(o, f, since))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

function relatedFiles(results: LoadedResults, orderId: string): ResultFile[] {
  return results.filesByOrder.get(orderId) ?? [];
}

export function summarize(results: LoadedResults, o: Order): OrderSummary {
  const reports = results.snapshot.reports[o.id] ?? [];
  const last = reports[reports.length - 1];
  return {
    id: o.id,
    title: o.title,
    repo: o.repo,
    status: o.status,
    ...(o.issueKey ? { issueKey: o.issueKey } : {}),
    ...(o.prRef ? { prRef: o.prRef } : {}),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    reportCount: reports.length,
    refCount: results.orderRefs.get(o.id)?.refs.length ?? 0,
    relatedCount: relatedFiles(results, o.id).length,
    ...(last ? { lastReportAt: last.at } : {}),
  };
}

export function listOrders(
  results: LoadedResults,
  filters: ResultFilters = {},
): { total: number; orders: OrderSummary[] } {
  const orders = filteredOrders(results, filters);
  return { total: orders.length, orders: orders.map((o) => summarize(results, o)) };
}

export type ResolvedOrderId =
  | { ok: true; id: string }
  | { ok: false; reason: 'unknown' | 'removed' | 'ambiguous'; candidates: string[] };

/** 주문 id. 앞부분만 적어도 하나로 정해지면 받는다 */
export function resolveOrderId(results: LoadedResults, input: string): ResolvedOrderId {
  const { orders, removedOrders } = results.snapshot;
  if (Object.hasOwn(orders, input)) return { ok: true, id: input };
  if (Object.hasOwn(removedOrders, input)) return { ok: false, reason: 'removed', candidates: [] };
  const hits = input ? Object.keys(orders).filter((id) => id.startsWith(input)) : [];
  if (hits.length === 1) return { ok: true, id: hits[0]! };
  return { ok: false, reason: hits.length > 1 ? 'ambiguous' : 'unknown', candidates: hits.sort() };
}

export interface OrderDetail {
  order: Order;
  workers: Worker[];
  reports: IndexedReport[];
  gates: Gate[];
  bypasses: BypassRecord[];
  refs: (ClassifiedRef & { index: number; firstReport: number })[];
  related: ResultFile[];
}

export function getOrderDetail(results: LoadedResults, id: string): OrderDetail | undefined {
  const s = results.snapshot;
  const order = s.orders[id];
  if (!order) return undefined;
  const { refs, firstReport } = results.orderRefs.get(id) ?? { refs: [], firstReport: [] };
  return {
    order,
    workers: Object.values(s.workers).filter((w) => w.orderId === id),
    reports: (s.reports[id] ?? []).map((r, i) => ({ ...r, index: i + 1 })),
    gates: Object.values(s.gates)
      .filter((g) => g.orderId === id)
      .sort((a, b) => a.openedAt.localeCompare(b.openedAt)),
    bypasses: s.bypasses.filter((b) => b.orderId === id),
    refs: refs.map((r, i) => ({ ...r, index: i + 1, firstReport: firstReport[i] ?? 0 })),
    related: relatedFiles(results, id),
  };
}

export type HitSource = 'title' | 'summary' | 'ref' | 'file';

export interface SearchHit {
  orderId: string | null;
  title: string;
  repo: string | null;
  at: string;
  source: HitSource;
  /** title, summary, 또는 파일 경로. refs는 워커가 적은 원문 경로고 디렉토리 항목은 그 뒤에 파일 이름을 붙인다 */
  where: string;
  /** summary면 보고 번호(1부터) */
  reportIndex?: number;
  /** ref면 refs 번호(1부터)와 디렉토리 항목 번호(0부터) */
  refIndex?: number;
  entryIndex?: number;
  /** 저장소 파일이면 그 키와 실제 경로 */
  fileKey?: string;
  absPath?: string;
  /** 본문이면 줄 번호(1부터) */
  line?: number;
  /** 이 파일에서 맞았지만 파일당 상한에 걸려 결과로 안 만든 줄 수 */
  moreInFile?: number;
  /** 파일이 커서 앞부분만 읽고 찾았으면 true */
  partial?: boolean;
  excerpt: string;
  /** excerpt 안에서 맞은 자리 */
  matchStart: number;
  matchLength: number;
}

export interface SearchOptions extends ResultFilters {
  /** 끄면 요약과 제목만 찾는다 */
  body?: boolean;
  limit?: number;
}

export interface SearchResults {
  query: string;
  total: number;
  hits: SearchHit[];
  /** 크기가 커서 앞부분만 읽고 찾은 파일 수. 맞은 줄이 없어도 센다. 0이면 뺀다 */
  partialFiles?: number;
}

const EXCERPT_RADIUS = 80;
/** 파일 하나에서 내는 결과 수 상한. 한 파일이 결과를 다 차지하지 않게 한다 */
const MAX_HITS_PER_FILE = 3;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 맞은 자리 앞뒤로 잘라 한 줄로 만든다. 개행과 제어 문자는 공백으로 바꾼다.
 * 대소문자를 무시하는 정규식으로 원문 위치를 그대로 잡는다. toLowerCase는 길이가 바뀌는 글자가 있어 위치가 어긋난다.
 */
export function excerpt(
  text: string,
  re: RegExp,
  radius = EXCERPT_RADIUS,
): { excerpt: string; matchStart: number; matchLength: number } | null {
  re.lastIndex = 0;
  const m = re.exec(text);
  if (!m) return null;
  return excerptAt(text, m.index, m[0].length, radius);
}

function excerptAt(
  text: string,
  index: number,
  length: number,
  radius: number,
): { excerpt: string; matchStart: number; matchLength: number } {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  const head = start > 0 ? '…' : '';
  const tail = end < text.length ? '…' : '';
  const before = head + flat(text.slice(start, index));
  return {
    excerpt:
      before +
      flat(text.slice(index, index + length)) +
      flat(text.slice(index + length, end)) +
      tail,
    matchStart: before.length,
    matchLength: length,
  };
}

function flat(s: string): string {
  let out = '';
  for (const ch of s) out += isControlChar(ch.codePointAt(0)!) ? ' ' : ch;
  return out;
}

type HitBase = Omit<SearchHit, 'line' | 'excerpt' | 'matchStart' | 'matchLength'>;

/** 맞은 건수는 모두 세고 결과 객체는 limit까지만 만든다. limit 뒤에 excerpt를 만들 일이 없게 한다 */
interface HitSink {
  hits: SearchHit[];
  total: number;
  limit: number;
  /** 같은 파일을 가리키는 주문이 여럿이어도 한 번만 세려고 경로로 모은다 */
  partialPaths: Set<string>;
}

function addHit(sink: HitSink, make: () => SearchHit): SearchHit | undefined {
  sink.total++;
  if (sink.hits.length >= sink.limit) return undefined;
  const hit = make();
  sink.hits.push(hit);
  return hit;
}

/** 읽은 범위 안에서 맞은 줄을 다 센다. 결과는 파일당 앞 MAX_HITS_PER_FILE건만 만든다 */
function bodyHits(sink: HitSink, path: string, body: FileBody, re: RegExp, base: HitBase): number {
  // 0건이어도 뒷부분에 있을 수 있다고 알려야 해서 맞았는지와 무관하게 센다
  if (body.truncated) sink.partialPaths.add(path);
  // 본문 전체에서 안 맞으면 어느 줄에서도 안 맞는다. 큰 본문을 줄로 쪼개지 않고 끝낸다
  // re는 g, y 플래그 없이 만들어 lastIndex가 test 결과에 영향을 주지 않는다
  if (!re.test(body.text)) return 0;
  const lines = body.text.split('\n');
  const extra = body.truncated ? { partial: true } : {};
  let matched = 0;
  let last: SearchHit | undefined;
  let made = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    re.lastIndex = 0;
    const m = re.exec(line);
    if (!m) continue;
    matched++;
    if (matched > MAX_HITS_PER_FILE) {
      sink.total++;
      continue;
    }
    const hit = addHit(sink, () => ({
      ...base,
      ...extra,
      line: i + 1,
      ...excerptAt(line, m.index, m[0].length, EXCERPT_RADIUS),
    }));
    if (hit) {
      last = hit;
      made++;
    }
  }
  if (last && matched > made) last.moreInFile = matched - made;
  return matched;
}

/**
 * 제목과 보고 요약, 읽을 수 있는 refs 본문, 저장소 파일에서 찾는다. 대소문자는 무시한다.
 * 결과는 주문 갱신순이고 한 주문 안에서는 제목, 요약(최근 보고 먼저), refs, 관련 파일 순이다. 주문 없음 파일은 끝에 온다.
 * total은 맞은 건수 전부다. 파일당 상한과 limit에 걸려 결과로 안 만든 것도 센다.
 */
export function searchResults(
  results: LoadedResults,
  query: string,
  opts: SearchOptions = {},
): SearchResults {
  const q = query.trim();
  if (!q) return { query: q, total: 0, hits: [] };
  const re = new RegExp(escapeRegExp(q), 'iu');
  // 줄 단위로 찾으니 개행이 든 검색어는 본문에서 맞을 수 없다. 제목과 요약만 찾는다
  const body = opts.body !== false && !q.includes('\n');
  const sink: HitSink = {
    hits: [],
    total: 0,
    limit: opts.limit ?? Infinity,
    partialPaths: new Set(),
  };

  for (const o of filteredOrders(results, opts)) {
    const head = { orderId: o.id, title: o.title, repo: o.repo };
    const t = excerpt(o.title, re);
    if (t)
      addHit(sink, () => ({ ...head, at: o.updatedAt, source: 'title', where: 'title', ...t }));
    const reports = results.snapshot.reports[o.id] ?? [];
    for (let i = reports.length - 1; i >= 0; i--) {
      const r = reports[i]!;
      re.lastIndex = 0;
      if (!re.test(r.summary)) continue;
      addHit(sink, () => ({
        ...head,
        at: r.at,
        source: 'summary',
        where: 'summary',
        reportIndex: i + 1,
        ...excerpt(r.summary, re)!,
      }));
    }
    if (!body) continue;
    const { refs, firstReport } = results.orderRefs.get(o.id) ?? { refs: [], firstReport: [] };
    refs.forEach((ref, i) => {
      const at = reports[(firstReport[i] ?? 1) - 1]?.at ?? o.updatedAt;
      if (ref.kind === 'file') {
        const b = loadedRefBody(results, ref);
        if (b) {
          bodyHits(sink, ref.path!, b, re, {
            ...head,
            at,
            source: 'ref',
            where: ref.display,
            refIndex: i + 1,
          });
        }
      } else if (ref.kind === 'dir') {
        (ref.entries ?? []).forEach((entry, j) => {
          const b = loadedRefBody(results, ref, j);
          if (!b) return;
          bodyHits(sink, entry.path, b, re, {
            ...head,
            at,
            source: 'ref',
            where: `${ref.display.replace(/\/+$/, '')}/${entry.name}`,
            refIndex: i + 1,
            entryIndex: j,
          });
        });
      }
    });
    for (const f of relatedFiles(results, o.id)) fileHits(sink, results, f, re, head);
  }

  // 주문 없는 파일에는 레포나 상태, 지라 키가 없다. 그중 하나라도 필터를 걸었으면 뺀다
  if (body && !opts.repo && !opts.status && !opts.issueKey) {
    const since = opts.since ? parseSince(opts.since) : undefined;
    for (const f of results.files) {
      if (f.orderId) continue;
      if (since !== undefined && Date.parse(f.mtime) < since) continue;
      fileHits(sink, results, f, re, { orderId: null, title: f.rel, repo: null });
    }
  }

  return {
    query: q,
    total: sink.total,
    hits: sink.hits,
    ...(sink.partialPaths.size > 0 ? { partialFiles: sink.partialPaths.size } : {}),
  };
}

function fileHits(
  sink: HitSink,
  results: LoadedResults,
  f: ResultFile,
  re: RegExp,
  head: { orderId: string | null; title: string; repo: string | null },
): void {
  const b = readResultFile(results, f.key, { cache: false });
  const base = {
    ...head,
    at: f.mtime,
    source: 'file' as const,
    where: f.rel,
    fileKey: f.key,
    absPath: f.path,
  };
  const matched = b ? bodyHits(sink, f.path, b, re, base) : 0;
  if (matched > 0) return;
  // 본문에 없고 이름에만 있으면 이름으로 한 건 낸다
  const name = excerpt(basename(f.rel), re);
  if (name) addHit(sink, () => ({ ...base, ...name }));
}
