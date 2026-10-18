import { describe, expect, it } from 'vitest';
import { buildFigmaPlan } from '../../../src/research/figma-plan.js';
import { lintResearch, parseResearch, type ResearchInput } from '../../../src/research/index.js';
import { renderResearchHtml } from '../../../src/research/render-html.js';
import { sampleResearch } from './fixture.js';

function withFlow(): ResearchInput {
  const input = sampleResearch();
  input.screenMap = [
    ...input.screenMap!,
    {
      id: 's2',
      productId: 'a',
      screen: '상세',
      entryPath: ['홈', '상품 탭'],
      source: 'app-explore',
      capture: 'captured',
      platform: 'ios',
      order: 2,
    },
  ];
  input.screenMap[0]!.platform = 'ios';
  input.wowPain!.findings![0]!.screenMapId = 's1';
  input.flow = {
    transitions: [
      {
        id: 't1',
        from: 's1',
        to: 's2',
        trigger: '상품 카드 탭',
        gesture: 'tap',
        condition: '로그인 상태',
        basis: 'observation',
        evidence: [{ type: 'capture', captureId: 'cap1' }],
      },
      {
        id: 't2',
        from: 's2',
        to: 's1',
        trigger: '뒤로 가기',
        gesture: 'tap',
        loop: true,
        basis: 'observation',
        evidence: [{ type: 'capture', captureId: 'cap1' }],
        note: '상품 20개를 비교하려면 19번 되풀이한다',
      },
    ],
    markers: [
      {
        id: 'm1',
        screenMapId: 's1',
        no: '1',
        element: '상품 카드',
        behavior: '탭 시 → 상세로 이동',
      },
      {
        id: 'm2',
        screenMapId: 's1',
        no: '1-1',
        element: '찜 아이콘',
        behavior: '탭 시 → 찜 목록에 담김',
        limit: '최대 50개',
        parentId: 'm1',
      },
    ],
    attempts: [
      {
        id: 'at1',
        what: '브랜드 검색',
        result: 'too-many',
        text: '브랜드가 70개 넘게 나열돼 고르지 못했다',
        limit: '검색창 없음',
        captureIds: ['cap1'],
      },
    ],
    userTypes: [],
  };
  return input;
}

function messageOf(input: unknown): string {
  const r = parseResearch(input);
  expect(r.ok).toBe(false);
  return r.ok ? '' : r.error.message;
}

describe('화면 흐름 스키마', () => {
  it('flow 없는 문서는 그대로 읽히고 흐름 섹션이 없다', () => {
    const r = parseResearch(sampleResearch());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = renderResearchHtml(r.value, { audience: 'private', loadImage: () => null });
    expect(out.ok && out.html.includes('화면 전이')).toBe(false);
  });

  it('없는 화면과 마커를 가리키면 거절한다', () => {
    const input = withFlow();
    input.flow!.transitions![0]!.to = 'ghost';
    input.flow!.markers![1]!.parentId = 'nope';
    const m = messageOf(input);
    expect(m).toContain('없는 화면: ghost');
    expect(m).toContain('없는 마커: nope');
  });

  it('같은 화면 안에서 번호가 겹치면 거절한다', () => {
    const input = withFlow();
    input.flow!.markers![1]!.no = '1';
    expect(messageOf(input)).toContain('화면 안에서 번호가 겹친다');
  });

  it('전이 근거도 상태 규칙을 따른다', () => {
    const input = withFlow();
    input.flow!.transitions![0]!.evidence = [];
    expect(messageOf(input)).toContain('출처(evidence)');
  });

  it('반복 전이에 반복 비용이 없으면 경고한다', () => {
    const input = withFlow();
    delete input.flow!.transitions![1]!.note;
    const r = parseResearch(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(lintResearch(r.value).some((w) => w.path === 'flow.transitions.1')).toBe(true);
  });
});

describe('화면 흐름 렌더', () => {
  it('HTML 5번과 6번 사이에 전이, 마커, 주석, 시도 기록, 사용자 유형을 그린다', () => {
    const parsed = parseResearch(withFlow());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const out = renderResearchHtml(parsed.value, { audience: 'private', loadImage: () => null });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const { html } = out;
    for (const word of [
      '화면 전이',
      '탭: 상품 카드 탭',
      '탭: 뒤로 가기 (반복)',
      '로그인 상태',
      '홈 목록 (iOS)',
      '번호 마커 명세',
      '1-1',
      '최대 50개',
      '화면 주석',
      '시도 기록',
      '너무 많아 못 고름',
      '인터뷰 없음',
    ]) {
      expect(html).toContain(word);
    }
    const flowAt = html.indexOf('화면 전이');
    expect(flowAt).toBeGreaterThan(html.indexOf('5. 레퍼런스가 그렇게 한 이유'));
    expect(flowAt).toBeLessThan(html.indexOf('6. 판단'));
  });

  it('사용자 유형이 있으면 인터뷰 없음 대신 카드를 그린다', () => {
    const input = withFlow();
    input.flow!.userTypes = [
      {
        id: 'u1',
        name: '선물 위주 구매자',
        summary: '명절에 몰아서 산다',
        source: '내부 인터뷰 노트',
      },
    ];
    const parsed = parseResearch(input);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const out = renderResearchHtml(parsed.value, { audience: 'private', loadImage: () => null });
    expect(out.ok && out.html.includes('선물 위주 구매자')).toBe(true);
    expect(out.ok && out.html.includes('인터뷰 없음')).toBe(false);
  });

  it('Figma 계획의 5번 섹션에 같은 표가 들어간다', () => {
    const parsed = parseResearch(withFlow());
    if (!parsed.ok) throw new Error(parsed.error.message);
    const result = buildFigmaPlan(parsed.value, { audience: 'private' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const json = JSON.stringify(result.plan.nodes);
    expect(json).toContain('화면 전이');
    expect(json).toContain('번호 마커 명세');
    expect(json).toContain('탭: 상품 카드 탭');
  });
});
