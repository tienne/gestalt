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
 * 레포 안이어도 기준 문서일 리 없는 자리.
 *
 * 레포 밖을 막는 검사만으로는 부족하다. 남의 레포를 검사하러 들어갔을 때 그쪽
 * gestalt.json 이 자기 `.env` 를 "조직 컨벤션"으로 선언하면, 스킬이 그걸 읽어
 * "적용한 기준"으로 보고에 옮겨 적는다.
 *
 * 한 줄짜리 정규식으로 두면 항목을 더할 때마다 읽기 어려워져서 배열로 나눠 둔다.
 */
const SECRET_FILE_REFS = [
  // .env, .env.local, prod.env. env.md 처럼 env 를 설명하는 문서는 안 걸린다
  /(^|\/)(\.env(\.[^/]*)?|[^/]*\.env)$/i,
  /(^|\/)\.(git|ssh|aws|kube|docker|gnupg)\//i,
  /(^|\/)(\.npmrc|\.netrc|\.pgpass|\.envrc|\.htpasswd)$/i,
  // 뒤에 .pub 까지만 붙는다. id_rsa-rotation.md 같은 설명 문서는 안 걸린다
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p8|p12|pfx|der|cer|ppk|jks|keystore|kdbx)$/i,
  /(^|\/)(credentials|secrets?)(\.(json|ya?ml|toml))?$/i,
];

/**
 * 위 목록에 걸려도 통과시키는 자리.
 *
 * `.env.example` 은 값이 아니라 **키 목록**이라 레포에 커밋된다. 무엇을 채워야 하는지
 * 적힌 파일이라 규칙 소스로 선언할 이유가 오히려 크다.
 */
const SECRET_FILE_ALLOW = /(^|\/)[^/]*\.env\.(example|sample|template|dist)$/i;

/**
 * 위 목록에 걸기 전에 경로를 맞춘다.
 *
 * 구분자를 통일하는 건 위의 `..` 검사가 두 꼴을 다 받기 때문이다. 조각 끝의 점을
 * 떼는 건 윈도우가 그걸 떼고 파일을 열기 때문이다 — `".env."` 를 그대로 두면 목록에는
 * 안 걸리는데 실제로는 `.env` 가 열린다. 공백은 INVISIBLE_IN_REF 가 앞에서 막는다.
 */
function isSecretRef(ref: string): boolean {
  return !SECRET_FILE_ALLOW.test(ref) && SECRET_FILE_REFS.some((pattern) => pattern.test(ref));
}

function normalizeRefForMatch(ref: string): string {
  return ref
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.replace(/\.+$/, ''))
    .join('/');
}

/**
 * 보고 화면에 그대로 찍히는 값에서 막을 문자.
 *
 * 이름 꼴을 영숫자로 좁히면 한글 id 를 쓰는 레포가 깨진다. 막아야 하는 건 글자
 * 종류가 아니라 **줄이나 칸을 새로 만드는 문자**다 — 그게 섞이면 대상 레포가 쓴
 * 값이 게슈탈트가 쓴 줄처럼 보인다. 제어문자는 줄을, 백틱은 코드 블록을,
 * 세로줄은 표의 칸을 연다. 기울임 같은 나머지 서식은 그렇게 못 하므로 안 막는다.
 */
const UNSAFE_IN_REPORT = /[\p{C}`|]/u;

/**
 * ref 에서 통째로 거부할 문자.
 *
 * 공백을 막는 건 검사하는 값과 여는 값을 같게 만들기 위해서다. 보이지 않는 문자는
 * `\p{C}` 가 대부분 잡지만 U+200B 처럼 판이 갈리는 자리가 있어 범위로 직접 적는다.
 * 규칙 문서의 경로에 이 문자들이 들어갈 일은 없다.
 */
const INVISIBLE_IN_REF =
  // eslint-disable-next-line no-control-regex
  /[\s\u0000-\u001F\u007F\u00A0\u180E\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/;

/** MCP 도구 이름 꼴 */
const MCP_REF = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** 스킬 이름 꼴. `review` 와 `gestalt:review` 를 받는다 */
const SKILL_REF = /^[a-z0-9][a-z0-9-]*(:[a-z0-9][a-z0-9-]*)?$/;

/**
 * 레포 밖에 있는 규칙 소스. 게슈탈트도 대상 레포도 소유하지 않은 기준을 가리킨다.
 *
 * 선언된 것만 읽는다 — 붙어 있는 MCP를 훑어 고르면 무엇을 근거로 삼았는지 사라진다.
 * 적용 규칙은 `plugin/skills/_shared/rule-sources.md`가 원본이다.
 */
const ruleSourceSchema = z
  .object({
    /** 보고에 쓰는 이름. 레포 안에서 고유해야 한다 */
    id: z.string().min(1).max(64),
    kind: z.enum(['mcp', 'file', 'skill']),
    /**
     * kind별 대상 — mcp면 도구 이름, file이면 경로, skill이면 스킬 이름.
     *
     * 상한이 있는 건 이 값이 ges_status 응답으로 매번 실려 나가서다. 넘으면 자르지
     * 않고 거부한다 — 자른 ref 는 스킬이 가진 유일한 ref 라, 읽기에 실패한 뒤
     * onMissing 을 타고 조용히 지나간다. 거부하면 ruleSourceErrors 로 드러난다
     */
    ref: z.string().min(1).max(512),
    /** 이 태그가 걸린 작업에서만 읽는다. 비면 항상 읽는다 */
    scope: z.array(z.string().min(1).max(32)).max(16).default([]),
    /** convention=형식을 따른다, delegate=그 작업을 넘긴다 */
    trust: z.enum(['convention', 'delegate']).default('convention'),
    /** 못 읽었을 때. warn 이상은 결과에 남는다 */
    onMissing: z.enum(['skip', 'warn', 'stop']).default('warn'),
    // strict 다. 모르는 키를 조용히 버리면 onMising 같은 오타가 기본값으로 떨어져
    // stop 으로 걸어둔 검사가 warn 으로 강등된 사실을 어디서도 알 수 없다.
    // JSON 스키마의 additionalProperties: false 와 같은 선이다
  })
  .strict()
  .superRefine((source, ctx) => {
    // 아래 세 검사가 전부 문자열을 그대로 본다. 그런데 이 값을 실제로 여는 주체는
    // fs 가 아니라 에이전트라 눈에 안 보이는 문자를 다듬어서 연다. `" /etc/passwd"` 는
    // 앞 공백 때문에 isAbsolute 가 false 다. `".. /x"` 는 조각이 `".. "` 라 .. 검사에
    // 안 걸린다. 다듬는 쪽과 검사하는 쪽이 다른 값을 보면 경계가 거기서 열린다.
    // 그래서 그런 문자가 들어 있으면 검사하기 전에 거부한다
    if (INVISIBLE_IN_REF.test(source.ref)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ref'],
        message: 'ref 에는 공백이나 눈에 보이지 않는 문자를 넣을 수 없습니다',
      });
      return;
    }

    // ref 는 코드가 읽기 전에 에이전트가 읽는다. rule-sources.md 가 선언된 소스를
    // 읽고 결과 보고에 남기라고 지시하므로, 적대적인 gestalt.json 이 레포 밖 비밀
    // 파일을 "조직 컨벤션"으로 선언하면 그게 보고에 실리는 경로가 열린다
    if (source.kind === 'file') {
      if (isAbsolute(source.ref)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ref'],
          message: 'file 소스의 ref 는 레포 기준 상대 경로여야 합니다',
        });
      } else if (source.ref.split(/[/\\]/).includes('..')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ref'],
          message: 'file 소스의 ref 는 레포 밖을 가리킬 수 없습니다',
        });
      } else if (isSecretRef(normalizeRefForMatch(source.ref))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ref'],
          message: 'file 소스의 ref 로 자격 증명이 담기는 자리를 가리킬 수 없습니다',
        });
      }
    }

    if (UNSAFE_IN_REPORT.test(source.id) || source.id !== source.id.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['id'],
        message: 'id 에는 제어문자나 마크다운 기호를 쓸 수 없습니다',
      });
    }

    // 이름 꼴만 본다. 이 도구가 읽기인지 쓰기인지는 코드가 알 방법이 없어서
    // rule-sources.md 가 "쓰기 도구면 부르지 않고 사용자에게 알린다"로 받는다
    if (source.kind === 'mcp' && !MCP_REF.test(source.ref)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ref'],
        message: 'mcp 소스의 ref 는 도구 이름이어야 합니다',
      });
    }
    if (source.kind === 'skill' && !SKILL_REF.test(source.ref)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ref'],
        message: 'skill 소스의 ref 는 스킬 이름이어야 합니다',
      });
    }

    // delegate 는 "이 작업을 저 스킬이 맡는다"는 뜻이라 kind 가 skill 이어야 성립한다.
    // mcp 나 file 에 붙으면 무엇을 넘기라는 것인지 정의된 자리가 없다
    if (source.trust === 'delegate' && source.kind !== 'skill') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['trust'],
        message: 'delegate 는 kind 가 skill 일 때만 쓸 수 있습니다',
      });
    }
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
    // 손으로 적는 선언이라 이 정도면 넉넉하다. 상한이 없으면 선언 수가 그대로
    // 매 ges_status 응답 크기가 된다
    .max(32)
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
  /**
   * 선언이 깨지진 않았는데 짚어줄 게 있을 때. 마찬가지로 loadConfig가 채운다.
   *
   * **멈춤 사유와 한 필드에 담지 않는다.** 담으면 탐지기를 한 번 넓힐 때마다 그게
   * 세션을 세우는 레버가 된다 — 실제로 키 이름 오타 탐지를 넓혔더니 `resources` 같은
   * 남의 키 하나로 스킬 다섯 자리가 전부 멈췄다. 확실하지 않은 판정은 여기로 온다.
   */
  ruleSourceWarnings: z.array(z.string()).default([]),
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

  // 배열 원소 안의 필드가 잘못되면 그 원소를 통째로 뺀다. 필드만 지우면 남은 원소가
  // required 검사에 다시 걸려 복구가 실패한다. 그러면 설정 전체가 기본값으로 떨어진다
  const firstIndex = path.findIndex((segment) => typeof segment === 'number');
  if (firstIndex >= 0 && firstIndex < path.length - 1) {
    return path.slice(0, firstIndex + 1);
  }

  return path;
}

/**
 * 잘못된 값 하나를 걷어낸다. 걷어내면 나머지 설정이 기본값으로 안 되돌아간다.
 *
 * 배열 원소는 그 자리에서 빼지 않고 인덱스만 모은다. 한 원소에 잘못된 필드가 둘이면
 * zod가 issue를 둘 내고 둘 다 같은 원소를 가리키는데, 받는 대로 빼면 두 번째가 이미
 * 당겨진 배열의 옆 원소를 지운다. 그래서 전부 모은 뒤 한 번에 걸러낸다.
 */
function removePath(
  root: Record<string, unknown>,
  path: (string | number)[],
  arrayDrops: Map<unknown[], Set<number>>,
): boolean {
  if (path.length === 0) return false;

  let current: unknown = root;
  for (const segment of path.slice(0, -1)) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return false;
      current = current[index];
      continue;
    }
    if (!isRecord(current)) return false;
    current = current[String(segment)];
  }

  const finalSegment = path[path.length - 1]!;

  if (Array.isArray(current)) {
    const index = Number(finalSegment);
    if (!Number.isInteger(index) || index < 0 || index >= current.length) return false;
    const drops = arrayDrops.get(current) ?? new Set<number>();
    drops.add(index);
    arrayDrops.set(current, drops);
    return true;
  }

  if (!isRecord(current)) return false;
  const key = String(finalSegment);
  if (!(key in current)) return false;
  delete current[key];
  return true;
}

function pruneInvalidConfig(
  input: Record<string, unknown>,
  paths: (string | number)[][],
): Record<string, unknown> {
  const pruned = cloneRecord(input);

  // 정규화한 뒤 같은 자리를 가리키는 경로를 하나로 접는다. 접지 않으면 한 원소의
  // 필드 둘이 각각 삭제를 요구해 옆 원소까지 빠진다
  const unique = new Map<string, (string | number)[]>();
  for (const path of paths) {
    const normalized = normalizeInvalidPath(path);
    unique.set(JSON.stringify(normalized), normalized);
  }

  const arrayDrops = new Map<unknown[], Set<number>>();
  for (const path of unique.values()) {
    removePath(pruned, path, arrayDrops);
  }

  // 배열은 마지막에 한 번만 걸러낸다. 인덱스가 당겨지지 않으니 순서를 맞출 필요가 없다.
  // 되돌릴 때 스프레드를 안 쓰는 건 원소 수가 그대로 인자 개수가 되기 때문이다.
  // ruleSources 는 상한이 32라 이 경로로는 안 닿지만 여기는 설정 전체를 받는 자리다
  for (const [array, drops] of arrayDrops) {
    const kept = array.filter((_, index) => !drops.has(index));
    array.length = kept.length;
    for (let i = 0; i < kept.length; i++) array[i] = kept[i];
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

  // ruleSourceErrors 는 로더가 채우는 출력이다. 스킬 여러 자리가 "비어 있지 않으면
  // 멈춘다"로 읽으므로, 작성자가 적은 값을 살려두면 gestalt.json 한 줄로 파이프라인을
  // 세우거나 게슈탈트 경고를 사칭할 수 있다
  delete merged.ruleSourceErrors;
  delete merged.ruleSourceWarnings;

  // 이름이 비슷하다는 건 정황이지 선언이 깨졌다는 증거가 아니다. 경고로 간다
  const misspelled = findMisspelledRuleSourcesKey(jsonConfig);
  const declared = Array.isArray(merged.ruleSources) && merged.ruleSources.length > 0;

  // 5. Validate with Zod — warn + fallback on invalid values
  const result = configSchema.safeParse(merged);
  if (!result.success) {
    const messages = result.error.issues.map(
      (i) => `${describeIssuePath(i.path, merged)}: ${i.message}`,
    );
    console.error(
      `[gestalt] Warning: Invalid configuration, using defaults for invalid fields:\n${messages.join('\n')}`,
    );
    const pruned = pruneInvalidConfig(
      merged,
      result.error.issues.map((issue) => issue.path),
    );
    const broken = messages.filter((m) => m.startsWith('ruleSources'));
    const recovered = configSchema.safeParse(pruned);
    if (recovered.success) {
      return applyPostProcessing(withRuleSourceNotes(recovered.data, broken, misspelled));
    }

    console.error('[gestalt] Warning: Failed to recover configuration, using defaults');
    // 여기서는 ruleSources 가 멀쩡했어도 함께 날아간다. 앞에 세워 두는 건 고칠 자리가
    // 선언 안이 아니라 다른 필드라서다 — 안 적으면 "선언한 적 없는 레포"와 구분이 안 된다
    if (declared) {
      broken.unshift('ruleSources: 설정을 복구하지 못해 선언 전체가 빠졌습니다');
    }
    return applyPostProcessing(withRuleSourceNotes(configSchema.parse({}), broken, misspelled));
  }

  return applyPostProcessing(withRuleSourceNotes(result.data, [], misspelled));
}

/**
 * ruleSources 를 적으려다 키 이름을 틀린 자리를 찾는다.
 *
 * 최상위 스키마는 strict 가 아니다. `$schema` 가 들어와야 하고 예전 gestalt.json 을
 * 쓰는 레포를 깨뜨릴 수도 없다. 그래서 모르는 키는 조용히 버려지는데, 하필 그 키가
 * `ruleSource` 였으면 결과가 `ruleSources: []` 이고 이건 선언을 안 한 레포와 똑같다.
 * onMissing: "stop" 으로 걸어둔 검사가 있었는지조차 아무도 모른 채 지나간다.
 *
 * **이름만으로 판정하지 않는다.** 이 결과가 ruleSourceErrors 로 가고 스킬 다섯 자리가
 * 전부 거기서 멈추므로, 이름이 비슷하다는 것만으로 올리면 남의 레포 JSON 한 줄이
 * 세션을 세우는 자리가 된다. 값이 선언 꼴일 때만 올린다.
 *
 * **gestalt.json 만 본다.** env 는 이 필드를 표현할 방법이 없고 overrides 는 호출한
 * 코드가 만든 값이라 작성자의 오타로 볼 자리가 아니다.
 */
function findMisspelledRuleSourcesKey(jsonConfig: Record<string, unknown>): string[] {
  const known = new Set(Object.keys(configSchema.shape));
  return Object.keys(jsonConfig)
    .filter((key) => !known.has(key))
    .filter((key) => looksLikeRuleSources(key.toLowerCase().replace(/[_-]/g, '')))
    .filter((key) => looksLikeDeclaration(jsonConfig[key]))
    .map(
      (key) =>
        `${JSON.stringify(key.slice(0, 40))}: 모르는 키입니다. ruleSources 를 적으려던 것인지 확인해주세요`,
    );
}

/**
 * 오류 자리를 사람이 따라갈 수 있게 적는다.
 *
 * 인덱스만 적으면 못 따라간다 — 응답에 실리는 `ruleSources` 는 깨진 원소가 빠진 뒤
 * 다시 매겨진 배열이라, `ruleSources.1` 을 세어 보면 멀쩡한 다른 소스를 짚는다.
 * 그래서 원본 원소의 `id` 를 붙인다.
 */
function describeIssuePath(path: (string | number)[], merged: Record<string, unknown>): string {
  const joined = path.join('.');
  if (path[0] !== 'ruleSources' || typeof path[1] !== 'number') return joined;

  const sources = merged['ruleSources'];
  if (!Array.isArray(sources)) return joined;
  const source = sources[path[1]];
  if (!isRecord(source)) return joined;

  // id 가 빠진 것 자체가 흔한 오타라 그때는 ref 로, 그것도 없으면 kind 로 짚는다
  for (const field of ['id', 'ref', 'kind'] as const) {
    const value = source[field];
    if (typeof value === 'string') {
      return `${joined} (${field}: ${JSON.stringify(value.slice(0, 64))})`;
    }
  }
  return joined;
}

/**
 * 선언하려던 값인지 본다. 스칼라 하나가 들어 있으면 오타로 안 본다.
 *
 * 빈 배열은 선언 꼴로 안 본다. `every` 가 true 를 주는 자리라 그냥 두면 `{"resources": []}`
 * 한 줄이 판정을 타고 들어온다 — 어차피 빈 선언은 안 한 것과 결과가 같다.
 */
function looksLikeDeclaration(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((item) => isRecord(item));
}

/**
 * 접두 일치만 보면 `ruleSource` 는 잡아도 `ruleSorces` 같은 자리 바뀜은 놓친다.
 * 두 글자까지 어긋난 것을 같은 의도로 본다.
 */
function looksLikeRuleSources(normalized: string): boolean {
  return normalized === 'rulesource' || editDistanceWithin(normalized, 'rulesources', 2);
}

function editDistanceWithin(a: string, b: string, limit: number): boolean {
  if (Math.abs(a.length - b.length) > limit) return false;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
    }
    // 이 행 전체가 한계를 넘었으면 남은 행도 줄어들지 않는다
    if (Math.min(...current) > limit) return false;
    previous = current;
  }
  return previous[b.length]! <= limit;
}

/**
 * 빠진 ruleSources 선언의 이유와 짚어줄 거리를 config에 실어 보낸다.
 *
 * 잘못된 항목은 prune이 걷어내고 나머지는 살아남는다. 그런데 무엇이 빠졌는지를 안 알리면
 * 스킬 쪽에서 처음부터 선언 안 한 것과 구분할 수 없다. onMissing: "stop"으로 걸어둔
 * 검사가 그 상태로 안 돈 채 지나간다.
 *
 * 둘을 갈라 싣는 건 `errors`만 멈춤 사유이기 때문이다.
 */
function withRuleSourceNotes(
  config: GestaltConfig,
  errors: string[],
  warnings: string[],
): GestaltConfig {
  if (errors.length === 0 && warnings.length === 0) return config;
  return { ...config, ruleSourceErrors: errors, ruleSourceWarnings: warnings };
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
