/**
 * 설명 대상 프리셋.
 *
 * 여섯 값이 용어 허용치와 문장 길이, 원문 핵심어를 얼마나 남겨야 하는지, 비유가 필요한지,
 * 어미를 무엇으로 끝낼지를 한꺼번에 정한다. 사람이 읽는 기준은
 * `plugin/role-agents/explainer/references/audience.md`에 있고 여기 숫자가 그 표를 코드로 옮긴 것이다.
 *
 * 임계값이 프리셋마다 다른 이유는 설명이 잘될수록 원문에서 멀어지기 때문이다. 같은 잣대를
 * 들이대면 `outsider`용 좋은 설명이 `peer` 기준으로는 내용을 버린 글이 된다.
 */

export type Audience = 'nontech' | 'junior' | 'peer' | 'manager' | 'exec' | 'outsider';

export const AUDIENCES: readonly Audience[] = [
  'nontech',
  'junior',
  'peer',
  'manager',
  'exec',
  'outsider',
];

/**
 * 대상을 안 밝히면 동료 개발자로 본다.
 *
 * 개발 레포 안에서 `outsider`를 기본으로 잡으면 옆자리 개발자에게 일상 비유를 늘어놓는
 * 글이 나간다. 반대 방향 실수가 훨씬 싸다.
 */
export const DEFAULT_AUDIENCE: Audience = 'peer';

/** 원문에서 핵심어로 볼 상위 몇 개 */
export const CORE_TERM_COUNT = 5;

/** 비유가 필요한 정도. required 는 없으면 채택 금지, recommended 는 경고 */
export type AnalogyRule = 'required' | 'recommended' | 'off';

/** polite 는 해요체, formal 은 합니다체 */
export type Register = 'polite' | 'formal';

/**
 * 상한을 재는 축은 warn 을 넘으면 경고이고 abort 를 넘으면 채택 금지다.
 * 하한을 재는 축(coverage)은 방향이 반대라 warn 아래가 경고이고 abort 아래가 채택 금지다.
 */
export interface Band {
  warn: number;
  abort: number;
}

export interface AudiencePreset {
  audience: Audience;
  who: string;
  /** 풀이 없이 남은 전문용어 밀도. 출현 수를 설명본 어절 수로 나눈 값 */
  jargon: Band;
  /** 평균 문장 길이. 글자 수로 센다 */
  sentence: Band;
  /** 원문 핵심어 중 다뤄야 하는 최소 비율 */
  coverage: Band;
  analogy: AnalogyRule;
  register: Register;
}

/**
 * coverage 하한이 프리셋마다 크게 벌어지는 게 이 표의 핵심이다.
 *
 * 핵심어를 다섯 개 잡으므로 0.2 는 하나, 0.4 는 둘이다. `outsider`는 하나만 남겨도
 * 통과하고 `peer`는 넷을 요구한다. 이게 humanize 의 preservation 을 뒤집은 자리다 —
 * 거기서는 전부 살아남아야 하고 여기서는 몇 개를 남겼느냐만 본다.
 */
export const PRESETS: Record<Audience, AudiencePreset> = {
  nontech: {
    audience: 'nontech',
    who: '기획, 디자인, 마케팅 동료',
    jargon: { warn: 0.005, abort: 0.02 },
    sentence: { warn: 45, abort: 60 },
    coverage: { warn: 0.4, abort: 0.2 },
    analogy: 'required',
    register: 'polite',
  },
  junior: {
    audience: 'junior',
    who: '주니어 개발자',
    jargon: { warn: 0.06, abort: 0.12 },
    sentence: { warn: 60, abort: 80 },
    coverage: { warn: 0.7, abort: 0.5 },
    analogy: 'recommended',
    register: 'polite',
  },
  peer: {
    audience: 'peer',
    who: '동료 개발자',
    jargon: { warn: 0.35, abort: 0.5 },
    sentence: { warn: 70, abort: 95 },
    coverage: { warn: 0.8, abort: 0.6 },
    analogy: 'off',
    register: 'polite',
  },
  manager: {
    audience: 'manager',
    who: '관리자',
    jargon: { warn: 0.02, abort: 0.05 },
    sentence: { warn: 55, abort: 75 },
    coverage: { warn: 0.5, abort: 0.3 },
    analogy: 'off',
    register: 'formal',
  },
  exec: {
    audience: 'exec',
    who: '경영진',
    jargon: { warn: 0.005, abort: 0.02 },
    sentence: { warn: 50, abort: 70 },
    coverage: { warn: 0.4, abort: 0.2 },
    analogy: 'off',
    register: 'formal',
  },
  outsider: {
    audience: 'outsider',
    who: '사외 비전문가, 가족',
    jargon: { warn: 0, abort: 0.01 },
    sentence: { warn: 35, abort: 50 },
    coverage: { warn: 0.2, abort: 0.1 },
    analogy: 'required',
    register: 'polite',
  },
};

export function isAudience(value: string): value is Audience {
  return (AUDIENCES as readonly string[]).includes(value);
}

/** 값이 없으면 기본값, 모르는 값이면 undefined. 종료 코드는 부르는 쪽이 정한다 */
export function parseAudience(value?: string): Audience | undefined {
  if (value === undefined) return DEFAULT_AUDIENCE;
  return isAudience(value) ? value : undefined;
}

export function presetOf(audience: Audience): AudiencePreset {
  return PRESETS[audience];
}
