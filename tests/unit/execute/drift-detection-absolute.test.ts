import { describe, it, expect } from 'vitest';
import { measureDrift } from '../../../src/execute/drift-detector.js';
import { DRIFT_THRESHOLD } from '../../../src/core/constants.js';
import { randomUUID } from 'node:crypto';
import type { Spec, TaskExecutionResult, AtomicTask } from '../../../src/core/types.js';

/**
 * 절대기준(absolute threshold) 회귀 테스트.
 *
 * drift-detection.test.ts의 기존 테스트는 "정렬 쪽이 이탈 쪽보다 낮다"는 상대 비교만
 * 검증한다 — 두 값이 모두 threshold를 넘거나 모두 못 넘어도 통과해버리는 맹점이 있었고,
 * 실제로 이 맹점 때문에 정렬된 산출물조차 threshold(당시 Jaccard 척도)를 넘겨 CRITICAL로
 * 오판정되는 버그가 있었다. 이 파일은 정렬 샘플이 실제로 DRIFT_THRESHOLD(0.6) 미만으로,
 * 이탈 샘플이 실제로 DRIFT_THRESHOLD 초과로 나오는지 절대값 기준으로 검증한다.
 *
 * 픽스처는 영문으로 작성한다 — LocalEmbeddingProvider(Xenova/all-MiniLM-L6-v2)가
 * 영문 코퍼스 위주로 학습된 모델이라, 같은 의미 차이라도 한국어 문장 쌍보다 영문
 * 문장 쌍에서 코사인 유사도 분리력이 훨씬 뚜렷하게 나온다(사전 프로빙으로 확인).
 * 실제로 이 영문 픽스처의 정렬/이탈 값은 constants.ts DRIFT_THRESHOLD 주석에 기록된
 * 실측 분포(정렬 0.302~0.573 / 이탈 0.645~0.755)와 정확히 일치한다 — 즉 그 임계값
 * 재조정 자체가 이런 영문 샘플로 캘리브레이션됐다는 뜻이다.
 *
 * LocalEmbeddingProvider는 모킹하지 않는다 — 실제 임베딩 추론 경로를 검증하는 것이
 * 이 테스트의 핵심이다. 첫 호출 시 모델 로딩 시간이 걸리므로 넉넉한 타임아웃을 둔다.
 */

const MODEL_LOAD_TIMEOUT = 30_000;

const dummyTask: AtomicTask = {
  taskId: 'task-0',
  title: 'dummy',
  description: 'dummy',
  sourceAC: [0],
  isImplicit: false,
  estimatedComplexity: 'low',
  dependsOn: [],
};

function makeResult(output: string): TaskExecutionResult {
  return {
    taskId: 'task-0',
    status: 'completed',
    output,
    artifacts: [],
  };
}

function makeSpec(
  goal: string,
  constraints: string[],
  entities: { name: string; attrs: string[] }[],
): Spec {
  return {
    version: '1.0.0',
    goal,
    constraints,
    acceptanceCriteria: ['Acceptance criterion A', 'Acceptance criterion B'],
    ontologySchema: {
      entities: entities.map((e) => ({ name: e.name, description: e.name, attributes: e.attrs })),
      relations: [],
    },
    gestaltAnalysis: [{ principle: 'closure' as const, finding: 'n/a', confidence: 0.9 }],
    metadata: {
      specId: randomUUID(),
      interviewSessionId: randomUUID(),
      resolutionScore: 0.85,
      generatedAt: new Date().toISOString(),
    },
  };
}

function logDrift(label: string, drift: Awaited<ReturnType<typeof measureDrift>>) {
  const goalScore = drift.dimensions.find((d) => d.name === 'goal')?.score;
  console.log(`[absolute-threshold] ${label} overall=${drift.overall} goal=${goalScore}`);
}

const jwtSpec = makeSpec(
  'Build a user authentication system with JWT tokens',
  ['Must use JWT', 'Must support OAuth2'],
  [
    { name: 'User', attrs: ['email', 'password', 'role'] },
    { name: 'Token', attrs: ['accessToken', 'refreshToken'] },
  ],
);

const cartSpec = makeSpec(
  'Build a shopping cart feature where users can add products and check out',
  ['Must validate stock quantity', 'Prices must be shown in KRW'],
  [
    { name: 'Product', attrs: ['name', 'price', 'stock'] },
    { name: 'Cart', attrs: ['items', 'total'] },
  ],
);

describe('Drift Detector — 절대기준(absolute threshold) 회귀', () => {
  it(
    'JWT 인증 목표에 정렬된 산출물은 overall이 DRIFT_THRESHOLD 미만이다 (thresholdExceeded=false)',
    async () => {
      const aligned = makeResult(
        'Created User authentication system with JWT tokens, email and password registration',
      );

      const drift = await measureDrift(jwtSpec, dummyTask, aligned, DRIFT_THRESHOLD);
      logDrift('jwt-aligned', drift);

      expect(drift.overall).toBeLessThan(DRIFT_THRESHOLD);
      expect(drift.thresholdExceeded).toBe(false);
    },
    MODEL_LOAD_TIMEOUT,
  );

  it(
    'JWT 인증 목표와 무관한 산출물(날씨 대시보드)은 overall이 DRIFT_THRESHOLD를 초과한다 (thresholdExceeded=true)',
    async () => {
      const drifted = makeResult(
        'Implemented weather forecast dashboard with chart visualizations and map integration',
      );

      const drift = await measureDrift(jwtSpec, dummyTask, drifted, DRIFT_THRESHOLD);
      logDrift('jwt-drifted-weather', drift);

      expect(drift.overall).toBeGreaterThan(DRIFT_THRESHOLD);
      expect(drift.thresholdExceeded).toBe(true);
    },
    MODEL_LOAD_TIMEOUT,
  );

  it(
    '장바구니 목표에 정렬된 산출물은 overall이 DRIFT_THRESHOLD 미만이다',
    async () => {
      const aligned = makeResult(
        'Implemented Product entity with name, price and stock, and a Cart that holds multiple ' +
          'Products. Checkout validates stock quantity and displays prices in KRW.',
      );

      const drift = await measureDrift(cartSpec, dummyTask, aligned, DRIFT_THRESHOLD);
      logDrift('cart-aligned', drift);

      expect(drift.overall).toBeLessThan(DRIFT_THRESHOLD);
      expect(drift.thresholdExceeded).toBe(false);
    },
    MODEL_LOAD_TIMEOUT,
  );

  it(
    '장바구니 목표와 상충되는 산출물(실시간 채팅)은 overall이 DRIFT_THRESHOLD를 초과한다',
    async () => {
      const drifted = makeResult(
        'Implemented a real-time chat notification system with socket connections, push messages, ' +
          'read receipts and typing indicators.',
      );

      const drift = await measureDrift(cartSpec, dummyTask, drifted, DRIFT_THRESHOLD);
      logDrift('cart-drifted-chat', drift);

      expect(drift.overall).toBeGreaterThan(DRIFT_THRESHOLD);
      expect(drift.thresholdExceeded).toBe(true);
    },
    MODEL_LOAD_TIMEOUT,
  );

  it(
    '경계값 근처(정렬 쪽) — 목표를 뭉뚱그려 다루는 산출물도 여전히 DRIFT_THRESHOLD 미만이다',
    async () => {
      // 로그인 기능이긴 하나 JWT/OAuth2/User/Token 등 구체 용어 없이 뭉뚱그린 설명 —
      // 정렬 쪽 경계 사례(실측 overall ≈ 0.587, threshold 0.6 바로 아래)
      const partiallyAligned = makeResult(
        'Added a login button. Users type a username and password to sign in.',
      );

      const drift = await measureDrift(jwtSpec, dummyTask, partiallyAligned, DRIFT_THRESHOLD);
      logDrift('jwt-boundary-aligned-side', drift);

      expect(drift.overall).toBeLessThan(DRIFT_THRESHOLD);
      expect(drift.thresholdExceeded).toBe(false);
    },
    MODEL_LOAD_TIMEOUT,
  );

  it(
    '경계값 근처(이탈 쪽) — 목표와 느슨하게만 연결된 산출물은 DRIFT_THRESHOLD를 초과한다',
    async () => {
      // 인증과 인접한 주제(세션 쿠키)를 다루지만 목표(JWT 인증 시스템)의 핵심 용어는
      // 전혀 언급하지 않는 산출물 — 이탈 쪽 경계 사례(실측 overall ≈ 0.636, threshold 0.6 바로 위)
      const looselyRelated = makeResult(
        'Set up session cookies for the login page so returning visitors stay signed in.',
      );

      const drift = await measureDrift(jwtSpec, dummyTask, looselyRelated, DRIFT_THRESHOLD);
      logDrift('jwt-boundary-drifted-side', drift);

      expect(drift.overall).toBeGreaterThan(DRIFT_THRESHOLD);
      expect(drift.thresholdExceeded).toBe(true);
    },
    MODEL_LOAD_TIMEOUT,
  );
});
