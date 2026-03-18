import type { BenchmarkScenario } from '../types.js';

export const apiGatewayScenario: BenchmarkScenario = {
  name: 'api-gateway',
  description: 'API Gateway with routing, auth, and rate limiting',
  topic: 'API Gateway',
  userResponses: [
    'MSA 환경에서 API Gateway를 구현합니다. 라우팅, 인증, rate limiting, 로깅이 필요합니다.',
    'Express 기반, 서비스별 프록시 라우팅, JWT 토큰 검증 미들웨어입니다.',
    'Rate limiting은 sliding window 알고리즘, Redis로 카운터 관리, 서비스별 별도 한도입니다.',
    '헬스체크 엔드포인트, 요청/응답 로깅, 에러 핸들링 미들웨어가 필요합니다.',
    '우선순위: 1) 프록시 라우팅 2) JWT 인증 3) rate limiting 4) 로깅/헬스체크',
  ],
  expectedSpec: {
    goal: 'MSA용 API Gateway 구현 (라우팅, 인증, rate limiting, 로깅)',
    constraints: [
      'Express 프레임워크',
      'JWT 토큰 검증 미들웨어',
      'Redis 기반 sliding window rate limiting',
      '서비스별 독립 rate limit 한도',
    ],
    acceptanceCriteria: [
      'AC0: 프록시 라우팅 — URL 패턴 기반 서비스 라우팅, 동적 서비스 등록/해제',
      'AC1: JWT 인증 — 모든 요청에 JWT 검증, 공개 경로 화이트리스트',
      'AC2: Rate Limiting — Redis sliding window, 서비스별 한도 설정',
      'AC3: 요청 로깅 — 요청/응답 메타데이터 구조화 로깅',
      'AC4: 헬스체크 — 게이트웨이 + 다운스트림 서비스 상태 확인',
    ],
    ontologySchema: {
      entities: [
        { name: 'Route', description: '서비스 라우팅 규칙', attributes: ['pattern', 'target', 'methods'] },
        { name: 'Service', description: '다운스트림 서비스', attributes: ['name', 'url', 'healthEndpoint', 'rateLimit'] },
        { name: 'Request', description: '게이트웨이 요청', attributes: ['id', 'method', 'path', 'headers', 'timestamp'] },
      ],
      relations: [
        { from: 'Route', to: 'Service', type: 'routes_to' },
        { from: 'Request', to: 'Route', type: 'matched_by' },
      ],
    },
    gestaltAnalysis: [
      { principle: 'figure_ground', finding: '프록시 라우팅이 핵심(figure), 로깅/헬스체크는 보조(ground)', confidence: 0.93 },
      { principle: 'closure', finding: '에러 핸들링 미들웨어가 암묵적으로 필요', confidence: 0.87 },
      { principle: 'continuity', finding: '요청 → 인증 → rate limit → 프록시 → 로깅 파이프라인 흐름', confidence: 0.91 },
    ],
  },
  planningSteps: {
    figureGround: {
      classifiedACs: [
        { acIndex: 0, classification: 'essential', reasoning: '게이트웨이 핵심 기능' },
        { acIndex: 1, classification: 'essential', reasoning: '보안 필수 레이어' },
        { acIndex: 2, classification: 'essential', reasoning: '트래픽 보호 필수' },
        { acIndex: 3, classification: 'supplementary', reasoning: '운영 편의 기능' },
        { acIndex: 4, classification: 'supplementary', reasoning: '모니터링 보조 기능' },
      ],
    },
    closure: {
      atomicTasks: [
        { taskId: 'T1', title: 'Express 앱 스캐폴딩 + 라우트 설정 파서', acIndices: [0], dependencies: [] },
        { taskId: 'T2', title: '프록시 미들웨어 (http-proxy-middleware)', acIndices: [0], dependencies: ['T1'] },
        { taskId: 'T3', title: 'JWT 인증 미들웨어 + 화이트리스트', acIndices: [1], dependencies: ['T1'] },
        { taskId: 'T4', title: 'Redis 연결 + sliding window 모듈', acIndices: [2], dependencies: [] },
        { taskId: 'T5', title: 'Rate limiting 미들웨어', acIndices: [2], dependencies: ['T4', 'T1'] },
        { taskId: 'T6', title: '요청/응답 로깅 미들웨어', acIndices: [3], dependencies: ['T1'] },
        { taskId: 'T7', title: '헬스체크 엔드포인트', acIndices: [4], dependencies: ['T1'] },
        { taskId: 'T8', title: '에러 핸들링 미들웨어', acIndices: [0, 1, 2], dependencies: ['T1'] },
      ],
    },
    proximity: {
      taskGroups: [
        { groupId: 'G1', name: '코어 라우팅', taskIds: ['T1', 'T2'] },
        { groupId: 'G2', name: '보안', taskIds: ['T3', 'T4', 'T5'] },
        { groupId: 'G3', name: '관측성', taskIds: ['T6', 'T7'] },
        { groupId: 'G4', name: '안정성', taskIds: ['T8'] },
      ],
    },
    continuity: {
      dagValidation: {
        isValid: true,
        hasCycles: false,
        hasConflicts: false,
        topologicalOrder: ['T1', 'T4', 'T2', 'T3', 'T5', 'T6', 'T7', 'T8'],
        criticalPath: ['T1', 'T4', 'T5'],
      },
    },
  },
  taskOutputs: [
    { taskId: 'T1', output: 'Express 앱 + YAML 기반 라우트 설정 파서', artifacts: ['src/app.ts', 'src/config/routes.yml'] },
    { taskId: 'T2', output: 'http-proxy-middleware 기반 프록시', artifacts: ['src/middleware/proxy.ts'] },
    { taskId: 'T3', output: 'JWT 검증 + 공개 경로 화이트리스트', artifacts: ['src/middleware/auth.ts'] },
    { taskId: 'T4', output: 'Redis 연결 + sliding window 카운터', artifacts: ['src/lib/redis.ts', 'src/lib/sliding-window.ts'] },
    { taskId: 'T5', output: '서비스별 rate limiting 미들웨어', artifacts: ['src/middleware/rate-limit.ts'] },
    { taskId: 'T6', output: 'pino 기반 구조화 로깅', artifacts: ['src/middleware/logger.ts'] },
    { taskId: 'T7', output: '/health 및 /health/:service 엔드포인트', artifacts: ['src/routes/health.ts'] },
    { taskId: 'T8', output: '글로벌 에러 핸들러', artifacts: ['src/middleware/error-handler.ts'] },
  ],
  structuralResult: {
    commands: [
      { name: 'lint', command: 'eslint src/', exitCode: 0, output: 'No errors found' },
      { name: 'build', command: 'tsc --noEmit', exitCode: 0, output: '' },
      { name: 'test', command: 'vitest run', exitCode: 0, output: 'Tests: 31 passed' },
    ],
    allPassed: true,
  },
  evaluationResult: {
    verifications: [
      { acIndex: 0, satisfied: true, evidence: '프록시 라우팅 + 동적 서비스 등록', gaps: [] },
      { acIndex: 1, satisfied: true, evidence: 'JWT 미들웨어 + 화이트리스트', gaps: [] },
      { acIndex: 2, satisfied: true, evidence: 'Redis sliding window + 서비스별 한도', gaps: [] },
      { acIndex: 3, satisfied: true, evidence: 'pino 구조화 로깅', gaps: [] },
      { acIndex: 4, satisfied: true, evidence: '게이트웨이 + 다운스트림 헬스체크', gaps: [] },
    ],
    overallScore: 0.95,
    goalAlignment: 0.92,
    recommendations: ['서킷 브레이커 패턴 추가 고려'],
  },
};
