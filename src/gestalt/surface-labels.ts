import { GestaltPrinciple } from '../core/types.js';

/**
 * 표면/심층 분리 (Figure-Ground)의 표면 레이어 단일 소스.
 *
 * 코드 내부는 게슈탈트 원리(GestaltPrinciple enum)와 에이전트 식별자를 그대로 쓰지만,
 * 사용자에게 돌려주는 표면 문자열에는 게슈탈트 용어가 새어 나가면 안 된다.
 * 이 모듈이 내부 식별자를 평범한 한국어·영어 문구로 잇는 유일한 매핑 지점이다.
 *
 * 심층 레이어(README·docs·LLM 시스템 프롬프트·내부 타입)는 이 모듈을 거치지 않고
 * 게슈탈트 어휘를 그대로 유지한다.
 */

export type SurfaceLang = 'ko' | 'en';

interface BilingualText {
  ko: string;
  en: string;
}

/**
 * 각 원리가 담당하는 인터뷰/실행 단계를, 원리 이름 없이 "그 단계가 실제로 하는 일"로 설명한다.
 * currentPrinciple·principleStrategy·gestaltFocus 등 원리명이 노출되던 자리를 이 문구로 치환한다.
 */
const STAGE_LABELS: Record<GestaltPrinciple, BilingualText> = {
  [GestaltPrinciple.CLOSURE]: {
    ko: '빠진 요구사항 채우기',
    en: 'Filling in missing requirements',
  },
  [GestaltPrinciple.PROXIMITY]: {
    ko: '관련 요구사항 묶기',
    en: 'Grouping related requirements',
  },
  [GestaltPrinciple.SIMILARITY]: {
    ko: '반복 패턴 찾기',
    en: 'Identifying recurring patterns',
  },
  [GestaltPrinciple.FIGURE_GROUND]: {
    ko: '핵심과 부가 나누기',
    en: 'Separating core from optional',
  },
  [GestaltPrinciple.CONTINUITY]: {
    ko: '일관성 검토',
    en: 'Checking consistency',
  },
};

/**
 * 내부 에이전트 식별자를 게슈탈트 용어가 없는 중립적 표시 이름으로 잇는다.
 * activeAgents 등 응답에 노출되는 에이전트 이름을 이 표를 거쳐 치환한다.
 * 키는 내부 식별자(파일·레지스트리에서 쓰는 이름)이며 바꾸지 않는다.
 */
const AGENT_DISPLAY_NAMES: Record<string, BilingualText> = {
  'closure-completer': { ko: '요구사항 완성기', en: 'Requirement completer' },
  'ground-mapper': { ko: '범위 구분기', en: 'Scope mapper' },
  'similarity-crystallizer': { ko: '패턴 정리기', en: 'Pattern crystallizer' },
  'proximity-worker': { ko: '그룹 실행기', en: 'Grouping worker' },
  'continuity-judge': { ko: '일관성 검토기', en: 'Consistency judge' },
};

/**
 * 원리가 담당하는 단계를 평범한 말로 설명한 문구를 돌려준다.
 * currentPrinciple/principleStrategy/gestaltFocus 등 표면 노출 자리에 사용한다.
 * 알 수 없는 값('next' 등)은 중립적 기본 문구로 대체한다.
 */
export function getStageLabel(
  principle: GestaltPrinciple | string,
  lang: SurfaceLang = 'ko',
): string {
  const entry = STAGE_LABELS[principle as GestaltPrinciple];
  if (entry) return entry[lang];
  return lang === 'ko' ? '다음 단계' : 'Next step';
}

/**
 * 내부 에이전트 식별자를 중립적 표시 이름으로 바꾼다.
 * 매핑에 없는 식별자는 원리 용어가 없다고 보고 그대로 돌려준다.
 */
export function getAgentDisplayName(agentName: string, lang: SurfaceLang = 'ko'): string {
  return AGENT_DISPLAY_NAMES[agentName]?.[lang] ?? agentName;
}

/**
 * 에이전트 식별자 배열을 중립적 표시 이름 배열로 바꾼다.
 */
export function toDisplayAgentNames(agentNames: string[], lang: SurfaceLang = 'ko'): string[] {
  return agentNames.map((name) => getAgentDisplayName(name, lang));
}

/**
 * 실행 단계에서 caller에게 주는 "일관성 유지" 힌트의 평범한 표면 문구.
 * Similarity 원리를 노출하던 similarityStrategy 필드를 이 문구로 치환한다.
 */
const CONSISTENCY_HINT: BilingualText = {
  ko: '이미 끝낸 태스크 중 비슷한 패턴을 참고해 일관되게 구현하세요.',
  en: 'Reference completed tasks with similar patterns to keep the implementation consistent.',
};

export function getConsistencyHint(lang: SurfaceLang = 'ko'): string {
  return CONSISTENCY_HINT[lang];
}

/**
 * 표면 문자열에 절대 나타나면 안 되는 게슈탈트 금지어.
 * 회귀 테스트(LeakTest)가 이 목록으로 사용자 표면 응답을 검사한다.
 * 원리 이름 6종(figure-ground는 두 표기 모두)만 담는다 — 에이전트 접미사(completer 등)는
 * 게슈탈트 용어가 아니므로 중립 표시 이름에 그대로 쓸 수 있어 제외한다.
 */
export const BANNED_SURFACE_TERMS: readonly string[] = [
  'closure',
  'proximity',
  'similarity',
  'figure-ground',
  'figure_ground',
  'continuity',
  'gestalt',
];

/**
 * MCP 도구 응답에서 심층 레이어(LLM 지시 프롬프트) 필드 키.
 * 이 필드들은 게슈탈트 어휘를 담은 채 유지되므로 표면 누수 검사 대상에서 제외한다.
 */
export const DEEP_PROMPT_KEYS: readonly string[] = [
  'systemPrompt',
  'questionPrompt',
  'scoringPrompt',
  'specPrompt',
  'planningPrompt',
  'taskPrompt',
  'compressionPrompt',
];

/**
 * 도구 응답에 통째로 실리는 컨텍스트 객체(gestaltContext/specContext/executeContext)에서
 * 게슈탈트 용어가 새는 메타 필드를 중립적 표면 값으로 치환한다.
 *
 * - currentPrinciple(원리 enum 값) → currentStage(평범한 단계 설명)
 * - principleStrategy(원리 용어가 박힌 전략 문구) → 표면에서 제거 (프롬프트에 이미 포함)
 * - activeAgents(에이전트 식별자) → 중립적 표시 이름
 * - allRounds[].gestaltFocus(원리 enum 값) → stage(평범한 단계 설명)
 *
 * 심층 프롬프트 필드(systemPrompt 등)와 나머지 필드는 그대로 둔다.
 */
export function sanitizeSurfaceContext<T>(ctx: T, lang: SurfaceLang = 'ko'): T {
  if (!ctx || typeof ctx !== 'object') return ctx;
  const result: Record<string, unknown> = { ...(ctx as Record<string, unknown>) };

  if (typeof result.currentPrinciple === 'string') {
    result.currentStage = getStageLabel(result.currentPrinciple as string, lang);
    delete result.currentPrinciple;
  }

  delete result.principleStrategy;

  if (Array.isArray(result.activeAgents)) {
    result.activeAgents = toDisplayAgentNames(result.activeAgents as string[], lang);
  }

  if (Array.isArray(result.allRounds)) {
    result.allRounds = (result.allRounds as Array<Record<string, unknown>>).map((round) => {
      if (round && typeof round === 'object' && typeof round.gestaltFocus === 'string') {
        const { gestaltFocus, ...rest } = round;
        return { ...rest, stage: getStageLabel(gestaltFocus as string, lang) };
      }
      return round;
    });
  }

  return result as T;
}
