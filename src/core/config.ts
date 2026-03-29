import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';
import {
  DEFAULT_MODEL,
  AMBIGUITY_THRESHOLD,
  MAX_INTERVIEW_ROUNDS,
  DRIFT_THRESHOLD,
  EVOLVE_SUCCESS_THRESHOLD,
  EVOLVE_GOAL_ALIGNMENT_THRESHOLD,
} from './constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, '..', '..');
const GLOBAL_DB_PATH = resolve(homedir(), '.gestalt', 'events.db');

// ─── Zod Schemas ────────────────────────────────────────────────

const llmConfigSchema = z.object({
  apiKey: z.string().default(''),
  model: z.string().default(DEFAULT_MODEL),
});

const interviewConfigSchema = z.object({
  ambiguityThreshold: z.number().min(0).max(1).default(AMBIGUITY_THRESHOLD),
  maxRounds: z.number().int().positive().default(MAX_INTERVIEW_ROUNDS),
});

const executeConfigSchema = z.object({
  driftThreshold: z.number().min(0).max(1).default(DRIFT_THRESHOLD),
  successThreshold: z.number().min(0).max(1).default(EVOLVE_SUCCESS_THRESHOLD),
  goalAlignmentThreshold: z.number().min(0).max(1).default(EVOLVE_GOAL_ALIGNMENT_THRESHOLD),
});

const configSchema = z.object({
  llm: llmConfigSchema.default({}),
  interview: interviewConfigSchema.default({}),
  execute: executeConfigSchema.default({}),
  notifications: z.boolean().default(false),
  dbPath: z.string().default(GLOBAL_DB_PATH),
  skillsDir: z.string().default('skills'),
  agentsDir: z.string().default('agents'),
  roleAgentsDir: z.string().default('role-agents'),
  reviewAgentsDir: z.string().default('review-agents'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type GestaltConfig = z.infer<typeof configSchema>;

// ─── Internal Utilities ─────────────────────────────────────────

/**
 * Resolve a directory path:
 * 1. Absolute path → use as-is
 * 2. CWD-relative → if exists, use it
 * 3. Fallback to package root (for plugin/npm install environments)
 */
function resolveDir(dir: string): string {
  if (isAbsolute(dir)) return dir;

  const cwdResolved = resolve(dir);
  if (existsSync(cwdResolved)) return cwdResolved;

  return resolve(PACKAGE_ROOT, dir);
}

/**
 * Deep merge two objects. Source values override target values.
 * Only merges plain objects — arrays and primitives are replaced.
 */
function deepMerge<T extends Record<string, unknown>>(target: T, source: Record<string, unknown>): T {
  const result = { ...target } as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = result[key];
    if (
      sv !== null && typeof sv === 'object' && !Array.isArray(sv) &&
      tv !== null && typeof tv === 'object' && !Array.isArray(tv)
    ) {
      result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>);
    } else if (sv !== undefined) {
      result[key] = sv;
    }
  }
  return result as T;
}

/**
 * Load gestalt.json from CWD. Returns empty object if not found.
 */
function loadGestaltJson(): Record<string, unknown> {
  const filePath = resolve('gestalt.json');
  if (!existsSync(filePath)) return {};

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    // Strip $schema key — not a config field
    const { $schema: _, ...rest } = parsed;
    return rest;
  } catch {
    console.error('[gestalt] Warning: Failed to parse gestalt.json, using defaults');
    return {};
  }
}

/**
 * Load .env file via dotenv. Does not override existing env vars.
 */
function loadDotEnv(): void {
  dotenvConfig(); // loads .env, respects existing env vars
}

/**
 * Extract GESTALT_* and ANTHROPIC_API_KEY from process.env → nested config structure.
 * Only includes keys that are actually set.
 */
function buildEnvConfig(): Record<string, unknown> {
  const env = process.env;
  const result: Record<string, unknown> = {};

  // llm
  const llm: Record<string, unknown> = {};
  if (env['ANTHROPIC_API_KEY'] !== undefined) llm.apiKey = env['ANTHROPIC_API_KEY'];
  if (env['GESTALT_MODEL'] !== undefined) llm.model = env['GESTALT_MODEL'];
  if (Object.keys(llm).length > 0) result.llm = llm;

  // interview
  const interview: Record<string, unknown> = {};
  if (env['GESTALT_AMBIGUITY_THRESHOLD'] !== undefined) {
    interview.ambiguityThreshold = Number(env['GESTALT_AMBIGUITY_THRESHOLD']);
  }
  if (env['GESTALT_MAX_ROUNDS'] !== undefined) {
    interview.maxRounds = Number(env['GESTALT_MAX_ROUNDS']);
  }
  if (Object.keys(interview).length > 0) result.interview = interview;

  // execute
  const execute: Record<string, unknown> = {};
  if (env['GESTALT_DRIFT_THRESHOLD'] !== undefined) {
    execute.driftThreshold = Number(env['GESTALT_DRIFT_THRESHOLD']);
  }
  if (env['GESTALT_EVOLVE_SUCCESS_THRESHOLD'] !== undefined) {
    execute.successThreshold = Number(env['GESTALT_EVOLVE_SUCCESS_THRESHOLD']);
  }
  if (env['GESTALT_EVOLVE_GOAL_ALIGNMENT_THRESHOLD'] !== undefined) {
    execute.goalAlignmentThreshold = Number(env['GESTALT_EVOLVE_GOAL_ALIGNMENT_THRESHOLD']);
  }
  if (Object.keys(execute).length > 0) result.execute = execute;

  // notifications
  if (env['GESTALT_NOTIFICATIONS'] !== undefined) {
    result.notifications = env['GESTALT_NOTIFICATIONS'] === 'true';
  }

  // top-level
  if (env['GESTALT_DB_PATH'] !== undefined) result.dbPath = env['GESTALT_DB_PATH'];
  if (env['GESTALT_SKILLS_DIR'] !== undefined) result.skillsDir = env['GESTALT_SKILLS_DIR'];
  if (env['GESTALT_AGENTS_DIR'] !== undefined) result.agentsDir = env['GESTALT_AGENTS_DIR'];
  if (env['GESTALT_ROLE_AGENTS_DIR'] !== undefined) result.roleAgentsDir = env['GESTALT_ROLE_AGENTS_DIR'];
  if (env['GESTALT_REVIEW_AGENTS_DIR'] !== undefined) result.reviewAgentsDir = env['GESTALT_REVIEW_AGENTS_DIR'];
  if (env['GESTALT_LOG_LEVEL'] !== undefined) result.logLevel = env['GESTALT_LOG_LEVEL'];

  return result;
}

// ─── Public API ─────────────────────────────────────────────────

export function loadConfig(overrides: Partial<Record<string, unknown>> = {}, options?: { skipDotEnv?: boolean }): GestaltConfig {
  // 1. Load .env (does not override existing env vars)
  if (!options?.skipDotEnv) {
    loadDotEnv();
  }

  // 2. Load gestalt.json
  const jsonConfig = loadGestaltJson();

  // 3. Build env config from process.env
  const envConfig = buildEnvConfig();

  // 4. Merge: defaults ← gestalt.json ← envConfig ← overrides
  const merged = deepMerge(
    deepMerge(jsonConfig, envConfig),
    overrides as Record<string, unknown>,
  );

  // 5. Validate with Zod — warn + fallback on invalid values
  const result = configSchema.safeParse(merged);
  if (!result.success) {
    const messages = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    console.error(`[gestalt] Warning: Invalid configuration, using defaults for invalid fields:\n${messages.join('\n')}`);
    // Fallback: parse empty to get all defaults, then overlay what we can
    return applyPostProcessing(configSchema.parse({}));
  }

  return applyPostProcessing(result.data);
}

function applyPostProcessing(config: GestaltConfig): GestaltConfig {
  config.skillsDir = resolveDir(config.skillsDir);
  config.agentsDir = resolveDir(config.agentsDir);
  config.roleAgentsDir = resolveDir(config.roleAgentsDir);
  config.reviewAgentsDir = resolveDir(config.reviewAgentsDir);
  return config;
}

// Re-export for testing
export { deepMerge as _deepMerge, loadGestaltJson as _loadGestaltJson, buildEnvConfig as _buildEnvConfig };
