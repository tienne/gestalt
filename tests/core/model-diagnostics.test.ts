import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import { diagnoseModelAliases } from '../../src/core/model-diagnostics.js';
import type { InterviewEngine } from '../../src/interview/engine.js';
import { describeClientHost } from '../../src/mcp/client-host.js';
import { buildStatusConfigInfo, handleStatus } from '../../src/mcp/tools/status.js';

const isolated = { skipDotEnv: true, skipGestaltJson: true };
const configFor = (overrides: Record<string, unknown>) =>
  loadConfig({ client: 'codex', ...overrides }, isolated);

describe('advisory model diagnostics', () => {
  beforeEach(() => {
    vi.stubEnv('GESTALT_REASONING_MODEL', undefined);
    vi.stubEnv('GESTALT_REASONING_MODEL_FALLBACK', undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ['opuss', 'opus'],
    ['sonet', 'sonnet'],
    ['haiku', null],
    ['haiko', 'haiku'],
    ['inheirt', 'inherit'],
  ])('keeps %s unchanged while explaining possible alias mistakes', (model, suggestion) => {
    const config = configFor({ reasoningModel: model });
    const warnings = diagnoseModelAliases(config);
    expect(config.reasoningModel).toBe(model);
    if (suggestion) {
      expect(warnings).toEqual([
        expect.objectContaining({ path: 'reasoningModel', model, suggestion }),
      ]);
      expect(warnings[0]!.message).toContain('kept unchanged');
      expect(warnings[0]!.message).toContain('custom alias');
    } else expect(warnings).toEqual([]);
  });

  it('diagnoses every effective field with its precise path without changing any model', () => {
    const config = configFor({
      reasoningModel: 'opuss',
      reasoningModelFallback: 'fabl',
      tierModels: { frugal: 'haik', standard: 'snonet', frontier: 'inheri' },
    });
    const before = structuredClone(config);
    expect(
      diagnoseModelAliases(config).map(({ path, model, suggestion }) => ({
        path,
        model,
        suggestion,
      })),
    ).toEqual([
      { path: 'reasoningModel', model: 'opuss', suggestion: 'opus' },
      { path: 'reasoningModelFallback', model: 'fabl', suggestion: 'fable' },
      { path: 'tierModels.frugal', model: 'haik', suggestion: 'haiku' },
      { path: 'tierModels.standard', model: 'snonet', suggestion: 'sonnet' },
      { path: 'tierModels.frontier', model: 'inheri', suggestion: 'inherit' },
    ]);
    expect(config).toEqual(before);
  });

  it.each([
    'inherit',
    'fable',
    'haiku',
    'sonnet',
    'opus',
    'claude-opuss-2026',
    'custom/opuss',
    'gpt-6.1',
    'gpt4',
    'myalias',
    'team@opuss',
    'opuss:v2',
  ])('does not invent support or corrections for %s', (model) => {
    const config = configFor({
      reasoningModel: model,
      reasoningModelFallback: model,
      tierModels: { frugal: model, standard: model, frontier: model },
    });
    expect(diagnoseModelAliases(config)).toEqual([]);
    expect(config.reasoningModel).toBe(model);
    expect(config.tierModels.frontier).toBe(model);
  });

  it('uses the same computed diagnostics on API status success and error paths', () => {
    const config = configFor({ reasoningModel: 'opuss', modelWarnings: [{ model: 'fake' }] });
    const detection = describeClientHost('unknown-wrapper');
    const common = buildStatusConfigInfo(config, detection);
    const engine = { listSessions: () => [] } as unknown as InterviewEngine;
    const success = JSON.parse(handleStatus(engine, {}, undefined, config, detection));
    const error = JSON.parse(
      handleStatus(engine, { sessionId: 'nonexistent-session' }, undefined, config, detection),
    );
    expect(error.error).toBeTruthy();
    for (const result of [success, error]) {
      expect(result.modelWarnings).toEqual(common.modelWarnings);
      expect(result.clientDetection).toEqual(detection);
      expect(result.reasoningModel).toBe('opuss');
    }
    expect(common.modelWarnings).toHaveLength(1);
    expect(common.modelWarnings[0]!.model).toBe('opuss');
    expect(buildStatusConfigInfo().modelWarnings).toEqual([]);
  });
});
