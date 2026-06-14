/**
 * Resolution Benchmark — LLM-as-judge
 *
 * Gestalt 핵심 가설 검증:
 * "해상도 0.8 스펙이 0.5 스펙보다 재작업률이 낮다"
 *
 * Usage:
 *   pnpm tsx benchmarks/run-resolution-benchmark.ts
 *   pnpm tsx benchmarks/run-resolution-benchmark.ts --dry-run
 *   pnpm tsx benchmarks/run-resolution-benchmark.ts --limit 5
 */

import 'dotenv/config';
import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';

// ─── Types ────────────────────────────────────────────────────────

interface Requirement {
  id: string;
  text: string;
  domain: string;
  ambiguityLevel: string;
  expectedResolutionRange: { min: number; max: number };
}

interface RequirementsFile {
  version: string;
  description: string;
  requirements: Requirement[];
}

interface RubricCriterion {
  id: string;
  name: string;
  weight: number;
  description: string;
  scoringPrompt: string;
}

interface ResolutionLevel {
  score: number;
  description: string;
  contextTemplate: string;
}

interface Rubric {
  version: string;
  hypothesis: string;
  resolutionLevels: Record<string, ResolutionLevel>;
  criteria: RubricCriterion[];
  outputSchema: Record<string, unknown>;
  successThresholds: {
    minReworkReduction_lowToHigh: number;
    minMonotonicityRate: number;
    minReproducibilityScore: number;
  };
}

interface JudgeOutput {
  reworkProbability: number;
  confidence: number;
  reasoning: string;
  keyAmbiguities: string[];
}

type ResolutionKey = 'low' | 'mid' | 'high';

interface RequirementResult {
  requirementId: string;
  requirementText: string;
  domain: string;
  ambiguityLevel: string;
  judgements: Record<ResolutionKey, JudgeOutput>;
  isMonotonic: boolean;
  reworkReduction_lowToHigh: number;
  isDryRun: boolean;
}

interface BenchmarkResult {
  version: string;
  timestamp: string;
  hypothesis: string;
  isDryRun: boolean;
  totalRequirements: number;
  results: RequirementResult[];
  summary: {
    avgReworkProbability: Record<ResolutionKey, number>;
    avgReworkReduction_lowToHigh: number;
    monotonicityRate: number;
    monotonicitySatisfied: boolean;
    causalitySatisfied: boolean;
    hypothesisSupported: boolean;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

function loadJSON<T>(filePath: string): T {
  const content = readFileSync(filePath, 'utf-8');
  return JSON.parse(content) as T;
}

function buildContext(requirement: string, level: ResolutionLevel): string {
  return level.contextTemplate.replace('{requirement}', requirement);
}

function buildJudgePrompt(context: string, rubric: Rubric): { system: string; user: string } {
  const criteriaText = rubric.criteria
    .map((c) => `- ${c.name}(weight=${c.weight}): ${c.scoringPrompt}`)
    .join('\n');

  const system = `당신은 소프트웨어 개발 스펙의 품질을 평가하는 전문 judge입니다.
주어진 요구사항 스펙을 읽고, 개발팀이 이 스펙 기반으로 작업할 때 재작업(rework)이 얼마나 필요할지 평가합니다.

평가 기준:
${criteriaText}

반드시 아래 JSON 형식으로만 응답하세요 (코드블록 없이):
{
  "reworkProbability": 0.0~1.0 사이 숫자,
  "confidence": 0.0~1.0 사이 숫자,
  "reasoning": "평가 근거 2-3문장",
  "keyAmbiguities": ["모호성1", "모호성2"]
}`;

  const user = `다음 스펙을 평가해주세요:

${context}

위 스펙을 기반으로 개발팀이 작업할 때 재작업이 필요할 확률을 JSON으로 응답하세요.`;

  return { system, user };
}

// ─── Mock Judge (Dry-Run) ─────────────────────────────────────────

function mockJudge(requirementId: string, level: ResolutionKey, ambiguityLevel: string): JudgeOutput {
  // 실제 패턴을 반영한 deterministic mock
  const baseRework: Record<string, number> = {
    'very-high': 0.88,
    'high': 0.72,
    'medium': 0.52,
    'low': 0.30,
  };

  const levelAdjust: Record<ResolutionKey, number> = {
    low: 0,
    mid: -0.12,
    high: -0.28,
  };

  // id 기반 미세 변동 (±0.05 범위)
  const idHash = requirementId.split('-').pop();
  const idNum = parseInt(idHash ?? '0', 10) || 0;
  const jitter = ((idNum % 5) - 2) * 0.01;

  const base = baseRework[ambiguityLevel] ?? 0.5;
  const reworkProbability = Math.max(0.05, Math.min(0.98, base + (levelAdjust[level] ?? 0) + jitter));

  const ambiguities: Record<ResolutionKey, string[]> = {
    low: ['범위가 불명확함', '성공 기준 없음', '기술 스택 미지정', '엣지 케이스 미정의'],
    mid: ['일부 제약조건 불명확', '성공 기준 모호'],
    high: [],
  };

  return {
    reworkProbability: Math.round(reworkProbability * 100) / 100,
    confidence: level === 'high' ? 0.90 : level === 'mid' ? 0.82 : 0.78,
    reasoning: `[DRY-RUN] 해상도 ${level} 스펙. 모호성 수준 ${ambiguityLevel}. 재작업 확률 ${(reworkProbability * 100).toFixed(0)}%.`,
    keyAmbiguities: (ambiguities[level] ?? []).slice(0, 3),
  };
}

// ─── LLM Judge ────────────────────────────────────────────────────

async function llmJudge(
  client: Anthropic,
  model: string,
  context: string,
  rubric: Rubric,
): Promise<JudgeOutput> {
  const { system, user } = buildJudgePrompt(context, rubric);

  const response = await client.messages.create({
    model,
    max_tokens: 512,
    temperature: 0.2,
    system,
    messages: [{ role: 'user', content: user }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text content in LLM response');
  }

  try {
    return JSON.parse(textBlock.text) as JudgeOutput;
  } catch {
    // fallback: 파싱 실패 시 텍스트에서 JSON 추출 시도
    const match = textBlock.text.match(/\{[\s\S]*\}/);
    if (match?.[0]) {
      return JSON.parse(match[0]) as JudgeOutput;
    }
    throw new Error(`Failed to parse judge response: ${textBlock.text.slice(0, 200)}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────

async function runBenchmark(opts: {
  dryRun: boolean;
  limit: number | null;
  output: string;
  model: string;
}): Promise<void> {
  const { dryRun, limit, output, model } = opts;

  // 파일 로드
  const requirementsPath = join(PROJECT_ROOT, 'benchmarks/golden-set/requirements.json');
  const rubricPath = join(PROJECT_ROOT, 'benchmarks/judge/rubric.json');

  if (!existsSync(requirementsPath)) {
    throw new Error(`requirements.json not found: ${requirementsPath}`);
  }
  if (!existsSync(rubricPath)) {
    throw new Error(`rubric.json not found: ${rubricPath}`);
  }

  const reqFile = loadJSON<RequirementsFile>(requirementsPath);
  const rubric = loadJSON<Rubric>(rubricPath);

  let requirements = reqFile.requirements;
  if (limit !== null && limit > 0) {
    requirements = requirements.slice(0, limit);
  }

  // API 키 체크
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
  const hasApiKey = apiKey.length > 0;
  const isActualDryRun = dryRun || !hasApiKey;

  if (isActualDryRun && !dryRun) {
    console.log('⚠  ANTHROPIC_API_KEY 없음 → dry-run 모드로 자동 전환\n');
  }

  const client = hasApiKey && !dryRun ? new Anthropic({ apiKey }) : null;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Resolution Benchmark — LLM-as-judge`);
  console.log(`${'='.repeat(60)}`);
  console.log(`가설: ${rubric.hypothesis}`);
  console.log(`모드: ${isActualDryRun ? 'DRY-RUN (mock)' : `실제 LLM (${model})`}`);
  console.log(`요구사항: ${requirements.length}개`);
  console.log(`${'='.repeat(60)}\n`);

  const levels: ResolutionKey[] = ['low', 'mid', 'high'];
  const results: RequirementResult[] = [];

  for (let i = 0; i < requirements.length; i++) {
    const req = requirements[i]!;
    process.stdout.write(`[${i + 1}/${requirements.length}] ${req.id} (${req.domain}) ... `);

    const judgements = {} as Record<ResolutionKey, JudgeOutput>;

    for (const level of levels) {
      const levelConfig = rubric.resolutionLevels[level]!;
      const context = buildContext(req.text, levelConfig);

      if (isActualDryRun) {
        judgements[level] = mockJudge(req.id, level, req.ambiguityLevel);
      } else {
        judgements[level] = await llmJudge(client!, model, context, rubric);
        // rate limit 방지
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    const lowP = judgements['low']!.reworkProbability;
    const midP = judgements['mid']!.reworkProbability;
    const highP = judgements['high']!.reworkProbability;

    const isMonotonic = lowP >= midP && midP >= highP;
    const reworkReduction_lowToHigh = Math.round((lowP - highP) * 100) / 100;

    results.push({
      requirementId: req.id,
      requirementText: req.text,
      domain: req.domain,
      ambiguityLevel: req.ambiguityLevel,
      judgements,
      isMonotonic,
      reworkReduction_lowToHigh,
      isDryRun: isActualDryRun,
    });

    const mono = isMonotonic ? 'OK' : 'FAIL';
    console.log(
      `low=${lowP.toFixed(2)} mid=${midP.toFixed(2)} high=${highP.toFixed(2)} ` +
      `reduction=${(reworkReduction_lowToHigh * 100).toFixed(0)}% mono=${mono}`,
    );
  }

  // ─── Summary ────────────────────────────────────────────────────

  const avgRework = (level: ResolutionKey): number => {
    const sum = results.reduce((acc, r) => acc + r.judgements[level]!.reworkProbability, 0);
    return Math.round((sum / results.length) * 1000) / 1000;
  };

  const avgReworkProbability: Record<ResolutionKey, number> = {
    low: avgRework('low'),
    mid: avgRework('mid'),
    high: avgRework('high'),
  };

  const avgReworkReduction_lowToHigh =
    Math.round((avgReworkProbability.low - avgReworkProbability.high) * 1000) / 1000;

  const monotonicCount = results.filter((r) => r.isMonotonic).length;
  const monotonicityRate = Math.round((monotonicCount / results.length) * 1000) / 1000;

  const thresholds = rubric.successThresholds;
  const monotonicitySatisfied = monotonicityRate >= thresholds.minMonotonicityRate;
  const causalitySatisfied = avgReworkReduction_lowToHigh >= thresholds.minReworkReduction_lowToHigh;
  const hypothesisSupported = monotonicitySatisfied && causalitySatisfied;

  const benchmarkResult: BenchmarkResult = {
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    hypothesis: rubric.hypothesis,
    isDryRun: isActualDryRun,
    totalRequirements: results.length,
    results,
    summary: {
      avgReworkProbability,
      avgReworkReduction_lowToHigh,
      monotonicityRate,
      monotonicitySatisfied,
      causalitySatisfied,
      hypothesisSupported,
    },
  };

  // ─── 결과 저장 ───────────────────────────────────────────────────

  const outputDir = join(PROJECT_ROOT, output);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const prefix = isActualDryRun ? 'resolution-dry' : 'resolution';
  const jsonPath = join(outputDir, `${prefix}-${ts}.json`);
  const latestPath = join(outputDir, 'resolution-latest.json');

  writeFileSync(jsonPath, JSON.stringify(benchmarkResult, null, 2), 'utf-8');
  writeFileSync(latestPath, JSON.stringify(benchmarkResult, null, 2), 'utf-8');

  // ─── 콘솔 요약 ───────────────────────────────────────────────────

  const reductionPct = (avgReworkReduction_lowToHigh * 100).toFixed(1);
  const lowPct = (avgReworkProbability.low * 100).toFixed(1);
  const midPct = (avgReworkProbability.mid * 100).toFixed(1);
  const highPct = (avgReworkProbability.high * 100).toFixed(1);

  console.log(`\n${'─'.repeat(60)}`);
  console.log('SUMMARY');
  console.log(`${'─'.repeat(60)}`);
  console.log(`요구사항: ${results.length}개 분석`);
  console.log(`\n재작업 확률 (평균):`);
  console.log(`  해상도 0.5 (low):  ${lowPct}%`);
  console.log(`  해상도 0.65 (mid): ${midPct}%`);
  console.log(`  해상도 0.8 (high): ${highPct}%`);
  console.log(`\n  --> 해상도 0.8 스펙은 0.5 대비 재작업률 ${reductionPct}% 감소`);
  console.log(`\n단조성 충족률: ${(monotonicityRate * 100).toFixed(1)}% (기준: ${(thresholds.minMonotonicityRate * 100)}%)`);
  console.log(`  단조성 조건: ${monotonicitySatisfied ? 'PASS' : 'FAIL'}`);
  console.log(`인과성 조건 (감소 >= ${(thresholds.minReworkReduction_lowToHigh * 100)}%): ${causalitySatisfied ? 'PASS' : 'FAIL'}`);
  console.log(`\n가설 검증 결과: ${hypothesisSupported ? 'SUPPORTED' : 'NOT SUPPORTED'}`);
  console.log(`  "${rubric.hypothesis}"`);

  console.log(`\n결과 저장: ${jsonPath}`);
  console.log(`최신 결과: ${latestPath}`);
  console.log(`${'─'.repeat(60)}\n`);
}

// ─── CLI ──────────────────────────────────────────────────────────

const program = new Command();

program
  .name('resolution-bench')
  .description('LLM-as-judge 기반 해상도 재작업률 벤치마크')
  .option('--dry-run', 'LLM 호출 없이 mock 결과로 실행', false)
  .option('--limit <n>', '테스트할 요구사항 수 제한 (기본: 전체)', null)
  .option('-o, --output <dir>', '결과 저장 디렉토리', 'benchmarks/results')
  .option('--model <model>', 'Anthropic 모델 ID', 'claude-haiku-4-5')
  .action(async (opts) => {
    const limit = opts.limit !== null ? parseInt(String(opts.limit), 10) : null;
    await runBenchmark({
      dryRun: Boolean(opts.dryRun),
      limit,
      output: String(opts.output),
      model: String(opts.model),
    });
  });

program.parse();
