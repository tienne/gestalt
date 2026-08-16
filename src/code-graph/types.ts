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
  summary: string;
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
}

// ─── Blast Radius Options ────────────────────────────────────────
export interface BlastRadiusOptions {
  changedFiles?: string[]; // explicit list, overrides git diff
  base?: string; // git base ref, default 'HEAD~1'
  maxDepth?: number; // BFS max depth, default 2
}

// ─── Diff Radius ─────────────────────────────────────────────────
export type DiffMode = 'staged' | 'unstaged' | 'all';

export interface DiffRadiusOptions {
  mode?: DiffMode; // default 'all'
  maxDepth?: number;
}
