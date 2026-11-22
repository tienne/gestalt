import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { ConductorStore } from '../../../src/conductor/store.js';
import type { Order, StoredReport, Worker } from '../../../src/conductor/types.js';
import { order, tempStateDir, worker } from './fixtures.js';

const outsideDirs: string[] = [];

/** 상태 저장소 밖의 임시 디렉토리. 허용 루트 밖 경로를 만들 때 쓴다 */
export function outsideDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'conductor-results-')));
  outsideDirs.push(dir);
  return dir;
}

export function cleanupOutsideDirs(): void {
  for (const d of outsideDirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** 상위 디렉토리를 만들며 파일을 쓴다. 절대 경로를 돌려준다 */
export function put(path: string, text = '내용'): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

export interface SeedReport extends Partial<StoredReport> {
  at?: string;
}

export interface SeedOrder {
  order?: Partial<Order>;
  worker?: Partial<Worker>;
  reports?: SeedReport[];
}

/**
 * 주문과 워커, 보고를 이벤트 로그로 심는다. 보고는 워커가 있는 주문에만 붙는다.
 * 저장소 디렉토리는 절대 경로로 돌려준다.
 */
export function seed(
  orders: SeedOrder[],
  dir = tempStateDir(),
): { dir: string; abs: string; ids: string[]; workers: Worker[] } {
  const store = ConductorStore.open(dir);
  const ids: string[] = [];
  const workers: Worker[] = [];
  for (const s of orders) {
    const o = order(s.order);
    store.addOrder(o);
    ids.push(o.id);
    const w = worker(o.id, s.worker);
    store.startWorker(w);
    workers.push(w);
    for (const [i, r] of (s.reports ?? []).entries()) {
      const { at, ...rest } = r;
      store.append({
        type: 'report-applied',
        at: at ?? `2026-11-01T00:0${i}:00.000Z`,
        name: `r-${o.id}-${i}.json`,
        report: { workerId: w.id, status: 'done', summary: '요약', refs: [], ...rest },
      });
    }
  }
  return { dir, abs: resolve(dir), ids, workers };
}

/** ESC, BEL, 개행 같은 제어 문자가 남았는지. 정규식 대신 코드 값으로 본다(no-control-regex) */
export function hasControl(s: string, keepNewline = false): boolean {
  return [...s].some((ch) => {
    const c = ch.codePointAt(0)!;
    return (c < 0x20 && !(keepNewline && c === 0x0a)) || c === 0x7f;
  });
}

/** 디렉토리 아래 모든 항목의 이름과 크기, mtime. atime은 읽기만 해도 바뀌어 넣지 않는다 */
export function snapshotTree(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .map((d) => {
      const path = join(d.parentPath, d.name);
      const st = lstatSync(path);
      return `${relative(dir, path)}\t${st.size}\t${st.mtimeMs}`;
    })
    .sort();
}
