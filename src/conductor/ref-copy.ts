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
  rmSync,
  unlinkSync,
  writeFileSync,
  type Stats,
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
export const SAFE_ORDER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_NAME_CHARS = 100;

/**
 * 홈 아래 `Library`에서 복사를 허용하는 자리. 오르카가 에이전트에게 붙여 준 파일을 두는 곳이라
 * 2026-11-20 저장소의 refs에 실제로 나왔다. 나머지 `Library`는 앱 설정과 키체인이 있어 막는다
 */
const LIBRARY_ALLOWED = [
  join('Library', 'Application Support', 'orca', 'agent-session-attachments'),
  join('Library', 'Application Support', 'orca', 'chat-scratch'),
];

/**
 * 이름에 이 말이 들어간 파일은 확장자가 맞아도 비밀 값으로 보고 복사하지 않는다. 부분 일치라
 * `design-tokens.json`처럼 비밀이 아닌 파일도 막힌다. 놓치는 쪽보다 덜 복사하는 쪽을 골랐다
 */
const SECRET_NAME = /credential|secret|token/;

/**
 * 위 세 낱말 밖에서 비밀 값 파일에 흔한 이름 꼴. 확장자를 뗀 이름을 구분자로 나눠 끝 낱말을 본다.
 * `password-reset-flow.md`처럼 그 말로 시작하는 리뷰 문서는 막지 않는다
 */
const SECRET_LAST_WORDS = new Set([
  'password',
  'passwords',
  'passwd',
  'apikey',
  'auth',
  'kubeconfig',
]);
/** 끝 낱말이 auth여도 문서 확장자면 `login-auth.md` 같은 리뷰 문서로 보고 복사한다 */
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);
/** `.env`, `.env.local` 같은 환경 변수 파일. 예시 파일은 값이 없어 막지 않는다 */
const DOTENV = /^\.env(\.|$)/;
const DOTENV_SAMPLE = /\.(example|sample|template)$/;
const SECRET_STEM = /(^|[-_.])(api[-_]?key|private[-_]?key|service[-_]?account(-key)?)$/;

/**
 * 저장소 안이어도 복사하는 자리. git 워크트리 워커의 작업 디렉토리라 워커를 거두면 같이 지워진다
 */
const WORKTREES_DIR = 'worktrees';

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
 * 바이너리)는 결과에 넣지 않는다. 비밀 값이 있을 만한 자리나 이름은 확장자와 상관없이 `skipped: 'denied'`로 남기고
 * 실패는 던지지 않고 `skipped: 'error'`로 남긴다.
 */
export function copyReportRefs(input: CopyRefsInput): RefCopy[] {
  const maxFile = input.maxFileBytes ?? REF_COPY_MAX_FILE_BYTES;
  let budget = input.maxReportBytes ?? REF_COPY_MAX_REPORT_BYTES;
  if (!SAFE_ORDER_ID.test(input.orderId)) return [];
  let stateReal: string;
  try {
    stateReal = realpathSync.native(input.stateDir);
  } catch {
    return [];
  }
  const worktreesReal = join(stateReal, WORKTREES_DIR);
  const home = input.homeDir ?? homedir();
  const homeReal = realOrSelf(home);
  const out: RefCopy[] = [];
  const seen = new Set<string>();
  // 다른 ref 문자열이 같은 파일을 가리키면 처음 사본을 같이 쓴다
  const copiedByReal = new Map<string, RefCopy>();
  for (const ref of input.refs) {
    // 같은 ref가 두 번 오면 사본 이름도 같다. 한 번만 쓰고 예산도 한 번만 깎는다
    if (seen.has(ref)) continue;
    seen.add(ref);
    const source = localPath(ref, home);
    if (!source) continue;
    const isDenied = (real: string): boolean =>
      isSecretName(real) ||
      // 기본 저장소가 홈 점 디렉토리(`~/.gestalt`) 아래라 워크트리 파일은 위치 판정을 건너뛴다.
      // 실제 경로로 판정하므로 워크트리 밖을 가리키는 심링크는 여기 안 걸린다
      (!isInside(worktreesReal, real) &&
        (isSecretLocation(source, home) || isSecretLocation(real, homeReal)));
    if (!REF_COPY_EXTENSIONS.has(extname(source).toLowerCase())) {
      // 복사 대상이 아니어도 비밀 자리나 이름이면 남긴다. 사본도 기록도 없으면 원래 경로를 읽게 되기 때문이다
      const real = realOrSelf(source);
      const inState = isInside(stateReal, real) && !isInside(worktreesReal, real);
      if (!inState && isDenied(real)) out.push({ ref, skipped: 'denied' });
      continue;
    }
    let found: Located | null;
    try {
      found = locate(source);
    } catch (err) {
      out.push({ ref, skipped: 'error', reason: message(err) });
      continue;
    }
    if (!found) continue;
    if (isInside(stateReal, found.real) && !isInside(worktreesReal, found.real)) continue;
    if (isDenied(found.real)) {
      out.push({ ref, skipped: 'denied' });
      continue;
    }
    const earlier = copiedByReal.get(found.real);
    if (earlier) {
      out.push({ ...earlier, ref });
      continue;
    }
    // 남은 예산에 앞부분조차 못 담는 파일은 읽지도 않는다. tick 잠금 안에서 도는 동기 IO라서다
    if (Math.min(found.st.size, maxFile) > budget) {
      out.push({ ref, skipped: 'report-limit', size: found.st.size });
      continue;
    }
    let read: ReadResult | null;
    try {
      read = readSource(found, maxFile);
    } catch (err) {
      out.push({ ref, skipped: 'error', reason: message(err) });
      continue;
    }
    if (!read) continue;
    const size = read.size;
    // 판정한 뒤에 파일이 커졌을 수 있어 읽은 크기로 한 번 더 본다
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
    const copied: RefCopy = {
      ref,
      path: rel.split(sep).join('/'),
      ...(read.data.length < size ? { truncated: true, size } : {}),
    };
    copiedByReal.set(found.real, copied);
    out.push(copied);
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

function realOrSelf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** target이 base 안쪽이면 true다. `..cache` 같은 이름의 하위 디렉토리도 안쪽이다 */
function isInside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function isSecretName(path: string): boolean {
  const name = basename(path).toLowerCase();
  if (SECRET_NAME.test(name)) return true;
  if (DOTENV.test(name) && !DOTENV_SAMPLE.test(name)) return true;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const words = stem.split(/[-_.\s]+/);
  const last = words[words.length - 1]!;
  return (
    (SECRET_LAST_WORDS.has(last) && !(last === 'auth' && MARKDOWN_EXTENSIONS.has(ext))) ||
    SECRET_STEM.test(stem) ||
    words.includes('adminsdk')
  );
}

/**
 * 비밀 값이 있을 만한 자리면 true다. 부르는 쪽이 워커가 적은 경로와 풀린 실제 경로를 둘 다 넘긴다.
 * 실제 경로로는 중간 심링크로 `~/.config`를 가리킨 경우를 잡는다. 적은 경로로는 `~/.docker`가
 * 다른 디렉토리로 가는 심링크인 경우를 잡는다.
 * 홈 바로 아래 점 디렉토리(`~/.claude`, `~/.config`)만 막고 레포 안 `.git/`처럼 깊은 점 디렉토리는 둔다.
 * 2026-11-20 저장소의 refs 중 72개가 레포 `.git/` 아래 리뷰 산출물이었다.
 * macOS 기본 파일 시스템은 대소문자를 안 가려 `~/library`도 같은 자리라 소문자로 비교한다
 */
function isSecretLocation(path: string, home: string): boolean {
  const lowerHome = home.toLowerCase();
  const lowerPath = path.toLowerCase();
  // 홈 앞부분 대소문자만 바꿔 적어도 같은 자리라 홈 안 판정부터 소문자로 한다
  if (!isInside(lowerHome, lowerPath)) return false;
  const rel = relative(lowerHome, lowerPath);
  const first = rel.split(sep)[0]!;
  if (first.startsWith('.')) return true;
  if (first !== 'library') return false;
  return !LIBRARY_ALLOWED.some((dir) => rel.startsWith(dir.toLowerCase() + sep));
}

interface Located {
  real: string;
  st: Stats;
}

/**
 * 없는 파일, 디렉토리, 마지막 칸이 심링크인 경로면 null이다. 중간 디렉토리 심링크는 막지 않고 풀어서
 * 실제 위치를 돌려준다. macOS의 `/tmp`와 `/var`가 `/private` 아래로 가는 심링크라 막으면 워커 결과를 두는
 * 주된 자리가 다 빠진다
 */
function locate(source: string): Located | null {
  const own = lstatSync(source, { throwIfNoEntry: false });
  if (!own || !own.isFile()) return null;
  let real: string;
  try {
    // native는 macOS에서 디스크에 적힌 대소문자로 돌려준다. JS 구현은 받은 대소문자를 그대로 둔다
    real = realpathSync.native(source);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const st = lstatSync(real, { throwIfNoEntry: false });
  if (!st || !st.isFile()) return null;
  return { real, st };
}

interface ReadResult {
  data: Buffer;
  size: number;
}

/**
 * 판정한 실제 경로를 `O_NOFOLLOW`로 열고 연 파일이 판정한 파일과 같은지 dev와 ino로 확인한다.
 * 그 사이에 바뀌었으면 null이다. 그다음은 연 fd로만 읽는다. 바이너리도 null이다
 */
function readSource(found: Located, maxFile: number): ReadResult | null {
  let fd: number;
  try {
    fd = openSync(found.real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP' || code === 'EMLINK') return null;
    throw err;
  }
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.dev !== found.st.dev || fst.ino !== found.st.ino) return null;
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
    if (!lstatSync(d, { throwIfNoEntry: false })) mkdirSync(d, { mode: 0o700 });
    if (!lstatSync(d).isDirectory())
      throw new Error(`${relative(stateDir, d)}가 디렉토리가 아니에요`);
  }
  const tmp = `${target}.${randomUUID().slice(0, 8)}.tmp`;
  // 원본이 0600인 파일도 있어서 사본은 소유자만 읽게 쓴다
  writeFileSync(tmp, data, { flag: 'wx', mode: 0o600 });
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

/**
 * 지운 주문의 사본 디렉토리를 지운다. `refs`가 심링크면 저장소 밖을 지우게 된다. 주문 디렉토리가
 * 심링크면 누가 사본 자리를 바꿔 둔 것이라 손대지 않고 알린다. 못 지우면 이유를 돌려주고 던지지 않는다
 */
export function removeOrderRefCopies(stateDir: string, orderId: string): string | undefined {
  if (!SAFE_ORDER_ID.test(orderId)) return `주문 id 꼴이 이상해 사본을 안 지웠어요: ${orderId}`;
  try {
    const refs = join(stateDir, REFS_DIR);
    const top = lstatSync(refs, { throwIfNoEntry: false });
    if (!top) return undefined;
    if (!top.isDirectory()) return `${REFS_DIR}가 디렉토리가 아니라 사본을 안 지웠어요`;
    const dir = join(refs, orderId);
    const own = lstatSync(dir, { throwIfNoEntry: false });
    if (!own) return undefined;
    if (!own.isDirectory()) return `${REFS_DIR}/${orderId}가 디렉토리가 아니라 사본을 안 지웠어요`;
    rmSync(dir, { recursive: true, force: true });
    return undefined;
  } catch (err) {
    return `${REFS_DIR}/${orderId} 사본을 못 지웠어요: ${message(err)}`;
  }
}

function message(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}
