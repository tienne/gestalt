import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  activityDir,
  readsClaudeTranscript,
  readWorkerInfo,
  refreshTranscript,
  type WorkerActivityInfo,
} from './activity.js';
import { clean, type TextEntry, type ToolEvent, type TranscriptState } from './transcript.js';
import { ACTIVE_WORKER_STATUSES, type Worker } from './types.js';

/**
 * browse "작업 내용" 탭의 값과 워커가 끝날 때 남기는 타임라인 요약.
 *
 * 요약은 `activity/<워커 id>.summary.json`에 0600으로 둔다. tool 이름과 시각, 명령이나 설명 앞부분, 성공 여부,
 * todo, 서브에이전트, 고친 파일만 싣는다. 프롬프트와 답변, 파일 내용, tool 결과는 싣지 않는다.
 * 트랜스크립트가 지워졌거나 다른 머신으로 옮겨진 뒤에도 탭이 이 요약으로 그린다.
 */

const FILE_MODE = 0o600;
/** 요약에 남기는 명령과 설명 길이. 리더가 이미 자른 값을 한 번 더 줄인다 */
const SUMMARY_DETAIL_MAX = 60;
/** 요약 형식이 바뀌면 올린다. 읽는 쪽은 모르는 버전을 버린다 */
const SUMMARY_VERSION = 1;

export interface WorkSummary {
  version: number;
  workerId: string;
  savedAt: string;
  timeline: { at: string; tool: string; detail: string; ok?: boolean; ms?: number }[];
  tasks: { title: string; status: string }[] | null;
  subagents: { name: string; startedAt: string; state: string; endedAt?: string }[];
  changedFiles: string[] | null;
  partial: boolean;
}

const summaryPath = (stateDir: string, workerId: string) =>
  join(activityDir(stateDir), `${workerId.replace(/[^A-Za-z0-9_-]/g, '_')}.summary.json`);

export function readWorkSummary(stateDir: string, workerId: string): WorkSummary | undefined {
  try {
    const v = JSON.parse(readFileSync(summaryPath(stateDir, workerId), 'utf-8')) as WorkSummary;
    return v.version === SUMMARY_VERSION && Array.isArray(v.timeline) ? v : undefined;
  } catch {
    return undefined;
  }
}

function summaryOf(
  w: Worker,
  state: TranscriptState,
  info: WorkerActivityInfo,
  at: string,
): WorkSummary {
  const d = state.digest;
  return {
    version: SUMMARY_VERSION,
    workerId: w.id,
    savedAt: at,
    timeline: d.timeline.map((t) => ({
      at: t.at,
      tool: t.tool,
      detail: clean(t.detail, SUMMARY_DETAIL_MAX),
      ...(t.ok !== undefined ? { ok: t.ok } : {}),
      ...(t.ms !== undefined ? { ms: t.ms } : {}),
    })),
    tasks: d.tasks?.map((t) => ({ title: t.title, status: t.status })) ?? null,
    subagents: d.subagents.map((s) => ({
      name: s.name,
      startedAt: s.startedAt,
      state: s.state,
      ...(s.endedAt ? { endedAt: s.endedAt } : {}),
    })),
    changedFiles: info.changedFiles ?? null,
    partial: state.cursor.partial,
  };
}

function writeSummary(stateDir: string, summary: WorkSummary): void {
  const file = summaryPath(stateDir, summary.workerId);
  mkdirSync(activityDir(stateDir), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(summary), { mode: FILE_MODE });
  chmodSync(tmp, FILE_MODE);
  renameSync(tmp, file);
}

/**
 * 끝 상태가 된 워커의 타임라인 요약을 한 번 남긴다. tick이 부른다.
 * tick이 작업 내용을 저장해 둔 워커만 본다. 그 기록이 없는 옛 워커까지 트랜스크립트를 뒤지지 않게 해서다
 */
export function saveFinishedSummaries(
  stateDir: string,
  workers: Worker[],
  opts: { now: string; roots?: string[]; nextStartOf?: (w: Worker) => string | undefined },
): string[] {
  const saved: string[] = [];
  for (const w of workers) {
    if (ACTIVE_WORKER_STATUSES.has(w.status) || !readsClaudeTranscript(w)) continue;
    if (existsSync(summaryPath(stateDir, w.id))) continue;
    const info = readWorkerInfo(stateDir, w.id);
    if (!info.worktreePath) continue;
    const endedAt = opts.nextStartOf?.(w);
    const state = refreshTranscript(stateDir, w, info, {
      ...(opts.roots ? { roots: opts.roots } : {}),
      ...(endedAt ? { endedAt } : {}),
    });
    if (!state) continue;
    try {
      writeSummary(stateDir, summaryOf(w, state, info, opts.now));
      saved.push(w.id);
    } catch {
      // 요약은 보여 주기용이라 못 써도 tick은 계속 돈다
    }
  }
  return saved;
}

// ── browse 작업 내용 탭 ─────────────────────────────────────

export interface WorkSection {
  workerId: string;
  attempt: number;
  status: Worker['status'];
  startedAt: string;
  /** transcript는 트랜스크립트를 읽었고 summary는 저장한 요약으로 그렸다. none이면 둘 다 없다 */
  source: 'transcript' | 'summary' | 'none';
  timeline: { at: string; tool: string; detail: string; ok?: boolean; ms?: number }[];
  /** assistant가 쓴 글. 트랜스크립트를 읽었을 때만 있다 */
  texts: TextEntry[];
  tasks: { title: string; status: string }[] | null;
  subagents: { name: string; startedAt: string; state: string; endedAt?: string }[];
  changedFiles: string[] | null;
  partial: boolean;
}

export interface OrderWork {
  sections: WorkSection[];
  /** 아직 도는 워커가 있으면 화면이 몇 초마다 다시 부른다 */
  live: boolean;
}

/** 작업 내용 탭이 워커마다 들고 있는 리더 상태. 서버 메모리에만 두고 저장소 커서와 따로 굴린다 */
export type WorkReaderCache = Map<string, TranscriptState>;

const MAX_CACHED_READERS = 64;

function toolRow(t: ToolEvent): WorkSection['timeline'][number] {
  return {
    at: t.at,
    tool: t.tool,
    detail: t.detail,
    ...(t.ok !== undefined ? { ok: t.ok } : {}),
    ...(t.ms !== undefined ? { ms: t.ms } : {}),
  };
}

/**
 * 주문의 워커를 재개 회차 순으로 묶어 작업 내용을 만든다. 트랜스크립트는 캐시한 커서에서 새 줄만 읽는다.
 * 트랜스크립트를 못 찾으면 저장한 요약으로 그린다
 */
export function orderWork(
  stateDir: string,
  workers: Worker[],
  cache: WorkReaderCache,
  opts: { roots?: string[] } = {},
): OrderWork {
  const sorted = [...workers]
    .filter((w) => w.kind !== 'subagent')
    .sort((a, b) => a.attempt - b.attempt);
  const sections = sorted.map((w, i): WorkSection => {
    const info = readWorkerInfo(stateDir, w.id);
    const endedAt = sorted[i + 1]?.startedAt;
    const base = {
      workerId: w.id,
      attempt: w.attempt,
      status: w.status,
      startedAt: w.startedAt,
    };
    const state = refreshTranscript(stateDir, w, info, {
      keepText: true,
      noSave: true,
      ...(cache.has(w.id) ? { prev: cache.get(w.id)! } : {}),
      ...(opts.roots ? { roots: opts.roots } : {}),
      ...(endedAt ? { endedAt } : {}),
    });
    if (state) {
      cache.delete(w.id);
      cache.set(w.id, state);
      while (cache.size > MAX_CACHED_READERS) cache.delete(cache.keys().next().value!);
      const d = state.digest;
      return {
        ...base,
        source: 'transcript',
        timeline: d.timeline.map(toolRow),
        texts: d.texts ?? [],
        tasks: d.tasks?.map((t) => ({ title: t.title, status: t.status })) ?? null,
        subagents: d.subagents.map((s) => ({
          name: s.name,
          startedAt: s.startedAt,
          state: s.state,
          ...(s.endedAt ? { endedAt: s.endedAt } : {}),
        })),
        changedFiles: info.changedFiles ?? null,
        partial: state.cursor.partial,
      };
    }
    const s = readWorkSummary(stateDir, w.id);
    if (s) {
      return {
        ...base,
        source: 'summary',
        timeline: s.timeline,
        texts: [],
        tasks: s.tasks,
        subagents: s.subagents,
        changedFiles: s.changedFiles,
        partial: s.partial,
      };
    }
    return {
      ...base,
      source: 'none',
      timeline: [],
      texts: [],
      tasks: null,
      subagents: [],
      changedFiles: info.changedFiles ?? null,
      partial: false,
    };
  });
  return { sections, live: sorted.some((w) => ACTIVE_WORKER_STATUSES.has(w.status)) };
}
