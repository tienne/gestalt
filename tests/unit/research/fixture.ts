import type { ResearchInput } from '../../../src/research/index.js';

/** 서비스 A, B, C로만 쓴 최소 리서치. 실제 서비스 이름은 넣지 않는다 */
export function sampleResearch(overrides: Partial<ResearchInput> = {}): ResearchInput {
  return {
    meta: {
      slug: 'sample-giftcard',
      title: '샘플 상품권 리서치',
      task: '상품권 목록 화면의 구매 전환',
      kind: 'ux-research',
    },
    plan: { confirmedAt: '2026-10-16T09:00:00+09:00' },
    premise: {
      goalMetric: '앱 안 구매 건수와 거래액',
      scaleAssumption: '브랜드는 10개 이상으로 늘어날 예정',
      structureConstraints: ['상세에 금액 선택이 없다'],
      pendingInputs: ['브랜드 목록은 담당자가 공유 예정'],
      evidenceLimits: ['전환 데이터가 없다'],
    },
    productCandidates: [
      {
        id: 'a',
        name: '서비스 A',
        axis: 'same-market',
        reason: '같은 시장에서 순위형으로 보여준다',
        foundVia: [],
      },
      {
        id: 'b',
        name: '서비스 B',
        axis: 'same-problem',
        reason: '혜택 가격을 앞세운다',
        foundVia: [],
      },
      {
        id: 'c',
        name: '서비스 C',
        axis: 'same-market',
        reason: '일반 커머스 틀을 쓴다',
        foundVia: [],
      },
    ],
    screenMap: [
      {
        id: 's1',
        productId: 'a',
        screen: '홈 목록',
        entryPath: ['앱 실행', '홈'],
        source: 'app-explore',
        capture: 'captured',
      },
    ],
    captures: [
      {
        id: 'cap1',
        productId: 'a',
        screenMapId: 's1',
        path: 'captures/a-home.png',
        kind: 'direct',
        pii: 'none',
      },
    ],
    references: [
      {
        id: 'ra',
        symbol: 'A',
        typeName: '순위 리스트형',
        productIds: ['a'],
        reason: '순위로 고르게 하는 해법을 대표한다',
      },
      {
        id: 'rb',
        symbol: 'B',
        typeName: '혜택 가격형',
        productIds: ['b'],
        reason: '할인 폭을 앞세우는 해법을 대표한다',
      },
      {
        id: 'rc',
        symbol: 'C',
        typeName: '커머스 틀형',
        productIds: ['c'],
        reason: '일반 상품 목록 틀을 대표한다',
      },
    ],
    comparison: [
      {
        phase: '노출',
        criterion: '홈 첫 화면에 보이는 상품 수',
        kind: 'graded',
        cells: [
          {
            referenceId: 'ra',
            symbol: '△',
            text: '3개. 인기 TOP 3 다음에 브랜드 목록이 와서 스크롤해야 보임',
          },
          { referenceId: 'rb', symbol: '○', text: '5개. 한 줄에 상품이 둘씩 보임' },
          { referenceId: 'rc', symbol: '◎', text: '6개. 촘촘한 1열 행이라 가장 많음' },
        ],
      },
      {
        phase: '비용',
        criterion: '구현 부담',
        kind: 'burden',
        cells: [{ referenceId: 'ra', text: '중간. 순위 산정 기준과 브랜드 로고 이미지가 필요' }],
      },
    ],
    wowPain: {
      userViewpoint: '원하는 걸 빨리 찾는지',
      bizViewpoint: '구매 전환과 이탈',
      items: [
        {
          referenceId: 'ra',
          userWow: ['인기 상품을 바로 알아봐요', '순위가 눈에 띄어요'],
          userPain: ['전체 상품은 스크롤해야 해요', '브랜드가 많으면 헤매요'],
          bizWow: ['상위 상품에 구매가 몰려요 (해석)', '객단가를 조절하기 쉬워요 (해석)'],
          bizPain: ['하위 상품이 묻혀요 (해석)', '순위 기준을 계속 손봐야 해요 (해석)'],
        },
      ],
    },
    reasons: [
      {
        referenceId: 'ra',
        business: '인기 상품을 먼저 보여주는 게 본업이다 (해석)',
        screens: '그래서 순위 리스트를 홈에 둔 것으로 보인다 (해석)',
        difference: '우리는 브랜드가 10개 이상이라 순위만으로는 모자란다 (해석)',
        take: ['순위 노출'],
        skip: ['순위 산정'],
      },
    ],
    judgment: [
      {
        area: '홈',
        conclusion: '홈은 C의 리스트 틀이 유력하다',
        confidence: 'likely',
        rationale: '한 화면에 상품이 가장 많이 보인다 (화면 03)',
      },
      {
        area: '수량',
        conclusion: '수량 영역은 한도가 정해진 뒤에 정한다',
        confidence: 'hold',
        rationale: '한도 정책이 아직 없다',
        holdUntil: '수량 한도 정책이 확정되면',
      },
    ],
    verification: [
      {
        hypothesis: '할인율을 크게 보이면 상세 진입이 늘어난다 (B 대 A, C) (해석)',
        metric: '상세 진입률',
        splitBy: '할인 폭이 작은 상품과 큰 상품',
      },
    ],
    openQuestions: {
      recipient: 'PM',
      intro: '근거가 없어 임시로 둔 것들이다.',
      items: [
        {
          question: '실제 할인 폭은?',
          temporary: '서비스 C의 가격으로 둠',
          affects: '시안 B의 할인율 강조',
        },
      ],
    },
    ...overrides,
  };
}
