import type { BenchmarkScenario } from '../types.js';

export const authSystemScenario: BenchmarkScenario = {
  name: 'auth-system',
  description: 'JWT 기반 사용자 인증 시스템',
  topic: '사용자 인증 시스템',
  userResponses: [
    'JWT 기반 인증 시스템을 구현하려 합니다. 회원가입, 로그인, 토큰 갱신이 필요합니다.',
    'bcrypt로 패스워드 해싱, access token 15분, refresh token 7일 유효기간입니다.',
    'PostgreSQL 사용, 이메일 중복 불가, 비밀번호 최소 8자, 대소문자+숫자 포함 필수입니다.',
    'rate limiting은 IP당 로그인 시도 5회/분, 실패 시 5분 잠금입니다.',
    '우선순위: 1) 로그인/회원가입 2) 토큰 갱신 3) rate limiting 4) 로그아웃',
  ],
  expectedSpec: {
    goal: 'JWT 기반 사용자 인증 시스템 구현 (회원가입, 로그인, 토큰 갱신, rate limiting)',
    constraints: [
      'bcrypt 패스워드 해싱',
      'Access token 유효기간 15분',
      'Refresh token 유효기간 7일',
      'PostgreSQL 데이터베이스',
      '비밀번호: 최소 8자, 대소문자+숫자 포함',
      'IP당 로그인 시도 5회/분, 실패 시 5분 잠금',
    ],
    acceptanceCriteria: [
      'AC0: 사용자 회원가입 — 이메일+비밀번호로 계정 생성, 이메일 중복 검증',
      'AC1: 사용자 로그인 — 이메일+비밀번호 인증 후 JWT access/refresh 토큰 발급',
      'AC2: 토큰 갱신 — refresh token으로 새 access token 발급',
      'AC3: Rate Limiting — IP당 5회/분 제한, 초과 시 5분 잠금',
      'AC4: 로그아웃 — refresh token 무효화',
    ],
    ontologySchema: {
      entities: [
        { name: 'User', description: '인증 사용자', attributes: ['id', 'email', 'passwordHash', 'createdAt'] },
        { name: 'Token', description: 'JWT 토큰', attributes: ['id', 'userId', 'type', 'expiresAt'] },
        { name: 'LoginAttempt', description: '로그인 시도 기록', attributes: ['ip', 'userId', 'success', 'timestamp'] },
      ],
      relations: [
        { from: 'User', to: 'Token', type: 'has_many' },
        { from: 'User', to: 'LoginAttempt', type: 'has_many' },
      ],
    },
    gestaltAnalysis: [
      { principle: 'closure', finding: '로그아웃 시 refresh token 무효화 로직 암묵적 요구', confidence: 0.9 },
      { principle: 'figure_ground', finding: '로그인/회원가입이 핵심, rate limiting은 보조', confidence: 0.95 },
      { principle: 'proximity', finding: '토큰 관리(발급/갱신/무효화)가 하나의 도메인 그룹', confidence: 0.85 },
    ],
  },
  planningSteps: {
    figureGround: {
      classifiedACs: [
        { acIndex: 0, classification: 'essential', reasoning: '핵심 진입점' },
        { acIndex: 1, classification: 'essential', reasoning: '핵심 인증 기능' },
        { acIndex: 2, classification: 'essential', reasoning: '토큰 수명 관리 필수' },
        { acIndex: 3, classification: 'supplementary', reasoning: '보안 강화 부가 기능' },
        { acIndex: 4, classification: 'supplementary', reasoning: '선택적 세션 종료' },
      ],
    },
    closure: {
      atomicTasks: [
        { taskId: 'T1', title: 'User 엔티티 및 DB 스키마 생성', acIndices: [0], dependencies: [] },
        { taskId: 'T2', title: '회원가입 API 엔드포인트', acIndices: [0], dependencies: ['T1'] },
        { taskId: 'T3', title: 'JWT 토큰 발급 유틸리티', acIndices: [1, 2], dependencies: ['T1'] },
        { taskId: 'T4', title: '로그인 API 엔드포인트', acIndices: [1], dependencies: ['T2', 'T3'] },
        { taskId: 'T5', title: '토큰 갱신 API', acIndices: [2], dependencies: ['T3'] },
        { taskId: 'T6', title: 'Rate Limiting 미들웨어', acIndices: [3], dependencies: ['T1'] },
        { taskId: 'T7', title: '로그아웃 API 및 토큰 무효화', acIndices: [4], dependencies: ['T3'] },
      ],
    },
    proximity: {
      taskGroups: [
        { groupId: 'G1', name: '사용자 관리', taskIds: ['T1', 'T2'] },
        { groupId: 'G2', name: '인증/토큰', taskIds: ['T3', 'T4', 'T5', 'T7'] },
        { groupId: 'G3', name: '보안', taskIds: ['T6'] },
      ],
    },
    continuity: {
      dagValidation: {
        isValid: true,
        hasCycles: false,
        hasConflicts: false,
        topologicalOrder: ['T1', 'T2', 'T3', 'T6', 'T4', 'T5', 'T7'],
        criticalPath: ['T1', 'T2', 'T3', 'T4'],
      },
    },
  },
  taskOutputs: [
    { taskId: 'T1', output: 'User 테이블 생성 마이그레이션 완료', artifacts: ['migrations/001_users.sql'] },
    { taskId: 'T2', output: 'POST /auth/register 엔드포인트 구현 완료', artifacts: ['src/routes/auth.ts'] },
    { taskId: 'T3', output: 'JWT 유틸리티 (sign, verify, refresh) 구현', artifacts: ['src/utils/jwt.ts'] },
    { taskId: 'T4', output: 'POST /auth/login 엔드포인트 구현 완료', artifacts: ['src/routes/auth.ts'] },
    { taskId: 'T5', output: 'POST /auth/refresh 엔드포인트 구현 완료', artifacts: ['src/routes/auth.ts'] },
    { taskId: 'T6', output: 'Rate limiting 미들웨어 구현', artifacts: ['src/middleware/rate-limit.ts'] },
    { taskId: 'T7', output: 'POST /auth/logout 구현, refresh token 블랙리스트', artifacts: ['src/routes/auth.ts'] },
  ],
  structuralResult: {
    commands: [
      { name: 'lint', command: 'eslint src/', exitCode: 0, output: 'No errors found' },
      { name: 'build', command: 'tsc --noEmit', exitCode: 0, output: '' },
      { name: 'test', command: 'vitest run', exitCode: 0, output: 'Tests: 24 passed' },
    ],
    allPassed: true,
  },
  evaluationResult: {
    verifications: [
      { acIndex: 0, satisfied: true, evidence: '회원가입 API, 이메일 중복 검증, 비밀번호 해싱 구현', gaps: [] },
      { acIndex: 1, satisfied: true, evidence: '로그인 API, JWT 발급 구현', gaps: [] },
      { acIndex: 2, satisfied: true, evidence: 'Refresh token으로 새 access token 발급', gaps: [] },
      { acIndex: 3, satisfied: true, evidence: 'IP 기반 rate limiting 미들웨어 구현', gaps: [] },
      { acIndex: 4, satisfied: true, evidence: '로그아웃 시 refresh token 블랙리스트', gaps: [] },
    ],
    overallScore: 0.92,
    goalAlignment: 0.90,
    recommendations: ['E2E 테스트 추가 권장'],
  },
};
