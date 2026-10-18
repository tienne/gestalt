import { describe, expect, it } from 'vitest';
import { buildFigmaPlan } from '../../../src/research/figma-plan.js';
import { renderResearchHtml, type LoadedImage } from '../../../src/research/render-html.js';
import { lintResearch, parseResearch, type Research } from '../../../src/research/schema.js';
import { sampleResearch } from './fixture.js';

const png: LoadedImage = { mime: 'image/png', data: Buffer.from('fake-png-bytes') };
const render = (r: Research): string => {
  const out = renderResearchHtml(r, { audience: 'private', loadImage: () => png });
  if (!out.ok) throw new Error('렌더 실패');
  return out.html;
};

type Input = ReturnType<typeof sampleResearch>;

function build(edit: (input: Input) => void = () => {}): Research {
  const input = sampleResearch();
  edit(input);
  const parsed = parseResearch(input);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

function parseError(edit: (input: Input) => void): string {
  const input = sampleResearch();
  edit(input);
  const parsed = parseResearch(input);
  expect(parsed.ok).toBe(false);
  return parsed.ok ? '' : parsed.error.message;
}

const paths = (r: Research): string[] => lintResearch(r).map((w) => w.path);

describe('타사 지표 사례(metricCases)', () => {
  it('없는 사례를 가리키는 가설은 스키마에서 막는다', () => {
    const msg = parseError((input) => {
      input.verification![0]!.metricCaseIds = ['ghost'];
    });
    expect(msg).toContain('없는 지표 사례: ghost');
  });

  it('회사 발언 사례에 출처가 없으면 스키마에서 막는다', () => {
    parseError((input) => {
      input.metricCases![0]!.evidence = [];
    });
  });

  it('가설은 있는데 사례가 하나도 없으면 경고한다', () => {
    const r = build((input) => {
      input.metricCases = [];
      input.verification![0]!.metricCaseIds = [];
    });
    expect(paths(r)).toContain('metricCases');
  });

  it('못 찾은 사례만 있으면 사례 없음 경고도, 사례 안 건 성공 기준 경고도 내지 않는다', () => {
    const r = build((input) => {
      input.metricCases = [
        {
          id: 'mc-x',
          company: '서비스 B',
          metric: '구매 전환율',
          value: '확인 못함',
          basis: 'unconfirmed',
          evidence: [],
          note: '공개된 자료가 없다',
        },
      ];
      input.verification![0]!.metricCaseIds = [];
    });
    expect(paths(r).filter((p) => p.startsWith('metricCases'))).toEqual([
      'metricCases.0.denominator',
    ]);
    expect(paths(r)).not.toContain('verification.0.metricCaseIds');
  });

  it('비율 사례에 분모가 없으면 경고한다', () => {
    const r = build((input) => {
      input.metricCases![0]!.denominator = undefined;
    });
    expect(paths(r)).toContain('metricCases.0.denominator');
  });

  it('비율이 아닌 사례는 분모가 없어도 경고하지 않는다', () => {
    const r = build((input) => {
      const m = input.metricCases![0]!;
      m.metric = '월 거래액';
      m.value = '120억 원';
      m.denominator = undefined;
    });
    expect(paths(r)).not.toContain('metricCases.0.denominator');
  });

  it('쓸 만한 사례가 있는데 성공 기준에 사례를 안 걸면 경고한다', () => {
    const r = build((input) => {
      input.verification![0]!.metricCaseIds = [];
    });
    expect(paths(r)).toContain('verification.0.metricCaseIds');
  });

  it('HTML 7번에 사례 표와 가설의 근거 사례가 나온다', () => {
    const html = render(build());
    expect(html).toContain('<h3>타사 지표 사례</h3>');
    expect(html).toContain('목록 노출 대비');
    expect(html).toContain('근거 사례: 예시 쇼핑 상세 진입률 8%에서 11%로');
  });

  it('사례가 없으면 HTML에 사례 표를 그리지 않는다', () => {
    const html = render(
      build((input) => {
        input.metricCases = [];
        input.verification![0]!.metricCaseIds = [];
      }),
    );
    expect(html).not.toContain('타사 지표 사례');
  });

  it('Figma 7번에도 사례 표와 근거 사례 열이 생긴다', () => {
    const plan = buildFigmaPlan(build(), { audience: 'private' });
    if (!plan.ok) throw new Error('계획을 못 만들었다');
    const json = JSON.stringify(plan.plan);
    expect(json).toContain('"타사 지표 사례"');
    expect(json).toContain('"근거 사례"');
  });
});
