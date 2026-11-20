import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import type { RefCopy } from './types.js';

/**
 * 워커 보고의 refs 중 저장소 밖 로컬 텍스트 파일을 `refs/<주문 id>/`로 복사한다.
 *
 * 워커는 결과 원문을 /tmp나 자기 워크트리에 두고 경로만 보내는데 그 파일은 워커를 거두거나
 * 재부팅하면 사라진다. 2026-11-20 저장소를 확인했을 때 refs가 가리키는 파일의 35%쯤이 이미 없었다.
 * 보고를 적용할 때 사본을 남겨 두면 주문 결과를 나중에도 읽을 수 있다.
 */

export const REFS_DIR = 'refs';

/**
 * 파일 하나 상한. 2026-11-20 저장소의 보고 refs 중 남아 있던 로컬 파일 154개가
 * 중앙값 1.7KB, 99분위 91KB, 최대 111KB였다. 최대치의 두 배 넘게 잡아 정상 보고는 통째로 들어가고
 * 로그 덤프 같은 큰 파일만 앞부분이 남는다.
 */
export const REF_COPY_MAX_FILE_BYTES = 256 * 1024;

/**
 * 보고 하나 합계 상한. 같은 시점에 보고 하나에 실린 절대 경로는 많아야 3개였다.
 * refs 상한 20개가 전부 파일 상한까지 차도 저장소가 보고마다 5MB씩 늘지 않게 막는다.
 */
export const REF_COPY_MAX_REPORT_BYTES = 1024 * 1024;

export const REF_COPY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.log',
  '.json',
  '.diff',
  '.patch',
]);

/** 앞부분에 NUL이 있으면 확장자가 맞아도 바이너리로 본다 */
const BINARY_SNIFF_BYTES = 8 * 1024;
const SAFE_ORDER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_NAME_CHARS = 100;

export interface CopyRefsInput {
  stateDir: string;
  orderId: string;
  /** 보고 파일 이름. 사본 이름을 정해 같은 보고를 다시 처리해도 같은 파일에 쓴다 */
  reportName: string;
  refs: readonly string[];
  homeDir?: string;
  maxFileBytes?: number;
  maxReportBytes?: number;
}

/**
 * 복사한 결과를 돌려준다. 복사 대상이 아닌 ref(주소, 상대 경로, 디렉토리, 없는 파일,
 * 바이너리)는 결과에 넣지 않는다. 실패는 던지지 않고 `skipped: 'error'`로 남긴다.
 */
export function copyReportRefs(input: CopyRefsInput): RefCopy[] {
  const maxFile = input.maxFileBytes ?? REF_COPY_MAX_FILE_BYTES;
  let budget = input.maxReportBytes ?? REF_COPY_MAX_REPORT_BYTES;
  if (!SAFE_ORDER_ID.test(input.orderId)) return [];
  let stateReal: string;
  try {
    stateReal = realpathSync(input.stateDir);
  } catch {
    return [];
  }
  const home = input.homeDir ?? homedir();
  const out: RefCopy[] = [];
  for (const ref of input.refs) {
    const source = localPath(ref, home);
    if (!source || !REF_COPY_EXTENSIONS.has(extname(source).toLowerCase())) continue;
    if (insideStateDir(source, stateReal)) continue;
    let read: ReadResult | null;
    try {
      read = readSource(source, maxFile);
    } catch (err) {
      out.push({ ref, skipped: 'error', reason: message(err) });
      continue;
    }
    if (!read) continue;
    const size = read.size;
    if (read.data.length > budget) {
      out.push({ ref, skipped: 'report-limit', size });
      continue;
    }
    const rel = join(REFS_DIR, input.orderId, copyName(input.reportName, ref, source));
    try {
      writeCopy(input.stateDir, rel, read.data);
    } catch (err) {
      out.push({ ref, skipped: 'error', reason: message(err) });
      continue;
    }
    budget -= read.data.length;
    out.push({
      ref,
      path: rel.split(sep).join('/'),
      ...(read.data.length < size ? { truncated: true, size } : {}),
    });
  }
  return out;
}

/** 절대 경로와 `~/`만 받는다. 상대 경로는 워커 작업 디렉토리 기준이라 컨덕터가 풀 수 없다 */
function localPath(ref: string, home: string): string | null {
  const raw = ref.trim();
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) return null;
  const path = raw.startsWith('~/') ? join(home, raw.slice(2)) : raw;
  if (!isAbsolute(path)) return null;
  // `..`로 경로를 돌려 확장자 검사나 저장소 안 판정을 비켜 가지 못하게 아예 받지 않는다
  if (path.split(/[\\/]/).includes('..')) return null;
  return path;
}

function insideStateDir(source: string, stateReal: string): boolean {
  let parent: string;
  try {
    parent = realpathSync(dirname(source));
  } catch {
    return false;
  }
  const rel = relative(stateReal, parent);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

interface ReadResult {
  data: Buffer;
  size: number;
}

/**
 * 없는 파일, 디렉토리, 심링크, 바이너리면 null이다. 마지막 칸이 심링크면 `O_NOFOLLOW`로 열기부터 막는다.
 * 경로를 확인한 뒤 다시 열지 않고 연 fd로만 읽어서 그 사이에 파일이 바뀌어도 확인한 파일을 읽는다.
 */
function readSource(path: string, maxFile: number): ReadResult | null {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st || !st.isFile()) return null;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP' || code === 'EMLINK') return null;
    throw err;
  }
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile()) return null;
    const want = Math.min(fst.size, maxFile);
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const n = readSync(fd, buf, got, want - got, got);
      if (n === 0) break;
      got += n;
    }
    const data = buf.subarray(0, got);
    if (data.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null;
    return { data, size: Math.max(fst.size, got) };
  } finally {
    closeSync(fd);
  }
}

/** 같은 보고의 같은 ref는 늘 같은 이름이라 다시 처리해도 사본이 늘지 않는다 */
function copyName(reportName: string, ref: string, source: string): string {
  const hash = createHash('sha256').update(`${reportName}\0${ref}`).digest('hex').slice(0, 8);
  const base = basename(source)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '');
  return `${hash}-${base.slice(-MAX_NAME_CHARS) || 'ref'}`;
}

function writeCopy(stateDir: string, rel: string, data: Buffer): void {
  const target = join(stateDir, rel);
  // refs나 주문 디렉토리가 심링크로 바뀌어 있으면 저장소 밖에 쓰게 된다. 한 칸씩 만들고 바로 확인한다
  for (const d of [join(stateDir, REFS_DIR), dirname(target)]) {
    if (!lstatSync(d, { throwIfNoEntry: false })) mkdirSync(d);
    if (!lstatSync(d).isDirectory())
      throw new Error(`${relative(stateDir, d)}가 디렉토리가 아니에요`);
  }
  const tmp = `${target}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, data, { flag: 'wx' });
  try {
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // 임시 파일을 못 지워도 사본 결과에는 영향이 없다
    }
    throw err;
  }
}

function message(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}
