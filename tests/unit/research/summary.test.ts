import { describe, expect, it } from 'vitest';
import { buildFigmaPlan } from '../../../src/research/figma-plan.js';
import {
  buildSummaryTables,
  gridFindings,
  renderResearchHtml,
  type LoadedImage,
} from '../../../src/research/render-html.js';
import { lintResearch, parseResearch, type Research } from '../../../src/research/schema.js';
import { sampleResearch } from './fixture.js';

const CRITERION = '홈 첫 화면에 보이는 상품 수';
const png: LoadedImage = { mime: 'image/png', data: Buffer.from('fake-png-bytes') };

function research(edit: (input: ReturnType<typeof sampleResearch>) => void = () => {}): Research {
  const input = sampleResearch();
  edit(input);
  const parsed = parseResearch(input);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

const withSlots = (input: ReturnType<typeof sampleResearch>): void => {
  for (const f of input.wowPain!.findings!) f.slot = CRITERION;
};

describe('종합과 격자 안의 와우와 페인', () => {
  it('발견의 구좌가 행의 기준과 같을 때만 칸에 붙고 와우와 페인만 모은다', () => {
    const r = research(withSlots);
    expect(gridFindings(r, 'rb', CRITERION).map((f) => f.id)).toEqual(['fw-b', 'fp-b']);
    expect(gridFindings(r, 'rb', '다른 구좌')).toEqual([]);
    expect(gridFindings(research(), 'rb', CRITERION)).toEqual([]);
  });

  it('칸에 붙은 발견을 HTML과 Figma 계획에 모두 그린다', () => {
    const r = research(withSlots);
    const html = renderResearchHtml(r, { audience: 'private', loadImage: () => png });
    if (!html.ok) throw new Error('렌더 실패');
    expect(html.html).toContain('class="fnd"');
    expect(html.html).toContain('할인율이 가격보다 크게 보여서');
    const plan = JSON.stringify(buildFigmaPlan(r, { audience: 'private' }));
    expect(plan).toContain('[와우] 할인율이 가격보다 크게 보여서');
    expect(plan).toContain('[페인] 원하는 금액을 찾으려면');
    const noSlot = renderResearchHtml(research(), { audience: 'private', loadImage: () => png });
    if (!noSlot.ok) throw new Error('렌더 실패');
    expect(noSlot.html).not.toContain('class="fnd"');
  });

  it('기준별 점수를 기호로 합산하고 구현 부담 행은 뺀다', () => {
    const tables = buildSummaryTables(research());
    const score = tables.find((t) => t.heading.startsWith('기준별 점수'));
    expect(score).toBeDefined();
    expect(score!.rows).toHaveLength(2);
    const total = score!.rows[score!.rows.length - 1]!;
    expect(total.slice(2)).toEqual(['0/2', '1/2', '2/2']);
  });

  it('우선순위는 순위 오름차순이고 순위 없는 판단은 싣지 않는다', () => {
    const r = research((input) => {
      input.judgment![0]!.rank = 2;
      input.judgment![0]!.todo = '카드 높이를 줄인다';
      input.judgment!.push({
        area: '선물 분기',
        conclusion: '범위에서 뺀다',
        confidence: 'out',
        rationale: '구매 단계가 늘어난다',
        rank: 1,
      });
      input.judgment!.push({
        area: '순위 없는 판단',
        conclusion: '나중에 본다',
        confidence: 'hold',
        rationale: '데이터가 없다',
        holdUntil: '데이터 확인 뒤',
      });
    });
    const t = buildSummaryTables(r).find((x) => x.heading === '우선순위')!;
    expect(t.rows.map((row) => row[0])).toEqual(['1', '2']);
    expect(t.rows[0]![1]).toBe('선물 분기');
    expect(t.rows[1]![4]).toBe('카드 높이를 줄인다');
    expect(JSON.stringify(t.rows)).not.toContain('순위 없는 판단');
  });

  it('가져올 와우와 피할 페인에는 확인 못한 발견을 넣지 않는다', () => {
    const r = research((input) => {
      input.wowPain!.findings!.push({
        id: 'fp-x',
        referenceId: 'rb',
        kind: 'pain',
        viewpoint: 'user',
        text: '결제 단계는 못 봤다',
        basis: 'unconfirmed',
        note: '결제 화면 미수집',
      });
    });
    const tables = buildSummaryTables(r);
    const wow = tables.find((t) => t.heading === '가져올 와우')!;
    const pain = tables.find((t) => t.heading === '피할 페인')!;
    expect(wow.rows).toHaveLength(2);
    expect(pain.rows).toHaveLength(2);
    expect(JSON.stringify(pain.rows)).not.toContain('결제 단계는 못 봤다');
  });

  it('종합을 0번 앞에 두고 모을 게 없으면 섹션을 만들지 않는다', () => {
    const html = renderResearchHtml(research(), { audience: 'private', loadImage: () => png });
    if (!html.ok) throw new Error('렌더 실패');
    expect(html.html.indexOf('<h2>종합</h2>')).toBeGreaterThan(-1);
    expect(html.html.indexOf('<h2>종합</h2>')).toBeLessThan(html.html.indexOf('<h2>0. 전제</h2>'));
    const empty = research((input) => {
      input.comparison = [];
      input.wowPain!.findings = [];
      input.adoptions = [];
    });
    expect(buildSummaryTables(empty)).toEqual([]);
    const plain = renderResearchHtml(empty, { audience: 'private', loadImage: () => png });
    if (!plain.ok) throw new Error('렌더 실패');
    expect(plain.html).not.toContain('<h2>종합</h2>');
  });

  it('구좌 이름이 비교표 기준과 다른 와우와 페인은 경고한다', () => {
    const ok = lintResearch(research(withSlots));
    expect(ok.filter((w) => w.path.endsWith('.slot'))).toEqual([]);
    const bad = lintResearch(
      research((input) => {
        input.wowPain!.findings![0]!.slot = '홈 첫화면 상품 수';
      }),
    );
    const w = bad.filter((x) => x.path.endsWith('.slot'));
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toContain('격자 칸에 안 붙는다');
  });
});
