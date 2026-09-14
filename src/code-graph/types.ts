// ─── Code Graph Node Types ───────────────────────────────────────
export enum NodeKind {
  File = 'File',
  Function = 'Function',
  Class = 'Class',
  Type = 'Type',
}

export enum EdgeKind {
  CALLS = 'CALLS',
  IMPORTS_FROM = 'IMPORTS_FROM',
  INHERITS = 'INHERITS',
  CONTAINS = 'CONTAINS',
  TESTED_BY = 'TESTED_BY',
}

export interface CodeGraphNode {
  id: string; // e.g. "function:src/auth.ts:login"
  kind: NodeKind;
  name: string;
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
  isTest: boolean;
  fileHash?: string; // SHA-256 for incremental update
  updatedAt: number; // Unix timestamp ms
}

export interface CodeGraphEdge {
  id?: number; // autoincrement in DB
  kind: EdgeKind;
  sourceId: string;
  targetId: string;
  line?: number;
  updatedAt: number;
}

// ─── Blast Radius ────────────────────────────────────────────────
export interface BlastRadiusNode {
  nodeId: string;
  filePath: string;
  kind: NodeKind;
  name: string;
  hopDistance: number;
  isTest: boolean;
}

export interface BlastRadiusResult {
  changedFiles: string[];
  impactedFiles: string[]; // unique file paths, test files first
  impactedNodes: BlastRadiusNode[];
  riskScore: number; // 0-1, impactedNodes / totalNodes. depthExhausted면 하한이다
  maxDepthUsed: number;
  /**
   * maxDepth에 걸려 탐색을 멈췄고 아직 갈 곳이 남아 있었다.
   * true면 impactedFiles와 riskScore는 실제값의 하한이지 전부가 아니다.
   */
  depthExhausted: boolean;
  /** depthExhausted일 때 다음 홉에서 기다리던 노드 수. 얼마나 잘렸는지 가늠용 */
  unexploredNodes: number;
  /**
   * import 신호와 git 이력 신호를 합쳐 출처를 붙인 목록.
   *
   * impactedFiles와 따로 두는 이유: impactedFiles는 소비자가 vitest 인자로
   * 그대로 넘기는 자리라(execute/orchestrators/evaluation.ts) 이력에만 걸린
   * md나 json이 섞이면 안 된다. 이력 신호는 전부 여기로만 간다.
   */
  rankedFiles: RankedImpactFile[];
  /**
   * 이력 신호가 실제로 실렸는지.
   *
   * false면 rankedFiles에 history 항목이 없는 게 "함께 바뀐 파일이 없다"가
   * 아니라 "수집이 안 됐다"는 뜻이다. 둘을 구분 못 하면 조용한 0건이 된다.
   */
  coChangeAvailable: boolean;
  /** coChangeAvailable이 false거나 이웃이 0건일 때 그 사유 */
  coChangeReason?: string;
  summary: string;
}

// ─── Co-Change (git 이력 기반) ───────────────────────────────────
export type ImpactOrigin = 'both' | 'history' | 'import';

export interface RankedImpactFile {
  filePath: string;
  origin: ImpactOrigin;
  /** import 신호가 있을 때만 */
  hopDistance?: number;
  /** 이력 신호가 있을 때만 */
  coChangeCount?: number;
  confidence?: number;
  lift?: number;
  isTest: boolean;
}

export interface CoChangeNeighbor {
  filePath: string;
  pairCount: number;
  /** max(conf A→B, conf B→A). A가 바뀔 때 B도 바뀔 확률 중 큰 쪽 */
  confidence: number;
  /** 우연 대비 배수. package.json처럼 아무 데나 끼는 파일을 눌러준다 */
  lift: number;
}

export interface CoChangePair {
  fileA: string;
  fileB: string;
  pairCount: number;
  confidence: number;
  lift: number;
}

export interface CoChangeResult {
  target?: string;
  /** target을 준 경우의 이웃 목록 */
  neighbors: CoChangeNeighbor[];
  /** target을 생략한 경우의 상위 페어 목록 */
  pairs: CoChangePair[];
  commitsUsed: number;
  commitsScanned: number;
  /** DB에 저장된 전체 페어 수. 0건이 경로 불일치인지 수집 미실행인지 가르는 단서 */
  pairsInDb: number;
  available: boolean;
  reason?: string;
}

export interface CoChangeLookup {
  available: boolean;
  reason?: string;
  pairsInDb: number;
  neighbors: CoChangeNeighbor[];
}

export interface CoChangeBuildSummary {
  pairs: number;
  commitsUsed: number;
  commitsScanned: number;
  mode: 'full' | 'incremental';
}

export interface CoChangeMeta {
  headSha: string;
  commitsUsed: number;
  commitsScanned: number;
  maxFilesPerCommit: number;
  minPairCount: number;
  builtAt: number;
}

// ─── Analyzer Plugin Interface ───────────────────────────────────
export interface ParseResult {
  nodes: CodeGraphNode[];
  edges: CodeGraphEdge[];
  fileHash: string;
}

export interface AnalyzerPlugin {
  language: string;
  extensions: string[]; // e.g. ['.ts', '.tsx', '.js']
  parse(filePath: string, content: string): ParseResult;
}

// ─── Query Types ─────────────────────────────────────────────────
export type QueryPattern = 'callers_of' | 'callees_of' | 'tests_for' | 'imports_of';

export interface QueryResult {
  nodes: CodeGraphNode[];
  edges: CodeGraphEdge[];
}

// ─── Stats ───────────────────────────────────────────────────────
export interface CodeGraphStats {
  totalFiles: number;
  totalNodes: number;
  totalEdges: number;
  lastBuiltAt: number | null; // Unix timestamp ms
  dbSizeBytes: number;
}

// ─── Build Options ───────────────────────────────────────────────
export type BuildMode = 'full' | 'incremental';

export interface BuildOptions {
  include?: string[]; // glob patterns
  exclude?: string[];
  mode?: BuildMode;
}

export interface BuildResult {
  nodesBuilt: number;
  edgesBuilt: number;
  timeTakenMs: number;
  installedHook: boolean;
  /**
   * 읽거나 파싱하지 못해 그래프에 안 들어간 파일들.
   *
   * 세지 않으면 nodesBuilt만 보고 전부 처리됐다고 읽는다. 여기 빠진 파일은
   * 이후 blast-radius의 영향 범위에서 영영 누락되고, 그 누락은 깊이 상한과
   * 달리 어떤 파라미터로도 되살릴 수 없다.
   */
  skippedFiles: { filePath: string; reason: string }[];
  /**
   * git 이력 co-change 동기화 결과. git 레포가 아니거나 repoRoot가 레포
   * 최상위가 아니면 수집을 건너뛰므로 undefined다 — 필수 필드로 만들면
   * 수집 안 된 자리에서 0을 "함께 바뀐 게 없다"로 읽게 된다.
   */
  coChange?: CoChangeBuildSummary;
}

// ─── Blast Radius Options ────────────────────────────────────────
/**
 * co-change 조회 임계. co_change 액션이랑 blast-radius, diff-radius가 같은
 * 면을 쓴다. 여기서 갈라지면 튜닝한 값이 조회에만 먹는다.
 */
export interface CoChangeTuning {
  limit?: number;
  minPairCount?: number;
  minConfidence?: number;
}

export interface BlastRadiusOptions {
  changedFiles?: string[]; // explicit list, overrides git diff
  base?: string; // git base ref, default 'HEAD~1'
  maxDepth?: number; // BFS max depth, default 2
  coChange?: CoChangeTuning;
}

// ─── Diff Radius ─────────────────────────────────────────────────
export type DiffMode = 'staged' | 'unstaged' | 'all';

export interface DiffRadiusOptions {
  mode?: DiffMode; // default 'all'
  maxDepth?: number;
  coChange?: CoChangeTuning;
}
