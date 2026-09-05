/**
 * 설명 프롬프트 두 벌을 같은 케이스로 돌려 비교한다.
 *
 * ELI5 의 run-evals.py 가 참고 대상인데 저쪽은 채점이 전부 심판 모델이라 같은 답에 다른
 * 점수가 나온다. 여기서는 여섯 항목 중 다섯이 결정론이라 재현된다 — 프롬프트를 고쳤을 때
 * 움직인 숫자가 프롬프트 때문인지 심판 모델의 그날 기분인지 가릴 수 있다는 뜻이다.
 * 심판이 필요한 자리는 사실 정확도 하나뿐이라 거기만 태운다.
 */
import matter from 'gray-matter';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { loadConfig } from '../../core/config.js';
import { createAdapter } from '../../llm/factory.js';
import type { LLMAdapter } from '../../llm/types.js';
import {
  AUDIENCES,
  DETERMINISTIC_AXES,
  EXIT_CODE,
  judgeAccuracy,
  presetOf,
  runExplainCheck,
  type Audience,
  type ExplainAxis,
  type Verdict,
} from '../../explain/index.js';

export const DEFAULT_CASES_PATH = 'evals/explain-cases.json';

const caseSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  audience: z.enum(AUDIENCES as [Audience, ...Audience[]]),
  source: z.string().min(1),
  assertions: z
    .object({
      mustMention: z.array(z.string()).default([]),
      mustAvoid: z.array(z.string()).default([]),
    })
    .default({ mustMention: [], mustAvoid: [] }),
});

const fileSchema = z.object({
  version: z.literal(1),
  cases: z.array(caseSchema).min(1),
});

export type EvalCase = z.infer<typeof caseSchema>;

/** 결정론 다섯 축에 케이스별 어서션과 심판 축을 더한 것 */
export type EvalAxis = ExplainAxis | 'assertions';

export const EVAL_AXES: readonly EvalAxis[] = [...DETERMINISTIC_AXES, 'assertions', 'accuracy'];

/** explain-check 의 AxisResult 에 케이스 어서션 축을 더한 꼴 */
export interface EvalAxisResult {
  axis: EvalAxis;
  verdict: Verdict;
  detail: string;
  evidence?: string[];
}

export interface CaseResult {
  caseId: string;
  variant: string;
  explanation: string;
  axes: EvalAxisResult[];
  verdict: Verdict;
}

export interface AxisRate {
  axis: EvalAxis;
  a: number;
  b: number;
  delta: number;
}

export interface Summary {
  cases: number;
  labels: { a: string; b: string };
  axes: AxisRate[];
  overall: { a: number; b: number; delta: number };
}

export function loadCases(path: string): EvalCase[] {
  const full = resolve(process.cwd(), path);
  const parsed = fileSchema.safeParse(JSON.parse(readFileSync(full, 'utf-8')));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`케이스 파일이 형식에 안 맞습니다: ${full}\n${issues.join('\n')}`);
  }
  return parsed.data.cases;
}

/**
 * 케이스가 직접 적은 기대. 축 다섯이 못 보는 자리를 케이스마다 따로 잡는다.
 *
 * 있어야 할 말과 있으면 안 되는 말만 본다. 이걸 늘리기 시작하면 케이스 파일이 두 번째
 * 룰북이 되므로 두 갈래로 묶어 둔다.
 */
export function scoreAssertions(explanation: string, testCase: EvalCase): EvalAxisResult {
  const missing = testCase.assertions.mustMention.filter((word) => !explanation.includes(word));
  const banned = testCase.assertions.mustAvoid.filter((word) => explanation.includes(word));

  if (missing.length === 0 && banned.length === 0) {
    return { axis: 'assertions', verdict: 'pass', detail: '어서션 통과' };
  }
  return {
    axis: 'assertions',
    verdict: 'abort',
    detail: `어서션 ${missing.length + banned.length}건 실패`,
    evidence: [
      ...missing.map((word) => `빠짐: ${word}`),
      ...banned.map((word) => `있으면 안 됨: ${word}`),
    ],
  };
}

const SYSTEM_TAIL = (audience: Audience): string => {
  const preset = presetOf(audience);
  return `\n\n[대상] ${audience} — ${preset.who}\n어미는 ${preset.register === 'polite' ? '해요체' : '합니다체'}로 끝까지 간다. 설명문만 출력한다.`;
};

/** --b 를 안 주면 이 자리가 베이스라인이다. 에이전트 프롬프트 없이 그냥 시킨다 */
export const BASELINE_PROMPT = '다음 내용을 읽는 사람에게 설명하세요.';
export const BASELINE_LABEL = 'baseline';

export function readVariant(path?: string): { label: string; prompt: string } {
  if (!path) return { label: BASELINE_LABEL, prompt: BASELINE_PROMPT };
  const full = resolve(process.cwd(), path);
  const { content } = matter(readFileSync(full, 'utf-8'));
  return { label: path, prompt: content.trim() };
}

export async function runVariant(
  adapter: LLMAdapter,
  variant: { label: string; prompt: string },
  cases: readonly EvalCase[],
  options: { judge: boolean },
): Promise<CaseResult[]> {
  const results: CaseResult[] = [];

  for (const testCase of cases) {
    const response = await adapter.chat({
      system: variant.prompt + SYSTEM_TAIL(testCase.audience),
      messages: [{ role: 'user', content: testCase.source }],
      temperature: 0.3,
      maxTokens: 2048,
    });
    const explanation = response.content.trim();

    const report = runExplainCheck(testCase.source, explanation, { audience: testCase.audience });
    const axes: EvalAxisResult[] = [...report.axes, scoreAssertions(explanation, testCase)];

    if (options.judge) {
      axes.push(
        await judgeAccuracy(adapter, {
          source: testCase.source,
          explanation,
          audience: testCase.audience,
        }),
      );
    }

    results.push({
      caseId: testCase.id,
      variant: variant.label,
      explanation,
      axes,
      verdict: worstOf(axes.map((a) => a.verdict)),
    });
  }

  return results;
}

const WORST: Record<Verdict, number> = { pass: 0, warn: 1, abort: 2 };

function worstOf(verdicts: readonly Verdict[]): Verdict {
  return verdicts.reduce((acc, v) => (WORST[v] > WORST[acc] ? v : acc), 'pass' as Verdict);
}

/** 그 축을 실제로 잰 케이스만 분모에 넣는다. 심판을 안 태운 판에서 accuracy 가 0%로 보이면 안 된다 */
function passRate(results: readonly CaseResult[], axis: EvalAxis): number {
  const scored = results.filter((r) => r.axes.some((a) => a.axis === axis));
  if (scored.length === 0) return 0;
  const passed = scored.filter((r) => r.axes.some((a) => a.axis === axis && a.verdict === 'pass'));
  return passed.length / scored.length;
}

export function aggregate(
  labels: { a: string; b: string },
  a: readonly CaseResult[],
  b: readonly CaseResult[],
): Summary {
  const axes = EVAL_AXES.map((axis) => {
    const left = passRate(a, axis);
    const right = passRate(b, axis);
    return { axis, a: left, b: right, delta: right - left };
  });

  const overallA = a.length === 0 ? 0 : a.filter((r) => r.verdict === 'pass').length / a.length;
  const overallB = b.length === 0 ? 0 : b.filter((r) => r.verdict === 'pass').length / b.length;

  return {
    cases: Math.max(a.length, b.length),
    labels,
    axes,
    overall: { a: overallA, b: overallB, delta: overallB - overallA },
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function signed(value: number): string {
  const text = pct(Math.abs(value));
  if (value === 0) return '  0%';
  return value > 0 ? `+${text}` : `-${text}`;
}

export function formatSummary(summary: Summary): string {
  const lines = [
    `케이스 ${summary.cases}개`,
    `A = ${summary.labels.a}`,
    `B = ${summary.labels.b}`,
    '',
    '항목          A      B      차이',
  ];

  for (const row of summary.axes) {
    lines.push(
      `${row.axis.padEnd(12)}  ${pct(row.a).padStart(4)}  ${pct(row.b).padStart(4)}  ${signed(row.delta)}`,
    );
  }
  lines.push(
    '',
    `전체 통과     ${pct(summary.overall.a).padStart(4)}  ${pct(summary.overall.b).padStart(4)}  ${signed(summary.overall.delta)}`,
  );
  return lines.join('\n');
}

export interface ExplainEvalOptions {
  a: string;
  b?: string;
  cases?: string;
  json?: boolean;
}

export async function explainEvalCommand(options: ExplainEvalOptions): Promise<void> {
  let cases: EvalCase[];
  try {
    cases = loadCases(options.cases ?? DEFAULT_CASES_PATH);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(EXIT_CODE.unknown);
  }

  const config = loadConfig();
  if (!config.llm.apiKey) {
    console.error('설명본을 만들려면 API 키가 필요합니다. 결정론 축도 채점할 대상이 없습니다.');
    process.exit(EXIT_CODE.unknown);
  }

  const adapter = createAdapter(config.llm);
  const left = readVariant(options.a);
  const right = readVariant(options.b);

  // 설명본을 만드느라 이미 모델을 부르는 자리라 심판은 옵트인으로 두지 않는다.
  // 플래그를 늘리는 대신 사실 정확도를 항상 잰다
  const a = await runVariant(adapter, left, cases, { judge: true });
  const b = await runVariant(adapter, right, cases, { judge: true });
  const summary = aggregate({ a: left.label, b: right.label }, a, b);

  if (options.json) {
    console.log(JSON.stringify({ summary, results: { a, b } }, null, 2));
  } else {
    console.log(formatSummary(summary));
  }

  process.exit(summary.overall.b < summary.overall.a ? EXIT_CODE.warn : EXIT_CODE.pass);
}
