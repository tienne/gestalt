import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { CodeGraphStore, FileStatRow } from './storage.js';

/**
 * mtime이 마지막 확인 시각에서 이만큼 안쪽이면 stat이 같아도 다시 읽는다.
 * 확인 직후 같은 mtime 해상도 안에서 다시 쓰인 파일은 size까지 같으면
 * stat만으로 구분이 안 된다 (git의 racy-clean과 같은 문제다).
 * FAT 계열이 2초 해상도라 그 폭에 맞췄다.
 */
export const RACY_WINDOW_MS = 2000;

export interface FileStamp {
  filePath: string;
  size: number;
  mtimeMs: number;
}

export interface DriftReport {
  /** 그래프에 없던 파일 */
  added: FileStamp[];
  /** 내용이 바뀐 파일 */
  modified: FileStamp[];
  /** 디스크에서 사라진 파일 */
  removed: string[];
  /** stat만 바뀌고 내용은 그대로인 파일. 재파싱하지 않고 stat만 고쳐 쓴다 */
  touched: FileStatRow[];
  /** stat이 같아 읽지 않고 넘긴 파일 수 */
  unchanged: number;
  durationMs: number;
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function hasStructuralDrift(d: DriftReport): boolean {
  return d.added.length > 0 || d.modified.length > 0 || d.removed.length > 0;
}

export function hasAnyDrift(d: DriftReport): boolean {
  return hasStructuralDrift(d) || d.touched.length > 0;
}

/**
 * 디스크의 현재 파일 목록과 store를 맞대 바뀐 파일을 가린다. store에는 쓰지 않는다.
 *
 * - size와 mtime이 둘 다 같으면 파일을 읽지 않는다
 * - 하나라도 다르면 읽어서 해시로 확정한다
 * - stat 행이 없고 노드만 있는 파일은 stat 컬럼이 생기기 전에 빌드된 DB다.
 *   노드의 file_hash로 한 번 확정하고 나면 다음부터는 stat으로 넘어간다
 */
export function detectDrift(store: CodeGraphStore, currentFiles: string[]): DriftReport {
  const start = Date.now();
  const stats = store.getAllFileStats();
  const graphFiles = new Set(store.getGraphFilePaths());
  const report: DriftReport = {
    added: [],
    modified: [],
    removed: [],
    touched: [],
    unchanged: 0,
    durationMs: 0,
  };

  const current = new Set(currentFiles);
  for (const filePath of currentFiles) {
    let size: number;
    let mtimeMs: number;
    try {
      const st = statSync(filePath);
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      // 목록을 뽑은 뒤 지워진 파일이다. 다음 검사에서 removed로 잡힌다
      continue;
    }
    const stamp = { filePath, size, mtimeMs };
    const row = stats.get(filePath);

    if (row) {
      const racy = row.mtimeMs >= row.checkedAt - RACY_WINDOW_MS;
      if (row.size === size && row.mtimeMs === mtimeMs && !racy) {
        report.unchanged++;
        continue;
      }
      classifyByHash(report, stamp, row.fileHash);
      continue;
    }

    if (graphFiles.has(filePath)) {
      classifyByHash(report, stamp, store.getFileHash(filePath));
      continue;
    }

    report.added.push(stamp);
  }

  for (const filePath of new Set([...stats.keys(), ...graphFiles])) {
    if (!current.has(filePath)) report.removed.push(filePath);
  }

  report.durationMs = Date.now() - start;
  return report;
}

function classifyByHash(report: DriftReport, stamp: FileStamp, knownHash: string | null): void {
  let hash: string;
  try {
    hash = hashContent(readFileSync(stamp.filePath, 'utf-8'));
  } catch {
    // 못 읽으면 바뀐 걸로 보고 빌드에 넘긴다. 빌드가 skippedFiles로 남긴다
    report.modified.push(stamp);
    return;
  }
  if (knownHash !== null && hash === knownHash) {
    report.touched.push({ ...stamp, fileHash: hash, checkedAt: Date.now() });
  } else {
    report.modified.push(stamp);
  }
}
