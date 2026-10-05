import {
  ALL_PACKS_VOCABULARY,
  componentDisplayKind,
  type PackDisplayKind,
  type PackEdgeKind,
  type PackNodeKind,
} from './packs/index.js';
import { HARNESS_PACK } from './packs/harness.js';
import type { RenderClass } from './packs/types.js';

// 열거값은 배열 하나에서 타입과 zod 스키마를 함께 뽑는다. 두 곳에 따로 적으면 한쪽만 고쳐지기 쉽다.
/** knowledge는 문서 지도, knowledge-link는 기술 그림에 문서를 엮은 그림이다 */
export const ARCHITECTURE_VIEWS = [
  'screen-chain',
  'deploy-path',
  'knowledge',
  'knowledge-link',
] as const;
/** kind 목록은 팩에서 온다. 새 카테고리는 packs/에 팩을 더하면 여기 따라 붙는다 */
export const NODE_KINDS = Object.keys(ALL_PACKS_VOCABULARY.nodeKinds) as unknown as readonly [
  PackNodeKind,
  ...PackNodeKind[],
];
export const EDGE_KINDS = Object.keys(ALL_PACKS_VOCABULARY.edgeKinds) as unknown as readonly [
  PackEdgeKind,
  ...PackEdgeKind[],
];
/** endpoint가 받는 호출 방식. 없으면 http다. mcp면 label이 도구 이름이다 */
export const ENDPOINT_PROTOCOLS = ['http', 'mcp'] as const;
export const EVIDENCE_TYPES = ['code', 'spec', 'doc', 'user', 'live'] as const;
export const VISIBILITIES = ['public', 'private'] as const;
export const LINE_STYLES = ['solid', 'dashed'] as const;
export const CONTEXT_SOURCE_VIAS = ['repo', 'global', 'mcp', 'skill', 'user'] as const;
export const PLATFORMS = ['web', 'android', 'ios'] as const;
/**
 * 흐름의 행위자. person은 고객이나 직원처럼 사람이 누르는 쪽, system은 배치나 타이머, 자동 발송이다.
 * agent는 세션 모델이나 서브에이전트처럼 지시를 읽고 스스로 판단하는 AI 쪽이다
 */
export const FLOW_ACTOR_KINDS = ['person', 'system', 'agent'] as const;
/** main은 정상 흐름, side는 취소나 노쇼처럼 옆으로 빠지는 흐름이다 */
export const FLOW_PATHS = ['main', 'side'] as const;
/**
 * 단계 refs가 가리킬 수 있는 kind. 사용자가 실제로 만나는 화면과 그 화면이 부르는 API까지만 잇는다.
 * 하네스에서는 사용자가 부르는 스킬과 스킬이 띄우는 에이전트가 화면 자리다. MCP 도구는 endpoint로 들어온다
 */
export const FLOW_REF_KINDS: readonly NodeKind[] = [
  'screen',
  'endpoint',
  'feature',
  'micro_app',
  'skill',
  'agent',
  'component',
];
/** 하네스와 MCP 레포에만 나오는 kind. 이게 하나라도 있으면 하네스 IR로 보고 하네스 규칙을 건다 */
export const HARNESS_KINDS: readonly NodeKind[] = Object.keys(HARNESS_PACK.nodeKinds) as NodeKind[];
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
/** 포함 관계 규칙. 키에 없는 kind는 parent를 가질 수 없다. 규칙은 팩의 nodeKinds.parents에 있다 */
export const PARENT_KINDS: Partial<Record<NodeKind, readonly NodeKind[]>> = Object.fromEntries(
  Object.entries(ALL_PACKS_VOCABULARY.nodeKinds).flatMap(([k, d]) =>
    d.parents === undefined ? [] : [[k, d.parents]],
  ),
);

export type ArchitectureView = (typeof ARCHITECTURE_VIEWS)[number];
export type NodeKind = PackNodeKind;
export type EdgeKind = PackEdgeKind;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];
export type Visibility = (typeof VISIBILITIES)[number];
export type LineStyle = (typeof LINE_STYLES)[number];
export type ContextSourceVia = (typeof CONTEXT_SOURCE_VIAS)[number];
export type Platform = (typeof PLATFORMS)[number];
export type FlowActorKind = (typeof FLOW_ACTOR_KINDS)[number];
export type FlowPath = (typeof FLOW_PATHS)[number];
export type EndpointProtocol = (typeof ENDPOINT_PROTOCOLS)[number];
/**
 * 카드 칩과 아이콘, 색을 고르는 종류. MCP 도구는 IR에서는 endpoint라 매칭과 드릴다운을 그대로 타고
 * 읽는 사람에게만 API 대신 MCP 도구로 보인다
 */
export type DisplayKind = NodeKind | PackDisplayKind;

export function displayKindOf(node: {
  kind: NodeKind;
  protocol?: EndpointProtocol;
  renderClass?: RenderClass;
}): DisplayKind {
  if (node.kind === 'component') return componentDisplayKind(node.renderClass ?? 'service');
  return node.kind === 'endpoint' && node.protocol === 'mcp' ? 'mcp_tool' : node.kind;
}

/** 칩에 kind 표 대신 노드가 직접 적은 글자를 쓰는 경우. component만 해당한다 */
export function chipTextOverride(node: {
  kind: NodeKind;
  displayKind?: string;
}): string | undefined {
  return node.kind === 'component' ? node.displayKind : undefined;
}
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

/** 문서가 스스로 적은 구멍. gap은 비었다고 밝힌 자리, unverified는 확인 안 된 서술이다 */
export const DOC_GAP_KINDS = ['gap', 'unverified'] as const;
export type DocGapKind = (typeof DOC_GAP_KINDS)[number];

export interface DocGap {
  kind: DocGapKind;
  /** 표시 뒤에 적힌 설명. 본문 조각이라 공유본에서 뺀다 */
  text?: string;
  /** 표시에 적힌 담당. 공유본에서 뺀다 */
  owner?: string;
  line?: number;
}

/** 안내 문서(INDEX)의 길 하나. 질문 키워드에서 문서로 간다 */
export interface DocRoute {
  keywords: string[];
  /** 표에 적힌 경로. 레포 기준으로 푼 값이다 */
  targetPath: string;
  /** 그 경로의 노드 id. 없는 문서를 가리키면 비운다 */
  target?: string;
}

/** 디자인 화면 색인의 한 행에서 읽은 값 */
export interface DocScreen {
  route?: string;
  screenType?: string;
  /** 디자인 도구의 프레임 이름과 노드 id */
  frame?: string;
  frameNode?: string;
  /** 컴포넌트로 묶였는지(심볼화) */
  symbolized?: boolean;
  /** 화면별 설계 문서가 있는지 */
  hasSpec?: boolean;
  synonyms?: string[];
  /** private 산출물에만 싣는 썸네일 data URI */
  thumbnail?: string;
}

/** 문서 안 근거 표시가 가리킨 곳의 상태. 레포 클론과 읽기 명령으로만 확인한다 */
export interface DocLinkHealth {
  total: number;
  /** 가리킨 레포나 파일이 없다 */
  broken: number;
  /** 브랜치 이름만 적어 시간이 지나면 다른 내용을 가리킨다 */
  branchOnly: number;
  /** 커밋에 고정했다 */
  pinned: number;
  /** 클론이 없어 확인 못 했다 */
  unchecked: number;
}

/**
 * 지식 팩 노드(doc_group, document, design_screen)만 갖는 문서 정보.
 * 공유본은 path와 숫자, 날짜, 참거짓만 남기고 본문에서 온 글자는 뺀다
 */
export interface DocInfo {
  /** 레포 기준 경로 */
  path: string;
  /** 문서가 머리줄에 적은 최종 수정일 */
  updatedAt?: string;
  /** git이 아는 마지막 커밋 날짜 */
  committedAt?: string;
  /** 절 제목. 문서 노드는 파일 단위라 절은 패널에서만 보인다 */
  sections?: string[];
  gaps?: DocGap[];
  /** 근거 종류별 수. 종류 이름은 스캐너 설정이 정한다 */
  evidenceMix?: Record<string, number>;
  links?: DocLinkHealth;
  routes?: DocRoute[];
  screen?: DocScreen;
  /** 읽힌 횟수. 사용량 도구가 읽기로 열려 있을 때만 */
  reads?: number;
}

/** describes 엣지가 가리키는 파일 하나 */
export interface DocLinkRef {
  /** `<repoId>:<relPath>` */
  target: string;
  /** 가리킨 파일이 클론에 있다 */
  verified: boolean;
  /** 근거 표시가 적은 ref 종류 */
  pinned?: 'branch' | 'commit' | 'none';
  /** 가리킨 파일의 마지막 커밋 날짜 */
  committedAt?: string;
}

/** describes 엣지만. 문서가 무엇을 보고 그 기술 노드에 이어졌는지 */
export interface DocLink {
  /** code-ref는 근거 표시의 파일 경로, screen-route는 화면 색인의 라우트, session은 세션이 직접 이었다 */
  via: 'code-ref' | 'screen-route' | 'session';
  refs: DocLinkRef[];
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
  /** datastore만. mysql, redis 같은 엔진 이름. 아는 엔진이면 카드에 그 로고가 선다. 없으면 label에서 찾는다 */
  engine?: string;
  /** 이 노드가 속한 cloud_account 노드 id. 양 끝 계정이 다른 선을 가려 그리는 데 쓴다 */
  account?: string;
  /** service만. web은 serves 엣지로도 판정하고 android와 ios는 platformEvidence가 있어야 그린다 */
  platforms?: Platform[];
  /** service만. 플랫폼별 근거 */
  platformEvidence?: Partial<Record<Platform, Evidence[]>>;
  /** endpoint만. 없으면 http다 */
  protocol?: EndpointProtocol;
  /** mcp endpoint만. 도구를 등록한 MCP 서버 이름 */
  mcpServer?: string;
  /** mcp endpoint만. 도구가 action 인자로 나눠 받는 값. 서버의 enum이나 분기 그대로다 */
  actions?: string[];
  /** component만. 읽는 사람이 보는 종류 이름(예: 배치 잡, 결재 문서). 칩에 그대로 찍힌다 */
  displayKind?: string;
  /** component만. 색과 아이콘을 고르는 렌더 분류 */
  renderClass?: RenderClass;
  /** 지식 팩 노드만. 경로, 수정일, 구멍, 근거 구성 */
  doc?: DocInfo;
  /** 담당 팀이나 사람. CODEOWNERS나 소유 표처럼 출처가 있는 값만 적는다. 공유본에서 뺀다 */
  owners?: string[];
}

export interface ArchitectureEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  evidence: Evidence[];
  lineStyle: LineStyle;
  /** mcp endpoint를 부르는 calls만. 이 호출이 실제로 넘기는 action 값 */
  actions?: string[];
  /** describes만. 가리킨 파일과 그 파일이 있는지 */
  docLink?: DocLink;
}

export interface UnresolvedQuestion {
  id: string;
  /** stepId와 transitionId는 흐름의 단계와 전이를 가리킨다. 흐름 id끼리 겹치지 않아야 한다 */
  subject: {
    nodeId?: string;
    edgeId?: string;
    stepId?: string;
    transitionId?: string;
    /** 투영 메시지 id. 투영끼리 겹치지 않아야 한다 */
    messageId?: string;
  };
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
  /**
   * 체크아웃 경로. 없으면 코드 없이 문서와 사람 말로만 엮은 문서 묶음이다.
   * 문서 묶음을 가리키는 code 근거는 확인할 파일이 없어서 거부한다
   */
  root?: string;
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
  /** 흐름이 여기서 끝날 수 있다. 착석이나 취소처럼 더 갈 곳이 없는 단계에 단다. 나가는 전이가 없는데 이 표시도 없으면 질문이 생긴다 */
  terminal?: boolean;
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
  /** 이 전이를 일으키는 행위자 id. 되돌리기처럼 여러 행위자가 할 수 있는 전이에 단다. 선 글자 옆에 이름이 붙는다 */
  actors?: string[];
  evidence: Evidence[];
  lineStyle: LineStyle;
}

/**
 * 도메인과 사용자 관점의 서비스 흐름. 행위자마다 가로줄, 단계는 왼쪽에서 오른쪽으로 그린다.
 * 기술 그림의 노드와 엣지에 섞지 않고 따로 둔다. 섞으면 드릴다운과 병합 키, 포커스가 단계까지 훑는다
 */
export interface ArchitectureFlow {
  id: string;
  /**
   * 이 흐름이 딸린 service 노드 id. 그 서비스 레벨 아래 레벨로 그린다.
   * 없으면 전체 바로 아래 독립 흐름 레벨이 된다. 승인 절차나 장애 대응처럼 코드 서비스에 안 딸린 흐름이다
   */
  service?: string;
  title: string;
  description?: string;
  /** 상태 값 → 그림에 찍을 이름. 상태 값은 코드의 enum 그대로라 사용자 언어로 된 이름을 따로 받는다. 없는 값은 상태 값 그대로 찍는다 */
  stateLabels?: Record<string, string>;
  actors: FlowActor[];
  steps: FlowStep[];
  transitions: FlowTransition[];
}

/** 투영의 답 모양. 지도(nodes, edges)는 그대로 두고 질문 하나에 맞게 골라 그린다 */
/**
 * 투영 모양. sequence는 주고받는 순서, dataflow는 데이터가 어디서 어디로 옮겨 가는지, compare는 두 묶음의 같고 다른 점이다.
 * 팩과 무관하게 어느 카테고리든 이 중 하나로 답한다
 */
export const PROJECTION_SHAPES = ['sequence', 'dataflow', 'compare'] as const;
export type ProjectionShape = (typeof PROJECTION_SHAPES)[number];
/** sequence 묶음 종류. alt는 경우 나누기, opt는 조건이 맞을 때만, loop는 반복, par는 동시 실행이다 */
export const SEQUENCE_BLOCK_KINDS = ['alt', 'opt', 'loop', 'par'] as const;
export type SequenceBlockKind = (typeof SEQUENCE_BLOCK_KINDS)[number];

export interface ProjectionBlock {
  id: string;
  kind: SequenceBlockKind;
  label: string;
}

/**
 * 투영 안의 메시지 하나. from과 to는 지도의 노드 id다.
 * edge를 적으면 그 엣지의 근거를 함께 쓴다. edge도 evidence도 없으면 unresolved에 이 메시지를 묻는 질문이 있어야 한다
 */
export interface ProjectionMessage {
  id: string;
  from: string;
  to: string;
  label: string;
  edge?: string;
  evidence: Evidence[];
  lineStyle: LineStyle;
  /** 응답이면 true. 화살표를 열린 꼴로 그린다 */
  reply?: boolean;
  block?: string;
  /** alt 묶음 안에서 이 메시지가 속한 경우의 이름. 경우가 바뀌는 자리에 가로 점선을 긋는다 */
  branch?: string;
}

/**
 * 질문 하나에 답하는 그림. 지도에서 노드를 골라 순서와 묶음을 붙인다.
 * 지도에 없는 노드는 못 가리킨다. 필요하면 근거와 함께 지도에 먼저 넣는다
 */
export interface ArchitectureProjection {
  id: string;
  shape: ProjectionShape;
  title: string;
  question: string;
  /** 왼쪽부터 놓을 참여자. 없으면 메시지에 처음 나온 순서다 */
  participants?: string[];
  /** sequence와 dataflow의 선. compare는 비워 둔다 */
  messages: ProjectionMessage[];
  blocks?: ProjectionBlock[];
  /** compare가 견주는 두 묶음. 전과 후, 제품 둘처럼 왼쪽과 오른쪽에 선다 */
  sides?: ProjectionSide[];
}

/** compare 묶음 하나. nodes는 지도의 노드 id다. 두 묶음에 다 있는 노드는 가운데 열에 선다 */
export interface ProjectionSide {
  id: string;
  label: string;
  nodes: string[];
}

/**
 * 기술 그림을 왼쪽에서 오른쪽으로 나누는 구간. 세션이 분석하면서 정한다 (예: 앱, 웨이팅 서버, 알림 서버, DB).
 * 노드는 nodes에 이름이 오른 구간에 먼저 들어간다. 없으면 kinds와 repos가 맞는 첫 구간에 들어간다
 */
export interface ArchitectureStage {
  id: string;
  label: string;
  nodes?: string[];
  kinds?: NodeKind[];
  /** kinds와 함께 쓰면 둘 다 맞아야 한다 */
  repos?: string[];
}

export interface ArchitectureIr {
  schemaVersion: typeof ARCHITECTURE_IR_SCHEMA_VERSION;
  view: ArchitectureView;
  /** 이 IR이 쓰는 어휘 팩 id. 없으면 web-product와 harness다. 여기 없는 팩의 kind를 쓰면 검증에서 막힌다 */
  packs?: string[];
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
  /** 기술 그림 구간. 배열 순서가 왼쪽부터다. 없으면 종류별 레인만 그린다 */
  stages?: ArchitectureStage[]; /** 질문별 그림. 드릴다운 끝에 레벨로 붙고 저장할 때 views/<id>.json으로도 남는다 */
  projections?: ArchitectureProjection[];
}
