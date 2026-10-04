/**
 * 카드 색과 아이콘을 고르는 작은 고정 분류. 팩의 kind는 이 중 하나에 걸린다.
 * 팩 kind는 자기 색과 아이콘을 쓴다. 범용 component만 이 분류의 모양을 그대로 받는다
 */
export const RENDER_CLASSES = [
  'actor',
  'client',
  'service',
  'gateway',
  'store',
  'queue',
  'external',
  'infra',
  'step',
  'state',
  'document',
] as const;
export type RenderClass = (typeof RENDER_CLASSES)[number];

export interface KindColor {
  light: string;
  dark: string;
}

/** 카드에 보이는 모양. 칩 글자, 읽는 사람 말, 색, 24 격자 선 아이콘 path */
export interface KindLook {
  renderClass: RenderClass;
  short: string;
  text: string;
  color: KindColor;
  icon: string;
}

export interface NodeKindDef extends KindLook {
  /** 평면 그림에서 서는 레인 id. 같은 팩이나 requires한 팩의 lanes에 있어야 한다 */
  lane: string;
  /** 왼쪽부터 서는 열 순위. 작을수록 왼쪽이다 */
  rank: number;
  /** 이 kind가 parent로 둘 수 있는 kind. 없으면 parent를 못 가진다 */
  parents?: readonly string[];
}

export interface LaneDef {
  title: string;
  /** 같은 레인끼리 잇는 선을 elk에 안 넘기고 세로로 쌓는다. 화면 이동처럼 요청 흐름이 아닌 선이 그 레인 안에 있다 */
  stacked?: boolean;
}

export interface EdgeKindDef {
  text: string;
  /** 평면 그림에서 레인 순서가 화살표 반대라 오른쪽에서 왼쪽으로 그린다 */
  backward?: boolean;
  /** 양 끝에 올 수 있는 kind. 없으면 끝을 가리지 않는다 */
  ends?: { from: readonly string[]; to: readonly string[] };
}

/**
 * 드릴다운 알고리즘 이름. web-product는 전체 → 서비스 → 기능 영역 → 화면으로 내려가는 지금 그림이다.
 * tree는 parent 포함 관계로 레벨을 나눈다. none은 평면 한 장으로 그린다
 */
export type DrilldownStrategy = 'web-product' | 'tree' | 'none';

/**
 * 카테고리 하나의 어휘. 새 카테고리는 이 데이터만 더하고 렌더러와 드릴다운 코드는 안 고친다.
 * 레코드의 키 순서가 HTML에 싣는 표의 순서라 기존 팩의 순서를 바꾸면 기존 그림 바이트가 바뀐다
 */
export interface VocabularyPack {
  id: string;
  title: string;
  description: string;
  /** 이 팩이 kind나 엣지를 빌려 쓰는 팩. 해석할 때 먼저 들어간다 */
  requires?: readonly string[];
  drilldown: DrilldownStrategy;
  /** 이 팩 IR에 거는 매칭 이름. http-endpoint는 match_endpoints, mcp-tool은 스킬의 도구 호출 매칭이다 */
  matchers: readonly string[];
  nodeKinds: Readonly<Record<string, NodeKindDef>>;
  /** IR kind는 아니지만 카드에 따로 보이는 종류. MCP 도구는 IR에서 endpoint다 */
  displayKinds?: Readonly<Record<string, KindLook>>;
  lanes: Readonly<Record<string, LaneDef>>;
  edgeKinds: Readonly<Record<string, EdgeKindDef>>;
}
