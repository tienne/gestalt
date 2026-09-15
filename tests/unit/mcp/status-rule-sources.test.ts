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

  // 빈 ruleSources는 "선언 안 함"과 "선언이 깨짐" 두 가지 뜻이다. 구분이 없으면
  // 오타 하나가 onMissing stop을 조용히 끄는 우회로가 된다
  it('선언이 깨지면 빈 배열과 함께 이유가 나간다', () => {
    const out = info({
      ruleSources: [
        { id: 'gate', kind: 'skill', ref: 'kb-design-to-code', onMissing: 'stop' },
        { id: 'typo', kind: 'http', ref: 'https://example.com' },
      ],
    });
    expect(out.ruleSources).toEqual([]);
    expect(out.ruleSourceErrors).not.toEqual([]);
    expect(out.ruleSourceErrors.join()).toContain('ruleSources.1.kind');
  });

  it('선언 없는 레포와 깨진 레포가 서로 다르게 보인다', () => {
    const none = info({});
    const broken = info({ ruleSources: [{ id: 'x', kind: 'http', ref: 'y' }] });
    expect(none.ruleSources).toEqual(broken.ruleSources);
    expect(none.ruleSourceErrors).not.toEqual(broken.ruleSourceErrors);
  });

  it('기존 필드를 밀어내지 않는다', () => {
    const out = info({});
    expect(out).toHaveProperty('reasoningModel');
    expect(out).toHaveProperty('reasoningModelFallback');
    expect(out).toHaveProperty('tierModels');
  });
});
