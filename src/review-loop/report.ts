import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchPrSnapshot, runGh, type GhRunner } from './fetch.js';
import { deriveSignal, type LoopSignal } from './signal.js';
import { countPending } from './threads.js';
import { LOGIN_FILE, REVIEWED_HEAD_FILE, stateDir } from './state.js';

export interface LoopStateReport {
  prNumber: number;
  prState: string;
  open: boolean;
  head: string;
  reviewedHead: string | null;
  changed: boolean;
  rerequested: boolean;
  me: string;
  totalThreads: number;
  pending: number;
  signal: LoopSignal;
}

/**
 * 판정에 쓰는 수를 전부 만든다.
 *
 * 부르는 쪽이 이 함수 하나만 보면 되도록 조회와 집계와 신호 도출을 여기서 잇는다.
 * 문서가 이 셋을 따로 적던 때는 각 코드블록이 다른 Bash 호출이라 앞 블록의 값이 뒤에서
 * 빈 문자열로 풀렸다. 그 빈 값이 미대응 0 으로 읽혀 승인이 나갔다.
 */
export function readLoopState(
  opts: { prNumber: number; me?: string; cwd?: string },
  gh: GhRunner = runGh,
): LoopStateReport {
  const cwd = opts.cwd ?? process.cwd();
  const dir = stateDir(opts.prNumber, cwd);
  const me = opts.me?.trim() || resolveLogin(dir, gh);
  const { owner, repo } = resolveRepo(gh);

  const snapshot = fetchPrSnapshot({ owner, repo, prNumber: opts.prNumber }, gh);

  const reviewedPath = join(dir, REVIEWED_HEAD_FILE);
  const reviewedHead = existsSync(reviewedPath)
    ? readFileSync(reviewedPath, 'utf-8').trim() || null
    : null;

  const pending = countPending(snapshot.threads, me);
  const open = snapshot.prState === 'OPEN';
  // 첫 라운드는 비교할 이전 head 가 없다. 그때 changed 를 참으로 두면 리뷰도 안 한
  // 커밋을 "새 커밋이 왔다"로 읽으므로 거짓으로 둔다
  const changed = reviewedHead !== null && snapshot.headRefOid !== reviewedHead;
  const rerequested = snapshot.requestedReviewers.includes(me);

  return {
    prNumber: opts.prNumber,
    prState: snapshot.prState,
    open,
    head: snapshot.headRefOid,
    reviewedHead,
    changed,
    rerequested,
    me,
    totalThreads: snapshot.threads.length,
    pending,
    signal: deriveSignal({ open, pending, changed, rerequested }),
  };
}

/**
 * 내 로그인. 캐시가 있으면 그걸 쓰고 없으면 조회한다.
 *
 * 캐시 파일이 비어 있으면 조회로 떨어진다. 셸로 적던 때는 `gh api user > my-login` 이
 * 종료 코드를 안 봐서 인증이 끊긴 순간 0 바이트 파일이 남았다. 그 뒤 모든 라운드가
 * 빈 로그인으로 집계해 미대응이 영구히 0 이 됐다.
 */
function resolveLogin(dir: string, gh: GhRunner): string {
  const cached = join(dir, LOGIN_FILE);
  if (existsSync(cached)) {
    const value = readFileSync(cached, 'utf-8').trim();
    if (value) return value;
  }
  const login = gh(['api', 'user', '--jq', '.login']).trim();
  if (!login) throw new Error('내 로그인을 못 읽었다 — gh 인증을 확인한다');
  return login;
}

function resolveRepo(gh: GhRunner): { owner: string; repo: string } {
  const raw = gh(['repo', 'view', '--json', 'owner,name']).trim();
  const parsed = JSON.parse(raw) as { owner?: { login?: string }; name?: string };
  const owner = parsed.owner?.login;
  const repo = parsed.name;
  if (!owner || !repo) throw new Error('레포를 못 읽었다 — origin 원격을 확인한다');
  return { owner, repo };
}
