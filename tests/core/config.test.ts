import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, _deepMerge, _buildEnvConfig } from '../../src/core/config.js';

// ─── Helpers ────────────────────────────────────────────────────

/** Temporarily change CWD to a given directory for the duration of the callback. */
function withCwd<T>(dir: string, fn: () => T): T {
  const original = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(original);
  }
}

/** Create a unique temp directory under os.tmpdir(). */
function makeTmpDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Env isolation ──────────────────────────────────────────────

const GESTALT_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'GESTALT_MODEL',
  'GESTALT_RESOLUTION_THRESHOLD',
  'GESTALT_MAX_ROUNDS',
  'GESTALT_DB_PATH',
  'GESTALT_SKILLS_DIR',
  'GESTALT_AGENTS_DIR',
  'GESTALT_ROLE_AGENTS_DIR',
  'GESTALT_REVIEW_AGENTS_DIR',
  'GESTALT_PERSONAS_DIR',
  'GESTALT_LOG_LEVEL',
  'GESTALT_CLIENT',
  'GESTALT_DRIFT_THRESHOLD',
  'GESTALT_EVOLVE_SUCCESS_THRESHOLD',
  'GESTALT_EVOLVE_GOAL_ALIGNMENT_THRESHOLD',
  'GESTALT_NOTIFICATIONS',
  'GESTALT_LLM_FRUGAL_PROVIDER',
  'GESTALT_LLM_FRUGAL_API_KEY',
  'GESTALT_LLM_FRUGAL_BASE_URL',
  'GESTALT_LLM_FRUGAL_MODEL',
  'GESTALT_LLM_STANDARD_PROVIDER',
  'GESTALT_LLM_STANDARD_API_KEY',
  'GESTALT_LLM_STANDARD_BASE_URL',
  'GESTALT_LLM_STANDARD_MODEL',
  'GESTALT_LLM_FRONTIER_PROVIDER',
  'GESTALT_LLM_FRONTIER_API_KEY',
  'GESTALT_LLM_FRONTIER_BASE_URL',
  'GESTALT_LLM_FRONTIER_MODEL',
] as const;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of GESTALT_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of GESTALT_ENV_KEYS) {
    const saved = savedEnv[key];
    if (saved === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved;
    }
  }
});

// ─── Shared opts ────────────────────────────────────────────────

/** Skip .env + gestalt.json for pure unit tests */
const isolatedOpts = { skipDotEnv: true, skipGestaltJson: true };

// ─── Default Values ─────────────────────────────────────────────

describe('loadConfig — default values', () => {
  it('returns empty string for llm.apiKey when no env is set', () => {
    const config = loadConfig({}, isolatedOpts);
    expect(config.llm.apiKey).toBe('');
  });

  it('returns default model', () => {
    const config = loadConfig({}, isolatedOpts);
    expect(config.llm.model).toBe('claude-sonnet-4-20250514');
  });

  it('returns default interview settings', () => {
    const config = loadConfig({}, isolatedOpts);
    expect(config.interview.resolutionThreshold).toBe(0.8);
    expect(config.interview.maxRounds).toBe(15);
  });

  it('returns default execute thresholds', () => {
    const config = loadConfig({}, isolatedOpts);
    expect(config.execute.driftThreshold).toBe(0.3);
    expect(config.execute.successThreshold).toBe(0.85);
    expect(config.execute.goalAlignmentThreshold).toBe(0.8);
  });

  it('returns default logLevel = info', () => {
    const config = loadConfig({}, isolatedOpts);
    expect(config.logLevel).toBe('info');
  });

  it('returns default notifications = false', () => {
    const config = loadConfig({}, isolatedOpts);
    expect(config.notifications).toBe(false);
  });

  it('returns default client = claude-code', () => {
    const config = loadConfig({}, isolatedOpts);
    expect(config.client).toBe('claude-code');
  });
});

// ─── gestalt.json Parsing ───────────────────────────────────────

describe('loadConfig — gestalt.json parsing', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir('gestalt-config-test');
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('reads llm.apiKey from gestalt.json', () => {
    writeFileSync(
      join(tmpDir, 'gestalt.json'),
      JSON.stringify({ llm: { apiKey: 'from-json-key' } }),
    );
    const config = withCwd(tmpDir, () => loadConfig({}, { skipDotEnv: true }));
    expect(config.llm.apiKey).toBe('from-json-key');
  });

  it('reads interview thresholds from gestalt.json', () => {
    writeFileSync(
      join(tmpDir, 'gestalt.json'),
      JSON.stringify({ interview: { resolutionThreshold: 0.6, maxRounds: 8 } }),
    );
    const config = withCwd(tmpDir, () => loadConfig({}, { skipDotEnv: true }));
    expect(config.interview.resolutionThreshold).toBe(0.6);
    expect(config.interview.maxRounds).toBe(8);
  });

  it('reads execute thresholds from gestalt.json', () => {
    writeFileSync(
      join(tmpDir, 'gestalt.json'),
      JSON.stringify({
        execute: {
          driftThreshold: 0.4,
          successThreshold: 0.9,
          goalAlignmentThreshold: 0.75,
        },
      }),
    );
    const config = withCwd(tmpDir, () => loadConfig({}, { skipDotEnv: true }));
    expect(config.execute.driftThreshold).toBe(0.4);
    expect(config.execute.successThreshold).toBe(0.9);
    expect(config.execute.goalAlignmentThreshold).toBe(0.75);
  });

  it('strips $schema key from gestalt.json without error', () => {
    writeFileSync(
      join(tmpDir, 'gestalt.json'),
      JSON.stringify({ $schema: './schema.json', logLevel: 'debug' }),
    );
    const config = withCwd(tmpDir, () => loadConfig({}, { skipDotEnv: true }));
    expect(config.logLevel).toBe('debug');
  });

  it('reads dbPath from gestalt.json', () => {
    const customDbPath = join(tmpDir, 'custom.db');
    writeFileSync(join(tmpDir, 'gestalt.json'), JSON.stringify({ dbPath: customDbPath }));
    const config = withCwd(tmpDir, () => loadConfig({}, { skipDotEnv: true }));
    expect(config.dbPath).toBe(customDbPath);
  });
});

// ─── Environment Variable Priority ──────────────────────────────

describe('loadConfig — environment variable priority', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir('gestalt-env-test');
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('env var ANTHROPIC_API_KEY overrides gestalt.json', () => {
    writeFileSync(join(tmpDir, 'gestalt.json'), JSON.stringify({ llm: { apiKey: 'from-json' } }));
    process.env['ANTHROPIC_API_KEY'] = 'from-env';
    const config = withCwd(tmpDir, () => loadConfig({}, { skipDotEnv: true }));
    expect(config.llm.apiKey).toBe('from-env');
  });

  it('env var GESTALT_RESOLUTION_THRESHOLD overrides gestalt.json', () => {
    writeFileSync(
      join(tmpDir, 'gestalt.json'),
      JSON.stringify({ interview: { resolutionThreshold: 0.5 } }),
    );
    process.env['GESTALT_RESOLUTION_THRESHOLD'] = '0.7';
    const config = withCwd(tmpDir, () => loadConfig({}, { skipDotEnv: true }));
    expect(config.interview.resolutionThreshold).toBe(0.7);
  });

  it('code override takes highest priority over env and gestalt.json', () => {
    writeFileSync(join(tmpDir, 'gestalt.json'), JSON.stringify({ llm: { apiKey: 'from-json' } }));
    process.env['ANTHROPIC_API_KEY'] = 'from-env';
    const config = withCwd(tmpDir, () =>
      loadConfig({ llm: { apiKey: 'from-override' } }, { skipDotEnv: true }),
    );
    expect(config.llm.apiKey).toBe('from-override');
  });

  it('code override logLevel beats env var', () => {
    process.env['GESTALT_LOG_LEVEL'] = 'warn';
    const config = loadConfig({ logLevel: 'debug' }, isolatedOpts);
    expect(config.logLevel).toBe('debug');
  });

  it('code override execute threshold beats env var', () => {
    process.env['GESTALT_DRIFT_THRESHOLD'] = '0.5';
    const config = loadConfig({ execute: { driftThreshold: 0.9 } }, isolatedOpts);
    expect(config.execute.driftThreshold).toBe(0.9);
  });

  it('env var GESTALT_MODEL sets llm.model', () => {
    process.env['GESTALT_MODEL'] = 'claude-3-opus-20240229';
    const config = loadConfig({}, isolatedOpts);
    expect(config.llm.model).toBe('claude-3-opus-20240229');
  });

  it('env var GESTALT_NOTIFICATIONS=true sets notifications boolean', () => {
    process.env['GESTALT_NOTIFICATIONS'] = 'true';
    const config = loadConfig({}, isolatedOpts);
    expect(config.notifications).toBe(true);
  });

  it('env var GESTALT_NOTIFICATIONS=false sets notifications=false', () => {
    process.env['GESTALT_NOTIFICATIONS'] = 'false';
    const config = loadConfig({}, isolatedOpts);
    expect(config.notifications).toBe(false);
  });

  it('tier env vars set llm tier config (frugal)', () => {
    process.env['GESTALT_LLM_FRUGAL_PROVIDER'] = 'openai';
    process.env['GESTALT_LLM_FRUGAL_MODEL'] = 'gpt-4o-mini';
    const config = loadConfig({}, isolatedOpts);
    expect(config.llm.frugal?.provider).toBe('openai');
    expect(config.llm.frugal?.model).toBe('gpt-4o-mini');
  });

  it('tier env vars set llm tier config (frontier)', () => {
    process.env['GESTALT_LLM_FRONTIER_PROVIDER'] = 'anthropic';
    process.env['GESTALT_LLM_FRONTIER_MODEL'] = 'claude-opus-4-5';
    process.env['GESTALT_LLM_FRONTIER_API_KEY'] = 'sk-frontier-key';
    const config = loadConfig({}, isolatedOpts);
    expect(config.llm.frontier?.provider).toBe('anthropic');
    expect(config.llm.frontier?.model).toBe('claude-opus-4-5');
    expect(config.llm.frontier?.apiKey).toBe('sk-frontier-key');
  });
});

// ─── Missing gestalt.json Fallback ──────────────────────────────

describe('loadConfig — missing gestalt.json fallback', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir('gestalt-no-json-test');
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('falls back to defaults when gestalt.json does not exist', () => {
    // tmpDir has no gestalt.json
    const config = withCwd(tmpDir, () => loadConfig({}, { skipDotEnv: true }));
    expect(config.llm.apiKey).toBe('');
    expect(config.interview.resolutionThreshold).toBe(0.8);
    expect(config.logLevel).toBe('info');
  });

  it('does not throw when gestalt.json is absent', () => {
    expect(() => {
      withCwd(tmpDir, () => loadConfig({}, { skipDotEnv: true }));
    }).not.toThrow();
  });
});

// ─── Invalid / Malformed JSON Fallback ──────────────────────────

describe('loadConfig — invalid JSON fallback', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir('gestalt-bad-json-test');
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('falls back to defaults when gestalt.json contains invalid JSON', () => {
    writeFileSync(join(tmpDir, 'gestalt.json'), '{ invalid json !!');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const config = withCwd(tmpDir, () => loadConfig({}, { skipDotEnv: true }));
    consoleSpy.mockRestore();
    expect(config.llm.apiKey).toBe('');
    expect(config.interview.resolutionThreshold).toBe(0.8);
  });

  it('logs a warning when gestalt.json fails to parse', () => {
    writeFileSync(join(tmpDir, 'gestalt.json'), '<<<bad>>>');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    withCwd(tmpDir, () => loadConfig({}, { skipDotEnv: true }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Warning'));
    consoleSpy.mockRestore();
  });

  it('falls back gracefully when gestalt.json contains invalid field values', () => {
    writeFileSync(
      join(tmpDir, 'gestalt.json'),
      JSON.stringify({ interview: { resolutionThreshold: 999 } }), // > max 1
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const config = withCwd(tmpDir, () => loadConfig({}, { skipDotEnv: true }));
    consoleSpy.mockRestore();
    // Invalid threshold falls back to default
    expect(config.interview.resolutionThreshold).toBe(0.8);
  });
});

// ─── Priority Order Summary ──────────────────────────────────────

describe('loadConfig — full priority chain', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir('gestalt-priority-test');
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('priority: code override > env > gestalt.json > default', () => {
    // gestalt.json sets resolutionThreshold=0.5
    writeFileSync(
      join(tmpDir, 'gestalt.json'),
      JSON.stringify({ interview: { resolutionThreshold: 0.5 } }),
    );
    // env sets resolutionThreshold=0.65
    process.env['GESTALT_RESOLUTION_THRESHOLD'] = '0.65';
    // code override sets resolutionThreshold=0.9
    const config = withCwd(tmpDir, () =>
      loadConfig({ interview: { resolutionThreshold: 0.9 } }, { skipDotEnv: true }),
    );
    expect(config.interview.resolutionThreshold).toBe(0.9);
  });

  it('priority: env > gestalt.json (no code override)', () => {
    writeFileSync(
      join(tmpDir, 'gestalt.json'),
      JSON.stringify({ interview: { resolutionThreshold: 0.5 } }),
    );
    process.env['GESTALT_RESOLUTION_THRESHOLD'] = '0.65';
    const config = withCwd(tmpDir, () => loadConfig({}, { skipDotEnv: true }));
    expect(config.interview.resolutionThreshold).toBe(0.65);
  });

  it('priority: gestalt.json > default (no env, no override)', () => {
    writeFileSync(
      join(tmpDir, 'gestalt.json'),
      JSON.stringify({ interview: { resolutionThreshold: 0.55 } }),
    );
    const config = withCwd(tmpDir, () => loadConfig({}, { skipDotEnv: true }));
    expect(config.interview.resolutionThreshold).toBe(0.55);
  });
});

// ─── _deepMerge unit tests ──────────────────────────────────────

describe('_deepMerge', () => {
  it('merges nested objects deeply', () => {
    const target = { a: { b: 1, c: 2 }, d: 3 };
    const source = { a: { b: 10 }, e: 5 };
    const result = _deepMerge(target, source);
    expect(result).toEqual({ a: { b: 10, c: 2 }, d: 3, e: 5 });
  });

  it('replaces arrays (does not merge them)', () => {
    const target = { items: [1, 2, 3] };
    const source = { items: [9] };
    const result = _deepMerge(target, source);
    expect(result).toEqual({ items: [9] });
  });

  it('does not mutate the target object', () => {
    const target = { a: { b: 1 } };
    const source = { a: { b: 99 } };
    _deepMerge(target, source);
    expect(target.a.b).toBe(1);
  });

  it('skips undefined source values (preserves target)', () => {
    const target = { x: 42 };
    const source = { x: undefined };
    const result = _deepMerge(target, source);
    expect(result.x).toBe(42);
  });

  it('adds new keys from source', () => {
    const target = { a: 1 };
    const source = { b: 2 };
    const result = _deepMerge(target, source);
    expect(result).toEqual({ a: 1, b: 2 });
  });
});

// ─── _buildEnvConfig unit tests ─────────────────────────────────

describe('_buildEnvConfig', () => {
  it('returns empty object when no GESTALT env vars are set', () => {
    const result = _buildEnvConfig();
    expect(result).toEqual({});
  });

  it('maps ANTHROPIC_API_KEY to llm.apiKey', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    const result = _buildEnvConfig();
    expect((result['llm'] as Record<string, unknown>)['apiKey']).toBe('sk-test');
  });

  it('maps GESTALT_MAX_ROUNDS to interview.maxRounds as number', () => {
    process.env['GESTALT_MAX_ROUNDS'] = '20';
    const result = _buildEnvConfig();
    expect((result['interview'] as Record<string, unknown>)['maxRounds']).toBe(20);
  });

  it('maps GESTALT_DB_PATH to dbPath', () => {
    process.env['GESTALT_DB_PATH'] = '/custom/path.db';
    const result = _buildEnvConfig();
    expect(result['dbPath']).toBe('/custom/path.db');
  });

  it('maps GESTALT_PERSONAS_DIR to personasDir', () => {
    process.env['GESTALT_PERSONAS_DIR'] = '/custom/personas';
    const result = _buildEnvConfig();
    expect(result['personasDir']).toBe('/custom/personas');
  });
});

// ─── personasDir resolution ─────────────────────────────────────

describe('loadConfig — personasDir', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir('gestalt-personas-test');
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('env var GESTALT_PERSONAS_DIR overrides default (absolute path passes through)', () => {
    const abs = join(tmpDir, 'my-personas');
    mkdirSync(abs, { recursive: true });
    process.env['GESTALT_PERSONAS_DIR'] = abs;
    const config = loadConfig({}, isolatedOpts);
    expect(config.personasDir).toBe(abs);
  });

  it('env var GESTALT_PERSONAS_DIR overrides gestalt.json', () => {
    const fromEnv = join(tmpDir, 'env-personas');
    mkdirSync(fromEnv, { recursive: true });
    writeFileSync(
      join(tmpDir, 'gestalt.json'),
      JSON.stringify({ personasDir: join(tmpDir, 'json-personas') }),
    );
    process.env['GESTALT_PERSONAS_DIR'] = fromEnv;
    const config = withCwd(tmpDir, () => loadConfig({}, { skipDotEnv: true }));
    expect(config.personasDir).toBe(fromEnv);
  });
});
