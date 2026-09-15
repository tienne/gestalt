import { readFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';
import { gestaltPath } from './home.js';
import {
  DEFAULT_MODEL,
  DEFAULT_REASONING_MODEL,
  DEFAULT_TIER_MODELS,
  REASONING_MODEL_FALLBACK,
  RESOLUTION_THRESHOLD,
  MAX_INTERVIEW_ROUNDS,
  DRIFT_THRESHOLD,
  EVOLVE_SUCCESS_THRESHOLD,
  EVOLVE_GOAL_ALIGNMENT_THRESHOLD,
} from './constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, '..', '..');

// ─── Zod Schemas ────────────────────────────────────────────────

const llmTierConfigSchema = z.object({
  provider: z.enum(['anthropic', 'openai']),
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
  model: z.string(),
});

export type LLMTierConfig = z.infer<typeof llmTierConfigSchema>;

const llmConfigSchema = z.object({
  apiKey: z.string().default(''),
  model: z.string().default(DEFAULT_MODEL),
  frugal: llmTierConfigSchema.optional(),
  standard: llmTierConfigSchema.optional(),
  frontier: llmTierConfigSchema.optional(),
});

const interviewConfigSchema = z.object({
  resolutionThreshold: z.number().min(0).max(1).default(RESOLUTION_THRESHOLD),
  maxRounds: z.number().int().positive().default(MAX_INTERVIEW_ROUNDS),
});

const executeConfigSchema = z.object({
  driftThreshold: z.number().min(0).max(1).default(DRIFT_THRESHOLD),
  successThreshold: z.number().min(0).max(1).default(EVOLVE_SUCCESS_THRESHOLD),
  goalAlignmentThreshold: z.number().min(0).max(1).default(EVOLVE_GOAL_ALIGNMENT_THRESHOLD),
});

/** 호스트 Agent 도구가 받는 모델 별칭. API 모델 ID(llm.model)와는 층위가 다르다. */
const agentModelAliasSchema = z.enum(['fable', 'opus', 'sonnet', 'haiku']);
const reasoningModelSchema = agentModelAliasSchema;

/**
 * 레포 밖에 있는 규칙 소스. 게슈탈트도 대상 레포도 소유하지 않은 기준을 가리킨다.
 *
 * 선언된 것만 읽는다 — 붙어 있는 MCP를 훑어 고르면 무엇을 근거로 삼았는지 사라진다.
 * 적용 규칙은 `plugin/skills/_shared/rule-sources.md`가 원본이다.
 */
const ruleSourceSchema = z.object({
  /** 보고에 쓰는 이름. 레포 안에서 고유해야 한다 */
  id: z.string().min(1),
  kind: z.enum(['mcp', 'file', 'skill']),
  /** kind별 대상 — mcp면 도구 이름, file이면 경로, skill이면 스킬 이름 */
  ref: z.string().min(1),
  /** 이 태그가 걸린 작업에서만 읽는다. 비면 항상 읽는다 */
  scope: z.array(z.string()).default([]),
  /** convention=형식을 따른다, delegate=그 작업을 넘긴다 */
  trust: z.enum(['convention', 'delegate']).default('convention'),
  /** 못 읽었을 때. warn 이상은 결과에 남는다 */
  onMissing: z.enum(['skip', 'warn', 'stop']).default('warn'),
});

export type RuleSource = z.infer<typeof ruleSourceSchema>;

/** 에이전트 tier를 Agent 도구 model 별칭으로 옮기는 표 */
const tierModelsSchema = z.object({
  frugal: agentModelAliasSchema.default(DEFAULT_TIER_MODELS.frugal),
  standard: agentModelAliasSchema.default(DEFAULT_TIER_MODELS.standard),
  frontier: agentModelAliasSchema.default(DEFAULT_TIER_MODELS.frontier),
});

const configSchema = z.object({
  llm: llmConfigSchema.default({}),
  interview: interviewConfigSchema.default({}),
  execute: executeConfigSchema.default({}),
  reasoningModel: reasoningModelSchema.default(DEFAULT_REASONING_MODEL),
  reasoningModelFallback: reasoningModelSchema.default(REASONING_MODEL_FALLBACK),
  tierModels: tierModelsSchema.default({}),
  ruleSources: z
    .array(ruleSourceSchema)
    // id가 겹치면 "어느 기준으로 작업했나" 보고에서 둘을 구분할 수 없다
    .refine((s) => new Set(s.map((r) => r.id)).size === s.length, {
      message: 'ruleSources[].id는 서로 달라야 합니다',
    })
    .default([]),
  /**
   * ruleSources 선언이 깨졌을 때 그 이유. 사용자가 쓰는 필드가 아니라 loadConfig가 채운다.
   * 비어 있지 않으면 선언은 있었는데 못 읽은 상태이므로 스킬은 진행하지 않는다.
   */
  ruleSourceErrors: z.array(z.string()).default([]),
  notifications: z.boolean().default(false),
  // 상수가 아니라 함수다. 모듈을 읽을 때 굳히면 테스트 setupFiles가 GESTALT_HOME을
  // 세우기 전에 값이 정해져서 진짜 홈을 가리킨다
  dbPath: z.string().default(() => gestaltPath('events.db')),
  skillsDir: z.string().default('plugin/skills'),
  agentsDir: z.string().default('plugin/agents'),
  roleAgentsDir: z.string().default('plugin/role-agents'),
  reviewAgentsDir: z.string().default('plugin/review-agents'),
  personasDir: z.string().default('plugin/personas'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  client: z.enum(['claude-code', 'codex', 'both', 'grok']).default('claude-code'),
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
function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Record<string, unknown>,
): T {
  const result = { ...target } as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = result[key];
    if (
      sv !== null &&
      typeof sv === 'object' &&
      !Array.isArray(sv) &&
      tv !== null &&
      typeof tv === 'object' &&
      !Array.isArray(tv)
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
  dotenvConfig({ quiet: true }); // loads .env, respects existing env vars
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

  // tier-level env overrides: GESTALT_LLM_<TIER>_PROVIDER, _API_KEY, _BASE_URL, _MODEL
  for (const tier of ['frugal', 'standard', 'frontier'] as const) {
    const prefix = `GESTALT_LLM_${tier.toUpperCase()}`;
    const provider = env[`${prefix}_PROVIDER`];
    const tierApiKey = env[`${prefix}_API_KEY`];
    const baseURL = env[`${prefix}_BASE_URL`];
    const model = env[`${prefix}_MODEL`];
    if (provider || tierApiKey || baseURL || model) {
      const tierCfg: Record<string, string> = {};
      if (provider) tierCfg.provider = provider;
      if (tierApiKey) tierCfg.apiKey = tierApiKey;
      if (baseURL) tierCfg.baseURL = baseURL;
      if (model) tierCfg.model = model;
      llm[tier] = tierCfg;
    }
  }

  if (Object.keys(llm).length > 0) result.llm = llm;

  // interview
  const interview: Record<string, unknown> = {};
  if (env['GESTALT_RESOLUTION_THRESHOLD'] !== undefined) {
    interview.resolutionThreshold = Number(env['GESTALT_RESOLUTION_THRESHOLD']);
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
  if (env['GESTALT_REASONING_MODEL'] !== undefined)
    result.reasoningModel = env['GESTALT_REASONING_MODEL'];
  if (env['GESTALT_REASONING_MODEL_FALLBACK'] !== undefined)
    result.reasoningModelFallback = env['GESTALT_REASONING_MODEL_FALLBACK'];

  const tierModels: Record<string, string> = {};
  for (const tier of ['frugal', 'standard', 'frontier'] as const) {
    const value = env[`GESTALT_TIER_MODEL_${tier.toUpperCase()}`];
    if (value !== undefined) tierModels[tier] = value;
  }
  if (Object.keys(tierModels).length > 0) result.tierModels = tierModels;

  if (env['GESTALT_DB_PATH'] !== undefined) result.dbPath = env['GESTALT_DB_PATH'];
  if (env['GESTALT_SKILLS_DIR'] !== undefined) result.skillsDir = env['GESTALT_SKILLS_DIR'];
  if (env['GESTALT_AGENTS_DIR'] !== undefined) result.agentsDir = env['GESTALT_AGENTS_DIR'];
  if (env['GESTALT_ROLE_AGENTS_DIR'] !== undefined)
    result.roleAgentsDir = env['GESTALT_ROLE_AGENTS_DIR'];
  if (env['GESTALT_REVIEW_AGENTS_DIR'] !== undefined)
    result.reviewAgentsDir = env['GESTALT_REVIEW_AGENTS_DIR'];
  if (env['GESTALT_PERSONAS_DIR'] !== undefined) result.personasDir = env['GESTALT_PERSONAS_DIR'];
  if (env['GESTALT_LOG_LEVEL'] !== undefined) result.logLevel = env['GESTALT_LOG_LEVEL'];
  if (env['GESTALT_CLIENT'] !== undefined) result.client = env['GESTALT_CLIENT'];

  return result;
}

function cloneRecord(input: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeInvalidPath(path: (string | number)[]): (string | number)[] {
  if (
    path[0] === 'llm' &&
    typeof path[1] === 'string' &&
    ['frugal', 'standard', 'frontier'].includes(path[1]) &&
    path.length > 2
  ) {
    return ['llm', path[1]];
  }
  return path;
}

function removePath(root: Record<string, unknown>, rawPath: (string | number)[]): boolean {
  const path = normalizeInvalidPath(rawPath);
  if (path.length === 0) return false;

  let current: unknown = root;
  for (const segment of path.slice(0, -1)) {
    if (!isRecord(current)) return false;
    current = current[String(segment)];
  }

  if (!isRecord(current)) return false;
  const finalSegment = String(path[path.length - 1]);
  if (!(finalSegment in current)) return false;
  delete current[finalSegment];
  return true;
}

function pruneInvalidConfig(
  input: Record<string, unknown>,
  paths: (string | number)[][],
): Record<string, unknown> {
  const pruned = cloneRecord(input);
  for (const path of paths) {
    removePath(pruned, path);
  }
  return pruned;
}

// ─── Public API ─────────────────────────────────────────────────

export function loadConfig(
  overrides: Partial<Record<string, unknown>> = {},
  options?: { skipDotEnv?: boolean; skipGestaltJson?: boolean },
): GestaltConfig {
  // 1. Load .env (does not override existing env vars)
  if (!options?.skipDotEnv) {
    loadDotEnv();
  }

  // 2. Load gestalt.json
  const jsonConfig = options?.skipGestaltJson ? {} : loadGestaltJson();

  // 3. Build env config from process.env
  const envConfig = buildEnvConfig();

  // 4. Merge: defaults ← gestalt.json ← envConfig ← overrides
  const merged = deepMerge(deepMerge(jsonConfig, envConfig), overrides as Record<string, unknown>);

  // 5. Validate with Zod — warn + fallback on invalid values
  const result = configSchema.safeParse(merged);
  if (!result.success) {
    const messages = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    console.error(
      `[gestalt] Warning: Invalid configuration, using defaults for invalid fields:\n${messages.join('\n')}`,
    );
    const pruned = pruneInvalidConfig(
      merged,
      result.error.issues.map((issue) => issue.path),
    );
    const brokenRuleSources = messages.filter((m) => m.startsWith('ruleSources'));
    const recovered = configSchema.safeParse(pruned);
    if (recovered.success) {
      return applyPostProcessing(withRuleSourceErrors(recovered.data, brokenRuleSources));
    }

    console.error('[gestalt] Warning: Failed to recover configuration, using defaults');
    return applyPostProcessing(withRuleSourceErrors(configSchema.parse({}), brokenRuleSources));
  }

  return applyPostProcessing(result.data);
}

/**
 * 깨진 ruleSources 선언을 config에 실어 보낸다.
 *
 * 잘못된 항목 하나면 zod가 ruleSources 배열을 통째로 기본값(빈 배열)으로 되돌린다.
 * 그 상태를 그냥 두면 스킬 쪽에서 "선언 안 한 레포"와 구분할 수 없어, 오타 하나가
 * onMissing: "stop" 게이트까지 조용히 끄는 우회로가 된다. 그래서 왜 비었는지를
 * 함께 싣고 스킬이 멈출 수 있게 한다.
 */
function withRuleSourceErrors(config: GestaltConfig, errors: string[]): GestaltConfig {
  if (errors.length > 0) config.ruleSourceErrors = errors;
  return config;
}

function applyPostProcessing(config: GestaltConfig): GestaltConfig {
  config.skillsDir = resolveDir(config.skillsDir);
  config.agentsDir = resolveDir(config.agentsDir);
  config.roleAgentsDir = resolveDir(config.roleAgentsDir);
  config.reviewAgentsDir = resolveDir(config.reviewAgentsDir);
  config.personasDir = resolveDir(config.personasDir);
  return config;
}

// Re-export for testing
export {
  deepMerge as _deepMerge,
  loadGestaltJson as _loadGestaltJson,
  buildEnvConfig as _buildEnvConfig,
};
