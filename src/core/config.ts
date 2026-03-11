import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DEFAULT_MODEL, AMBIGUITY_THRESHOLD, MAX_INTERVIEW_ROUNDS } from './constants.js';
import { ConfigError } from './errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, '..', '..');

const configSchema = z.object({
  anthropicApiKey: z.string().default(''),
  model: z.string().default(DEFAULT_MODEL),
  ambiguityThreshold: z.number().min(0).max(1).default(AMBIGUITY_THRESHOLD),
  maxInterviewRounds: z.number().int().positive().default(MAX_INTERVIEW_ROUNDS),
  dbPath: z.string().default('.gestalt/events.db'),
  skillsDir: z.string().default('skills'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type GestaltConfig = z.infer<typeof configSchema>;

/**
 * Resolve skills directory path:
 * 1. Absolute path → use as-is
 * 2. CWD-relative → if exists, use it
 * 3. Fallback to package root (for plugin/npm install environments)
 */
function resolveSkillsDir(dir: string): string {
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
    dbPath: process.env['GESTALT_DB_PATH'] ?? '.gestalt/events.db',
    skillsDir: process.env['GESTALT_SKILLS_DIR'] ?? 'skills',
    logLevel: process.env['GESTALT_LOG_LEVEL'] ?? 'info',
    ...overrides,
  };

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const messages = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${messages.join('\n')}`);
  }

  const config = result.data;
  config.skillsDir = resolveSkillsDir(config.skillsDir);
  return config;
}
