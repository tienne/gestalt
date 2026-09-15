import { describe, it, expect, afterEach, vi } from 'vitest';
import { loadConfig, _deepMerge } from '../src/core/config.js';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // Use skipDotEnv + skipGestaltJson to isolate from local config files
  const opts = { skipDotEnv: true, skipGestaltJson: true };

  it('loads config with empty API key for passthrough mode', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const config = loadConfig({}, opts);
    expect(config.llm.apiKey).toBe('');
  });

  it('loads config with valid API key', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-key';
    const config = loadConfig({}, opts);
    expect(config.llm.apiKey).toBe('sk-ant-test-key');
    expect(config.interview.resolutionThreshold).toBe(0.8);
    expect(config.interview.maxRounds).toBe(15);
  });

  it('respects environment variable overrides', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-key';
    process.env['GESTALT_RESOLUTION_THRESHOLD'] = '0.5';
    process.env['GESTALT_MAX_ROUNDS'] = '10';
    process.env['GESTALT_DB_PATH'] = '/tmp/test.db';

    const config = loadConfig({}, opts);
    expect(config.interview.resolutionThreshold).toBe(0.5);
    expect(config.interview.maxRounds).toBe(10);
    expect(config.dbPath).toBe('/tmp/test.db');
  });

  it('accepts overrides parameter', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-key';
    const config = loadConfig({ logLevel: 'debug' }, opts);
    expect(config.logLevel).toBe('debug');
  });

  it('nested overrides merge correctly', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const config = loadConfig(
      {
        llm: { apiKey: 'test-key', model: 'custom-model' },
        interview: { resolutionThreshold: 0.9 },
      },
      opts,
    );
    expect(config.llm.apiKey).toBe('test-key');
    expect(config.llm.model).toBe('custom-model');
    expect(config.interview.resolutionThreshold).toBe(0.9);
    expect(config.interview.maxRounds).toBe(15); // default preserved
  });

  it('env vars override gestalt.json values', () => {
    process.env['GESTALT_DRIFT_THRESHOLD'] = '0.5';
    const config = loadConfig({}, opts);
    expect(config.execute.driftThreshold).toBe(0.5);
  });

  it('execute thresholds from env vars', () => {
    process.env['GESTALT_EVOLVE_SUCCESS_THRESHOLD'] = '0.9';
    process.env['GESTALT_EVOLVE_GOAL_ALIGNMENT_THRESHOLD'] = '0.75';
    const config = loadConfig({}, opts);
    expect(config.execute.successThreshold).toBe(0.9);
    expect(config.execute.goalAlignmentThreshold).toBe(0.75);
  });

  it('returns defaults when no config sources exist', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['GESTALT_MODEL'];
    delete process.env['GESTALT_RESOLUTION_THRESHOLD'];
    delete process.env['GESTALT_MAX_ROUNDS'];
    delete process.env['GESTALT_DB_PATH'];
    delete process.env['GESTALT_SKILLS_DIR'];
    delete process.env['GESTALT_AGENTS_DIR'];
    delete process.env['GESTALT_LOG_LEVEL'];
    delete process.env['GESTALT_DRIFT_THRESHOLD'];
    delete process.env['GESTALT_EVOLVE_SUCCESS_THRESHOLD'];
    delete process.env['GESTALT_EVOLVE_GOAL_ALIGNMENT_THRESHOLD'];

    const config = loadConfig({}, opts);
    expect(config.llm.apiKey).toBe('');
    expect(config.llm.model).toBe('claude-sonnet-5');
    expect(config.interview.resolutionThreshold).toBe(0.8);
    expect(config.interview.maxRounds).toBe(15);
    expect(config.execute.driftThreshold).toBe(0.6);
    expect(config.execute.successThreshold).toBe(0.85);
    expect(config.execute.goalAlignmentThreshold).toBe(0.8);
    expect(config.logLevel).toBe('info');
  });

  it('warns and falls back only on invalid values', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env['ANTHROPIC_API_KEY'];
    const config = loadConfig(
      {
        llm: { model: 'custom-model' },
        interview: { resolutionThreshold: 5 }, // invalid: max 1
        execute: { driftThreshold: 0.4 },
      },
      opts,
    );
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Warning'));
    // Invalid field falls back to default, valid fields are preserved.
    expect(config.llm.model).toBe('custom-model');
    expect(config.interview.resolutionThreshold).toBe(0.8);
    expect(config.execute.driftThreshold).toBe(0.4);
    consoleSpy.mockRestore();
  });

  it('overrides take highest priority over env vars', () => {
    process.env['GESTALT_DRIFT_THRESHOLD'] = '0.5';
    const config = loadConfig(
      {
        execute: { driftThreshold: 0.7 },
      },
      opts,
    );
    expect(config.execute.driftThreshold).toBe(0.7);
  });
});

describe('loadConfig — tierModels', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });
  const opts = { skipDotEnv: true, skipGestaltJson: true };

  it('기본 표는 frugal=haiku, standard=sonnet, frontier=opus', () => {
    const config = loadConfig({}, opts);
    expect(config.tierModels).toEqual({
      frugal: 'haiku',
      standard: 'sonnet',
      frontier: 'opus',
    });
  });

  it('env로 한 tier만 바꿔도 나머지는 기본값을 유지한다', () => {
    process.env['GESTALT_TIER_MODEL_FRONTIER'] = 'fable';
    const config = loadConfig({}, opts);
    expect(config.tierModels.frontier).toBe('fable');
    expect(config.tierModels.standard).toBe('sonnet');
    expect(config.tierModels.frugal).toBe('haiku');
  });

  it('DEFAULT_MODEL은 현행 sonnet 5다', () => {
    const config = loadConfig({}, opts);
    expect(config.llm.model).toBe('claude-sonnet-5');
  });
});

describe('loadConfig — ruleSources', () => {
  const opts = { skipDotEnv: true, skipGestaltJson: true };

  it('선언이 없으면 빈 배열이다 — 선언 안 한 레포는 아무것도 안 읽는다', () => {
    const config = loadConfig({}, opts);
    expect(config.ruleSources).toEqual([]);
  });

  it('kind와 ref만 줘도 나머지는 기본값으로 채워진다', () => {
    const config = loadConfig(
      { ruleSources: [{ id: 'design-tokens', kind: 'mcp', ref: 'mcp__plate__get_design_tokens' }] },
      opts,
    );
    expect(config.ruleSources[0]).toEqual({
      id: 'design-tokens',
      kind: 'mcp',
      ref: 'mcp__plate__get_design_tokens',
      scope: [],
      trust: 'convention',
      onMissing: 'warn',
    });
  });

  it('id가 겹치면 받지 않는다 — 보고에서 둘을 구분할 수 없다', () => {
    const config = loadConfig(
      {
        ruleSources: [
          { id: 'dup', kind: 'mcp', ref: 'a' },
          { id: 'dup', kind: 'file', ref: 'b' },
        ],
      },
      opts,
    );
    expect(config.ruleSources).toEqual([]);
    expect(config.ruleSourceErrors.join()).toMatch(/서로 달라야/);
  });

  it('모르는 kind는 받지 않는다 — 스킬이 읽을 방법을 모르는 소스는 선언돼도 소용없다', () => {
    const config = loadConfig(
      { ruleSources: [{ id: 'x', kind: 'http', ref: 'https://example.com' }] },
      opts,
    );
    expect(config.ruleSources).toEqual([]);
    expect(config.ruleSourceErrors.join()).toMatch(/kind/);
  });

  it('onMissing은 정해진 세 값만 받는다', () => {
    const config = loadConfig(
      { ruleSources: [{ id: 'x', kind: 'file', ref: 'a.md', onMissing: 'ignore' }] },
      opts,
    );
    expect(config.ruleSources).toEqual([]);
    expect(config.ruleSourceErrors.join()).toMatch(/onMissing/);
  });

  // 오타 하나가 선언 전체를 날리는데, 그걸 "선언 없음"과 구분 못 하면
  // onMissing: "stop" 게이트가 조용히 꺼진다
  it('한 소스만 잘못돼도 배열 전체가 비지만 그 이유가 남는다', () => {
    const config = loadConfig(
      {
        ruleSources: [
          { id: 'good', kind: 'mcp', ref: 'ok', onMissing: 'stop' },
          { id: 'bad', kind: 'http', ref: 'x' },
        ],
      },
      opts,
    );
    expect(config.ruleSources).toEqual([]);
    expect(config.ruleSourceErrors.length).toBeGreaterThan(0);
  });

  it('선언이 멀쩡하면 ruleSourceErrors는 비어 있다 — 선언 없는 레포와 같은 상태', () => {
    const ok = loadConfig({ ruleSources: [{ id: 'a', kind: 'file', ref: 'x.md' }] }, opts);
    expect(ok.ruleSourceErrors).toEqual([]);
    expect(loadConfig({}, opts).ruleSourceErrors).toEqual([]);
  });
});

describe('deepMerge', () => {
  it('merges nested objects', () => {
    const target = { a: { b: 1, c: 2 }, d: 3 };
    const source = { a: { b: 10 }, e: 5 };
    const result = _deepMerge(target, source);
    expect(result).toEqual({ a: { b: 10, c: 2 }, d: 3, e: 5 });
  });

  it('replaces arrays instead of merging', () => {
    const target = { a: [1, 2] };
    const source = { a: [3] };
    const result = _deepMerge(target, source);
    expect(result).toEqual({ a: [3] });
  });

  it('does not mutate target', () => {
    const target = { a: { b: 1 } };
    const source = { a: { b: 2 } };
    _deepMerge(target, source);
    expect(target.a.b).toBe(1);
  });

  it('skips undefined source values', () => {
    const target = { a: 1 };
    const source = { a: undefined };
    const result = _deepMerge(target, source);
    expect(result.a).toBe(1);
  });
});
