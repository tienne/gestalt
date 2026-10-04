// 열거값은 배열 하나에서 타입과 zod 스키마를 함께 뽑는다. 두 곳에 따로 적으면 한쪽만 고쳐지기 쉽다.
export const ARCHITECTURE_VIEWS = ['screen-chain', 'deploy-path'] as const;
export const NODE_KINDS = [
  'screen',
  'endpoint',
  'app_module',
  'external_service',
  'db_table',
  'datastore',
  'workflow',
  'build',
  'artifact',
  'deploy_target',
  'service',
  'micro_app',
  'feature',
  'gateway',
  'domain',
  'cdn',
  'bucket',
  'cloud_account',
] as const;
export const EDGE_KINDS = [
  'calls',
  'handles',
  'uses',
  'reads_writes',
  'triggers',
  'builds',
  'produces',
  'deploys_to',
  'routes',
  'navigates',
  'resolves_to',
  'origin',
  'serves',
  'loads',
] as const;
export const EVIDENCE_TYPES = ['code', 'spec', 'doc', 'user', 'live'] as const;
export const VISIBILITIES = ['public', 'private'] as const;
export const LINE_STYLES = ['solid', 'dashed'] as const;
export const CONTEXT_SOURCE_VIAS = ['repo', 'global', 'mcp', 'skill', 'user'] as const;
export const PLATFORMS = ['web', 'android', 'ios'] as const;
/** 흐름의 행위자. person은 고객이나 직원처럼 사람이 누르는 쪽, system은 배치나 타이머, 자동 발송이다 */
export const FLOW_ACTOR_KINDS = ['person', 'system'] as const;
/** main은 정상 흐름, side는 취소나 노쇼처럼 옆으로 빠지는 흐름이다 */
export const FLOW_PATHS = ['main', 'side'] as const;
/** 단계 refs가 가리킬 수 있는 kind. 사용자가 실제로 만나는 화면과 그 화면이 부르는 API까지만 잇는다 */
export const FLOW_REF_KINDS: readonly NodeKind[] = ['screen', 'endpoint', 'feature', 'micro_app'];
/** 서빙 인프라. 화면 흐름과 배포 경로 둘 다에 설 수 있다 */
export const INFRA_KINDS = ['domain', 'cdn', 'bucket', 'cloud_account'] as const;
/** environment를 가질 수 있는 kind. 네이티브 배포처는 deploy_target으로 그린다 */
export const ENVIRONMENT_KINDS: readonly NodeKind[] = [
  ...INFRA_KINDS,
  'deploy_target',
  'datastore',
];
/** 환경 정렬 순서. 여기 없는 환경은 이름순으로 뒤에, 환경이 없으면 맨 뒤에 선다 */
export const ENVIRONMENT_ORDER = ['prod', 'stage', 'qa', 'dev'] as const;
export const ARCHITECTURE_IR_SCHEMA_VERSION = '1.0.0';
/**
 * 포함 관계 규칙. 키에 없는 kind는 parent를 가질 수 없다.
 * micro_app은 Module Federation 같은 마이크로 프론트엔드의 호스트나 리모트다. 서비스가 그 묶음이고
 * 기능 영역과 화면은 페이지 코드가 있는 앱 밑에 둔다
 */
export const PARENT_KINDS: Partial<Record<NodeKind, readonly NodeKind[]>> = {
  screen: ['feature', 'micro_app', 'service'],
  feature: ['micro_app', 'service'],
  micro_app: ['service'],
  db_table: ['datastore'],
};

export type ArchitectureView = (typeof ARCHITECTURE_VIEWS)[number];
export type NodeKind = (typeof NODE_KINDS)[number];
export type EdgeKind = (typeof EDGE_KINDS)[number];
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];
export type Visibility = (typeof VISIBILITIES)[number];
export type LineStyle = (typeof LINE_STYLES)[number];
export type ContextSourceVia = (typeof CONTEXT_SOURCE_VIAS)[number];
export type Platform = (typeof PLATFORMS)[number];
export type FlowActorKind = (typeof FLOW_ACTOR_KINDS)[number];
export type FlowPath = (typeof FLOW_PATHS)[number];
/** 웹 서빙 방식. 버킷이 서빙하면 정적, 배포 대상(서버)이 서빙하면 SSR이다 */
export type WebHosting = 'static' | 'ssr';

export interface Evidence {
  type: EvidenceType;
  /** code 근거는 `<repoId>:<relPath>:<line>` 꼴, live 근거는 조회로 찾은 리소스 식별자 */
  location: string;
  updatedAt?: string;
  visibility: Visibility;
  excerpt?: string;
  /** live 근거만. 실행한 읽기 전용 명령 */
  command?: string;
  /** live 근거만. 조회한 시각(ISO 8601) */
  observedAt?: string;
}

export interface ArchitectureNode {
  id: string;
  kind: NodeKind;
  /** 기술 이름. 이전 실행 병합 키(kind, repo, 정규화 label)에 쓰인다 */
  label: string;
  /** 사람이 부르는 이름. 박스에 크게 보이고 병합 키에는 안 들어간다 */
  displayName?: string;
  /** 문서에 그대로 있는 이름이 아니라 근거 문장을 줄여 지은 이름이면 true. displayName 없이는 못 온다 */
  displayNameInferred?: boolean;
  repo: string;
  /** 포함 관계. 허용하는 parent kind는 PARENT_KINDS에 있다 */
  parent?: string;
  description?: string;
  evidence: Evidence[];
  /** 인프라 노드와 deploy_target, datastore만. prod, stage, qa, dev 같은 환경 이름 */
  environment?: string;
  /** 이 노드가 속한 cloud_account 노드 id. 양 끝 계정이 다른 선을 가려 그리는 데 쓴다 */
  account?: string;
  /** service만. web은 serves 엣지로도 판정하고 android와 ios는 platformEvidence가 있어야 그린다 */
  platforms?: Platform[];
  /** service만. 플랫폼별 근거 */
  platformEvidence?: Partial<Record<Platform, Evidence[]>>;
}

export interface ArchitectureEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  evidence: Evidence[];
  lineStyle: LineStyle;
}

export interface UnresolvedQuestion {
  id: string;
  /** stepId와 transitionId는 흐름의 단계와 전이를 가리킨다. 흐름 id끼리 겹치지 않아야 한다 */
  subject: { nodeId?: string; edgeId?: string; stepId?: string; transitionId?: string };
  question: string;
  answer?: string;
}

export interface ContextSource {
  via: ContextSourceVia;
  identifier: string;
  readOnly: boolean;
  probeHit: boolean;
  visibility: Visibility;
}

export interface ArchitectureRepo {
  id: string;
  name: string;
  root: string;
  remote?: string;
}

/**
 * 합친 IR에서 한 제품 몫. 분석은 제 제품이 닿는 것만 적으므로 그 입력에 있던 노드가 곧 그 제품 영역이다.
 * 엣지를 따라 펼쳐 정하면 게이트웨이 하나가 제품이 안 쓰는 서버까지 끌고 들어온다
 */
export interface ArchitectureGroup {
  id: string;
  name: string;
  members: string[];
}

export interface FlowActor {
  id: string;
  label: string;
  kind: FlowActorKind;
}

export interface FlowStep {
  id: string;
  /** 이 단계를 하는 행위자 id. 같은 흐름의 actors에 있어야 한다 */
  actor: string;
  label: string;
  description?: string;
  /** 이 단계가 끝난 뒤의 업무 상태. 코드 enum 값을 그대로 적는다 */
  state?: string;
  /** 이 단계에서 만나는 화면이나 부르는 API 노드 id. 기술 그림으로 내려가는 입구다 */
  refs?: string[];
  evidence: Evidence[];
}

/** 단계에서 단계로 넘어가는 선. 상태가 바뀌는 자리이고 근거 규칙은 엣지와 같다 */
export interface FlowTransition {
  id: string;
  from: string;
  to: string;
  path: FlowPath;
  /** 넘어가는 조건. 선 위에 짧게 보인다 */
  label?: string;
  evidence: Evidence[];
  lineStyle: LineStyle;
}

/**
 * 도메인과 사용자 관점의 서비스 흐름. 행위자마다 가로줄, 단계는 왼쪽에서 오른쪽으로 그린다.
 * 기술 그림의 노드와 엣지에 섞지 않고 따로 둔다. 섞으면 드릴다운과 병합 키, 포커스가 단계까지 훑는다
 */
export interface ArchitectureFlow {
  id: string;
  /** 이 흐름이 딸린 service 노드 id. 그 서비스 레벨 아래 레벨로 그린다 */
  service: string;
  title: string;
  description?: string;
  actors: FlowActor[];
  steps: FlowStep[];
  transitions: FlowTransition[];
}

export interface ArchitectureIr {
  schemaVersion: typeof ARCHITECTURE_IR_SCHEMA_VERSION;
  view: ArchitectureView;
  repos: ArchitectureRepo[];
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  unresolved: UnresolvedQuestion[];
  sourcesUsed: ContextSource[];
  generatedAt: string;
  /** merge가 남기는 제품 그룹. 둘 이상이면 렌더러가 제품끼리 겹치는 띠를 그린다 */
  groups?: ArchitectureGroup[];
  /** 도메인 흐름. 없으면 기술 그림만 그린다 */
  flows?: ArchitectureFlow[];
}
