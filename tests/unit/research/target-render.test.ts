import { describe, expect, it } from 'vitest';
import { buildFigmaPlan } from '../../../src/research/figma-plan.js';
import {
  renderResearchHtml,
  type LoadedImage,
  type RenderOptions,
} from '../../../src/research/render-html.js';
import { parseResearch, type Research } from '../../../src/research/schema.js';
import { sampleResearch } from './fixture.js';

const png: LoadedImage = { mime: 'image/png', data: Buffer.from('fake-png-bytes') };
const render = (r: Research, audience: RenderOptions['audience'] = 'private'): string => {
  const out = renderResearchHtml(r, { audience, loadImage: () => png });
  if (!out.ok) throw new Error(out.message);
  return out.html;
};
const figma = (r: Research): string => {
  const plan = buildFigmaPlan(r, { audience: 'private' });
  if (!plan.ok) throw new Error('계획을 못 만들었다');
  return JSON.stringify(plan.plan);
};

type Input = ReturnType<typeof sampleResearch>;

function build(edit: (input: Input) => void = () => {}): Research {
  const input = sampleResearch();
  edit(input);
  const parsed = parseResearch(input);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

const withDetail = (input: Input): void => {
  const t = input.target!;
  t.mode = 'new';
  t.baseline.proxyOf = '기존 결제 퍼널';
  t.dailyEntrants!.derivation = '진입 화면 조회 수 × 배너 클릭률';
  t.steps = [
    {
      id: 'click',
      label: '배너 클릭률',
      value: '3%',
      method: 'proxy',
      basis: 'unconfirmed',
      evidence: [],
      note: '비슷한 배너가 없다',
    },
  ];
  t.dataSource = {
    kind: 'amplitude',
    project: '앱 운영',
    chartUrl: 'https://app.amplitude.com/chart/abc',
    events: [{ step: '상세 진입', event: 'product_detail_view' }],
    from: '2026-08-01',
    to: '2026-09-25',
  };
  t.trackingPlan = [
    { event: 'product_detail_view', step: '상세 진입', status: 'exists' },
    {
      event: 'gift_purchase_complete',
      step: '구매 완료',
      status: 'missing',
      note: '화면 만들 때 심는다',
    },
  ];
};

describe('목표치 근거 렌더', () => {
  it('0번 아래에 목표치 근거와 가설 합산, 가설별 표본을 그린다', () => {
    const html = render(build());
    expect(html).toContain('<h3>목표치 근거</h3>');
    expect(html).toContain('상세 진입률: 목록 노출 대비 상세 진입');
    expect(html).toContain('보수 11%, 기대 12%, 도전 13%');
    expect(html).toContain('가설을 다 성공하면 12%까지 간다');
    expect(html).toContain('<th>군당 표본</th>');
    expect(html).toContain('기대 효과: +2%p');
    expect(html).toContain('볼 이벤트: product_detail_view');
  });

  it('신규 화면이면 대신 쓴 퍼널과 계산 단계, 심어야 할 이벤트를 그린다', () => {
    const html = render(build(withDetail));
    expect(html).toContain('새로 만드는 화면');
    expect(html).toContain('대신 쓴 퍼널: 기존 결제 퍼널');
    expect(html).toContain('진입 화면 조회 수 × 배너 클릭률');
    expect(html).toContain('비슷한 퍼널');
    expect(html).toContain('<h3>심어야 할 이벤트</h3>');
    expect(html).toContain('gift_purchase_complete');
    expect(html).not.toMatch(/<td>product_detail_view<\/td>/);
  });

  it('공유본에는 차트 링크를 싣지 않는다', () => {
    const r = build(withDetail);
    expect(render(r)).toContain('https://app.amplitude.com/chart/abc');
    expect(render(r, 'shared')).not.toContain('https://app.amplitude.com/chart/abc');
  });

  it('목표치가 없으면 아무것도 그리지 않는다', () => {
    const r = build((input) => {
      input.target = undefined;
    });
    expect(render(r)).not.toContain('목표치 근거');
    expect(figma(r)).not.toContain('목표치 근거');
  });

  it('Figma에도 같은 표와 7번 열이 생긴다', () => {
    const json = figma(build(withDetail));
    expect(json).toContain('"목표치 근거"');
    expect(json).toContain('"걸리는 일수"');
    expect(json).toContain('"기대 효과"');
    expect(json).toContain('"심어야 할 이벤트"');
    expect(json).toContain('[확인 못함] 3%');
  });
});
