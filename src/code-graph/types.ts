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
  id: string;           // e.g. "function:src/auth.ts:login"
  kind: NodeKind;
  name: string;
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
  isTest: boolean;
  fileHash?: string;    // SHA-256 for incremental update
  updatedAt: number;    // Unix timestamp ms
}

export interface CodeGraphEdge {
  id?: number;          // autoincrement in DB
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
  impactedFiles: string[];         // unique file paths, test files first
  impactedNodes: BlastRadiusNode[];
  riskScore: number;               // 0-1, impactedNodes / totalNodes
  maxDepthUsed: number;
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
  extensions: string[];           // e.g. ['.ts', '.tsx', '.js']
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
  lastBuiltAt: number | null;    // Unix timestamp ms
  dbSizeBytes: number;
}

// ─── Build Options ───────────────────────────────────────────────
export type BuildMode = 'full' | 'incremental';

export interface BuildOptions {
  include?: string[];             // glob patterns
  exclude?: string[];
  mode?: BuildMode;
}

export interface BuildResult {
  nodesBuilt: number;
  edgesBuilt: number;
  timeTakenMs: number;
  installedHook: boolean;
}

// ─── Blast Radius Options ────────────────────────────────────────
export interface BlastRadiusOptions {
  changedFiles?: string[];        // explicit list, overrides git diff
  base?: string;                  // git base ref, default 'HEAD~1'
  maxDepth?: number;              // BFS max depth, default 2
}

// ─── Diff Radius ─────────────────────────────────────────────────
export type DiffMode = 'staged' | 'unstaged' | 'all';

export interface DiffRadiusOptions {
  mode?: DiffMode;                // default 'all'
  maxDepth?: number;
}
