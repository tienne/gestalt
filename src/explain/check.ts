/**
 * 설명이 그 대상에게 읽히는 글인지 코드가 판단하는 검사.
 *
 * humanize-check 와 판정 구조만 같고 재는 것은 반대다. 거기는 의미가 보존됐는지를 보고
 * 원문을 절반 넘게 버리면 채택 금지다. 설명은 원문을 많이 버려야 성공이라 그 검사를 그대로
 * 쓰면 잘된 설명일수록 막힌다. 그래서 축을 새로 잡았다 — 용어, 문장 길이, 핵심어 잔존,
 * 비유, 어미, 사실 정확도.
 *
 * 여섯 중 다섯이 결정론이다. LLM 없이 돌고 같은 입력에 같은 점수가 나온다. 심판 모델은
 * 사실이 틀렸는지 하나만 본다 — 그건 코드가 못 재는 자리라서다.
 */
import { proseLines, splitSentences } from '../humanize/detectors.js';
import type { LLMAdapter } from '../llm/types.js';
import {
  CORE_TERM_COUNT,
  DEFAULT_AUDIENCE,
  presetOf,
  type Audience,
  type AudiencePreset,
  type Band,
} from './audience.js';
import { coreTerms, extractTerms, findTermUses, type Term, type TermUse } from './terms.js';

export type Verdict = 'pass' | 'warn' | 'abort';

export const EXIT_CODE: Record<Verdict | 'unknown', number> = {
  pass: 0,
  warn: 1,
  abort: 2,
  unknown: 3,
};

export type ExplainAxis = 'jargon' | 'length' | 'coverage' | 'analogy' | 'register' | 'accuracy';

/** 심판 모델 없이 도는 축. `--judge` 를 안 켜도 검사가 성립한다는 근거다 */
export const DETERMINISTIC_AXES: readonly ExplainAxis[] = [
  'jargon',
  'length',
  'coverage',
  'analogy',
  'register',
];

export interface AxisResult {
  axis: ExplainAxis;
  verdict: Verdict;
  detail: string;
  evidence?: string[];
}

export interface ExplainMetrics {
  words: number;
  sentences: number;
  avgSentenceLength: number;
  /** 풀이 없이 남은 용어 출현 수를 어절 수로 나눈 값 */
  jargonDensity: number;
  unglossed: number;
  glossed: number;
  coverage: number;
  coreTerms: string[];
  coveredTerms: string[];
  analogyMarkers: string[];
  register: RegisterStats;
}

export interface ExplainReport {
  audience: Audience;
  verdict: Verdict;
  exitCode: number;
  metrics: ExplainMetrics;
  axes: AxisResult[];
}

export interface ExplainCheckOptions {
  audience?: Audience;
}

const WORST: Record<Verdict, number> = { pass: 0, warn: 1, abort: 2 };

function worst(verdicts: readonly Verdict[]): Verdict {
  return verdicts.reduce((acc, v) => (WORST[v] > WORST[acc] ? v : acc), 'pass' as Verdict);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** 상한을 재는 축. 값이 클수록 나쁘다 */
function overBand(value: number, band: Band): Verdict {
  if (value > band.abort) return 'abort';
  if (value > band.warn) return 'warn';
  return 'pass';
}

/** 하한을 재는 축. 값이 작을수록 나쁘다 */
function underBand(value: number, band: Band): Verdict {
  if (value < band.abort) return 'abort';
  if (value < band.warn) return 'warn';
  return 'pass';
}

/**
 * 검사할 산문만 남긴다.
 *
 * humanize 의 proseOnly 를 안 쓰는 이유가 하나다 — 그쪽은 인라인 백틱을 공백으로 지운다.
 * 여기서는 백틱 안에 든 말이 곧 세야 할 전문용어라 지우면 검사가 통째로 빈다.
 * 언어 태그 붙은 코드펜스와 표를 빼는 건 proseLines 가 이미 한다.
 */
function explainProse(text: string, options: { excludeQuotes?: boolean } = {}): string {
  return proseLines(text, options)
    .map((line) => line.text)
    .filter((line) => !/^\s*#{1,6}\s/.test(line))
    .join('\n');
}

function countWords(prose: string): number {
  return prose.split(/\s+/).filter(Boolean).length;
}

/** 목록 기호와 번호는 문장 길이가 아니다 */
function sentenceBody(sentence: string): string {
  return sentence.replace(/^[\s>*+\-#]*(?:\d+[.)]\s*)?/, '').trim();
}

function measuredSentences(prose: string): string[] {
  return splitSentences(prose)
    .map(sentenceBody)
    .filter((s) => s.length >= 2);
}

// --- 용어 ------------------------------------------------------------------

/**
 * 한 번이라도 풀어준 용어는 그 뒤 출현도 풀린 것으로 본다.
 *
 * 대상표가 요구하는 건 "첫 등장 정의"지 매번 반복이 아니다. 출현마다 따로 세면 제대로 정의하고
 * 그다음부터 그냥 쓴 글이 정의를 아예 안 한 글과 같은 점수를 받는다.
 */
function unglossedUses(uses: readonly TermUse[]): TermUse[] {
  const explained = new Set(uses.filter((use) => use.glossed).map((use) => use.term));
  return uses.filter((use) => !explained.has(use.term));
}

function checkJargon(preset: AudiencePreset, uses: readonly TermUse[], words: number): AxisResult {
  const unglossed = unglossedUses(uses);
  const density = words === 0 ? 0 : unglossed.length / words;
  const detail = `풀이 없는 전문용어 ${unglossed.length}건 / ${words}어절 (밀도 ${pct(density)}, 상한 ${pct(preset.jargon.warn)})`;
  const verdict = overBand(density, preset.jargon);

  if (verdict === 'pass') {
    return { axis: 'jargon', verdict, detail };
  }
  return {
    axis: 'jargon',
    verdict,
    detail,
    evidence: [...new Set(unglossed.map((use) => `${use.term} — ${use.excerpt}`))].slice(0, 8),
  };
}

// --- 문장 길이 --------------------------------------------------------------

function checkLength(preset: AudiencePreset, sentences: readonly string[]): AxisResult {
  if (sentences.length === 0) {
    return { axis: 'length', verdict: 'abort', detail: '잴 문장이 없다' };
  }

  const total = sentences.reduce((sum, s) => sum + s.length, 0);
  const average = total / sentences.length;
  const verdict = overBand(average, preset.sentence);
  const detail = `평균 문장 ${average.toFixed(1)}자 / ${sentences.length}문장 (상한 ${preset.sentence.warn}자)`;

  if (verdict === 'pass') return { axis: 'length', verdict, detail };

  const longest = [...sentences].sort((a, b) => b.length - a.length).slice(0, 3);
  return {
    axis: 'length',
    verdict,
    detail,
    evidence: longest.map((s) => `${s.length}자 — ${s.slice(0, 60)}`),
  };
}

// --- 핵심어 잔존 -------------------------------------------------------------

function checkCoverage(
  preset: AudiencePreset,
  core: readonly Term[],
  covered: readonly string[],
): AxisResult {
  if (core.length === 0) {
    return { axis: 'coverage', verdict: 'pass', detail: '원문에서 뽑을 전문용어가 없다' };
  }

  const ratio = covered.length / core.length;
  const verdict = underBand(ratio, preset.coverage);
  const detail = `원문 핵심어 ${core.length}개 중 ${covered.length}개를 다룸 (${pct(ratio)}, 하한 ${pct(preset.coverage.warn)})`;

  if (verdict === 'pass') return { axis: 'coverage', verdict, detail };

  const missing = core.filter((term) => !covered.includes(term.text));
  return {
    axis: 'coverage',
    verdict,
    detail,
    evidence: [`빠진 핵심어: ${missing.map((t) => t.text).join(', ')}`],
  };
}

// --- 비유 -------------------------------------------------------------------

/** audience.md 의 비유 표지 표와 같은 목록이다. 한쪽만 고치면 문서와 검사가 갈라진다 */
const ANALOGY_MARKERS = [
  '비유하면',
  '비유하자면',
  '빗대면',
  '마치',
  '에 비유',
  '라고 생각하면',
  '인 셈',
  '와 같은 거',
  '같은 것',
  '비슷',
  '처럼',
  '과 같이',
];

function findAnalogyMarkers(prose: string): string[] {
  return ANALOGY_MARKERS.filter((marker) => prose.includes(marker));
}

function checkAnalogy(preset: AudiencePreset, markers: readonly string[]): AxisResult {
  if (preset.analogy === 'off') {
    return { axis: 'analogy', verdict: 'pass', detail: `${preset.audience}에게 비유는 안 본다` };
  }
  if (markers.length > 0) {
    return {
      axis: 'analogy',
      verdict: 'pass',
      detail: `비유 표지 ${markers.length}종`,
      evidence: [markers.join(', ')],
    };
  }
  return {
    axis: 'analogy',
    verdict: preset.analogy === 'required' ? 'abort' : 'warn',
    detail:
      preset.analogy === 'required'
        ? `${preset.audience}는 비유가 필수인데 표지가 없다`
        : `${preset.audience}에게는 비유를 권한다. 표지가 없다`,
  };
}

// --- 어미 -------------------------------------------------------------------

export interface RegisterStats {
  polite: number;
  formal: number;
  plain: number;
}

const TRAILING = /[\s.!?…~)\]"'”’*_]+$/;

/** 이만큼은 돼야 한 문장 튄 걸 흔들림으로 볼 수 있다. 그 아래에서는 섞어 쓴 것이다 */
const STRAY_ENDING_FLOOR = 10;

export function registerStats(text: string): RegisterStats {
  const stats: RegisterStats = { polite: 0, formal: 0, plain: 0 };

  for (const sentence of measuredSentences(explainProse(text, { excludeQuotes: true }))) {
    const tail = sentence.replace(TRAILING, '');
    if (/[가-힣]니다$/.test(tail)) stats.formal += 1;
    else if (/[가-힣]요$/.test(tail)) stats.polite += 1;
    else if (/[가-힣]다$/.test(tail)) stats.plain += 1;
  }

  return stats;
}

function checkRegister(preset: AudiencePreset, stats: RegisterStats): AxisResult {
  const counted = stats.polite + stats.formal + stats.plain;
  const shape = `해요체 ${stats.polite} / 합니다체 ${stats.formal} / 평서체 ${stats.plain}`;

  if (counted === 0) {
    return { axis: 'register', verdict: 'warn', detail: '판정할 어미가 없다' };
  }

  const mixed = [stats.polite, stats.formal, stats.plain].filter((n) => n > 0);
  if (mixed.length > 1) {
    // 어미를 섞으면 읽는 사람이 자기가 어느 대상인지 헷갈린다. 봐주는 건 한 자리뿐이다 —
    // 긴 글에서 한 문장만 튄 건 남의 말을 옮겨오다 딸려온 자리일 수 있다
    const stray = Math.min(...mixed) === 1 && counted >= STRAY_ENDING_FLOOR;
    return {
      axis: 'register',
      verdict: stray ? 'warn' : 'abort',
      detail: `어미가 섞였다 — ${shape}`,
    };
  }

  const wanted = preset.register === 'polite' ? stats.polite : stats.formal;
  if (wanted === 0) {
    return {
      axis: 'register',
      verdict: 'warn',
      detail: `${preset.audience}는 ${preset.register === 'polite' ? '해요체' : '합니다체'}인데 다른 어미로 썼다 — ${shape}`,
    };
  }

  return { axis: 'register', verdict: 'pass', detail: `어미 일관 — ${shape}` };
}

// --- 조립 -------------------------------------------------------------------

export function runExplainCheck(
  source: string,
  explanation: string,
  options: ExplainCheckOptions = {},
): ExplainReport {
  const audience = options.audience ?? DEFAULT_AUDIENCE;
  const preset = presetOf(audience);

  const prose = explainProse(explanation);
  const words = countWords(prose);
  const sentences = measuredSentences(prose);

  const terms = extractTerms(source);
  const core = coreTerms(terms, CORE_TERM_COUNT);
  const uses = findTermUses(prose, terms);
  const usedTexts = new Set(uses.map((use) => use.term));
  const covered = core.filter((term) => usedTexts.has(term.text)).map((term) => term.text);

  const markers = findAnalogyMarkers(prose);
  const register = registerStats(explanation);

  const axes: AxisResult[] = [
    checkJargon(preset, uses, words),
    checkLength(preset, sentences),
    checkCoverage(preset, core, covered),
    checkAnalogy(preset, markers),
    checkRegister(preset, register),
  ];

  const unglossed = unglossedUses(uses).length;
  const metrics: ExplainMetrics = {
    words,
    sentences: sentences.length,
    avgSentenceLength:
      sentences.length === 0
        ? 0
        : sentences.reduce((sum, s) => sum + s.length, 0) / sentences.length,
    jargonDensity: words === 0 ? 0 : unglossed / words,
    unglossed,
    glossed: uses.length - unglossed,
    coverage: core.length === 0 ? 1 : covered.length / core.length,
    coreTerms: core.map((term) => term.text),
    coveredTerms: covered,
    analogyMarkers: markers,
    register,
  };

  const verdict = worst(axes.map((a) => a.verdict));
  return { audience, verdict, exitCode: EXIT_CODE[verdict], metrics, axes };
}

/** 심판 축을 얹고 판정을 다시 낸다. 결정론 축은 그대로 둔다 */
export function withAxis(report: ExplainReport, axis: AxisResult): ExplainReport {
  const axes = [...report.axes.filter((a) => a.axis !== axis.axis), axis];
  const verdict = worst(axes.map((a) => a.verdict));
  return { ...report, axes, verdict, exitCode: EXIT_CODE[verdict] };
}

// --- 심판 모델 ---------------------------------------------------------------

export interface JudgeInput {
  source: string;
  explanation: string;
  audience: Audience;
}

const JUDGE_SYSTEM = `당신은 설명문의 사실 정확도만 판정합니다. 문체와 길이, 어미는 보지 않습니다.

원문과 그 원문을 특정 대상에게 다시 쓴 설명문을 받습니다. 설명문은 원문을 많이 버립니다 —
버린 것 자체는 문제가 아닙니다. 문제는 남긴 것이 틀렸을 때입니다.

판정 기준:
- abort: 원문에 없는 사실을 지어냈거나, 원문 내용을 반대로 말했거나, 인과를 뒤집었다
- warn: 지나치게 단순화해서 오해를 부를 여지가 있다
- pass: 남긴 내용이 원문과 어긋나지 않는다

JSON 하나만 출력합니다. 다른 말은 붙이지 않습니다.
{"verdict":"pass|warn|abort","detail":"한 문장","evidence":["근거가 된 설명문 문장"]}`;

const VERDICTS: readonly string[] = ['pass', 'warn', 'abort'];

/**
 * 사실 정확도만 심판 모델에게 묻는다.
 *
 * 어댑터를 인자로 받아 이 파일이 설정을 안 읽게 막는다. 결정론 축은 파일만 있으면 돌아야
 * 하는데 설정을 여기서 읽으면 그 조건이 깨진다.
 */
export async function judgeAccuracy(adapter: LLMAdapter, input: JudgeInput): Promise<AxisResult> {
  const user = [
    `[대상] ${input.audience}`,
    '',
    '=== 원문 ===',
    input.source,
    '',
    '=== 설명문 ===',
    input.explanation,
  ].join('\n');

  let raw: string;
  try {
    const response = await adapter.chat({
      system: JUDGE_SYSTEM,
      messages: [{ role: 'user', content: user }],
      temperature: 0.3,
      maxTokens: 1024,
    });
    raw = response.content;
  } catch (error) {
    return {
      axis: 'accuracy',
      verdict: 'warn',
      detail: `심판 모델을 못 불렀다: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const parsed = parseJudge(raw);
  if (!parsed) {
    return {
      axis: 'accuracy',
      verdict: 'warn',
      detail: '심판 응답을 못 읽었다',
      evidence: [raw.slice(0, 200)],
    };
  }
  return parsed;
}

function parseJudge(raw: string): AxisResult | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    const data = JSON.parse(match[0]) as {
      verdict?: unknown;
      detail?: unknown;
      evidence?: unknown;
    };
    const verdict = typeof data.verdict === 'string' ? data.verdict : '';
    if (!VERDICTS.includes(verdict)) return null;

    return {
      axis: 'accuracy',
      verdict: verdict as Verdict,
      detail: typeof data.detail === 'string' ? data.detail : '',
      evidence: Array.isArray(data.evidence) ? data.evidence.map(String).slice(0, 5) : undefined,
    };
  } catch {
    return null;
  }
}

// --- 다음 행동 ---------------------------------------------------------------

export type NextAction = 'accept' | 'accept-with-warning' | 'retry' | 'fallback';

export interface Decision {
  action: NextAction;
  message: string;
}

/** 설명은 한 번만 다시 시킨다. 두 번째도 막히면 사람이 본다 */
export const MAX_ATTEMPTS = 2;

export function decide(
  report: ExplainReport,
  attempt: number = 1,
  maxAttempts: number = MAX_ATTEMPTS,
): Decision {
  if (report.verdict === 'pass') {
    return { action: 'accept', message: '검사 통과. 설명본을 채택한다.' };
  }
  if (report.verdict === 'warn') {
    const flagged = report.axes
      .filter((axis) => axis.verdict === 'warn')
      .map((axis) => axis.axis)
      .join(', ');
    return {
      action: 'accept-with-warning',
      message: `설명본을 채택하되 걸린 축을 요약에 적는다: ${flagged}`,
    };
  }

  const blocking = report.axes
    .filter((axis) => axis.verdict === 'abort')
    .map((axis) => axis.detail)
    .join(' / ');

  if (attempt < maxAttempts) {
    return {
      action: 'retry',
      message: `${blocking} — 설명본을 버리고 원문에서 다시 쓴 뒤 --attempt ${attempt + 1}로 검사한다.`,
    };
  }
  return {
    action: 'fallback',
    message: `${blocking} — 재시도(${maxAttempts}회)를 소진했다. 사람이 읽고 정한다.`,
  };
}

export function formatExplainReport(report: ExplainReport, attempt: number = 1): string {
  const lines = [
    `검사 ${report.verdict.toUpperCase()} (exit ${report.exitCode}) / 대상 ${report.audience} / 시도 ${attempt}`,
    '',
  ];

  for (const axis of report.axes) {
    const mark = axis.verdict === 'pass' ? 'OK' : axis.verdict === 'warn' ? '경고' : '중단';
    lines.push(`[${mark}] ${axis.axis} — ${axis.detail}`);
    for (const item of axis.evidence ?? []) lines.push(`       ${item}`);
  }

  const decision = decide(report, attempt);
  lines.push('', `[다음] ${decision.action} — ${decision.message}`);
  return lines.join('\n');
}
