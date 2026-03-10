import { z } from 'zod';
import { DEFAULT_MODEL, AMBIGUITY_THRESHOLD, MAX_INTERVIEW_ROUNDS } from './constants.js';
import { ConfigError } from './errors.js';

const configSchema = z.object({
  anthropicApiKey: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  model: z.string().default(DEFAULT_MODEL),
  ambiguityThreshold: z.number().min(0).max(1).default(AMBIGUITY_THRESHOLD),
  maxInterviewRounds: z.number().int().positive().default(MAX_INTERVIEW_ROUNDS),
  dbPath: z.string().default('.gestalt/events.db'),
  skillsDir: z.string().default('skills'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type GestaltConfig = z.infer<typeof configSchema>;

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

  return result.data;
}
