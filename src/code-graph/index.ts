export { CodeGraphEngine, codeGraphEngine } from './engine.js';
export { CodeGraphStore, MAX_MATCHED_ROWS } from './storage.js';
export type { CoChangeScan, CoChangeNeighborRow, CoChangePairRow } from './storage.js';
export { computeBlastRadius } from './blast-radius.js';
export {
  syncCoChange,
  queryCoChange,
  buildCoChangeLookup,
  parseGitLog,
  countPairs,
  scoreNeighbor,
  MAX_FILES_PER_COMMIT,
  MIN_FILES_PER_COMMIT,
  MIN_PAIR_COUNT,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_NEIGHBOR_LIMIT,
  DEFAULT_PAIR_LIMIT,
  CONFIDENCE_DECIMALS,
  LIFT_DECIMALS,
} from './cochange.js';
export type { CoChangeQueryOptions, CoChangeSyncOptions, CommitRecord } from './cochange.js';
export { getPluginForFile, pluginRegistry } from './plugins/index.js';
export type {
  CodeGraphNode,
  CodeGraphEdge,
  BlastRadiusResult,
  BlastRadiusNode,
  BlastRadiusOptions,
  BuildOptions,
  BuildResult,
  QueryPattern,
  QueryResult,
  CodeGraphStats,
  AnalyzerPlugin,
  ParseResult,
  ImpactOrigin,
  RankedImpactFile,
  CoChangeNeighbor,
  CoChangePair,
  CoChangeResult,
  CoChangeLookup,
  CoChangeBuildSummary,
  CoChangeMeta,
  CoChangeTuning,
  FreshnessCounts,
  FreshnessReport,
  RefreshOptions,
} from './types.js';
export { detectDrift, RACY_WINDOW_MS } from './freshness.js';
export type { DriftReport, FileStamp } from './freshness.js';
export { acquireLock, tryAcquireLock, LOCK_STALE_MS } from './lock.js';
export type { LockHandle, LockOptions } from './lock.js';
export { NodeKind, EdgeKind } from './types.js';
