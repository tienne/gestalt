import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Order, Worker } from './types.js';
import {
  locateWorkerTranscript,
  readTranscript,
  type AgentTask,
  type ReadOptions,
  type SubagentEntry,
  type ToolEvent,
  type TranscriptState,
} from './transcript.js';

/**
 * 워커 작업 내용의 저장 자리. 저장소 아래 `activity/`에 워커마다 파일 둘을 둔다.
 *
 * - `<워커 id>.json`: tick만 쓴다. 워크트리 경로, `git diff`로 모은 고친 파일, 파일 겹침, gate 멈춤 알림 기록이다.
 *   status는 읽기만 해서 플러그인이 자주 불러도 git을 돌리지 않는다.
 * - `<워커 id>.transcript.json`: 트랜스크립트 리더의 커서와 쌓은 값이다. status와 tick이 둘 다 갱신한다.
 *   둘이 겹쳐 써도 같은 줄을 다시 읽을 뿐이라 잃는 건 없다.
 *
 * 이벤트 로그(`events.jsonl`)에 넣지 않는 건 tick마다 바뀌는 값이라 로그가 불어나서다.
 * 파일은 사용자만 읽게 둔다(0600). 경로와 명령 앞부분이 들어 있다.
 */

export const ACTIVITY_DIR = 'activity';
const FILE_MODE = 0o600;

export interface WorkerActivityInfo {
  /** 워커 워크트리. 오르카 워커는 tick이 오르카에 물어 채운다 */
  worktreePath?: string;
  /** `git diff --name-only <기준>`과 추적 안 된 새 파일. 못 구했으면 비어 있다 */
  changedFiles?: string[];
  changedAt?: string;
  /** diff 기준으로 쓴 ref */
  changedBase?: string;
  /** 같은 레포에서 도는 다른 주문과 겹친 파일 */
  overlaps?: { orderId: string; files: string[] }[];
  /** 백그라운드 gate 뒤 멈춤 알림을 보낸 시각. 한 워커에 한 번만 보낸다 */
  gateStallNotifiedAt?: string;
  /** 이 워커 주문에 겹침 게이트를 이미 연 상대 주문. 사람이 답한 뒤 다시 열지 않는다 */
  overlapGated?: string[];
}

export function activityDir(stateDir: string): string {
  return join(stateDir, ACTIVITY_DIR);
}

const infoPath = (stateDir: string, workerId: string) =>
  join(activityDir(stateDir), `${safeId(workerId)}.json`);
const transcriptPath = (stateDir: string, workerId: string) =>
  join(activityDir(stateDir), `${safeId(workerId)}.transcript.json`);

/** 워커 id가 파일 이름이 되므로 경로 문자를 걷는다 */
function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as T;
  } catch {
    return undefined;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: FILE_MODE });
  chmodSync(tmp, FILE_MODE);
  renameSync(tmp, file);
}

export function readWorkerInfo(stateDir: string, workerId: string): WorkerActivityInfo {
  return readJson<WorkerActivityInfo>(infoPath(stateDir, workerId)) ?? {};
}

/** tick만 부른다. 앞 값 위에 덮어쓴다 */
export function updateWorkerInfo(
  stateDir: string,
  workerId: string,
  patch: Partial<WorkerActivityInfo>,
): WorkerActivityInfo {
  const next = { ...readWorkerInfo(stateDir, workerId), ...patch };
  writeJson(infoPath(stateDir, workerId), next);
  return next;
}

/** Claude Code 트랜스크립트를 남기는 워커인지. Codex 같은 다른 에이전트는 이번 범위에서 비운다 */
export function readsClaudeTranscript(w: Pick<Worker, 'kind' | 'agent'>): boolean {
  if (w.kind === 'subagent') return false;
  const agent = w.agent ?? 'claude';
  return agent === 'claude' || agent.startsWith('claude-');
}

/** 워커 워크트리 경로. git 워크트리 워커는 handle이 곧 경로라 tick을 기다리지 않는다 */
export function worktreeOf(w: Worker, info: WorkerActivityInfo): string | undefined {
  if (info.worktreePath) return info.worktreePath;
  if (w.kind === 'git-worktree' && w.handle) return w.handle;
  return undefined;
}

export interface RefreshOptions extends Pick<ReadOptions, 'keepText' | 'readLimit'> {
  roots?: string[];
  /** 다음 회차 워커 시작 시각. 그 뒤에 시작한 세션은 이 워커 것이 아니다 */
  endedAt?: string;
  /** 저장소 커서를 건드리지 않는다. 작업 내용 탭처럼 따로 상태를 들고 있는 쪽이 켠다 */
  noSave?: boolean;
  prev?: TranscriptState;
}

/**
 * 워커 트랜스크립트를 새 줄까지 읽는다. 못 찾거나 읽다 실패하면 undefined라 부르는 쪽은 필드를 비운다.
 * 이미 고른 파일이 남아 있으면 다시 고르지 않는다
 */
export function refreshTranscript(
  stateDir: string,
  w: Worker,
  info: WorkerActivityInfo,
  opts: RefreshOptions = {},
): TranscriptState | undefined {
  if (!readsClaudeTranscript(w)) return undefined;
  const cwd = worktreeOf(w, info);
  if (!cwd) return undefined;
  try {
    const prev =
      opts.prev ??
      (opts.noSave ? undefined : readJson<TranscriptState>(transcriptPath(stateDir, w.id)));
    const sessionId = w.sessionId;
    const reuse =
      prev &&
      (!sessionId || prev.cursor.file.endsWith(`${sessionId}.jsonl`)) &&
      existsSync(prev.cursor.file);
    const file = reuse
      ? prev.cursor.file
      : locateWorkerTranscript({
          cwd,
          startedAt: w.startedAt,
          ...(opts.endedAt ? { endedAt: opts.endedAt } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(opts.roots ? { roots: opts.roots } : {}),
        });
    if (!file) return undefined;
    const next = readTranscript(file, reuse ? prev : undefined, {
      cwd,
      ...(opts.keepText ? { keepText: true } : {}),
      ...(opts.readLimit ? { readLimit: opts.readLimit } : {}),
    });
    if (!opts.noSave && next !== prev) writeJson(transcriptPath(stateDir, w.id), next);
    return next;
  } catch {
    return undefined;
  }
}

// ── status --with-activity ────────────────────────────────

export interface OrderActivityFields {
  activity: { tool: string; file?: string; at: string } | null;
  changedFiles: string[] | null;
  tasks: {
    items: { title: string; status: AgentTask['status'] }[];
    done: number;
    total: number;
  } | null;
  subagents: { name: string; startedAt: string; state: SubagentEntry['state'] }[] | null;
  /** 최근 tool 호출 몇 개. 데스크톱 상세에서만 그린다 */
  recentTools: { at: string; tool: string; detail: string; ok?: boolean }[] | null;
  /** 트랜스크립트 앞부분을 건너뛰고 읽었으면 partial */
  history: 'full' | 'partial' | null;
  /** 같은 레포 다른 주문과 겹친 파일 */
  overlapFiles?: string[];
}

const RECENT_TOOLS = 8;

export const EMPTY_ACTIVITY: OrderActivityFields = {
  activity: null,
  changedFiles: null,
  tasks: null,
  subagents: null,
  recentTools: null,
  history: null,
};

/** status `--with-activity`가 주문마다 싣는 값. 워커가 없거나 읽지 못하면 필드를 비운다 */
export function orderActivity(
  stateDir: string,
  _order: Order,
  w: Worker | undefined,
  opts: RefreshOptions = {},
): OrderActivityFields {
  if (!w) return EMPTY_ACTIVITY;
  const info = readWorkerInfo(stateDir, w.id);
  const overlapFiles = [...new Set((info.overlaps ?? []).flatMap((o) => o.files))].sort();
  const base: OrderActivityFields = {
    ...EMPTY_ACTIVITY,
    changedFiles: info.changedFiles ?? null,
    ...(overlapFiles.length > 0 ? { overlapFiles } : {}),
  };
  const state = refreshTranscript(stateDir, w, info, opts);
  if (!state) return base;
  const d = state.digest;
  return {
    ...base,
    activity: d.activity,
    tasks: d.tasks
      ? {
          items: d.tasks.map((t) => ({ title: t.title, status: t.status })),
          done: d.tasks.filter((t) => t.status === 'completed').length,
          total: d.tasks.length,
        }
      : null,
    subagents: d.subagents.map((s) => ({ name: s.name, startedAt: s.startedAt, state: s.state })),
    recentTools: d.timeline.slice(-RECENT_TOOLS).map(toolLine),
    history: state.cursor.partial ? 'partial' : 'full',
  };
}

function toolLine(t: ToolEvent): { at: string; tool: string; detail: string; ok?: boolean } {
  return { at: t.at, tool: t.tool, detail: t.detail, ...(t.ok !== undefined ? { ok: t.ok } : {}) };
}
