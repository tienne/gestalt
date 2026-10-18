import { describe, expect, it } from 'vitest';
import { buildFigmaPlan } from '../../../src/research/figma-plan.js';
import { renderResearchHtml, type LoadedImage } from '../../../src/research/render-html.js';
import { lintResearch, parseResearch, type Research } from '../../../src/research/schema.js';
import { sampleResearch } from './fixture.js';

const png: LoadedImage = { mime: 'image/png', data: Buffer.from('fake-png-bytes') };

type Input = ReturnType<typeof sampleResearch>;

function build(edit: (input: Input) => void = () => {}): Research {
  const input = sampleResearch();
  edit(input);
  const parsed = parseResearch(input);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

const designed = (input: Input): void => {
  const v = input.verification[0]!;
  v.sample = '사용성 시험 참가자 8명';
  v.period = '2주';
};

const noCriteria = (input: Input): void => {
  input.verification[0]!.successCriteria = undefined;
};

const render = (r: Research): string => {
  const out = renderResearchHtml(r, { audience: 'private', loadImage: () => png });
  if (!out.ok) throw new Error('렌더 실패');
  return out.html;
};

describe('검증 가설의 표본, 기간, 성공 기준', () => {
  it('성공 기준이 없는 가설에 경고한다', () => {
    const hit = lintResearch(build(noCriteria)).filter((w) => w.path === 'verification.0');
    expect(hit).toHaveLength(1);
    expect(hit[0]!.message).toContain('성공 기준');
  });

  it('성공 기준이 있으면 표본이나 기간이 없어도 경고하지 않는다', () => {
    expect(lintResearch(build()).some((w) => w.path.startsWith('verification.'))).toBe(false);
  });

  it('적힌 칸만 HTML 가설 카드에 나온다', () => {
    const html = render(build(designed));
    expect(html).toContain('표본: 사용성 시험 참가자 8명');
    expect(html).toContain('기간: 2주');
    expect(html).toContain('성공 기준: B 시안의 상세 진입률이 A보다 높다');
    expect(render(build())).not.toContain('표본:');
  });

  it('Figma 계획의 검증 표에는 칸이 하나라도 있을 때만 열이 생긴다', () => {
    const withDesign = buildFigmaPlan(build(designed), { audience: 'private' });
    const bare = buildFigmaPlan(build(noCriteria), { audience: 'private' });
    if (!withDesign.ok || !bare.ok) throw new Error('계획을 못 만들었다');
    expect(JSON.stringify(withDesign.plan)).toContain('"성공 기준"');
    expect(JSON.stringify(bare.plan)).not.toContain('"성공 기준"');
  });
});
