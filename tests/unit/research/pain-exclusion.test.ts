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

const findingIndex = (input: Input, id: string): number =>
  input.wowPain.findings!.findIndex((f) => f.id === id);

// fixture의 시안은 fp-b, fp-c를 둘 다 푼다. fp-c만 풀게 해서 fp-b를 남긴다
const leaveFpB = (input: Input): void => {
  input.adoptions![0]!.solvesFindingIds = ['fp-c'];
};

const unsolved = (r: Research) =>
  lintResearch(r).filter((w) => w.message.includes('풀지 않는 페인'));

describe('시안에서 뺀 페인(excludedReason)', () => {
  it('제외 이유가 있으면 안 풀린 페인 경고를 건너뛴다', () => {
    const r = build((input) => {
      leaveFpB(input);
      input.wowPain.findings![findingIndex(input, 'fp-b')]!.excludedReason =
        '다음 분기 목록 개편에서 다룬다';
    });
    expect(unsolved(r)).toHaveLength(0);
  });

  it('공백뿐인 제외 이유는 없는 것으로 본다', () => {
    const r = build((input) => {
      leaveFpB(input);
      input.wowPain.findings![findingIndex(input, 'fp-b')]!.excludedReason = '  ';
    });
    expect(unsolved(r).map((w) => w.message)).toEqual([expect.stringContaining('fp-b')]);
  });

  it('푸는 시안이 있는데 제외 이유도 적혀 있으면 경고한다', () => {
    const r = build((input) => {
      input.wowPain.findings![findingIndex(input, 'fp-c')]!.excludedReason = '범위 밖';
    });
    const hit = lintResearch(r).filter((w) => w.path.endsWith('.excludedReason'));
    expect(hit).toHaveLength(1);
    expect(hit[0]!.message).toContain('fp-c');
  });

  it('HTML과 Figma 발견 표에 뺀 이유가 같이 나온다', () => {
    const r = build((input) => {
      leaveFpB(input);
      input.wowPain.findings![findingIndex(input, 'fp-b')]!.excludedReason = '목록 개편에서 다룬다';
    });
    expect(render(r)).toContain('이번 시안에서 뺌: 목록 개편에서 다룬다');
    const plan = buildFigmaPlan(r, { audience: 'private' });
    if (!plan.ok) throw new Error('계획을 못 만들었다');
    expect(JSON.stringify(plan.plan)).toContain('이번 시안에서 뺌: 목록 개편에서 다룬다');
  });
});
