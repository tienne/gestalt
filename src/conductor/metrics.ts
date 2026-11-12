import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 끼어든 발화와 토큰 지표.
 *
 * 셈법은 세션 분석과 같다. 대상은 transcript(`*.jsonl`) 중 기간 안에 바뀐 것이고
 * `subagents/` 아래는 뺀다. 스킬을 부른 세션만 센다. 스킬 호출 뒤 사람 발화 N개(기본 8)
 * 안에 든 발화를 끼어든 발화로 센다. 도구 결과와 메타 메시지, 압축 요약, 작업 알림,
 * 워커 알림은 사람 발화가 아니라서 뺀다. 토큰은 assistant usage의 input, output,
 * cache_creation, cache_read를 더하고 같은 message.id는 한 번만 센다.
 */

export const DEFAULT_WINDOW = 8;
export const BASELINE_DAYS = 45;
export const INTERVENTION_REDUCTION_GOAL = 0.4;
export const TOKEN_INCREASE_TARGET = 0.1;

/** 재개 프롬프트 첫 줄에 붙는 표시. 지표가 워커 재시작 세션을 이걸로 가려낸다 */
export const RESUME_MARKER = '[conductor-resume]';

type Entry = Record<string, unknown>;

const NON_HUMAN_PATTERNS: RegExp[] = [
  /^<task-notification>/,
  /^<local-command/,
  /^<command-(?:message|args|stdout)>/,
  /You have \d+ (?:new )?orchestration messages?/,
  /^─+ From: /m,
  /^This session is being continued from a previous conversation/,
  /^\[Request interrupted by user/,
];

/** 디스패치된 워커 세션의 첫 발화. 사람이 직접 대화한 세션이 아니라 기준에서 뺀다 */
const WORKER_SESSION_PATTERNS: RegExp[] = [
  /orca orchestration (?:send|ask)/,
  /worker_done/,
  /GESTALT_CONDUCTOR_WORKER_ID/,
];

export function parseTranscript(text: string): Entry[] {
  const out: Entry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Entry);
    } catch {
      // 쓰다 끊긴 줄은 건너뛴다
    }
  }
  return out;
}

function message(e: Entry): Entry | undefined {
  const m = e['message'];
  return m && typeof m === 'object' ? (m as Entry) : undefined;
}

/** 사용자 항목의 글. 도구 결과나 메타 메시지면 null이다 */
export function userText(e: Entry): string | null {
  if (e['type'] !== 'user' || e['isMeta'] === true || e['isCompactSummary'] === true) return null;
  const content = message(e)?.['content'];
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content as Entry[]) {
    if (block?.['type'] === 'tool_result') return null;
    if (block?.['type'] === 'text' && typeof block['text'] === 'string') parts.push(block['text']);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function isSlashCommand(text: string): boolean {
  return /<command-name>/.test(text) || /^\/[a-z][\w:-]*(?:\s|$)/.test(text.trimStart());
}

/** 사람이 친 발화인지. 슬래시 명령은 스킬 호출로 따로 센다 */
export function isHumanUtterance(text: string): boolean {
  const t = text.trimStart();
  if (!t) return false;
  if (isSlashCommand(t)) return false;
  return !NON_HUMAN_PATTERNS.some((re) => re.test(t));
}

function toolUses(e: Entry): Entry[] {
  if (e['type'] !== 'assistant') return [];
  const content = message(e)?.['content'];
  if (!Array.isArray(content)) return [];
  return (content as Entry[]).filter((b) => b?.['type'] === 'tool_use');
}

function isSkillCall(e: Entry, text: string | null): boolean {
  if (toolUses(e).some((t) => t['name'] === 'Skill')) return true;
  return text !== null && isSlashCommand(text);
}

function usageOf(e: Entry): number {
  const u = message(e)?.['usage'] as Record<string, unknown> | undefined;
  if (!u) return 0;
  let sum = 0;
  for (const k of [
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
  ]) {
    const v = u[k];
    if (typeof v === 'number') sum += v;
  }
  return sum;
}

export interface SessionMetrics {
  skillCalls: number;
  interventions: number;
  tokens: number;
  isWorker: boolean;
  isResume: boolean;
  /** 이 세션에서 부른 스킬 이름. 컨덕터 세션을 가릴 때 쓴다 */
  skills: string[];
}

export function analyzeTranscript(entries: Entry[], window = DEFAULT_WINDOW): SessionMetrics {
  let skillCalls = 0;
  let humanSinceSkill = Number.POSITIVE_INFINITY;
  let interventions = 0;
  let tokens = 0;
  let firstUser: string | null = null;
  const seenIds = new Set<string>();
  const skills: string[] = [];

  for (const e of entries) {
    const text = userText(e);
    if (firstUser === null && text !== null) firstUser = text;

    if (e['type'] === 'assistant') {
      const id = message(e)?.['id'];
      if (typeof id !== 'string' || !seenIds.has(id)) {
        if (typeof id === 'string') seenIds.add(id);
        tokens += usageOf(e);
      }
      for (const t of toolUses(e)) {
        const skill = (t['input'] as Entry | undefined)?.['skill'];
        if (t['name'] === 'Skill' && typeof skill === 'string') skills.push(skill);
      }
    }
    if (text !== null) {
      const cmd =
        /<command-name>\/?([^<]+)<\/command-name>/.exec(text) ??
        /^\/([a-z][\w:-]*)(?:\s|$)/.exec(text.trimStart());
      if (cmd) skills.push(cmd[1]!.trim());
    }

    if (isSkillCall(e, text)) {
      skillCalls += 1;
      humanSinceSkill = 0;
      continue;
    }
    if (text !== null && isHumanUtterance(text) && humanSinceSkill < window) {
      interventions += 1;
      humanSinceSkill += 1;
    }
  }

  const first = firstUser ?? '';
  return {
    skillCalls,
    interventions,
    tokens,
    isWorker: WORKER_SESSION_PATTERNS.some((re) => re.test(first)),
    isResume: first.trimStart().startsWith(RESUME_MARKER),
    skills,
  };
}

/** 기간 안에 바뀐 transcript 경로. `subagents/` 아래는 뺀다 */
export function collectTranscripts(root: string, sinceMs: number, untilMs = Date.now()): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(root, { recursive: true, withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of entries) {
    if (!d.isFile() || !d.name.endsWith('.jsonl')) continue;
    const path = join(d.parentPath, d.name);
    if (path.split(/[\\/]/).includes('subagents')) continue;
    const mtime = statSync(path).mtimeMs;
    if (mtime >= sinceMs && mtime < untilMs) out.push(path);
  }
  return out.sort();
}

export interface MetricsAverage {
  sessions: number;
  interventions: number;
  tokens: number;
}

export function average(list: SessionMetrics[]): MetricsAverage {
  if (list.length === 0) return { sessions: 0, interventions: 0, tokens: 0 };
  const sum = list.reduce((a, m) => ({ i: a.i + m.interventions, t: a.t + m.tokens }), {
    i: 0,
    t: 0,
  });
  return { sessions: list.length, interventions: sum.i / list.length, tokens: sum.t / list.length };
}

/** 사람이 직접 대화한 스킬 세션. 기준을 셀 때 쓴다 */
export function isHumanSkillSession(m: SessionMetrics): boolean {
  return m.skillCalls > 0 && !m.isWorker;
}

export interface Comparison {
  baseline: MetricsAverage;
  current: MetricsAverage;
  /** 끼어든 발화가 기준보다 얼마나 줄었는지. 0.4면 40% 줄었다 */
  interventionReduction: number | null;
  /** 토큰이 기준보다 얼마나 늘었는지. 0.1이면 10% 늘었다 */
  tokenDelta: number | null;
  interventionGoalMet: boolean;
  tokenTargetMet: boolean;
  /** 합격 여부는 끼어든 발화로만 정한다. 토큰 초과는 notes에 보고만 한다 */
  passed: boolean;
  notes: string[];
}

export function compare(baseline: MetricsAverage, current: MetricsAverage): Comparison {
  const notes: string[] = [];
  const reduction =
    baseline.interventions > 0 ? 1 - current.interventions / baseline.interventions : null;
  const delta = baseline.tokens > 0 ? current.tokens / baseline.tokens - 1 : null;
  if (baseline.sessions === 0) notes.push('기준 세션이 없어 비교할 수 없어요');
  if (current.sessions === 0) notes.push('비교할 컨덕터 세션이 없어요');
  const interventionGoalMet = reduction !== null && reduction >= INTERVENTION_REDUCTION_GOAL;
  const tokenTargetMet = delta !== null && delta <= TOKEN_INCREASE_TARGET;
  if (delta !== null && !tokenTargetMet) {
    notes.push(
      `토큰이 기준보다 ${(delta * 100).toFixed(1)}% 늘어 목표 +${TOKEN_INCREASE_TARGET * 100}%를 넘었어요. 끼어든 발화 목표를 먼저 지키므로 보고만 해요`,
    );
  }
  return {
    baseline,
    current,
    interventionReduction: reduction,
    tokenDelta: delta,
    interventionGoalMet,
    tokenTargetMet,
    passed: interventionGoalMet && current.sessions > 0,
    notes,
  };
}

export type LeakSite = 'conductorContext' | 'polling' | 'results' | 'restart';

/**
 * 토큰이 많이 드는 네 자리를 따로 센다.
 *
 * 재개 세션은 통째로 restart다. 나머지는 assistant 메시지마다 그 메시지가 부른 명령으로
 * 가른다. 상태를 들여다보는 tick과 status는 polling, 워커 결과를 받는 report와 gate
 * 목록은 results, 그 밖은 컨덕터 컨텍스트가 쌓인 몫이다.
 */
export function leakBreakdown(entries: Entry[]): Record<LeakSite, number> {
  const out: Record<LeakSite, number> = { conductorContext: 0, polling: 0, results: 0, restart: 0 };
  const session = analyzeTranscript(entries);
  const seen = new Set<string>();
  for (const e of entries) {
    if (e['type'] !== 'assistant') continue;
    const id = message(e)?.['id'];
    if (typeof id === 'string') {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const n = usageOf(e);
    if (session.isResume) {
      out.restart += n;
      continue;
    }
    const commands = toolUses(e)
      .map((t) => (t['input'] as Entry | undefined)?.['command'])
      .filter((c): c is string => typeof c === 'string');
    if (commands.some((c) => /\bconductor\s+(?:tick|status)\b/.test(c))) out.polling += n;
    else if (commands.some((c) => /\bconductor\s+(?:worker\s+report|gate\s+list)\b/.test(c)))
      out.results += n;
    else out.conductorContext += n;
  }
  return out;
}

export interface MetricsReport {
  comparison: Comparison;
  leaks: Record<LeakSite, number>;
}

/**
 * `since` 이전 45일의 사람 직접 세션을 기준으로, `since` 이후 conductor 스킬을 쓴 세션을 잰다.
 * 컨덕터가 띄운 워커 세션은 컨덕터 세션 토큰에 더한다. 워커가 쓴 토큰도 컨덕터가 쓴 몫이라서다.
 */
export function measure(opts: {
  root: string;
  since: number;
  now?: number;
  window?: number;
  conductorSkill?: string;
}): MetricsReport {
  const now = opts.now ?? Date.now();
  const window = opts.window ?? DEFAULT_WINDOW;
  const conductorSkill = opts.conductorSkill ?? 'conductor';
  const dayMs = 24 * 60 * 60 * 1000;

  const read = (p: string) => parseTranscript(readFileSync(p, 'utf-8'));
  const baselineSessions = collectTranscripts(
    opts.root,
    opts.since - BASELINE_DAYS * dayMs,
    opts.since,
  )
    .map((p) => analyzeTranscript(read(p), window))
    .filter(isHumanSkillSession);

  const leaks: Record<LeakSite, number> = {
    conductorContext: 0,
    polling: 0,
    results: 0,
    restart: 0,
  };
  const conductorSessions: SessionMetrics[] = [];
  let workerTokens = 0;
  for (const p of collectTranscripts(opts.root, opts.since, now)) {
    const entries = read(p);
    const m = analyzeTranscript(entries, window);
    if (m.isWorker) {
      workerTokens += m.tokens;
      const l = leakBreakdown(entries);
      leaks.restart += l.restart;
      continue;
    }
    if (!m.skills.some((s) => s === conductorSkill || s.endsWith(`:${conductorSkill}`))) continue;
    conductorSessions.push(m);
    const l = leakBreakdown(entries);
    leaks.conductorContext += l.conductorContext;
    leaks.polling += l.polling;
    leaks.results += l.results;
  }
  const current = average(conductorSessions);
  if (conductorSessions.length > 0) current.tokens += workerTokens / conductorSessions.length;
  return { comparison: compare(average(baselineSessions), current), leaks };
}
