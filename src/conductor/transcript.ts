import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs';
import { maskSecrets } from '../architecture/secret-mask.js';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { cwdSlug, isSessionId } from '../peer/locate.js';
import {
  LAUNCHED_STATUSES,
  SHELL_TOOLS,
  SUBAGENT_TOOLS,
  TASK_TOOLS,
  TODO_TOOLS,
  WRITE_TOOLS,
} from './transcript-tools.js';

/**
 * 컨덕터 워커의 Claude Code 트랜스크립트 리더.
 *
 * `~/.claude/projects/<워크트리 경로를 인코딩한 디렉토리>/<세션 id>.jsonl` 끝에서 정해진 크기까지만 읽고
 * 읽은 위치를 커서에 남겨 다음엔 새 줄만 읽는다. 처음 읽을 때 앞부분을 건너뛰면 `history: 'partial'`이다.
 * 트랜스크립트는 문서화되지 않은 형식이라 모르는 줄은 건너뛰고 읽다 실패하면 부르는 쪽이 필드를 비운다.
 * 보조 신호라서 이 모듈이 실패해도 컨덕터 동작은 바뀌지 않아야 한다.
 *
 * 읽는 방식은 agenttrail(github.com/sodiumsun/agenttrail)의 `bin/lib/claude.mjs`, `logtail.mjs`, `tasks.mjs`를
 * 따랐다. 서브에이전트가 쓴 자기 트랜스크립트(`<세션 id>/subagents/`)는 읽지 않는다.
 */

/** 한 번에 읽는 상한. agenttrail과 같다 */
export const READ_LIMIT = 2 * 1024 * 1024;
const HEAD_BYTES = 256 * 1024;
const DETAIL_MAX = 90;
const MAX_PENDING = 64;
const MAX_TIMELINE = 300;
const MAX_SUBAGENTS = 50;
const MAX_TASKS = 100;
const MAX_TEXTS = 200;
const TEXT_MAX = 400;
/** 세션 시작 시각이 워커 시작보다 이만큼 앞서도 그 워커 세션으로 본다. 시계 차이와 띄우는 순서 몫이다 */
const START_SLACK_MS = 5 * 60_000;

export type TaskStatus = 'pending' | 'in_progress' | 'completed';
const LIVE_TASK = new Set<string>(['pending', 'in_progress', 'completed']);

export interface AgentTask {
  id?: string;
  title: string;
  status: TaskStatus;
}

export type SubagentState = 'running' | 'detached' | 'done';

export interface SubagentEntry {
  /** 띄운 tool 호출 id. 완료 알림을 이 값으로 짝짓는다 */
  id: string;
  name: string;
  startedAt: string;
  state: SubagentState;
  endedAt?: string;
}

export interface ToolEvent {
  id: string;
  at: string;
  tool: string;
  /** 명령이나 경로, 설명의 앞부분 한 줄 */
  detail: string;
  /** 결과를 못 봤으면 비어 있다 */
  ok?: boolean;
  ms?: number;
}

export interface ActivityNow {
  tool: string;
  /** 고치는 파일. 워크트리 안이면 상대 경로다 */
  file?: string;
  at: string;
}

export interface TextEntry {
  at: string;
  text: string;
}

interface PendingCall {
  tool: string;
  at: string;
  detail: string;
  file?: string;
  subagent?: true;
  task?: TaskInput;
}

interface TaskInput {
  taskId?: string;
  subject?: string;
  status?: string;
  merge?: boolean;
  todos?: AgentTask[];
}

/** 백그라운드로 gate를 띄운 자리. turnEndedAt이 차면 그 뒤로 턴이 끝난 채 머문다는 뜻이다 */
export interface BackgroundGate {
  at: string;
  turnEndedAt?: string;
}

/** 트랜스크립트를 읽어 쌓은 값. 커서와 함께 저장해 다음엔 새 줄만 반영한다 */
export interface TranscriptDigest {
  activity: ActivityNow | null;
  /** 보고가 아예 없으면 null, 보고했는데 비었으면 [] */
  tasks: AgentTask[] | null;
  subagents: SubagentEntry[];
  timeline: ToolEvent[];
  /** 마지막으로 읽은 줄의 시각. 생존 판단이 쓴다 */
  lastEventAt?: string;
  backgroundGate?: BackgroundGate;
  /** keepText를 켰을 때만 찬다. 저장소에는 남기지 않는다 */
  texts?: TextEntry[];
}

export interface TranscriptCursor {
  file: string;
  /** 다 읽은 마지막 줄 뒤 바이트 위치 */
  offset: number;
  /** 처음 읽을 때 앞부분을 건너뛰었다 */
  partial: boolean;
  pending: Record<string, PendingCall>;
}

export interface TranscriptState {
  cursor: TranscriptCursor;
  digest: TranscriptDigest;
}

export function emptyDigest(keepText = false): TranscriptDigest {
  return {
    activity: null,
    tasks: null,
    subagents: [],
    timeline: [],
    ...(keepText ? { texts: [] } : {}),
  };
}

/**
 * 트랜스크립트를 찾을 설정 디렉토리들. `CLAUDE_CONFIG_DIR`이 있으면 먼저 보고 `~/.claude`도 본다.
 * 오르카 프로필은 `projects`를 `~/.claude/projects`로 심링크해 두는 경우가 많아 실제 경로로 겹침을 걷는다
 */
export function projectRoots(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const dirs = [env['CLAUDE_CONFIG_DIR'], join(home, '.claude')]
    .filter((d): d is string => typeof d === 'string' && isAbsolute(d))
    .map((d) => join(d, 'projects'));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of dirs) {
    let key: string;
    try {
      key = realpathSync(d);
    } catch {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

export interface LocateOptions {
  /** 워커가 도는 워크트리 경로 */
  cwd: string;
  /** 워커 시작 시각 */
  startedAt: string;
  /** 워커가 끝난 시각. 다음 회차 워커 시작 시각을 넘긴다. 비우면 지금까지 */
  endedAt?: string;
  /** 런처가 받은 세션 id. 있으면 이걸로 바로 찾는다 */
  sessionId?: string;
  roots?: string[];
}

/** 저장해 둔 커서 경로를 다시 쓸 때 본다. 워크트리의 projects 디렉토리 바로 아래 세션 파일만 받는다 */
export function isWorkerTranscriptPath(file: string, cwd: string, roots = projectRoots()): boolean {
  const name = basename(file);
  if (!name.endsWith('.jsonl') || !isSessionId(name.slice(0, -'.jsonl'.length))) return false;
  const dir = dirname(file);
  return roots.some((r) => join(r, cwdSlug(cwd)) === dir);
}

/**
 * 워커 세션 트랜스크립트를 고른다. 세션 id가 있으면 그 파일을, 없으면 워크트리 디렉토리에서 세션이
 * 워커 시작 뒤(5분 여유)와 종료 앞에 시작한 파일 중 가장 최근에 바뀐 것을 고른다. 못 찾으면 undefined
 */
export function locateWorkerTranscript(opts: LocateOptions): string | undefined {
  const roots = opts.roots ?? projectRoots();
  const dirs = roots.map((r) => join(r, cwdSlug(opts.cwd)));
  if (opts.sessionId && isSessionId(opts.sessionId)) {
    for (const d of dirs) {
      const f = join(d, `${opts.sessionId}.jsonl`);
      if (isFile(f)) return f;
    }
  }
  const startMs = Date.parse(opts.startedAt);
  if (Number.isNaN(startMs)) return undefined;
  const endMs = opts.endedAt ? Date.parse(opts.endedAt) : Number.POSITIVE_INFINITY;
  let best: { file: string; mtime: number; gap: number } | undefined;
  for (const d of dirs) {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = join(d, name);
      let st: Stats;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const mtime = st.mtimeMs;
      if (mtime < startMs - START_SLACK_MS) continue;
      const began = sessionStartMs(file, st.size);
      if (began === undefined || began < startMs - START_SLACK_MS || began >= endMs) continue;
      // 끝이 정해진 회차는 다음 회차 세션이 일찍 떠 후보에 섞일 수 있어 시작 기록에 가장 가까운 세션을 고른다
      const gap = Math.abs(began - startMs);
      const better = opts.endedAt ? !best || gap < best.gap : !best || mtime > best.mtime;
      if (better) best = { file, mtime, gap };
    }
  }
  return best?.file;
}

/** 세션 첫 줄은 안 바뀌어서 한 번 읽은 시작 시각을 경로로 기억한다. tick과 browse가 후보마다 앞부분을 다시 읽지 않게 한다 */
const startCache = new Map<string, number>();
const START_CACHE_MAX = 512;

function sessionStartMs(file: string, size: number): number | undefined {
  const hit = startCache.get(file);
  if (hit !== undefined) return Number.isNaN(hit) ? undefined : hit;
  const v = readSessionStartMs(file);
  if (v === null) return undefined;
  // 앞부분을 다 채운 파일은 뒤에 더 써도 시각이 안 생기니 없다는 것도 기억한다. NaN이 그 표시다
  if (v !== undefined || size >= HEAD_BYTES) {
    startCache.set(file, v ?? Number.NaN);
    evictOldest(startCache, START_CACHE_MAX);
  }
  return v;
}

/** 크기 상한을 넘으면 먼저 넣은 것부터 지운다 */
export function evictOldest(items: Map<string, unknown> | Set<string>, max: number): void {
  while (items.size > max) items.delete(items.keys().next().value!);
}

/** 파일 앞부분에서 시각이 있는 첫 줄의 시각. 못 읽었으면 null */
function readSessionStartMs(file: string): number | null | undefined {
  let head: string;
  try {
    head = readRange(file, 0, HEAD_BYTES);
  } catch {
    return null;
  }
  const lines = head.split('\n');
  // 끝 줄은 잘렸을 수 있다
  for (const line of lines.slice(0, -1)) {
    if (!line.includes('"timestamp"')) continue;
    const row = parse(line);
    const t = typeof row?.['timestamp'] === 'string' ? Date.parse(row['timestamp']) : Number.NaN;
    if (!Number.isNaN(t)) return t;
  }
  return undefined;
}

export interface ReadOptions {
  /** 경로를 상대로 줄일 워크트리 */
  cwd?: string;
  /** assistant 글을 digest.texts에 쌓는다. 작업 내용 탭만 켠다 */
  keepText?: boolean;
  readLimit?: number;
}

/**
 * 새로 붙은 줄을 읽어 상태를 갱신한다. 앞 상태가 다른 파일이거나 파일이 줄었으면 처음부터 다시 쌓는다.
 * 쓰다 만 마지막 줄은 다음에 통째로 읽는다. 파일을 못 읽으면 던진다
 */
export function readTranscript(
  file: string,
  prev: TranscriptState | undefined,
  opts: ReadOptions = {},
): TranscriptState {
  const limit = opts.readLimit ?? READ_LIMIT;
  let state: TranscriptState =
    prev && prev.cursor.file === file
      ? prev
      : {
          cursor: { file, offset: 0, partial: false, pending: {} },
          digest: emptyDigest(opts.keepText),
        };
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size < state.cursor.offset)
      state = {
        cursor: { file, offset: 0, partial: false, pending: {} },
        digest: emptyDigest(opts.keepText),
      };
    if (size === state.cursor.offset) return state;
    let start = state.cursor.offset;
    let dropFirst = false;
    const cursor = { ...state.cursor, pending: { ...state.cursor.pending } };
    if (size - start > limit) {
      start = size - limit;
      dropFirst = true;
      cursor.partial = true;
    }
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const last = buf.lastIndexOf(10);
    if (last < 0) return state;
    const first = dropFirst ? buf.indexOf(10) + 1 : 0;
    cursor.offset = start + last + 1;
    const digest = cloneDigest(state.digest);
    const ctx: RowContext = { cursor, digest, cwd: opts.cwd, keepText: opts.keepText === true };
    for (const line of buf.toString('utf-8', first, last + 1).split('\n')) {
      if (!line) continue;
      const row = parse(line);
      if (row) applyRow(row, ctx);
    }
    return { cursor, digest };
  } finally {
    closeSync(fd);
  }
}

function cloneDigest(d: TranscriptDigest): TranscriptDigest {
  return {
    activity: d.activity,
    tasks: d.tasks ? [...d.tasks] : null,
    subagents: d.subagents.map((s) => ({ ...s })),
    timeline: d.timeline.map((t) => ({ ...t })),
    ...(d.lastEventAt ? { lastEventAt: d.lastEventAt } : {}),
    ...(d.backgroundGate ? { backgroundGate: { ...d.backgroundGate } } : {}),
    ...(d.texts ? { texts: [...d.texts] } : {}),
  };
}

type Row = Record<string, unknown>;

interface RowContext {
  cursor: TranscriptCursor;
  digest: TranscriptDigest;
  cwd: string | undefined;
  keepText: boolean;
}

const INTERRUPTED = /^\[Request interrupted by user/;
const NOT_A_TURN = /^<(local-command-[a-z]+|command-name|command-message)>/;
const NOTIFICATION = '<task-notification>';
const FINISHED = /<status>(?:completed|failed|killed)<\/status>/;
const NOTIFIED_CALL = /<tool-use-id>([^<]+)<\/tool-use-id>/;
const LAUNCH_TEXT = /async agent launched|teammate|^\s*spawned/i;
const GATE_COMMAND = /\bgate\b/;

function parse(line: string): Row | undefined {
  try {
    const v = JSON.parse(line) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : undefined;
  } catch {
    return undefined;
  }
}

const record = (v: unknown): Row | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : undefined;

export function clean(v: unknown, max = DETAIL_MAX): string {
  return typeof v === 'string'
    ? v
        // eslint-disable-next-line no-control-regex -- 화면에 그릴 값에서 제어 문자를 지우는 게 이 정규식의 일이다
        .replace(/[\x00-\x1f\x7f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
    : '';
}

function applyRow(row: Row, ctx: RowContext): void {
  if (row['isSidechain'] === true) return;
  const at = typeof row['timestamp'] === 'string' ? row['timestamp'] : undefined;
  if (!at || Number.isNaN(Date.parse(at))) return;
  const type = row['type'];
  if (type === 'system') {
    if (row['subtype'] === 'turn_duration') endTurn(at, ctx);
    return;
  }
  const message = record(row['message']);
  const content = message?.['content'];
  if (type === 'assistant') {
    ctx.digest.lastEventAt = at;
    const blocks = Array.isArray(content) ? content.map(record).filter(Boolean) : [];
    for (const b of blocks as Row[]) {
      if (b['type'] === 'tool_use' && typeof b['id'] === 'string') startCall(b, at, ctx);
      else if (ctx.keepText && b['type'] === 'text') pushText(ctx.digest, at, b['text']);
    }
    if (message?.['stop_reason'] === 'end_turn') endTurn(at, ctx);
    return;
  }
  if (type !== 'user' || row['isMeta'] === true || row['isCompactSummary'] === true) return;
  ctx.digest.lastEventAt = at;
  const blocks = Array.isArray(content) ? (content.map(record).filter(Boolean) as Row[]) : [];
  const results = blocks.filter((b) => b['type'] === 'tool_result');
  if (results.length > 0) {
    const structured = results.length === 1 ? record(row['toolUseResult']) : undefined;
    for (const b of results) finishCall(b, structured, at, ctx);
    return;
  }
  const text = (
    typeof content === 'string'
      ? content
      : blocks.map((b) => (typeof b['text'] === 'string' ? b['text'] : '')).join('\n')
  ).trimStart();
  if (!text) return;
  if (INTERRUPTED.test(text)) return endTurn(at, ctx);
  if (NOT_A_TURN.test(text)) return;
  turnStart(ctx);
  if (text.includes(NOTIFICATION) && FINISHED.test(text)) {
    const id = NOTIFIED_CALL.exec(text)?.[1];
    if (id) finishSubagent(ctx.digest, id, at);
  }
}

function turnStart(ctx: RowContext): void {
  // 턴이 끝난 뒤 새 턴이 왔으면 백그라운드 gate 뒤에 멈춘 게 아니다
  if (ctx.digest.backgroundGate?.turnEndedAt) delete ctx.digest.backgroundGate;
}

function endTurn(at: string, ctx: RowContext): void {
  ctx.cursor.pending = {};
  const bg = ctx.digest.backgroundGate;
  if (bg && !bg.turnEndedAt) bg.turnEndedAt = at;
}

function toolDetail(input: Row, cwd: string | undefined): string {
  const p = input['file_path'] ?? input['notebook_path'];
  const path = typeof p === 'string' ? shortPath(p, cwd) : '';
  // 명령 원문보다 사람이 붙인 설명이 짧고 덜 새어 나가서 먼저 쓴다
  const d =
    (path || undefined) ??
    input['description'] ??
    input['command'] ??
    input['pattern'] ??
    input['url'] ??
    input['query'] ??
    input['skill'] ??
    '';
  // 자른 뒤에 가리면 잘린 토큰이 패턴에 안 걸려 그대로 남는다
  return clean(typeof d === 'string' ? maskSecrets(d).text : d);
}

function shortPath(p: string, cwd: string | undefined): string {
  if (!cwd || !isAbsolute(p)) return p;
  const rel = relative(cwd, p);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : p;
}

function startCall(block: Row, at: string, ctx: RowContext): void {
  const id = block['id'] as string;
  if (ctx.cursor.pending[id] || ctx.digest.timeline.some((t) => t.id === id)) return;
  const input = record(block['input']) ?? {};
  // 바깥에서 온 이름이라 표 이름과 견줄 때만 그대로 쓰고 저장은 줄여서 한다
  const rawName = typeof block['name'] === 'string' ? block['name'] : '';
  const tool = clean(rawName, 60) || 'tool';
  const detail = toolDetail(input, ctx.cwd);
  const call: PendingCall = { tool, at, detail };
  const filePath = input['file_path'] ?? input['notebook_path'];
  if (WRITE_TOOLS.has(rawName) && typeof filePath === 'string')
    call.file = shortPath(filePath, ctx.cwd);
  if (TASK_TOOLS.has(rawName) || TODO_TOOLS.has(rawName)) call.task = taskInput(input);
  if (SUBAGENT_TOOLS.has(rawName)) {
    call.subagent = true;
    pushBounded(
      ctx.digest.subagents,
      {
        id,
        name:
          clean(input['description'] ?? input['name'] ?? input['subagent_type'], 60) || 'sub-agent',
        startedAt: at,
        state: 'running',
      },
      MAX_SUBAGENTS,
    );
  }
  if (
    SHELL_TOOLS.has(rawName) &&
    input['run_in_background'] === true &&
    typeof input['command'] === 'string' &&
    GATE_COMMAND.test(input['command'])
  )
    ctx.digest.backgroundGate = { at };
  else if (ctx.digest.backgroundGate?.turnEndedAt) delete ctx.digest.backgroundGate;
  hold(ctx.cursor, id, call);
  pushBounded(ctx.digest.timeline, { id, at, tool, detail }, MAX_TIMELINE);
  ctx.digest.activity = { tool, ...(call.file ? { file: call.file } : {}), at };
}

function hold(cursor: TranscriptCursor, id: string, call: PendingCall): void {
  cursor.pending[id] = call;
  const ids = Object.keys(cursor.pending);
  if (ids.length > MAX_PENDING) delete cursor.pending[ids[0]!];
}

function pushBounded<T>(list: T[], item: T, max: number): void {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
}

function pushText(digest: TranscriptDigest, at: string, text: unknown): void {
  // 본문에 붙여 넣은 토큰도 작업 내용 탭으로 나가서 도구 인자처럼 자르기 전에 가린다
  const t = clean(typeof text === 'string' ? maskSecrets(text).text : text, TEXT_MAX);
  if (!t) return;
  pushBounded((digest.texts ??= []), { at, text: t }, MAX_TEXTS);
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      const r = record(b);
      return typeof r?.['text'] === 'string' ? r['text'] : '';
    })
    .join('\n');
}

function finishCall(block: Row, structured: Row | undefined, at: string, ctx: RowContext): void {
  const id = block['tool_use_id'];
  if (typeof id !== 'string') return;
  const call = ctx.cursor.pending[id];
  // 시작이 읽은 범위 밖이면 아무것도 모른다
  if (!call) return;
  delete ctx.cursor.pending[id];
  const error = block['is_error'] === true;
  const event = ctx.digest.timeline.find((t) => t.id === id);
  if (event) {
    event.ok = !error;
    const ms = Date.parse(at) - Date.parse(call.at);
    if (Number.isFinite(ms)) event.ms = Math.max(0, ms);
  }
  if (call.subagent) {
    const s = ctx.digest.subagents.find((x) => x.id === id);
    if (s && s.state === 'running') {
      if (!error && wasLaunched(structured, block)) s.state = 'detached';
      else {
        s.state = 'done';
        s.endedAt = at;
      }
    }
  }
  if (call.task && !error) {
    const effect = taskEffect(call.tool, call.task, structured ?? block['content']);
    if (effect) {
      const next = applyTaskEffect(ctx.digest.tasks ?? [], effect);
      if (next) ctx.digest.tasks = next;
    }
  }
}

function wasLaunched(structured: Row | undefined, block: Row): boolean {
  const status = structured?.['status'];
  if (typeof status === 'string') return LAUNCHED_STATUSES.has(status);
  return LAUNCH_TEXT.test(blockText(block['content']).slice(0, 200));
}

function finishSubagent(digest: TranscriptDigest, id: string, at: string): void {
  const s = digest.subagents.find((x) => x.id === id);
  if (s && s.state !== 'done') {
    s.state = 'done';
    s.endedAt = at;
  }
}

const CREATED = /^Task #(\d+) created successfully: ([^\r\n]+)$/;
const UPDATED =
  /^Updated task #(\d+) ((?:owner|status|subject|description|activeForm|metadata|blocks|blockedBy|deleted)(?:, (?:owner|status|subject|description|activeForm|metadata|blocks|blockedBy|deleted))*)$/;

function taskId(v: unknown): string {
  return typeof v === 'string' || typeof v === 'number' ? clean(String(v), 100) : '';
}

/** Claude의 {content|subject}와 Codex의 {step}을 받는다. 상태를 모르는 항목은 뺀다 */
export function taskList(items: unknown): AgentTask[] | null {
  if (!Array.isArray(items)) return null;
  const out: AgentTask[] = [];
  for (const raw of items.slice(0, MAX_TASKS)) {
    const t = record(raw);
    if (!t) continue;
    const title = clean(t['content'] ?? t['step'] ?? t['subject'] ?? t['title'], 180);
    const status = t['status'];
    if (!title || typeof status !== 'string' || !LIVE_TASK.has(status)) continue;
    const id = taskId(t['id']);
    out.push({ ...(id ? { id } : {}), title, status: status as TaskStatus });
  }
  return out;
}

function taskInput(input: Row): TaskInput {
  const todos = taskList(input['todos']);
  return {
    ...(taskId(input['taskId']) ? { taskId: taskId(input['taskId']) } : {}),
    ...(clean(input['subject'], 180) ? { subject: clean(input['subject'], 180) } : {}),
    ...(typeof input['status'] === 'string' ? { status: input['status'] } : {}),
    ...(input['merge'] === true ? { merge: true } : {}),
    ...(todos ? { todos } : {}),
  };
}

type TaskEffect =
  | { replace: AgentTask[]; partial?: boolean }
  | { change: { id: string; title?: string; status?: TaskStatus | 'deleted' } };

const reportsFailure = (r: unknown): boolean => {
  const o = record(r);
  return (
    !!o &&
    (o['is_error'] === true || o['isError'] === true || !!o['error'] || o['success'] === false)
  );
};

/** 결과 꼴을 { failed } / { value } / { text } / {} 중 하나로 줄인다 */
function readResponse(response: unknown): { failed?: true; value?: Row; text?: string } {
  if (response === undefined || response === null) return {};
  if (reportsFailure(response)) return { failed: true };
  let r: unknown = response;
  if (Array.isArray(r)) {
    const only = r.length === 1 ? record(r[0]) : undefined;
    r = only?.['type'] === 'text' ? only['text'] : null;
  } else if (record(r) && 'content' in (r as Row)) {
    const c = (r as Row)['content'];
    if (Array.isArray(c)) {
      const only = c.length === 1 ? record(c[0]) : undefined;
      r = only?.['type'] === 'text' ? only['text'] : null;
    } else r = c;
  }
  if (typeof r === 'string') {
    const text = r.trim();
    const parsed = parse(text);
    if (parsed) return reportsFailure(parsed) ? { failed: true } : { value: parsed };
    return { text };
  }
  const obj = record(r);
  return obj ? { value: obj } : {};
}

function knownChange(id: string, title: string, status: unknown): TaskEffect | null {
  const statusKnown = typeof status === 'string' && (LIVE_TASK.has(status) || status === 'deleted');
  if (!statusKnown && !title) return null;
  return {
    change: {
      id,
      ...(title ? { title } : {}),
      ...(statusKnown ? { status: status as TaskStatus | 'deleted' } : {}),
    },
  };
}

function taskEffect(tool: string, input: TaskInput, response: unknown): TaskEffect | null {
  const result = readResponse(response);
  if (result.failed) return null;
  if (TODO_TOOLS.has(tool)) {
    const newTodos = result.value?.['newTodos'];
    const ok = Array.isArray(newTodos) || /modified successfully/i.test(result.text ?? '');
    const list = ok ? (Array.isArray(newTodos) ? taskList(newTodos) : (input.todos ?? null)) : null;
    return list ? { replace: list, ...(input.merge ? { partial: true } : {}) } : null;
  }
  if (result.text === undefined && result.value === undefined) return null;
  const task = record(result.value?.['task']);
  if (tool === 'TaskList') {
    const list = taskList(result.value?.['tasks']);
    return list ? { replace: list } : null;
  }
  if (tool === 'TaskCreate') {
    if (result.text !== undefined) {
      const m = CREATED.exec(result.text);
      const title = input.subject || clean(m?.[2], 180);
      return m && title ? { change: { id: m[1]!, title, status: 'pending' } } : null;
    }
    const id = taskId(task?.['id']);
    const title = clean(task?.['subject'], 180) || input.subject || '';
    if (!id || !title) return null;
    const st = task?.['status'];
    return {
      change: {
        id,
        title,
        status: typeof st === 'string' && LIVE_TASK.has(st) ? (st as TaskStatus) : 'pending',
      },
    };
  }
  if (tool === 'TaskUpdate') {
    const wanted = input.taskId ?? '';
    if (result.text !== undefined) {
      const m = UPDATED.exec(result.text);
      if (!m || (wanted && m[1] !== wanted)) return null;
      const fields = m[2]!.split(', ');
      const status =
        fields.includes('status') || fields.includes('deleted') ? input.status : undefined;
      return knownChange(m[1]!, fields.includes('subject') ? (input.subject ?? '') : '', status);
    }
    if (task) {
      const id = taskId(task['id']) || wanted;
      if (!id || (wanted && id !== wanted)) return null;
      return knownChange(id, clean(task['subject'], 180), task['status']);
    }
    if (result.value?.['success'] === true) {
      const id = taskId(result.value['taskId']) || wanted;
      if (!id || (wanted && id !== wanted)) return null;
      const fields = Array.isArray(result.value['updatedFields'])
        ? (result.value['updatedFields'] as unknown[])
        : [];
      const change = record(result.value['statusChange']);
      const status =
        change?.['to'] ??
        (fields.includes('status') || fields.includes('deleted') ? input.status : undefined);
      return knownChange(id, fields.includes('subject') ? (input.subject ?? '') : '', status);
    }
    return null;
  }
  // TaskGet
  if (task) return knownChange(taskId(task['id']), clean(task['subject'], 180), task['status']);
  return null;
}

/** 효과를 반영한 다음 목록. 바뀐 게 없으면 null. 제목을 본 적 없는 항목의 상태는 버린다 */
function applyTaskEffect(todos: AgentTask[], effect: TaskEffect): AgentTask[] | null {
  if ('replace' in effect) {
    if (!effect.partial) return effect.replace;
    const incoming = effect.replace.filter((t) => t.id);
    const ids = new Set(incoming.map((t) => t.id));
    return [...todos.filter((t) => !ids.has(t.id)), ...incoming];
  }
  const { id, title, status } = effect.change;
  if (!id) return null;
  const prior = todos.find((t) => t.id === id);
  if (status === 'deleted') return prior ? todos.filter((t) => t !== prior) : null;
  if (prior)
    return todos.map((t) =>
      t === prior ? { ...t, ...(title ? { title } : {}), ...(status ? { status } : {}) } : t,
    );
  return title && status && todos.length < MAX_TASKS ? [...todos, { id, title, status }] : null;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function readRange(file: string, start: number, length: number): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.toString('utf-8', 0, n);
  } finally {
    closeSync(fd);
  }
}

export function transcriptExists(file: string | undefined): file is string {
  return !!file && existsSync(file);
}
