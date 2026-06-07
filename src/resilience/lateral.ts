import type { Spec, EvaluationResult, EvolutionGeneration } from '../core/types.js';
import type {
  StagnationPattern,
  LateralPersonaName,
  LateralContext,
  EscalationContext,
} from './types.js';
import { STAGNATION_PERSONA_MAP } from './types.js';
import { getLateralSystemPrompt, buildLateralPrompt } from './prompts.js';

/** 모든 persona 이름 (순회 순서) */
const ALL_PERSONAS: LateralPersonaName[] = [
  'multistability',
  'simplicity',
  'reification',
  'invariance',
];

/**
 * pattern에 매핑된 1순위 persona를 먼저 시도하고,
 * 이미 시도했으면 나머지 중 미시도 persona를 순서대로 반환.
 * 모두 소진되면 null.
 */
export function suggestPersona(
  pattern: StagnationPattern,
  triedPersonas: LateralPersonaName[],
): LateralPersonaName | null {
  const tried = new Set(triedPersonas);

  // 1순위: pattern에 매핑된 persona
  const primary = STAGNATION_PERSONA_MAP[pattern];
  if (!tried.has(primary)) {
    return primary;
  }

  // 2순위: 나머지 중 미시도
  for (const persona of ALL_PERSONAS) {
    if (!tried.has(persona)) {
      return persona;
    }
  }

  return null;
}

/**
 * LateralContext 조립
 */
export function buildLateralContext(
  persona: LateralPersonaName,
  pattern: StagnationPattern,
  spec: Spec,
  evaluationResult: EvaluationResult,
  evolutionHistory: EvolutionGeneration[],
  attemptNumber: number,
): LateralContext {
  return {
    systemPrompt: getLateralSystemPrompt(persona),
    lateralPrompt: buildLateralPrompt(
      persona,
      pattern,
      spec,
      evaluationResult,
      evolutionHistory,
      attemptNumber,
    ),
    phase: 'evolving',
    stage: 'lateral',
    persona,
    pattern,
    attemptNumber,
    previousScores: evolutionHistory.map((g) => g.evaluationScore),
  };
}

/**
 * EscalationContext 조립 — 모든 persona 소진 시 호출
 */
export function buildEscalationContext(
  triedPersonas: LateralPersonaName[],
  evaluationResult: EvaluationResult,
  evolutionHistory: EvolutionGeneration[],
  blockedTask?: { taskId: string; title: string },
): EscalationContext {
  const scores = evolutionHistory.map((g) => g.evaluationScore);
  const bestScore = scores.length > 0 ? Math.max(...scores) : evaluationResult.overallScore;

  const unsatisfiedACs = evaluationResult.verifications
    .filter((v) => !v.satisfied)
    .map((v) => `AC[${v.acIndex}]: ${v.gaps.join(', ')}`);

  const firstUnsatisfiedAC = unsatisfiedACs[0];
  const recommendedSolutions = [
    '태스크를 더 작은 단위로 분해한 뒤 새 스펙으로 `execute start`를 재시작하세요.',
    firstUnsatisfiedAC
      ? `"${firstUnsatisfiedAC}" — 해당 acceptance criteria를 수정한 뒤 \`evolve_patch\`로 재실행하세요.`
      : '해당 acceptance criteria를 수정한 뒤 `evolve_patch`로 재실행하세요.',
    '이 태스크를 수동으로 처리한 뒤 `execute_task` 액션으로 결과를 제출하세요.',
  ];

  return {
    phase: 'evolving',
    stage: 'human_escalation',
    message: `All ${triedPersonas.length} lateral thinking personas have been exhausted without reaching the success threshold. Human intervention is required.`,
    triedPersonas,
    bestScore,
    lastEvaluationResult: evaluationResult,
    suggestions: [
      ...evaluationResult.recommendations,
      ...unsatisfiedACs.map((ac) => `Unresolved: ${ac}`),
    ],
    blockedTask,
    recommendedSolutions,
  };
}
