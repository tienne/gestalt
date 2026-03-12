import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DEFAULT_MODEL, AMBIGUITY_THRESHOLD, MAX_INTERVIEW_ROUNDS, DRIFT_THRESHOLD } from './constants.js';
import { ConfigError } from './errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, '..', '..');
const GLOBAL_DB_PATH = join(homedir(), '.gestalt', 'events.db');

const configSchema = z.object({
  anthropicApiKey: z.string().default(''),
  model: z.string().default(DEFAULT_MODEL),
  ambiguityThreshold: z.number().min(0).max(1).default(AMBIGUITY_THRESHOLD),
  maxInterviewRounds: z.number().int().positive().default(MAX_INTERVIEW_ROUNDS),
  dbPath: z.string().default(GLOBAL_DB_PATH),
  skillsDir: z.string().default('skills'),
  agentsDir: z.string().default('agents'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  driftThreshold: z.number().min(0).max(1).default(DRIFT_THRESHOLD),
});

export type GestaltConfig = z.infer<typeof configSchema>;

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

export function loadConfig(overrides: Partial<Record<string, unknown>> = {}): GestaltConfig {
  const raw = {
    anthropicApiKey: process.env['ANTHROPIC_API_KEY'] ?? '',
    model: process.env['GESTALT_MODEL'] ?? DEFAULT_MODEL,
    ambiguityThreshold: process.env['GESTALT_AMBIGUITY_THRESHOLD']
      ? Number(process.env['GESTALT_AMBIGUITY_THRESHOLD'])
      : AMBIGUITY_THRESHOLD,
    maxInterviewRounds: process.env['GESTALT_MAX_ROUNDS']
      ? Number(process.env['GESTALT_MAX_ROUNDS'])
      : MAX_INTERVIEW_ROUNDS,
    dbPath: process.env['GESTALT_DB_PATH'] ?? GLOBAL_DB_PATH,
    skillsDir: process.env['GESTALT_SKILLS_DIR'] ?? 'skills',
    agentsDir: process.env['GESTALT_AGENTS_DIR'] ?? 'agents',
    logLevel: process.env['GESTALT_LOG_LEVEL'] ?? 'info',
    driftThreshold: process.env['GESTALT_DRIFT_THRESHOLD']
      ? Number(process.env['GESTALT_DRIFT_THRESHOLD'])
      : DRIFT_THRESHOLD,
    ...overrides,
  };

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const messages = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${messages.join('\n')}`);
  }

  const config = result.data;
  config.skillsDir = resolveDir(config.skillsDir);
  config.agentsDir = resolveDir(config.agentsDir);
  return config;
}
