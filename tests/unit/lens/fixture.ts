import type { LensSource } from '../../../src/digest/lens-source.js';
import type { Digest, Report, Transcript } from '../../../src/digest/schema.js';

export const LENS_SLUG = 'flavor-paper';

const rect = (page: number, top: number) => ({
  page,
  bbox: [70, top, 290, top + 40] as [number, number, number, number],
});

const UNITS: Array<[number, 'para' | 'heading' | 'caption', string, string?]> = [
  [1, 'heading', 'FlavorDiffusion: Modeling Food-Chemical Interactions'],
  [1, 'para', 'We propose FlavorDiffusion. The CSP layer improves clustering.'],
  [2, 'heading', '5 Experimental Results'],
  [
    2,
    'para',
    'Table 4 shows that CSP significantly improves embeddings, reaching 0.3410 with 200 nodes.',
  ],
  [2, 'caption', 'Table 4: Performance Comparison Using NMI Metric.', 'table-4'],
  [3, 'para', 'Table 6 lists creative pairings that extend beyond known interactions.'],
  [3, 'caption', 'Table 6: Top 5 Creative Ingredient Pairings', 'table-6'],
  [3, 'caption', 'Figure 1: Progression of edge scores over diffusion steps.', 'figure-1'],
  [3, 'para', 'The reconstructed graph increasingly aligns with the ground truth.'],
  [3, 'para', 'References: Park et al., 2021.'],
];

export function lensTranscript(kind: 'pdf' | 'web' = 'pdf'): Transcript {
  return {
    schemaVersion: '1.0.0',
    slug: LENS_SLUG,
    meta: {
      source: kind,
      url: 'https://aclanthology.org/2025.aisd-main.7.pdf',
      title: 'FlavorDiffusion',
      durationSec: 0,
      lang: 'en',
      captionSource: 'text',
    },
    segments: UNITS.map(([page, role, text, ref], i) => ({
      i,
      startSec: 0,
      text,
      ...(kind === 'pdf' ? { page, rects: [rect(page, 100 + i * 50)] } : {}),
      role,
      ...(ref ? { ref } : {}),
    })),
  };
}

export function lensSource(): LensSource {
  return {
    schemaVersion: '1.0.0',
    slug: LENS_SLUG,
    kind: 'pdf',
    pages: [1, 2, 3].map((n) => ({ n, width: 595, height: 842, image: `pages/p${n}.jpg` })),
    tables: [
      {
        id: 'table-4',
        number: '4',
        caption: 'Table 4: Performance Comparison Using NMI Metric.',
        page: 2,
        bbox: [306, 250, 524, 365],
        rows: [
          ['Model', 'NMI Mean', 'NMI Std'],
          ['Flavor Diffusion (50 nodes)', '0.3236', '0.0134'],
          ['Flavor Diffusion_CSP (50 nodes)', '0.2862', '0.0152'],
          ['Flavor Diffusion_CSP (200 nodes)', '0.3410', '0.0150'],
        ],
        grid: 'ok',
        image: 'tables/table-4.png',
        unit: 4,
      },
      {
        id: 'table-6',
        number: '6',
        caption: 'Table 6: Top 5 Creative Ingredient Pairings',
        page: 3,
        rows: [
          ['Ingredient 1', 'Ingredient 2', 'Mean Score'],
          ['Soy Sauce', 'Vanilla Extract', '0.0006'],
          ['Olive Oil', 'Black Tea', '0.0004'],
        ],
        grid: 'ok',
        unit: 6,
      },
    ],
    figures: [
      {
        id: 'figure-1',
        number: '1',
        caption: 'Figure 1: Progression of edge scores over diffusion steps.',
        page: 3,
        bbox: [71, 113, 289, 660],
        image: 'figures/figure-1.png',
        unit: 7,
        panels: 3,
      },
    ],
  };
}

export function lensReport(): Report {
  return {
    options: { length: 'long', difficulty: 'normal', lang: 'ko' },
    lead: {
      question: '이 논문은 재료 궁합을 어떻게 예측하나요?',
      answer: 'diffusion 모델로 재료 그래프를 다시 짜요.',
      takeaway: '**CSP가 늘 좋아지지는 않아요.**',
      glance: [
        { kind: 'problem', text: '재료 궁합 예측', cite: { key: 1, from: 1, to: 1 } },
        { kind: 'method', text: 'diffusion으로 간선 점수 복원', cite: { key: 1, from: 1, to: 1 } },
        { kind: 'result', text: 'NMI 0.3410', cite: { key: 3, from: 3, to: 3 } },
        {
          kind: 'limit',
          text: '새 조합은 맛으로 확인하지 않았다',
          cite: { key: 5, from: 5, to: 5 },
        },
      ],
    },
    sections: [
      {
        id: 's1',
        title: '문제와 방법',
        intro: '무엇을 풀려는지부터 본다.',
        conclusion: '재료 그래프를 diffusion으로 복원한다.',
        cite: { key: 1, from: 0, to: 2 },
        subsections: [
          {
            id: 's1-1',
            title: '제안',
            cite: { key: 1, from: 0, to: 2 },
            bullets: [
              { text: '**FlavorDiffusion**을 제안한다.', cite: { key: 1, from: 0, to: 1 } },
            ],
          },
        ],
      },
      {
        id: 's2',
        title: '결과',
        intro: '표 4와 표 6을 본다.',
        conclusion: 'CSP 효과는 설정마다 다르다.',
        cite: { key: 3, from: 3, to: 8 },
        subsections: [
          {
            id: 's2-1',
            title: 'NMI 비교',
            cite: { key: 3, from: 3, to: 4 },
            bullets: [
              {
                text: '본문은 **CSP가 임베딩을 크게 개선한다**고 쓴다.',
                cite: { key: 3, from: 3, to: 3 },
                doubt: {
                  note: '노드 50개에서는 CSP를 켜면 0.3236에서 0.2862로 떨어진다.',
                  evidence: [
                    { table: 'table-4', row: 1, col: 1 },
                    { table: 'table-4', row: 2, col: 1 },
                  ],
                },
              },
            ],
            tables: [{ ref: 'table-4', note: '같은 노드 수끼리 견준다.' }],
          },
          {
            id: 's2-2',
            title: '창의적 조합',
            cite: { key: 5, from: 5, to: 8 },
            bullets: [{ text: '새 조합을 제안한다.', cite: { key: 5, from: 5, to: 6 } }],
            figures: [{ ref: 'figure-1' }],
          },
        ],
      },
    ],
    skipped: [{ from: 9, to: 9, reason: '참고문헌' }],
    keywords: [],
    limits: [
      {
        text: '창의적 조합 점수는 0.0006 이하라 거의 0이다.',
        evidence: [{ table: 'table-6', row: 1, col: 2 }],
      },
    ],
  };
}

export function lensDigest(report: Report = lensReport()): Digest {
  return {
    schemaVersion: '1.5.0',
    slug: LENS_SLUG,
    source: { kind: 'pdf' },
    reports: [report],
    extensions: [],
  };
}
