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

  // 스킬이 읽는 ref 가 이 값뿐이라 자르면 못 읽는 경로가 된다. 그 실패는
  // onMissing 을 타고 조용히 지나간다. 길이는 스키마가 거부로 막는다
  it('ref 는 자르지 않고 원본 그대로 싣는다', () => {
    const ref = `docs/${'a'.repeat(400)}.md`;
    const out = info({ ruleSources: [{ id: 'x', kind: 'file', ref }] });
    expect(out.ruleSources[0]!.ref).toBe(ref);
  });

  // 이 값은 매 응답에 실려 에이전트 컨텍스트로 들어간다. 줄 수도 묶지 않으면
  // 깨진 선언 수만큼 응답이 커진다
  it('오류가 많으면 앞쪽만 싣고 나머지는 개수로 알린다', () => {
    const out = info({
      ruleSources: Array.from({ length: 25 }, (_, i) => ({
        id: `s${i}`,
        kind: 'http',
        ref: 'x',
      })),
    });
    expect(out.ruleSourceErrors).toHaveLength(20);
    // 안 실린 줄 수는 문자열이 아니라 수로 온다. 스킬이 이 배열을 사용자에게
    // 옮겨 적으므로 문장으로 끼워 넣으면 그게 오류 한 건처럼 읽힌다
    expect(out.ruleSourceErrorCount).toBe(25);
  });

  it('기존 필드를 밀어내지 않는다', () => {
    const out = info({});
    expect(out).toHaveProperty('reasoningModel');
    expect(out).toHaveProperty('reasoningModelFallback');
    expect(out).toHaveProperty('tierModels');
  });
});
