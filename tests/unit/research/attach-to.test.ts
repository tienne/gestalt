import { describe, expect, it } from 'vitest';
import { buildFigmaPlan } from '../../../src/research/figma-plan.js';
import { renderResearchHtml, type LoadedImage } from '../../../src/research/render-html.js';
import { lintResearch, parseResearch, type Research } from '../../../src/research/schema.js';
import { sampleResearch } from './fixture.js';

type Input = ReturnType<typeof sampleResearch>;

function build(edit: (input: Input) => void = () => {}): Research {
  const input = sampleResearch();
  edit(input);
  const parsed = parseResearch(input);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

const paths = (r: Research): string[] => lintResearch(r).map((w) => w.path);
const png: LoadedImage = { mime: 'image/png', data: Buffer.from('fake-png-bytes') };

describe('기능이 붙는 흐름', () => {
  it('가설이 있는데 붙는 흐름이 없으면 경고한다', () => {
    const r = build((input) => {
      delete input.premise.attachTo;
    });
    expect(paths(r)).toContain('premise.attachTo');
  });

  it('가설도 목표치도 없으면 경고하지 않는다', () => {
    const r = build((input) => {
      delete input.premise.attachTo;
      input.verification = [];
      input.target = undefined;
    });
    expect(paths(r)).not.toContain('premise.attachTo');
  });

  it('같은 도메인 후보가 하나도 없으면 경고한다', () => {
    const r = build((input) => {
      input.productCandidates[0]!.domainFit = 'adjacent';
    });
    const w = lintResearch(r).find((x) => x.path === 'products');
    expect(w?.message).toContain('같은 도메인(모바일 상품권)의 후보가 없다');
  });

  it('붙는 흐름과 도메인 일치를 HTML과 Figma에 그린다', () => {
    const r = build();
    const out = renderResearchHtml(r, { audience: 'private', loadImage: () => png });
    if (!out.ok) throw new Error(out.message);
    expect(out.html).toContain('<td>붙는 흐름</td>');
    expect(out.html).toContain('상품 목록에서 상세로 가는 흐름 (모바일 상품권)');
    expect(out.html).toContain('같은 시장, 같은 도메인');
    const plan = buildFigmaPlan(r, { audience: 'private' });
    if (!plan.ok) throw new Error('계획을 못 만들었다');
    const json = JSON.stringify(plan.plan);
    expect(json).toContain('"붙는 흐름"');
    expect(json).toContain('같은 시장, 같은 도메인');
  });
});
