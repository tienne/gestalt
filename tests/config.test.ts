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

  // 깨진 선언을 "선언 없음"과 구분 못 하면 onMissing: "stop"으로 걸어둔 검사가
  // 조용히 꺼진다. 그래서 빠진 소스가 있으면 이유를 남긴다
  it('깨진 소스가 빠져도 그 이유는 남는다', () => {
    const config = loadConfig(
      {
        ruleSources: [
          { id: 'good', kind: 'mcp', ref: 'ok', onMissing: 'stop' },
          { id: 'bad', kind: 'http', ref: 'x' },
        ],
      },
      opts,
    );
    expect(config.ruleSources.map((r) => r.id)).toEqual(['good']);
    expect(config.ruleSourceErrors.length).toBeGreaterThan(0);
  });

  // 오타 하나로 dbPath나 tierModels까지 날아가면, 없애려던 실패 양식을 필드에서
  // 걷어내고 설정 전체로 옮긴 셈이 된다
  it('깨진 소스가 있어도 나머지 설정은 살아남는다', () => {
    const config = loadConfig(
      {
        notifications: true,
        reasoningModel: 'sonnet',
        logLevel: 'debug',
        ruleSources: [{ id: 'bad', kind: 'http', ref: 'x' }],
      },
      opts,
    );
    expect(config.notifications).toBe(true);
    expect(config.reasoningModel).toBe('sonnet');
    expect(config.logLevel).toBe('debug');
  });

  it('깨진 소스만 빠지고 멀쩡한 소스는 남는다', () => {
    const config = loadConfig(
      {
        ruleSources: [
          { id: 'good', kind: 'file', ref: 'a' },
          { id: 'bad1', kind: 'http', ref: 'b' },
          { id: 'bad2', kind: 'ftp', ref: 'c' },
          { id: 'good2', kind: 'mcp', ref: 'd' },
        ],
      },
      opts,
    );
    expect(config.ruleSources.map((r) => r.id)).toEqual(['good', 'good2']);
    expect(config.ruleSourceErrors).toHaveLength(2);
  });

  // 한 원소에 잘못된 필드가 둘이면 zod가 issue를 둘 낸다. 받는 대로 빼면 두 번째가
  // 이미 당겨진 배열의 옆 원소를 지운다
  it('한 원소에 잘못된 필드가 둘이어도 옆 소스는 안 빠진다', () => {
    const config = loadConfig(
      {
        ruleSources: [
          { id: 'bad', kind: 'http', ref: 'x', onMissing: 'ignore' },
          { id: 'good1', kind: 'file', ref: 'a' },
          { id: 'good2', kind: 'file', ref: 'b' },
        ],
      },
      opts,
    );
    expect(config.ruleSources.map((r) => r.id)).toEqual(['good1', 'good2']);
  });

  it('required가 통째로 빠진 원소도 그 하나만 걷어낸다', () => {
    const config = loadConfig({ ruleSources: [{}, { id: 'good', kind: 'file', ref: 'a' }] }, opts);
    expect(config.ruleSources.map((r) => r.id)).toEqual(['good']);
  });

  it('배열 밖 오류가 섞여도 남는 소스가 달라지지 않는다', () => {
    const config = loadConfig(
      {
        logLevel: 'nope',
        ruleSources: [
          { id: 'g1', kind: 'file', ref: 'a' },
          { id: 'bad', kind: 'http', ref: 'b' },
          { id: 'g2', kind: 'file', ref: 'c' },
        ],
      },
      opts,
    );
    expect(config.ruleSources.map((r) => r.id)).toEqual(['g1', 'g2']);
    expect(config.logLevel).toBe('info');
  });

  // 오타를 조용히 버리면 stop으로 걸어둔 검사가 warn으로 강등된 사실을 알 수 없다
  it('모르는 키는 조용히 버리지 않고 이유를 남긴다', () => {
    const config = loadConfig(
      { ruleSources: [{ id: 'gate', kind: 'skill', ref: 'kb', onMising: 'stop' }] },
      opts,
    );
    expect(config.ruleSourceErrors.join()).toContain('onMising');
  });

  // 스킬 여러 자리가 "비어 있지 않으면 멈춘다"로 읽으므로 작성자가 채우면 안 된다
  it('작성자가 적은 ruleSourceErrors는 무시한다', () => {
    const config = loadConfig({ ruleSourceErrors: ['forged'] }, opts);
    expect(config.ruleSourceErrors).toEqual([]);
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
