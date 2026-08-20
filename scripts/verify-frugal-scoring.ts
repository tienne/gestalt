/**
 * frugal tier 해상도 점수 검증 — standard와 얼마나 어긋나는지 잰다.
 *
 * `llm.frugal`을 설정하면 해상도 점수 산정이 그쪽으로 내려간다. 점수는 인터뷰를 언제
 * 끝낼지 정하는 값(임계값 0.8)이라, 모델을 내려서 점수가 흔들리면 라운드 수가 달라진다.
 * 그 흔들림이 실제로 얼마인지는 돌려보기 전엔 모른다 — 이 스크립트가 그걸 잰다.
 *
 * golden-set 요구사항 20건을 두 tier로 각각 채점해 세 가지를 본다.
 *   1. 점수 차이 (평균 절대 편차, 최대 편차)
 *   2. 임계값 0.8 판정이 뒤집힌 건수  ← 실제로 동작이 갈리는 지점
 *   3. golden-set이 라벨한 기대 범위 적중률 (두 tier 각각)
 *
 * Usage:
 *   pnpm tsx scripts/verify-frugal-scoring.ts
 *   pnpm tsx scripts/verify-frugal-scoring.ts --limit 5
 *
 * gestalt.json이나 환경변수에 llm.frugal과 llm.standard가 모두 있어야 한다.
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/core/config.js';
import { createTierAdapter } from '../src/llm/factory.js';
import { ResolutionScorer } from '../src/interview/resolution.js';
import { RESOLUTION_THRESHOLD } from '../src/core/constants.js';
import { GestaltPrinciple } from '../src/core/types.js';
import type { InterviewRound } from '../src/core/types.js';

interface Requirement {
  id: string;
  text: string;
  domain: string;
  ambiguityLevel: string;
  expectedResolutionRange: { min: number; max: number };
}

function buildRounds(text: string): InterviewRound[] {
  return [
    {
      roundNumber: 1,
      question: '무엇을 만들고 싶으신가요?',
      userResponse: text,
      gestaltFocus: GestaltPrinciple.CLOSURE,
      timestamp: '2026-01-01T00:00:00.000Z',
    },
  ];
}

async function main(): Promise<void> {
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg !== -1 ? Number(process.argv[limitArg + 1]) : Infinity;

  const config = loadConfig();
  const frugal = createTierAdapter(config.llm, 'frugal');
  const standard = createTierAdapter(config.llm, 'standard');

  if (!frugal || !standard) {
    console.error(
      'llm.frugal과 llm.standard가 모두 설정돼 있어야 비교가 된다.\n' +
        `현재: frugal=${frugal ? 'OK' : '없음'}, standard=${standard ? 'OK' : '없음'}\n` +
        'gestalt.json의 llm.frugal / llm.standard를 채우고 다시 실행한다.',
    );
    process.exit(1);
  }

  const goldenSetPath = resolve('benchmarks/golden-set/requirements.json');
  const { requirements } = JSON.parse(readFileSync(goldenSetPath, 'utf-8')) as {
    requirements: Requirement[];
  };
  const targets = requirements.slice(0, limit);

  const frugalScorer = new ResolutionScorer(frugal);
  const standardScorer = new ResolutionScorer(standard);

  const rows: Array<{
    id: string;
    frugal: number;
    standard: number;
    diff: number;
    verdictFlipped: boolean;
    frugalInRange: boolean;
    standardInRange: boolean;
  }> = [];

  for (const req of targets) {
    const rounds = buildRounds(req.text);

    // 두 tier에 같은 입력을 준다. 순서 효과가 없도록 병렬로 부른다.
    const [f, s] = await Promise.all([
      frugalScorer.score(req.text, rounds, 'greenfield'),
      standardScorer.score(req.text, rounds, 'greenfield'),
    ]);

    const { min, max } = req.expectedResolutionRange;
    rows.push({
      id: req.id,
      frugal: f.overall,
      standard: s.overall,
      diff: Math.abs(f.overall - s.overall),
      verdictFlipped: f.overall >= RESOLUTION_THRESHOLD !== (s.overall >= RESOLUTION_THRESHOLD),
      frugalInRange: f.overall >= min && f.overall <= max,
      standardInRange: s.overall >= min && s.overall <= max,
    });

    const row = rows[rows.length - 1]!;
    console.log(
      `${req.id}  frugal ${f.overall.toFixed(2)}  standard ${s.overall.toFixed(2)}  ` +
        `diff ${row.diff.toFixed(2)}${row.verdictFlipped ? '  ⚠️ 임계값 판정 뒤집힘' : ''}`,
    );
  }

  const n = rows.length;
  const meanDiff = rows.reduce((sum, r) => sum + r.diff, 0) / n;
  const maxDiff = Math.max(...rows.map((r) => r.diff));
  const flipped = rows.filter((r) => r.verdictFlipped).length;
  const frugalHits = rows.filter((r) => r.frugalInRange).length;
  const standardHits = rows.filter((r) => r.standardInRange).length;

  console.log('\n── 요약 ──');
  console.log(`대상: ${n}건`);
  console.log(`평균 편차: ${meanDiff.toFixed(3)}   최대 편차: ${maxDiff.toFixed(3)}`);
  console.log(`임계값(${RESOLUTION_THRESHOLD}) 판정 뒤집힘: ${flipped}/${n}건`);
  console.log(`기대 범위 적중 — frugal ${frugalHits}/${n}, standard ${standardHits}/${n}`);

  // 판정이 뒤집히면 인터뷰가 끝나는 시점이 달라진다. 편차 평균이 작아도 이건 별개 문제다.
  if (flipped > 0) {
    console.log(
      `\n⚠️ 판정이 ${flipped}건 뒤집혔다. 그만큼 인터뷰 종료 시점이 갈린다는 뜻이라,\n` +
        '   frugal로 내리기 전에 어느 쪽이 맞는 판정이었는지 봐야 한다.',
    );
  }
  if (frugalHits < standardHits) {
    console.log(
      `\n⚠️ 기대 범위 적중이 standard보다 ${standardHits - frugalHits}건 낮다. ` +
        'frugal 모델을 더 큰 것으로 올리는 편이 낫다.',
    );
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
