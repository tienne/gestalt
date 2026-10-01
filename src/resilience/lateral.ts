import { randomUUID } from 'node:crypto';
import type {
  Spec,
  EvaluationResult,
  EvolutionGeneration,
  HumanGate,
  HumanGateOptionId,
} from '../core/types.js';
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
    '태스크를 더 작은 단위로 분해한 뒤 새 스펙으로 `execute start`를 재시작하세요. (`gate_resolve` optionId=restart)',
    firstUnsatisfiedAC
      ? `"${firstUnsatisfiedAC}" — 해당 acceptance criteria를 수정한 뒤 \`evolve_patch\`로 재실행하세요. (\`gate_resolve\` optionId=patch_spec)`
      : '해당 acceptance criteria를 수정한 뒤 `evolve_patch`로 재실행하세요. (`gate_resolve` optionId=patch_spec)',
    '이 태스크를 수동으로 처리한 뒤 `evaluate`로 다시 검증하세요. (`gate_resolve` optionId=manual_task)',
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

/**
 * escalation을 사람이 답할 게이트로 바꾼다. 선택지는 recommendedSolutions의 세 방향에 abort를 더한 것이고
 * 세션을 이어가는 쪽을 앞에 둔다.
 */
export function buildEscalationGate(escalation: EscalationContext): HumanGate {
  const where = escalation.blockedTask
    ? `"${escalation.blockedTask.title}" 태스크에서`
    : '평가 단계에서';
  return {
    gateId: `gate-${randomUUID()}`,
    question: `${where} lateral persona ${escalation.triedPersonas.length}개를 다 써도 성공 기준에 못 닿았어요 (최고 점수 ${escalation.bestScore.toFixed(2)}). 어떻게 진행할까요?`,
    options: [
      {
        id: 'patch_spec',
        label: 'acceptance criteria나 제약을 고쳐 evolve_patch로 다시 돌린다',
        nextAction: 'evolve_patch',
      },
      {
        id: 'manual_task',
        label: '막힌 태스크를 사람이 직접 처리하고 evaluate로 다시 검증한다',
        nextAction: 'evaluate',
      },
      {
        id: 'restart',
        label: '태스크를 더 잘게 쪼갠 새 스펙으로 다시 시작한다 (이 세션은 종료된다)',
        nextAction: 'start',
      },
      {
        id: 'abort',
        label: '여기서 멈춘다 (이 세션은 실패로 종료된다)',
        nextAction: null,
      },
    ],
    context: {
      blockedTask: escalation.blockedTask,
      triedPersonas: escalation.triedPersonas,
      bestScore: escalation.bestScore,
      unresolved: escalation.suggestions,
    },
    status: 'open',
    openedAt: new Date().toISOString(),
  };
}

/** 이 선택지로 해소하면 세션이 이어지는가. 아니면 세션을 종료한다 */
export function gateOptionResumesSession(optionId: HumanGateOptionId): boolean {
  return optionId === 'patch_spec' || optionId === 'manual_task';
}
