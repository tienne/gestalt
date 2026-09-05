import { describe, it, expect } from 'vitest';
import {
  BASELINE_LABEL,
  BASELINE_PROMPT,
  DEFAULT_CASES_PATH,
  EVAL_AXES,
  aggregate,
  formatSummary,
  loadCases,
  readVariant,
  runVariant,
  scoreAssertions,
  type CaseResult,
  type EvalCase,
} from '../../../src/cli/commands/explain-eval.js';
import { AUDIENCES } from '../../../src/explain/index.js';
import type { LLMAdapter, LLMResponse } from '../../../src/llm/types.js';

const CASE: EvalCase = {
  id: 'sample',
  title: '샘플',
  audience: 'peer',
  source: 'ESM 로더가 vitest.config.ts 의 alias 때문에 멈췄다.',
  assertions: { mustMention: ['alias'], mustAvoid: ['압도적'] },
};

/** 케이스마다 답을 정해두고 돌린다. 심판 응답도 같은 자리에서 돌려준다 */
function scriptedAdapter(
  explanation: string,
  judge = '{"verdict":"pass","detail":"맞다"}',
): {
  adapter: LLMAdapter;
  systems: string[];
} {
  const systems: string[] = [];
  const adapter: LLMAdapter = {
    chat: async (request): Promise<LLMResponse> => {
      systems.push(request.system);
      const isJudge = request.system.includes('사실 정확도');
      return {
        content: isJudge ? judge : explanation,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
  return { adapter, systems };
}

describe('케이스 파일', () => {
  const cases = loadCases(DEFAULT_CASES_PATH);

  it('기본 경로에서 읽힌다', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it('대상 여섯을 모두 한 번씩 다룬다', () => {
    expect(new Set(cases.map((c) => c.audience))).toEqual(new Set(AUDIENCES));
  });

  it('id가 겹치지 않는다', () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it('어서션이 없어도 기본값으로 채운다', () => {
    for (const testCase of cases) {
      expect(Array.isArray(testCase.assertions.mustMention)).toBe(true);
      expect(Array.isArray(testCase.assertions.mustAvoid)).toBe(true);
    }
  });

  it('형식이 틀리면 어디가 틀렸는지 말한다', () => {
    expect(() => loadCases('package.json')).toThrow(/형식에 안 맞습니다/);
  });
});

describe('어서션 채점', () => {
  it('있어야 할 말과 없어야 할 말을 함께 본다', () => {
    expect(scoreAssertions('alias 를 고쳤어요.', CASE).verdict).toBe('pass');
  });

  it('빠진 말을 근거로 적는다', () => {
    const result = scoreAssertions('설정을 고쳤어요.', CASE);
    expect(result.verdict).toBe('abort');
    expect(result.evidence).toContain('빠짐: alias');
  });

  it('있으면 안 되는 말도 잡는다', () => {
    const result = scoreAssertions('alias 를 고쳤고 압도적으로 빨라졌어요.', CASE);
    expect(result.evidence).toContain('있으면 안 됨: 압도적');
  });
});

describe('변형 읽기', () => {
  it('AGENT.md 의 frontmatter를 걷고 본문만 쓴다', () => {
    const variant = readVariant('plugin/role-agents/explainer/AGENT.md');
    expect(variant.prompt).not.toContain('tier: standard');
    expect(variant.prompt).toContain('Explainer role agent');
  });

  it('경로를 안 주면 베이스라인이다', () => {
    expect(readVariant()).toEqual({ label: BASELINE_LABEL, prompt: BASELINE_PROMPT });
  });
});

describe('한 변형 돌리기', () => {
  it('결정론 축과 어서션, 심판까지 채점한다', async () => {
    const { adapter } = scriptedAdapter('ESM 로더가 vitest.config.ts 의 alias 때문에 멈췄어요.');
    const results = await runVariant(adapter, readVariant(), [CASE], { judge: true });

    expect(results).toHaveLength(1);
    expect(results[0]!.axes.map((a) => a.axis).sort()).toEqual([...EVAL_AXES].sort());
  });

  it('심판을 끄면 결정론 축과 어서션만 남는다', async () => {
    const { adapter } = scriptedAdapter('ESM 로더가 alias 때문에 멈췄어요.');
    const results = await runVariant(adapter, readVariant(), [CASE], { judge: false });
    expect(results[0]!.axes.some((a) => a.axis === 'accuracy')).toBe(false);
  });

  it('대상과 어미를 시스템 프롬프트에 붙여 보낸다', async () => {
    const { adapter, systems } = scriptedAdapter('설명이에요.');
    await runVariant(adapter, readVariant(), [CASE], { judge: false });
    expect(systems[0]).toContain('[대상] peer');
    expect(systems[0]).toContain('해요체');
  });

  it('같은 답을 두 번 채점하면 같은 점수가 나온다', async () => {
    const answer = 'ESM 로더가 vitest.config.ts 의 alias 때문에 멈췄어요.';
    const first = await runVariant(scriptedAdapter(answer).adapter, readVariant(), [CASE], {
      judge: false,
    });
    const second = await runVariant(scriptedAdapter(answer).adapter, readVariant(), [CASE], {
      judge: false,
    });
    expect(first).toEqual(second);
  });
});

describe('집계', () => {
  const result = (
    caseId: string,
    variant: string,
    verdicts: Record<string, string>,
  ): CaseResult => ({
    caseId,
    variant,
    explanation: '설명',
    axes: Object.entries(verdicts).map(([axis, verdict]) => ({
      axis: axis as CaseResult['axes'][number]['axis'],
      verdict: verdict as CaseResult['verdict'],
      detail: '',
    })),
    verdict: Object.values(verdicts).includes('abort')
      ? 'abort'
      : Object.values(verdicts).includes('warn')
        ? 'warn'
        : 'pass',
  });

  it('항목별 통과율과 차이를 낸다', () => {
    const a = [result('c1', 'a', { jargon: 'pass' }), result('c2', 'a', { jargon: 'abort' })];
    const b = [result('c1', 'b', { jargon: 'pass' }), result('c2', 'b', { jargon: 'pass' })];
    const summary = aggregate({ a: 'A', b: 'B' }, a, b);
    const jargon = summary.axes.find((row) => row.axis === 'jargon')!;

    expect(jargon.a).toBe(0.5);
    expect(jargon.b).toBe(1);
    expect(jargon.delta).toBe(0.5);
  });

  it('안 잰 축은 0%로 안 깎는다', () => {
    const a = [result('c1', 'a', { jargon: 'pass' })];
    const summary = aggregate({ a: 'A', b: 'B' }, a, a);
    expect(summary.axes.find((row) => row.axis === 'accuracy')!.delta).toBe(0);
  });

  it('전체 통과율은 축 하나라도 걸리면 안 센다', () => {
    const a = [result('c1', 'a', { jargon: 'pass', coverage: 'warn' })];
    expect(aggregate({ a: 'A', b: 'B' }, a, a).overall.a).toBe(0);
  });

  it('보고문에 두 변형 이름과 차이가 나온다', () => {
    const a = [result('c1', 'a', { jargon: 'abort' })];
    const b = [result('c1', 'b', { jargon: 'pass' })];
    const text = formatSummary(aggregate({ a: 'v1', b: 'v2' }, a, b));

    expect(text).toContain('A = v1');
    expect(text).toContain('B = v2');
    expect(text).toContain('+100%');
  });
});

describe('입력 읽기', () => {
  it('변형을 읽을 때 본문이 가리키는 룰북까지 함께 싣는다', () => {
    // 에이전트 본문의 첫 지시가 audience.md 를 먼저 읽으라는 것이다. 그게 안 실리면
    // A 는 룰북 없이 겨루고 delta 가 에이전트의 효용을 못 가린다
    const variant = readVariant('plugin/role-agents/explainer/AGENT.md');
    expect(variant.prompt).toContain('=== references/audience.md ===');
    expect(variant.prompt).toContain('핵심어 잔존을 안 재는 대상');
  });

  it('없는 파일은 읽은 척하지 않는다', () => {
    expect(() => loadCases('evals/no-such-file.json')).toThrow(/파일이 없습니다/);
  });

  it('파일이 아닌 경로도 막는다', () => {
    expect(() => readVariant('src/explain')).toThrow(/파일이 아닙니다/);
  });
});
