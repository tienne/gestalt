import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../../src/core/config.js';
import { buildStatusConfigInfo } from '../../../src/mcp/tools/status.js';

/**
 * execute Phase 0이 ges_status로 규칙 소스를 받는 경로.
 *
 * 스킬이 gestalt.json을 직접 파싱하지 않고 서버가 resolve한 값만 읽기로 했으므로,
 * 여기서 안 나오는 필드는 스킬 쪽에서 볼 방법이 없다.
 */
describe('ges_status — ruleSources', () => {
  const opts = { skipDotEnv: true, skipGestaltJson: true };
  const info = (overrides: Record<string, unknown>) =>
    buildStatusConfigInfo(loadConfig(overrides, opts));

  it('선언한 소스를 그대로 내보낸다', () => {
    const out = info({
      ruleSources: [
        { id: 'design-tokens', kind: 'mcp', ref: 'mcp__plate__get_design_tokens', scope: ['ui'] },
      ],
    });
    expect(out.ruleSources).toHaveLength(1);
    expect(out.ruleSources[0]).toMatchObject({
      id: 'design-tokens',
      kind: 'mcp',
      scope: ['ui'],
      trust: 'convention',
      onMissing: 'warn',
    });
  });

  it('config가 없어도 빈 배열이지 undefined가 아니다', () => {
    const out = buildStatusConfigInfo(undefined);
    expect(out.ruleSources).toEqual([]);
    expect(out.ruleSourceErrors).toEqual([]);
  });

  // 무엇이 빠졌는지 안 알리면 onMissing stop으로 걸어둔 검사가 안 돈 채 지나간다
  it('깨진 소스만 빠지고 이유가 함께 나간다', () => {
    const out = info({
      ruleSources: [
        { id: 'gate', kind: 'skill', ref: 'kb-design-to-code', onMissing: 'stop' },
        { id: 'typo', kind: 'http', ref: 'https://example.com' },
      ],
    });
    expect(out.ruleSources.map((r) => r.id)).toEqual(['gate']);
    expect(out.ruleSourceErrors.join()).toContain('ruleSources.1.kind');
  });

  it('선언 없는 레포와 일부가 빠진 레포가 서로 다르게 보인다', () => {
    const none = info({});
    const broken = info({ ruleSources: [{ id: 'x', kind: 'http', ref: 'y' }] });
    expect(none.ruleSourceErrors).toEqual([]);
    expect(broken.ruleSourceErrors).not.toEqual([]);
  });

  it('기존 필드를 밀어내지 않는다', () => {
    const out = info({});
    expect(out).toHaveProperty('reasoningModel');
    expect(out).toHaveProperty('reasoningModelFallback');
    expect(out).toHaveProperty('tierModels');
  });
});
