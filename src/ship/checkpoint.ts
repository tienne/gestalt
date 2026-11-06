import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { LocalPrEngine } from '../local-pr/engine.js';
import { defaultRunner, type CmdRunner } from './ci.js';

/**
 * ship 이 단계와 라운드가 끝날 때마다 남기는 체크포인트.
 *
 * 라운드가 길면 대화가 압축되거나 세션이 끊기고 다시 부르면 처음부터 돌았다. 어디까지
 * 갔는지는 로컬 PR 과 GitHub PR 에 흩어져 있어 사람이 맞춰야 했다. 다시 부르면 이 파일을
 * 읽고 git 과 PR 상태가 그대로인지 확인한 뒤 이어서 돈다.
 *
 * 자리는 ship 이 이미 쓰는 git 디렉토리 아래 상태 자리다. 워크트리 안(`.gestalt/`)에 두면
 * 그걸 무시 목록에 안 넣은 남의 레포에서 커밋에 딸려 들어간다.
 */

export const SHIP_PHASES = ['0', '1', '2', 'a', '3', '4', 'ci', 'c'] as const;
export type ShipPhase = (typeof SHIP_PHASES)[number];

export type StopKind = 'blocked' | 'escalated';

export interface RoundRecord {
  phase: ShipPhase;
  round: number;
  issues: number;
  head: string;
}

export interface ShipCheckpoint {
  version: 1;
  branch: string;
  phase: ShipPhase;
  round: number | null;
  localPrId: string | null;
  prNumber: number | null;
  prUrl: string | null;
  base: string | null;
  verifyCmd: string | null;
  /** 저장할 때의 HEAD. 다시 부를 때 이 커밋에서 이어지는지 본다 */
  head: string;
  /** 다음에 할 일 한 줄. 이어서 돌 자리를 사람과 에이전트가 같이 읽는다 */
  next: string;
  stopped: StopKind | null;
  /** 라운드별 이슈 수. 완료 보고의 "7 → 2 → 0" 이 여기서 나온다 */
  history: RoundRecord[];
  savedAt: string;
}

export interface CheckpointPatch {
  phase: ShipPhase;
  next: string;
  round?: number;
  localPrId?: string;
  prNumber?: number;
  prUrl?: string;
  base?: string;
  verifyCmd?: string;
  /** 'none' 이면 멈춤 표시를 지운다 */
  stopped?: StopKind | 'none';
  issues?: number;
}

export const CHECKPOINT_FILE = 'checkpoint.json';

export function checkpointPath(dir: string): string {
  return join(dir, CHECKPOINT_FILE);
}

/**
 * 상대 경로를 막는다. 스킬 문서의 Bash 블록은 서로 변수를 안 나눠서 `$shipTmp` 가 빈
 * 문자열로 풀릴 수 있는데, 그러면 작업 디렉토리에 파일이 생겨 커밋에 섞인다.
 */
export function assertDir(dir: string | undefined): string {
  if (!dir || !isAbsolute(dir)) {
    throw new Error(`--dir 는 절대 경로여야 해요 (받은 값: ${JSON.stringify(dir ?? '')})`);
  }
  return dir;
}

export function isShipPhase(v: string): v is ShipPhase {
  return (SHIP_PHASES as readonly string[]).includes(v);
}

export type CheckpointRead =
  | { kind: 'none' }
  | { kind: 'ok'; checkpoint: ShipCheckpoint }
  | { kind: 'unreadable'; error: string };

export function readCheckpoint(dir: string): CheckpointRead {
  const path = checkpointPath(dir);
  if (!existsSync(path)) return { kind: 'none' };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ShipCheckpoint>;
    if (
      raw.version !== 1 ||
      typeof raw.phase !== 'string' ||
      !isShipPhase(raw.phase) ||
      typeof raw.head !== 'string'
    ) {
      return { kind: 'unreadable', error: '알 수 없는 형식이에요' };
    }
    return { kind: 'ok', checkpoint: raw as ShipCheckpoint };
  } catch (e) {
    return { kind: 'unreadable', error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 앞 체크포인트에 이번 값을 덧씌운다. 단계마다 아는 값이 달라서(로컬 PR id 는 1단계,
 * GitHub PR 번호는 3단계) 매번 전부 넘기게 하면 뒤 단계에서 앞 값을 잃는다.
 */
export function mergeCheckpoint(
  prev: ShipCheckpoint | null,
  patch: CheckpointPatch,
  observed: { branch: string; head: string },
  savedAt: string,
): ShipCheckpoint {
  const round = patch.round ?? prev?.round ?? null;
  const history = [...(prev?.history ?? [])];
  if (patch.issues !== undefined) {
    if (round === null) throw new Error('--issues 는 --round 와 함께 줘야 해요');
    const entry: RoundRecord = {
      phase: patch.phase,
      round,
      issues: patch.issues,
      head: observed.head,
    };
    const at = history.findIndex((h) => h.phase === entry.phase && h.round === entry.round);
    if (at >= 0) history[at] = entry;
    else history.push(entry);
  }
  const stopped =
    patch.stopped === undefined
      ? (prev?.stopped ?? null)
      : patch.stopped === 'none'
        ? null
        : patch.stopped;
  return {
    version: 1,
    branch: observed.branch,
    phase: patch.phase,
    round,
    localPrId: patch.localPrId ?? prev?.localPrId ?? null,
    prNumber: patch.prNumber ?? prev?.prNumber ?? null,
    prUrl: patch.prUrl ?? prev?.prUrl ?? null,
    base: patch.base ?? prev?.base ?? null,
    verifyCmd: patch.verifyCmd ?? prev?.verifyCmd ?? null,
    head: observed.head,
    next: patch.next,
    stopped,
    history,
    savedAt,
  };
}

export function writeCheckpoint(dir: string, cp: ShipCheckpoint): string {
  mkdirSync(dir, { recursive: true });
  const path = checkpointPath(dir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cp, null, 2)}\n`);
  renameSync(tmp, path);
  return path;
}

// ─── 다시 부를 때의 대조 ─────────────────────────────────────

export interface ObservedState {
  branch: string;
  head: string;
  /** 추적 중인 파일에 커밋 안 한 변경이 있는지. 새 파일은 안 본다 */
  dirty: boolean;
  /** 체크포인트의 head 가 지금 HEAD 의 조상인지(같으면 true) */
  cpHeadIsAncestor: boolean;
  /** 체크포인트 뒤에 쌓인 커밋 수 */
  aheadBy: number;
  localPr?: { found: false } | { found: true; status: string; headSha: string };
  pr?:
    | { ok: false; error: string }
    | { ok: true; state: string; isDraft: boolean; headRefOid: string; url: string };
}

export type MismatchKind =
  | 'branch'
  | 'head-ahead'
  | 'head-diverged'
  | 'dirty'
  | 'local-pr-missing'
  | 'local-pr-closed'
  | 'local-pr-head'
  | 'pr-closed'
  | 'pr-head'
  | 'pr-lookup-failed'
  | 'unreadable';

export interface Mismatch {
  kind: MismatchKind;
  detail: string;
}

/** 로컬 PR head 를 맞춰 보는 단계. 4단계부터는 GitHub 에서 고치므로 로컬 PR head 가 뒤처지는 게 정상이다 */
const LOCAL_PR_HEAD_PHASES: readonly ShipPhase[] = ['1', '2', 'a'];
const GITHUB_PHASES: readonly ShipPhase[] = ['3', '4', 'ci', 'c'];

const short = (sha: string): string => sha.slice(0, 7);

export function compareCheckpoint(cp: ShipCheckpoint, obs: ObservedState): Mismatch[] {
  const out: Mismatch[] = [];
  if (cp.branch !== obs.branch) {
    out.push({
      kind: 'branch',
      detail: `체크포인트는 ${cp.branch} 브랜치인데 지금은 ${obs.branch}예요`,
    });
  }
  if (!obs.cpHeadIsAncestor) {
    out.push({
      kind: 'head-diverged',
      detail: `체크포인트 커밋 ${short(cp.head)}가 지금 HEAD ${short(obs.head)}의 조상이 아니에요 (rebase나 reset)`,
    });
  } else if (obs.aheadBy > 0) {
    out.push({
      kind: 'head-ahead',
      detail: `체크포인트 뒤에 커밋이 ${obs.aheadBy}개 더 있어요 (${short(cp.head)} → ${short(obs.head)})`,
    });
  }
  if (obs.dirty) out.push({ kind: 'dirty', detail: '커밋 안 한 변경이 있어요' });

  if (cp.localPrId && obs.localPr) {
    if (!obs.localPr.found) {
      out.push({ kind: 'local-pr-missing', detail: `로컬 PR ${cp.localPrId}를 못 찾았어요` });
    } else if (obs.localPr.status === 'merged' || obs.localPr.status === 'closed') {
      out.push({
        kind: 'local-pr-closed',
        detail: `로컬 PR ${cp.localPrId}가 ${obs.localPr.status} 상태예요`,
      });
    } else if (LOCAL_PR_HEAD_PHASES.includes(cp.phase) && obs.localPr.headSha !== obs.head) {
      out.push({
        kind: 'local-pr-head',
        detail: `로컬 PR head ${short(obs.localPr.headSha)}가 지금 HEAD ${short(obs.head)}와 달라요`,
      });
    }
  }

  if (cp.prNumber !== null && GITHUB_PHASES.includes(cp.phase) && obs.pr) {
    if (!obs.pr.ok) {
      out.push({
        kind: 'pr-lookup-failed',
        detail: `GitHub PR #${cp.prNumber}를 못 읽었어요: ${obs.pr.error}`,
      });
    } else if (obs.pr.state !== 'OPEN') {
      out.push({
        kind: 'pr-closed',
        detail: `GitHub PR #${cp.prNumber}가 ${obs.pr.state} 상태예요`,
      });
    } else if (obs.pr.headRefOid !== obs.head) {
      out.push({
        kind: 'pr-head',
        detail: `GitHub PR head ${short(obs.pr.headRefOid)}가 지금 HEAD ${short(obs.head)}와 달라요 (push 안 했거나 원격이 바뀜)`,
      });
    }
  }
  return out;
}

export interface ObserveDeps {
  run: CmdRunner;
  localPr: (id: string) => { status: string; headSha: string } | null;
}

function git(run: CmdRunner, args: string[]): string {
  const r = run('git', args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 실패: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

export function observeState(cp: ShipCheckpoint, deps: ObserveDeps): ObservedState {
  const branch = git(deps.run, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = git(deps.run, ['rev-parse', 'HEAD']);
  const dirty = git(deps.run, ['status', '--porcelain', '--untracked-files=no']).length > 0;

  // 128 은 커밋을 못 찾은 경우다(gc 됐거나 다른 클론). 조상이 아닌 것과 똑같이 다룬다
  const anc = deps.run('git', ['merge-base', '--is-ancestor', cp.head, 'HEAD']);
  const cpHeadIsAncestor = anc.status === 0;
  const aheadBy = cpHeadIsAncestor
    ? Number(git(deps.run, ['rev-list', '--count', `${cp.head}..HEAD`]))
    : 0;

  const obs: ObservedState = { branch, head, dirty, cpHeadIsAncestor, aheadBy };

  if (cp.localPrId) {
    const pr = deps.localPr(cp.localPrId);
    obs.localPr = pr ? { found: true, ...pr } : { found: false };
  }

  if (cp.prNumber !== null && GITHUB_PHASES.includes(cp.phase)) {
    const r = deps.run('gh', [
      'pr',
      'view',
      String(cp.prNumber),
      '--json',
      'state,isDraft,headRefOid,url',
    ]);
    if (r.status !== 0) {
      obs.pr = { ok: false, error: r.stderr.trim().split(/\r?\n/)[0] || `종료 코드 ${r.status}` };
    } else {
      try {
        const v = JSON.parse(r.stdout) as {
          state?: unknown;
          isDraft?: unknown;
          headRefOid?: unknown;
          url?: unknown;
        };
        obs.pr = {
          ok: true,
          state: String(v.state ?? ''),
          isDraft: v.isDraft === true,
          headRefOid: String(v.headRefOid ?? ''),
          url: String(v.url ?? ''),
        };
      } catch {
        obs.pr = { ok: false, error: 'gh pr view 출력을 JSON으로 못 읽었어요' };
      }
    }
  }
  return obs;
}

export function defaultObserveDeps(run: CmdRunner = defaultRunner): ObserveDeps {
  return {
    run,
    localPr: (id) => {
      const root = git(run, ['rev-parse', '--show-toplevel']);
      const engine = new LocalPrEngine(root);
      try {
        const pr = engine.get(id);
        return pr ? { status: pr.status, headSha: pr.headSha } : null;
      } finally {
        engine.dispose();
      }
    },
  };
}

export type CheckReport =
  | { status: 'none' }
  | { status: 'match'; checkpoint: ShipCheckpoint; observed: ObservedState; mismatches: [] }
  | {
      status: 'mismatch';
      checkpoint: ShipCheckpoint | null;
      observed: ObservedState | null;
      mismatches: Mismatch[];
    };

export function checkCheckpoint(dir: string, deps: ObserveDeps): CheckReport {
  const read = readCheckpoint(dir);
  if (read.kind === 'none') return { status: 'none' };
  if (read.kind === 'unreadable') {
    return {
      status: 'mismatch',
      checkpoint: null,
      observed: null,
      mismatches: [{ kind: 'unreadable', detail: `체크포인트를 못 읽었어요: ${read.error}` }],
    };
  }
  const observed = observeState(read.checkpoint, deps);
  const mismatches = compareCheckpoint(read.checkpoint, observed);
  if (mismatches.length === 0)
    return { status: 'match', checkpoint: read.checkpoint, observed, mismatches: [] };
  return { status: 'mismatch', checkpoint: read.checkpoint, observed, mismatches };
}

export function saveCheckpoint(
  dir: string,
  patch: CheckpointPatch,
  run: CmdRunner = defaultRunner,
  now = new Date(),
): ShipCheckpoint {
  const read = readCheckpoint(dir);
  const prev = read.kind === 'ok' ? read.checkpoint : null;
  const branch = git(run, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = git(run, ['rev-parse', 'HEAD']);
  const cp = mergeCheckpoint(prev, patch, { branch, head }, now.toISOString());
  writeCheckpoint(dir, cp);
  return cp;
}
