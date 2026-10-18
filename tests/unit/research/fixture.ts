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
    target: {
      mode: 'improve',
      metric: { name: '상세 진입률', numerator: '상세 진입', denominator: '목록 노출' },
      baseline: {
        valuePct: 10,
        period: '최근 8주',
        basis: 'observation',
        evidence: [{ type: 'internal', source: '분석 도구 목록 퍼널 차트' }],
      },
      dailyEntrants: {
        value: 20000,
        basis: 'observation',
        evidence: [{ type: 'internal', source: '분석 도구 목록 퍼널 차트' }],
      },
      weeklySpreadPp: 0.5,
      range: { conservativePct: 11, expectedPct: 12, stretchPct: 13 },
      trackingPlan: [{ event: 'product_detail_view', step: '상세 진입', status: 'exists' }],
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
            basis: 'observation',
            evidence: [{ type: 'capture', captureId: 'cap1' }],
          },
          {
            referenceId: 'rb',
            symbol: '○',
            text: '5개. 한 줄에 상품이 둘씩 보임',
            basis: 'observation',
            evidence: [{ type: 'capture', captureId: 'cap1' }],
          },
          {
            referenceId: 'rc',
            symbol: '◎',
            text: '6개. 촘촘한 1열 행이라 가장 많음',
            basis: 'observation',
            evidence: [{ type: 'capture', captureId: 'cap1' }],
          },
        ],
      },
      {
        phase: '비용',
        criterion: '구현 부담',
        kind: 'burden',
        cells: [
          {
            referenceId: 'ra',
            text: '중간. 순위 산정 기준과 브랜드 로고 이미지가 필요 (해석)',
            basis: 'interpretation',
          },
          {
            referenceId: 'rb',
            text: '영상에서 확인 못함',
            basis: 'unconfirmed',
            note: '구현 정보는 화면에 안 나온다',
          },
          {
            referenceId: 'rc',
            text: '영상에서 확인 못함',
            basis: 'unconfirmed',
            note: '구현 정보는 화면에 안 나온다',
          },
        ],
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
      findings: [
        {
          id: 'fw-b',
          referenceId: 'rb',
          kind: 'wow',
          viewpoint: 'user',
          text: '할인율이 가격보다 크게 보여서 싼 상품을 바로 알아봐요',
          basis: 'observation',
          evidence: [{ type: 'capture', captureId: 'cap1' }],
        },
        {
          id: 'fp-b',
          referenceId: 'rb',
          kind: 'pain',
          viewpoint: 'user',
          text: '원하는 금액을 찾으려면 상품마다 눌러 들어가야 해요',
          concrete: '5개 상품을 비교하려면 5번 진입',
          basis: 'observation',
          evidence: [{ type: 'capture', captureId: 'cap1' }],
        },
        {
          id: 'fw-c',
          referenceId: 'rc',
          kind: 'wow',
          viewpoint: 'user',
          text: '한 화면에 6개가 보여서 훑기 편해요',
          basis: 'observation',
          evidence: [{ type: 'capture', captureId: 'cap1' }],
        },
        {
          id: 'fp-c',
          referenceId: 'rc',
          kind: 'pain',
          viewpoint: 'user',
          text: '브랜드를 구분하는 요소가 약해요',
          basis: 'interpretation',
        },
      ],
    },
    adoptions: [
      {
        id: 'ad-c',
        variant: 'A',
        referenceIds: ['rc'],
        status: 'adopted',
        adopted: ['촘촘한 1열 행'],
        mitigated: ['브랜드 로고를 행마다 붙여 구분'],
        takesFindingIds: ['fw-c'],
        solvesFindingIds: ['fp-b', 'fp-c'],
      },
    ],
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
    metricCases: [
      {
        id: 'mc-a',
        company: '예시 쇼핑',
        metric: '상세 진입률',
        denominator: '목록 노출 대비',
        value: '8%에서 11%로',
        change: '할인율 글자를 키웠다',
        period: '2025년 3분기',
        basis: 'company-statement',
        evidence: [{ type: 'url', url: 'https://example.com/blog/discount-label' }],
      },
    ],
    verification: [
      {
        hypothesis: '할인율을 크게 보이면 상세 진입이 늘어난다 (B 대 A, C) (해석)',
        metric: '상세 진입률',
        splitBy: '할인 폭이 작은 상품과 큰 상품',
        successCriteria: 'B 시안의 상세 진입률이 A보다 높다',
        metricCaseIds: ['mc-a'],
        expectedLiftPp: 2,
        events: ['product_detail_view'],
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
          owner: 'data',
        },
      ],
    },
    ...overrides,
  };
}

/** 서비스 A의 화면 녹화 하나와 세미나 하나. 프레임 캡처는 `videoFrameCapture()`가 짝이다 */
export function sampleVideo(): NonNullable<ResearchInput['video']> {
  return {
    clips: [
      {
        id: 'v1',
        productId: 'a',
        title: '서비스 A 홈 둘러보기',
        kind: 'screen-recording',
        origin: 'recorded',
        durationSec: 95,
      },
      {
        id: 'v2',
        productId: 'a',
        title: '서비스 A 상품권 기획 세미나',
        kind: 'seminar',
        origin: 'public',
        url: 'https://example.com/seminar',
        durationSec: 1800,
      },
    ],
    findings: [
      {
        clipId: 'v1',
        group: 'flow',
        topic: '홈에서 상품권까지',
        text: '홈 두 번째 구좌에서 상품권 목록으로 들어간다.',
        at: 12.5,
        captureId: 'cap-v1',
        evidence: 'observation',
        nature: 'direction',
        cadence: 'always',
      },
      {
        clipId: 'v1',
        group: 'slot',
        topic: '상단 배너',
        text: '분기마다 바뀌는 배너가 상품권을 앞세운다.',
        at: 30,
        evidence: 'observation',
        cadence: 'seasonal',
      },
      {
        clipId: 'v2',
        group: 'summary',
        topic: '노출 원칙',
        text: '구매 단계를 줄이는 쪽으로 간다고 설명한다.',
        at: 640,
        evidence: 'company-statement',
        nature: 'convention',
      },
    ],
  };
}

export function videoFrameCapture(): NonNullable<ResearchInput['captures']>[number] {
  return {
    id: 'cap-v1',
    productId: 'a',
    path: 'captures/a-01.jpg',
    kind: 'video-frame',
    pii: 'none',
    label: '홈 구좌 진입',
  };
}
