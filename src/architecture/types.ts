// 열거값은 배열 하나에서 타입과 zod 스키마를 함께 뽑는다. 두 곳에 따로 적으면 한쪽만 고쳐지기 쉽다.
export const ARCHITECTURE_VIEWS = ['screen-chain', 'deploy-path'] as const;
export const NODE_KINDS = [
  'screen',
  'endpoint',
  'app_module',
  'external_service',
  'db_table',
  'workflow',
  'build',
  'artifact',
  'deploy_target',
  'service',
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
] as const;
export const EVIDENCE_TYPES = ['code', 'spec', 'doc', 'user', 'live'] as const;
export const VISIBILITIES = ['public', 'private'] as const;
export const LINE_STYLES = ['solid', 'dashed'] as const;
export const CONTEXT_SOURCE_VIAS = ['repo', 'global', 'mcp', 'skill', 'user'] as const;
export const PLATFORMS = ['web', 'android', 'ios'] as const;
/** 서빙 인프라. 화면 흐름과 배포 경로 둘 다에 설 수 있다 */
export const INFRA_KINDS = ['domain', 'cdn', 'bucket', 'cloud_account'] as const;
/** environment를 가질 수 있는 kind. 네이티브 배포처는 deploy_target으로 그린다 */
export const ENVIRONMENT_KINDS: readonly NodeKind[] = [...INFRA_KINDS, 'deploy_target'];
/** 환경 정렬 순서. 여기 없는 환경은 이름순으로 뒤에, 환경이 없으면 맨 뒤에 선다 */
export const ENVIRONMENT_ORDER = ['prod', 'stage', 'qa', 'dev'] as const;
export const ARCHITECTURE_IR_SCHEMA_VERSION = '1.0.0';
/** 포함 관계 규칙. 키에 없는 kind는 parent를 가질 수 없다 */
export const PARENT_KINDS: Partial<Record<NodeKind, readonly NodeKind[]>> = {
  screen: ['feature', 'service'],
  feature: ['service'],
};

export type ArchitectureView = (typeof ARCHITECTURE_VIEWS)[number];
export type NodeKind = (typeof NODE_KINDS)[number];
export type EdgeKind = (typeof EDGE_KINDS)[number];
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];
export type Visibility = (typeof VISIBILITIES)[number];
export type LineStyle = (typeof LINE_STYLES)[number];
export type ContextSourceVia = (typeof CONTEXT_SOURCE_VIAS)[number];
export type Platform = (typeof PLATFORMS)[number];

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
  /** 포함 관계. screen은 feature나 service, feature는 service만 가리킬 수 있다 */
  parent?: string;
  description?: string;
  evidence: Evidence[];
  /** 인프라 노드와 deploy_target만. prod, stage, qa, dev 같은 환경 이름 */
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
  subject: { nodeId?: string; edgeId?: string };
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

export interface ArchitectureIr {
  schemaVersion: typeof ARCHITECTURE_IR_SCHEMA_VERSION;
  view: ArchitectureView;
  repos: ArchitectureRepo[];
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  unresolved: UnresolvedQuestion[];
  sourcesUsed: ContextSource[];
  generatedAt: string;
}
