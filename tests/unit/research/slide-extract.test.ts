import { describe, expect, it } from 'vitest';
import {
  attachCaptions,
  findSlides,
  meanAbsDiff,
  parseCues,
  // @ts-expect-error 의존성 없는 .mjs 스크립트라 타입 선언이 없다
} from '../../../plugin/skills/research/scripts/slide-extract.mjs';

const BYTES = 64 * 36;
const frame = (fill: number, patch?: { from: number; to: number; value: number }): Uint8Array => {
  const f = new Uint8Array(BYTES).fill(fill);
  if (patch) f.fill(patch.value, patch.from, patch.to);
  return f;
};
const repeat = (n: number, f: Uint8Array): Uint8Array[] => Array.from({ length: n }, () => f);

describe('meanAbsDiff', () => {
  it('같은 화면은 0, 전부 뒤집힌 화면은 1이다', () => {
    expect(meanAbsDiff(frame(10), frame(10))).toBe(0);
    expect(meanAbsDiff(frame(0), frame(255))).toBe(1);
  });
});

describe('findSlides', () => {
  const white = frame(255);
  const blue = frame(60);
  const boxed = frame(255, { from: 0, to: 600, value: 0 });

  it('화면이 바뀔 때마다 한 구간을 만들고 대표는 구간의 마지막 표본이다', () => {
    const thumbs = [...repeat(5, white), ...repeat(5, blue)];
    const slides = findSlides(thumbs, 20, { intervalSec: 2 });
    expect(slides).toEqual([
      { index: 1, startSec: 0, endSec: 10, atSec: 8 },
      { index: 2, startSec: 10, endSec: 20, atSec: 18 },
    ]);
  });

  it('최소 머문 시간보다 짧은 화면은 버리고 그 시간은 앞 슬라이드가 이어받는다', () => {
    const thumbs = [...repeat(5, white), ...repeat(1, blue), ...repeat(5, boxed)];
    const slides = findSlides(thumbs, 22, { intervalSec: 2, minStableSec: 4 });
    expect(slides.map((s: { startSec: number }) => s.startSec)).toEqual([0, 12]);
    expect(slides[0].endSec).toBe(12);
  });

  it('앞서 뽑은 슬라이드로 돌아오면 중복으로 버린다', () => {
    const thumbs = [...repeat(5, white), ...repeat(5, blue), ...repeat(5, white)];
    const slides = findSlides(thumbs, 30, { intervalSec: 2 });
    expect(slides).toHaveLength(2);
    expect(slides[1].endSec).toBe(30);
  });

  it('압축 노이즈 정도의 흔들림은 같은 슬라이드로 본다', () => {
    const noisy = (n: number): Uint8Array => frame(255 - n);
    const thumbs = [noisy(0), noisy(2), noisy(1), noisy(3), noisy(0), noisy(2)];
    expect(findSlides(thumbs, 12, { intervalSec: 2 })).toHaveLength(1);
  });

  it('표본이 없으면 빈 배열이다', () => {
    expect(findSlides([], 0)).toEqual([]);
  });
});

describe('parseCues', () => {
  it('VTT의 태그를 걷고 직전 큐에 나온 줄은 뺀다', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:03.000',
      '안녕하세요 <c>여러분</c>',
      '',
      '00:00:03.000 --> 00:00:05.000',
      '안녕하세요 여러분',
      '오늘은 정산 이야기입니다',
    ].join('\n');
    expect(parseCues(vtt)).toEqual([
      { startSec: 1, text: '안녕하세요 여러분' },
      { startSec: 3, text: '오늘은 정산 이야기입니다' },
    ]);
  });

  it('SRT의 쉼표 시각과 번호 줄도 읽는다', () => {
    const srt =
      '1\n00:01:02,500 --> 00:01:04,000\n첫 줄\n\n2\n00:01:05,000 --> 00:01:06,000\n둘째 줄\n';
    expect(parseCues(srt)).toEqual([
      { startSec: 62.5, text: '첫 줄' },
      { startSec: 65, text: '둘째 줄' },
    ]);
  });
});

describe('attachCaptions', () => {
  it('큐의 시작 시각이 속한 슬라이드에 붙인다', () => {
    const slides = [
      { index: 1, startSec: 0, endSec: 10, atSec: 8 },
      { index: 2, startSec: 10, endSec: 20, atSec: 18 },
    ];
    const cues = [
      { startSec: 1, text: 'a' },
      { startSec: 9.9, text: 'b' },
      { startSec: 10, text: 'c' },
    ];
    const out = attachCaptions(slides, cues);
    expect(out.map((s: { caption: string }) => s.caption)).toEqual(['a b', 'c']);
  });
});
