import type { Digest, Transcript } from '../../../src/digest/index.js';

export const SLUG = 'design-with-code-layers-ukY9Dvwm7Gc'.toLowerCase();

/** 문장 12개, 5초 간격 */
export function sampleTranscript(overrides: Partial<Transcript> = {}): Transcript {
  return {
    schemaVersion: '1.0.0',
    slug: SLUG,
    meta: {
      source: 'youtube',
      videoId: 'ukY9Dvwm7Gc',
      url: 'https://www.youtube.com/watch?v=ukY9Dvwm7Gc',
      title: 'Design with Code Layers | Figma',
      channel: 'Figma',
      durationSec: 62,
      publishedAt: '2026-10-15',
      lang: 'en',
      captionSource: 'auto',
    },
    segments: Array.from({ length: 12 }, (_, i) => ({
      i,
      startSec: i * 5,
      text: `Sentence number ${i}.`,
    })),
    ...overrides,
  };
}

/** 두 대섹션이 스크립트 전체를, 소섹션이 대섹션을 빈틈없이 덮는 유효본 */
export function sampleDigest(): Digest {
  return {
    schemaVersion: '1.0.0',
    slug: SLUG,
    report: {
      options: { length: 'default', difficulty: 'normal', lang: 'ko' },
      lead: {
        question: 'Figma의 Code Layers는 무엇을 하나요?',
        answer: '기존 코드에서 디자인을 탐색하게 해줘요.',
        takeaway: '**코드에서 시작한다**는 점이 핵심이에요.',
      },
      sections: [
        {
          id: 's1',
          title: '코드 레이어 소개',
          conclusion: '{{kw:code-layers|코드 레이어}}는 캔버스 위에서 코드를 다룬다.',
          cite: { key: 1, from: 0, to: 5 },
          subsections: [
            {
              id: 's1-1',
              title: '1.1. 캔버스로 코드 가져오기',
              cite: { key: 0, from: 0, to: 2 },
              frameSec: 0,
              bullets: [
                {
                  text: '**코드를 그대로** 가져온다.',
                  cite: { key: 0, from: 0, to: 1 },
                  children: [{ text: '예시 하나.', cite: { key: 1, from: 1, to: 1 } }],
                },
                { text: '두 번째 주장.', cite: { key: 2, from: 2, to: 2 } },
              ],
            },
            {
              id: 's1-2',
              title: '1.2. 편집',
              cite: { key: 4, from: 3, to: 5 },
              frameSec: 15,
              bullets: [
                { text: '편집 주장.', cite: { key: 3, from: 3, to: 4 } },
                { text: '편집 주장 둘.', cite: { key: 5, from: 5, to: 5 } },
              ],
            },
          ],
        },
        {
          id: 's2',
          title: '여러 방향 만들기',
          conclusion: '에이전트가 여러 방향을 만든다.',
          cite: { key: 7, from: 6, to: 11 },
          subsections: [
            {
              id: 's2-1',
              title: '2.1. 방향 만들기',
              cite: { key: 6, from: 6, to: 8 },
              frameSec: 30,
              bullets: [
                { text: '첫 주장.', cite: { key: 6, from: 6, to: 7 } },
                { text: '둘째 주장.', cite: { key: 8, from: 8, to: 8 } },
              ],
            },
            {
              id: 's2-2',
              title: '2.2. 발전시키기',
              cite: { key: 10, from: 9, to: 11 },
              frameSec: 45,
              bullets: [
                { text: '셋째 주장.', cite: { key: 9, from: 9, to: 10 } },
                { text: '넷째 주장.', cite: { key: 11, from: 11, to: 11 } },
              ],
            },
          ],
        },
      ],
      skipped: [],
      keywords: [
        {
          id: 'code-layers',
          term: 'Code Layers',
          explanation: 'Figma 캔버스에서 실행되는 코드 레이어.',
          firstCite: { key: 1, from: 1, to: 1 },
        },
      ],
    },
  };
}
