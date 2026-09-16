export {
  BYPASS_LABEL,
  cssBypasses,
  detectBypasses,
  styleBypasses,
  type Bypass,
  type BypassRule,
} from './detectors.js';
export { zoneOf, type Zone, type ZoneOptions } from './scope.js';
export { findDuplicates, type DuplicateHit, type DuplicateInput } from './duplicates.js';
export { componentNameOf, nameSet, normalizeName, type DesignInventory } from './tokens.js';
export {
  hasBlockingGap,
  resolveInventory,
  type InventoryOptions,
  type ResolvedInventory,
} from './inventory.js';
export { runDesignCheck, type RunOptions } from './run.js';
export {
  EXIT_CODE,
  exitCodeOf,
  formatReport,
  judge,
  type DesignReport,
  type FileFinding,
  type JudgeInput,
  type Verdict,
} from './check.js';
