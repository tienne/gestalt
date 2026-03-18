import type { BenchmarkScenario } from '../types.js';

export const dashboardScenario: BenchmarkScenario = {
  name: 'dashboard',
  description: '실시간 모니터링 대시보드',
  topic: '실시간 모니터링 대시보드',
  userResponses: [
    'React 기반 실시간 메트릭 대시보드를 만들려 합니다. CPU, 메모리, 네트워크 트래픽을 시각화합니다.',
    'WebSocket으로 실시간 데이터 수신, Chart.js로 차트 렌더링, 5초 간격 업데이트입니다.',
    '대시보드 레이아웃은 그리드 기반, 위젯 드래그앤드롭 재배치 가능해야 합니다.',
    '알림 시스템: CPU > 90% 또는 메모리 > 85%일 때 토스트 알림 + 차트 색상 변경',
    '우선순위: 1) 실시간 차트 2) WebSocket 연결 3) 알림 4) 레이아웃 커스텀',
  ],
  expectedSpec: {
    goal: 'React 기반 실시간 시스템 메트릭 모니터링 대시보드 구현',
    constraints: [
      'React + TypeScript',
      'WebSocket 실시간 통신',
      'Chart.js 차트 라이브러리',
      '5초 간격 데이터 업데이트',
      '그리드 기반 드래그앤드롭 레이아웃',
    ],
    acceptanceCriteria: [
      'AC0: 실시간 차트 위젯 — CPU, 메모리, 네트워크 메트릭을 Chart.js로 시각화',
      'AC1: WebSocket 연결 — 서버와 실시간 양방향 통신, 자동 재연결',
      'AC2: 알림 시스템 — 임계치 초과 시 토스트 알림 + 차트 색상 변경',
      'AC3: 그리드 레이아웃 — 위젯 드래그앤드롭 재배치, 레이아웃 저장/복원',
    ],
    ontologySchema: {
      entities: [
        { name: 'MetricData', description: '시스템 메트릭 데이터 포인트', attributes: ['type', 'value', 'timestamp'] },
        { name: 'Widget', description: '대시보드 위젯', attributes: ['id', 'type', 'position', 'size'] },
        { name: 'Alert', description: '알림 규칙', attributes: ['metric', 'threshold', 'severity'] },
        { name: 'Layout', description: '대시보드 레이아웃', attributes: ['id', 'widgets', 'savedAt'] },
      ],
      relations: [
        { from: 'Widget', to: 'MetricData', type: 'displays' },
        { from: 'Alert', to: 'MetricData', type: 'monitors' },
        { from: 'Layout', to: 'Widget', type: 'contains' },
      ],
    },
    gestaltAnalysis: [
      { principle: 'figure_ground', finding: '실시간 차트가 핵심(figure), 레이아웃 커스텀은 보조(ground)', confidence: 0.92 },
      { principle: 'proximity', finding: 'WebSocket+차트+알림이 실시간 모니터링 도메인으로 그룹핑', confidence: 0.88 },
      { principle: 'continuity', finding: 'WebSocket 연결 → 데이터 수신 → 차트 업데이트 → 알림 체크 흐름', confidence: 0.90 },
    ],
  },
  planningSteps: {
    figureGround: {
      classifiedACs: [
        { acIndex: 0, classification: 'essential', reasoning: '핵심 시각화 기능' },
        { acIndex: 1, classification: 'essential', reasoning: '실시간 데이터의 근간' },
        { acIndex: 2, classification: 'supplementary', reasoning: '사용성 강화 부가기능' },
        { acIndex: 3, classification: 'supplementary', reasoning: '편의 기능' },
      ],
    },
    closure: {
      atomicTasks: [
        { taskId: 'T1', title: 'WebSocket 클라이언트 훅 구현', acIndices: [1], dependencies: [] },
        { taskId: 'T2', title: 'MetricData 타입 및 스토어', acIndices: [0], dependencies: [] },
        { taskId: 'T3', title: 'Chart.js 차트 위젯 컴포넌트', acIndices: [0], dependencies: ['T2'] },
        { taskId: 'T4', title: 'WebSocket-Chart 데이터 바인딩', acIndices: [0, 1], dependencies: ['T1', 'T3'] },
        { taskId: 'T5', title: '알림 엔진 및 토스트 UI', acIndices: [2], dependencies: ['T2'] },
        { taskId: 'T6', title: '그리드 레이아웃 + 드래그앤드롭', acIndices: [3], dependencies: ['T3'] },
      ],
    },
    proximity: {
      taskGroups: [
        { groupId: 'G1', name: '데이터 레이어', taskIds: ['T1', 'T2'] },
        { groupId: 'G2', name: '시각화', taskIds: ['T3', 'T4'] },
        { groupId: 'G3', name: 'UX 기능', taskIds: ['T5', 'T6'] },
      ],
    },
    continuity: {
      dagValidation: {
        isValid: true,
        hasCycles: false,
        hasConflicts: false,
        topologicalOrder: ['T1', 'T2', 'T3', 'T5', 'T4', 'T6'],
        criticalPath: ['T2', 'T3', 'T4'],
      },
    },
  },
  taskOutputs: [
    { taskId: 'T1', output: 'useWebSocket 훅 구현, 자동 재연결 포함', artifacts: ['src/hooks/useWebSocket.ts'] },
    { taskId: 'T2', output: 'MetricData 타입 정의 및 Zustand 스토어', artifacts: ['src/types/metric.ts', 'src/stores/metricStore.ts'] },
    { taskId: 'T3', output: 'LineChart, AreaChart 위젯 컴포넌트', artifacts: ['src/components/charts/LineChart.tsx'] },
    { taskId: 'T4', output: 'WebSocket 데이터를 Chart에 연결하는 바인딩 레이어', artifacts: ['src/hooks/useMetricStream.ts'] },
    { taskId: 'T5', output: '알림 엔진 + react-toastify 통합', artifacts: ['src/features/alerts/AlertEngine.ts'] },
    { taskId: 'T6', output: 'react-grid-layout 기반 드래그앤드롭', artifacts: ['src/components/DashboardGrid.tsx'] },
  ],
  structuralResult: {
    commands: [
      { name: 'lint', command: 'eslint src/', exitCode: 0, output: 'No errors found' },
      { name: 'build', command: 'tsc --noEmit', exitCode: 0, output: '' },
      { name: 'test', command: 'vitest run', exitCode: 0, output: 'Tests: 18 passed' },
    ],
    allPassed: true,
  },
  evaluationResult: {
    verifications: [
      { acIndex: 0, satisfied: true, evidence: 'Chart.js 기반 CPU/메모리/네트워크 위젯 구현', gaps: [] },
      { acIndex: 1, satisfied: true, evidence: 'WebSocket 훅 + 자동 재연결 구현', gaps: [] },
      { acIndex: 2, satisfied: true, evidence: '임계치 알림 엔진 + 토스트 UI', gaps: ['차트 색상 변경 미구현'] },
      { acIndex: 3, satisfied: true, evidence: 'react-grid-layout 드래그앤드롭', gaps: [] },
    ],
    overallScore: 0.88,
    goalAlignment: 0.85,
    recommendations: ['알림 시 차트 색상 변경 기능 추가 권장'],
  },
};
