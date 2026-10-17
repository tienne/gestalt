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

const placed = (input: Input): void => {
  input.adoptions!.push({
    id: 'ad-box',
    variant: '보관안',
    placement: 'MY 쿠폰함 옆',
    referenceIds: [],
    status: 'candidate',
    adopted: ['쿠폰함의 두 탭을 재사용한다'],
    mitigated: [],
    takesFindingIds: [],
    solvesFindingIds: [],
  });
};

describe('시안의 자리(placement)', () => {
  it('레퍼런스도 자리도 없는 시안에 경고한다', () => {
    const r = build((input) => {
      placed(input);
      input.adoptions![1]!.placement = undefined;
    });
    const hit = lintResearch(r).filter((w) => w.path === 'adoptions.1');
    expect(hit).toHaveLength(1);
    expect(hit[0]!.message).toContain('ad-box');
  });

  it('자리만 있고 레퍼런스가 없어도 경고하지 않는다', () => {
    const r = build(placed);
    expect(lintResearch(r).some((w) => w.path === 'adoptions.1')).toBe(false);
  });

  it('레퍼런스가 있으면 자리 없이도 경고하지 않는다', () => {
    const r = build();
    expect(lintResearch(r).some((w) => w.path.startsWith('adoptions.'))).toBe(false);
  });

  it('자리가 있는 시안이 하나라도 있으면 HTML 시안 표에 자리 열이 생긴다', () => {
    const html = render(build(placed));
    expect(html).toContain('<th>자리</th>');
    expect(html).toContain('MY 쿠폰함 옆');
  });

  it('자리가 하나도 없으면 자리 열을 그리지 않는다', () => {
    const html = render(build());
    expect(html).not.toContain('<th>자리</th>');
  });

  it('Figma 계획의 시안 표에도 같은 열이 생긴다', () => {
    const withPlace = buildFigmaPlan(build(placed), { audience: 'private' });
    const without = buildFigmaPlan(build(), { audience: 'private' });
    if (!withPlace.ok || !without.ok) throw new Error('계획을 못 만들었다');
    expect(JSON.stringify(withPlace.plan)).toContain('"자리"');
    expect(JSON.stringify(without.plan)).not.toContain('"자리"');
  });
});
