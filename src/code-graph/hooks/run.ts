import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { CodeGraphStore } from '../storage.js';
import { buildCoChangeLookup } from '../cochange.js';
import { NodeKind } from '../types.js';
import { logger } from '../../core/logger.js';
import { isHooksEnabled } from './settings.js';
import { tokenizePrompt } from './rank.js';
import { evidenceLabel, rankPointers } from './pointers.js';
import { pruneSessionStates, readSessionState, remember, writeSessionState } from './state.js';
import { requestRefresh, type RefreshSpawner } from './background.js';

/**
 * Claude Code 훅 진입점. 이 모듈과 그 import는 MCP 서버, LLM 어댑터, 임베딩, 그리고
 * typescript 파서를 끌고 오는 엔진을 불러오면 안 된다. 매 프롬프트마다 기동 비용이 그대로 붙는다.
 * 지키는 건 hooks-import-boundary 테스트다.
 */

export type HookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PostToolUse' | 'Stop';

const EVENTS: Record<string, HookEvent> = {
  'session-start': 'SessionStart',
  'user-prompt-submit': 'UserPromptSubmit',
  'post-tool-use': 'PostToolUse',
  stop: 'Stop',
};

export function parseEventArg(arg: string | undefined): HookEvent | null {
  return (arg && EVENTS[arg]) || null;
}

/**
 * 이벤트별 자체 데드라인. hooks.json의 timeout(초)보다 넉넉히 짧게 잡는다.
 * Claude Code는 timeout에 걸린 훅의 출력을 버리므로 거기까지 가면 일한 게 전부 헛것이 된다.
 */
export const DEADLINE_MS: Record<HookEvent, number> = {
  SessionStart: 2000,
  UserPromptSubmit: 1000,
  PostToolUse: 1000,
  Stop: 500,
};

export const SESSION_MAP_MAX_CHARS = 1500;
export const PROMPT_CONTEXT_MAX_CHARS = 800;
export const EDIT_CONTEXT_MAX_CHARS = 1200;
export const MAX_POINTERS = 3;
export const MIN_PROMPT_CHARS = 12;
const IMPACT_SHOWN = 5;
const COCHANGE_SHOWN = 5;
/** 연달아 고칠 때 갱신 프로세스를 다시 띄우기까지의 간격 */
const REFRESH_INTERVAL_MS: Record<HookEvent, number> = {
  SessionStart: 0,
  UserPromptSubmit: 30_000,
  PostToolUse: 5_000,
  Stop: 0,
};

export interface HookRunOptions {
  env?: NodeJS.ProcessEnv;
  /** 테스트용. 기본은 Date.now */
  now?: () => number;
  /** 테스트용. 기본은 DEADLINE_MS[event] */
  deadlineMs?: number;
  spawnRefresh?: RefreshSpawner;
}

interface HookInput {
  session_id?: unknown;
  cwd?: unknown;
  prompt?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
}

class Deadline {
  constructor(
    private readonly at: number,
    private readonly now: () => number,
  ) {}
  expired(): boolean {
    return this.now() >= this.at;
  }
}

function output(event: HookEvent, text: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
}

function rel(repoRoot: string, filePath: string): string {
  return filePath.startsWith(repoRoot + sep) ? filePath.slice(repoRoot.length + 1) : filePath;
}

/** 줄 단위로 잘라 max를 넘지 않게 한다. 마지막 줄을 중간에서 자르면 경로가 반쯤 남는다 */
function clampLines(lines: string[], max: number): string {
  const out: string[] = [];
  let len = 0;
  for (const line of lines) {
    const add = line.length + (out.length > 0 ? 1 : 0);
    if (len + add > max) break;
    out.push(line);
    len += add;
  }
  return out.join('\n');
}

function resolveRepoRoot(input: HookInput, env: NodeJS.ProcessEnv): string | null {
  const fromEnv = env['CLAUDE_PROJECT_DIR'];
  const candidate = fromEnv && isAbsolute(fromEnv) ? fromEnv : input.cwd;
  if (typeof candidate !== 'string' || !isAbsolute(candidate)) return null;
  return resolve(candidate);
}

/**
 * 훅 하나를 처리하고 stdout에 낼 문자열을 돌려준다. 낼 게 없으면 빈 문자열이다.
 * 어떤 실패도 던지지 않는다 — 호출하는 쪽은 결과를 쓰고 exit 0만 하면 된다.
 */
export async function runHook(
  event: HookEvent,
  rawInput: string,
  opts: HookRunOptions = {},
): Promise<string> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const start = now();
  try {
    let input: HookInput;
    try {
      const parsed = JSON.parse(rawInput) as unknown;
      if (!parsed || typeof parsed !== 'object') return '';
      input = parsed as HookInput;
    } catch {
      return '';
    }

    const repoRoot = resolveRepoRoot(input, env);
    if (!repoRoot || !isHooksEnabled(repoRoot, env)) return '';
    const dbPath = join(repoRoot, '.gestalt', 'code-graph.db');
    // CodeGraphStore는 없는 DB를 새로 만든다. 그래프를 만드는 건 build 액션의 몫이다
    if (!existsSync(dbPath)) return '';

    const deadline = new Deadline(start + (opts.deadlineMs ?? DEADLINE_MS[event]), now);
    const sessionId = typeof input.session_id === 'string' ? input.session_id : '';
    const refresh = () => {
      if (!opts.spawnRefresh) return;
      try {
        requestRefresh(repoRoot, opts.spawnRefresh, REFRESH_INTERVAL_MS[event], now());
      } catch (e) {
        logger.warn('code_graph.hook_refresh_spawn_failed', {
          module: 'code-graph/hooks',
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    };

    if (event === 'Stop') {
      refresh();
      return '';
    }
    if (event === 'UserPromptSubmit') {
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
      if (prompt.length < MIN_PROMPT_CHARS) return '';
    }

    const store = new CodeGraphStore(dbPath);
    try {
      let text = '';
      switch (event) {
        case 'SessionStart':
          pruneSessionStates(repoRoot, now());
          text = sessionMap(store, repoRoot, dbPath, now());
          break;
        case 'UserPromptSubmit':
          text = promptPointers(store, repoRoot, sessionId, String(input.prompt), deadline);
          break;
        case 'PostToolUse':
          text = editImpact(store, repoRoot, sessionId, input, deadline);
          break;
      }
      refresh();
      if (!text || deadline.expired()) return '';
      return output(event, text);
    } finally {
      store.close();
    }
  } catch (e) {
    logger.warn('code_graph.hook_failed', {
      module: 'code-graph/hooks',
      event,
      reason: e instanceof Error ? e.message : String(e),
    });
    return '';
  } finally {
    logger.debug('code_graph.hook_done', {
      module: 'code-graph/hooks',
      event,
      durationMs: now() - start,
    });
  }
}

function minutesAgo(ts: number | null, now: number): string {
  if (ts === null) return '갱신 시각 모름';
  const min = Math.max(0, Math.round((now - ts) / 60_000));
  if (min < 1) return '방금 갱신';
  if (min < 120) return `${min}분 전 갱신`;
  return `${Math.round(min / 60)}시간 전 갱신`;
}

/** 파일이 셋 이상 깊으면 앞 두 단계, 아니면 첫 단계로 묶는다 */
function dirKey(relPath: string): string {
  const parts = relPath.split('/');
  if (parts.length >= 3) return `${parts[0]}/${parts[1]}`;
  if (parts.length === 2) return parts[0]!;
  return '.';
}

function sessionMap(store: CodeGraphStore, repoRoot: string, dbPath: string, now: number): string {
  const stats = store.getStats(dbPath);
  if (stats.totalNodes === 0) return '';

  const dirs = new Map<string, number>();
  for (const f of store.getGraphFilePaths()) {
    const key = dirKey(rel(repoRoot, f));
    dirs.set(key, (dirs.get(key) ?? 0) + 1);
  }
  const topDirs = [...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  const hubs = [...store.getImporterCounts({ limit: 20 }).entries()]
    .filter(([f]) => !store.getNodeById(`file:${f}`)?.isTest)
    .slice(0, 6);

  const lines = [
    `[gestalt 코드 그래프] 파일 ${stats.totalFiles}개, 노드 ${stats.totalNodes}개 (${minutesAgo(stats.lastBuiltAt, now)})`,
    '디렉토리별 파일 수:',
    ...topDirs.map(([d, n]) => `- ${d}/ ${n}개`),
  ];
  if (hubs.length > 0) {
    lines.push(
      '많이 import되는 파일:',
      ...hubs.map(([f, n]) => `- ${rel(repoRoot, f)} (${n}곳에서 import)`),
    );
  }
  const meta = store.getCoChangeMeta();
  // 쌍이 하나도 없으면 실을 신호가 없다. "0개 커밋에서 모아뒀다"는 안내만 자리를 먹는다
  if (meta && store.countCoChangePairs() > 0)
    lines.push(`git 이력 ${meta.commitsUsed}개 커밋에서 함께 바뀐 파일 쌍을 모아뒀어요.`);
  lines.push(
    '고치기 전에 영향 범위가 궁금하면 ges_code_graph의 blast_radius, 파일 구조만 보려면 skeleton 액션을 쓰면 돼요.',
  );
  return clampLines(lines, SESSION_MAP_MAX_CHARS);
}

function kindLabel(kind: NodeKind): string {
  switch (kind) {
    case NodeKind.Function:
      return '함수';
    case NodeKind.Class:
      return '클래스';
    case NodeKind.Type:
      return '타입';
    case NodeKind.File:
      return '파일';
  }
}

/**
 * 중복 판정 키는 줄 범위를 빼고 `파일#심볼이름`이다. 줄 범위까지 키에 넣으면 위쪽에 한 줄만
 * 추가돼도 같은 심볼이 새것처럼 다시 들어간다.
 */
export function pointerKey(relPath: string, name: string): string {
  return `${relPath}#${name}`;
}

function promptPointers(
  store: CodeGraphStore,
  repoRoot: string,
  sessionId: string,
  prompt: string,
  deadline: Deadline,
): string {
  const tokens = tokenizePrompt(prompt);
  if (tokens.parts.length === 0 && tokens.ko.length === 0 && tokens.tickets.length === 0) return '';

  const top = rankPointers(store, repoRoot, tokens, MAX_POINTERS);
  if (top.length === 0 || deadline.expired()) return '';

  // 상위를 먼저 고르고 이미 넣은 걸 뺀다. 순서를 뒤집으면 같은 프롬프트를 다시 보냈을 때
  // 빠진 자리를 그다음 약한 후보가 채워서 매번 뭔가가 들어간다
  const state = sessionId ? readSessionState(repoRoot, sessionId) : { pointers: [], impacts: [] };
  const seen = new Set(state.pointers);
  const picks = top.filter((p) => !seen.has(pointerKey(p.relPath, p.node.name)));
  if (picks.length === 0) return '';
  const importers = store.getImporterCounts({ files: picks.map((p) => p.node.filePath) });
  const lines = [
    '[gestalt 코드 그래프] 요청과 겹치는 위치예요. 필요할 때만 열어보세요.',
    ...picks.map((p) => {
      const line = p.node.lineStart ?? 1;
      const n = importers.get(p.node.filePath);
      const label =
        p.node.kind === NodeKind.File ? '파일' : `${kindLabel(p.node.kind)} ${p.node.name}`;
      return `- ${p.relPath}:${line} — ${label}${n ? `, ${n}개 파일이 import` : ''}${evidenceLabel(p)}`;
    }),
  ];
  const text = clampLines(lines, PROMPT_CONTEXT_MAX_CHARS);
  if (sessionId) {
    writeSessionState(repoRoot, sessionId, {
      ...state,
      pointers: remember(
        state.pointers,
        picks.map((p) => pointerKey(p.relPath, p.node.name)),
      ),
    });
  }
  return text;
}

function editedFile(repoRoot: string, input: HookInput): string | null {
  const toolInput = input.tool_input as { file_path?: unknown } | undefined;
  const raw = toolInput?.file_path;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const base = typeof input.cwd === 'string' && isAbsolute(input.cwd) ? input.cwd : repoRoot;
  const abs = resolve(base, raw);
  if (!abs.startsWith(repoRoot + sep)) return null;
  return abs;
}

function editImpact(
  store: CodeGraphStore,
  repoRoot: string,
  sessionId: string,
  input: HookInput,
  deadline: Deadline,
): string {
  const file = editedFile(repoRoot, input);
  if (!file) return '';
  const relPath = rel(repoRoot, file);

  const state = sessionId ? readSessionState(repoRoot, sessionId) : { pointers: [], impacts: [] };
  // 같은 파일을 여러 번 고칠 때마다 같은 목록을 다시 넣지 않는다
  if (state.impacts.includes(relPath)) return '';

  const refs = store.getReferencingFilesDetailed(file);
  const counts = store.getImporterCounts({ files: refs.map((r) => r.filePath) });
  refs.sort(
    (a, b) =>
      Number(a.isTest) - Number(b.isTest) ||
      (counts.get(b.filePath) ?? 0) - (counts.get(a.filePath) ?? 0) ||
      a.filePath.localeCompare(b.filePath),
  );
  if (deadline.expired()) return '';

  const co = buildCoChangeLookup(store, repoRoot, [file], { limit: COCHANGE_SHOWN });
  const neighbors = co.available ? co.neighbors : [];
  if (refs.length === 0 && neighbors.length === 0) return '';

  const lines = [`[gestalt 코드 그래프] ${relPath}를 고쳤어요. 같이 봐야 할 수 있는 파일이에요.`];
  if (refs.length > 0) {
    const tests = refs.filter((r) => r.isTest).length;
    const shown = refs.slice(0, IMPACT_SHOWN).map((r) => rel(repoRoot, r.filePath));
    const rest = refs.length - shown.length;
    lines.push(
      `이 파일을 참조하는 곳 ${refs.length}개${tests > 0 ? ` (테스트 ${tests}개)` : ''}: ` +
        shown.join(', ') +
        (rest > 0 ? ` 외 ${rest}개` : ''),
    );
  }
  if (neighbors.length > 0) {
    lines.push(
      'git 이력에서 함께 자주 바뀐 파일: ' +
        neighbors.map((n) => `${rel(repoRoot, n.filePath)} (${n.pairCount}회)`).join(', '),
    );
  }
  const text = clampLines(lines, EDIT_CONTEXT_MAX_CHARS);
  if (sessionId) {
    writeSessionState(repoRoot, sessionId, {
      ...state,
      impacts: remember(state.impacts, [relPath]),
    });
  }
  return text;
}
