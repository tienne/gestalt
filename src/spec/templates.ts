import type { SpecTemplate } from '../core/types.js';

// ─── Built-in Templates ──────────────────────────────────────────

const REST_API_TEMPLATE: SpecTemplate = {
  id: 'rest-api',
  name: 'REST API Backend',
  description: 'RESTful API 백엔드 서비스 — 인증, CRUD, 에러 핸들링 포함',
  baseConstraints: [
    'RESTful API 설계 원칙 준수 (HTTP 메서드, 상태 코드)',
    'JWT 기반 인증/인가',
    '입력 유효성 검사 및 에러 응답 표준화',
    'API 버전 관리 (/api/v1/...)',
    '환경변수 기반 설정 관리 (비밀값 하드코딩 금지)',
  ],
  baseAcceptanceCriteria: [
    'GET /health 엔드포인트가 200 OK와 서버 상태를 반환한다',
    'POST /auth/login은 유효한 자격증명으로 JWT 토큰을 반환한다',
    '인증이 필요한 엔드포인트는 유효하지 않은 토큰으로 401을 반환한다',
    '잘못된 요청에 대해 표준 에러 형식(code, message)을 반환한다',
    '모든 엔드포인트에 요청/응답 로깅이 동작한다',
  ],
  baseOntologyEntities: ['User', 'AuthToken', 'Resource', 'ApiResponse'],
};

const REACT_DASHBOARD_TEMPLATE: SpecTemplate = {
  id: 'react-dashboard',
  name: 'React Dashboard',
  description: 'React 기반 관리자 대시보드 — 차트, 테이블, 필터링 포함',
  baseConstraints: [
    'React 18+ 함수형 컴포넌트 + TypeScript',
    '상태 관리: 서버 상태는 React Query, 클라이언트 상태는 Zustand 또는 Context',
    '반응형 레이아웃 (모바일/태블릿/데스크탑)',
    '접근성 (WCAG 2.1 AA) 준수',
    '컴포넌트 단위 Storybook 문서화',
  ],
  baseAcceptanceCriteria: [
    '대시보드 메인 페이지가 핵심 KPI 카드를 표시한다',
    '차트/그래프가 데이터 로딩 중 스켈레톤 UI를 보여준다',
    '테이블에 정렬, 필터링, 페이지네이션이 동작한다',
    '필터 조건이 URL 쿼리 파라미터에 반영되어 공유 가능하다',
    '다크 모드 전환이 즉시 적용된다',
  ],
  baseOntologyEntities: ['Dashboard', 'Chart', 'DataTable', 'Filter', 'UserPreference'],
};

const CLI_TOOL_TEMPLATE: SpecTemplate = {
  id: 'cli-tool',
  name: 'CLI Tool',
  description: 'Node.js CLI 도구 — 명령어, 옵션, 대화형 프롬프트 포함',
  baseConstraints: [
    'Node.js 20+ ESM 모듈',
    'commander.js 기반 명령어 파싱',
    '대화형 프롬프트: @inquirer/prompts',
    'JSON/YAML 설정 파일 지원 (cosmiconfig 또는 동등한 라이브러리)',
    '0-exit-code: 성공, 1-exit-code: 실패 (UNIX 표준)',
    'stdout: 결과 데이터만, stderr: 로그/에러',
  ],
  baseAcceptanceCriteria: [
    '`tool --help`가 모든 명령어와 옵션을 출력한다',
    '`tool --version`이 package.json 버전을 출력한다',
    '잘못된 옵션 사용 시 명확한 에러 메시지와 exit code 1을 반환한다',
    '`--quiet` 플래그로 진행 메시지를 숨기고 결과만 출력한다',
    '설정 파일이 없을 때 기본값으로 동작한다',
  ],
  baseOntologyEntities: ['Command', 'Option', 'Config', 'Output'],
};

// ─── Registry ────────────────────────────────────────────────────

const TEMPLATES: Map<string, SpecTemplate> = new Map([
  [REST_API_TEMPLATE.id, REST_API_TEMPLATE],
  [REACT_DASHBOARD_TEMPLATE.id, REACT_DASHBOARD_TEMPLATE],
  [CLI_TOOL_TEMPLATE.id, CLI_TOOL_TEMPLATE],
]);

export class SpecTemplateRegistry {
  get(id: string): SpecTemplate | undefined {
    return TEMPLATES.get(id);
  }

  list(): SpecTemplate[] {
    return [...TEMPLATES.values()];
  }

  has(id: string): boolean {
    return TEMPLATES.has(id);
  }

  /**
   * 템플릿을 기반으로 specPrompt를 위한 추가 컨텍스트 문자열 생성.
   * TextBasedSpecGenerator.buildSpecContext()에서 주입된다.
   */
  buildTemplateContext(id: string): string | null {
    const template = this.get(id);
    if (!template) return null;

    const lines: string[] = [
      `## Template: ${template.name}`,
      `${template.description}`,
      '',
      '### Template Base Constraints (merge into spec constraints)',
      ...template.baseConstraints.map((c) => `- ${c}`),
      '',
      '### Template Base Acceptance Criteria (merge into spec ACs)',
      ...template.baseAcceptanceCriteria.map((ac) => `- ${ac}`),
      '',
      '### Suggested Ontology Entities',
      ...template.baseOntologyEntities.map((e) => `- ${e}`),
    ];

    return lines.join('\n');
  }
}
