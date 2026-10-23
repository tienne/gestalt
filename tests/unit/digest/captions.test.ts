import { describe, expect, it } from 'vitest';
import {
  captionsToSentences,
  mergeSentences,
  parseCues,
  parseTimedWords,
} from '../../../src/digest/captions.js';
// @ts-expect-error 의존성 없는 .mjs 스크립트라 타입 선언이 없다
import { parseCues as parseCuesMjs } from '../../../plugin/skills/research/scripts/slide-extract.mjs';

/** 유튜브 자동 자막 꼴: 단어 시각 태그와 앞 큐를 되풀이하는 줄이 섞여 있다 */
const AUTO_VTT = [
  'WEBVTT',
  'Kind: captions',
  'Language: en',
  '',
  '00:00:00.000 --> 00:00:01.950 align:start position:0%',
  ' ',
  "Hi,<00:00:00.320><c> I'm</c><00:00:00.520><c> Anthony.</c><00:00:00.960><c> And</c><00:00:01.200><c> I'm</c><00:00:01.280><c> excited</c>",
  '',
  '00:00:01.950 --> 00:00:01.960 align:start position:0%',
  "Hi, I'm Anthony. And I'm excited",
  ' ',
  '',
  '00:00:01.960 --> 00:00:03.550 align:start position:0%',
  "Hi, I'm Anthony. And I'm excited",
  'to<00:00:02.080><c> talk</c><00:00:02.240><c> about</c><00:00:02.680><c> code</c><00:00:02.960><c> layers.</c>',
  '',
  '00:00:03.550 --> 00:00:03.560 align:start position:0%',
  'to talk about code layers.',
  ' ',
  '',
  '00:00:03.560 --> 00:00:05.000 align:start position:0%',
  'to talk about code layers.',
  '&gt;&gt; [music]<00:00:04.000><c> Thanks</c><00:00:04.400><c> &amp;</c><00:00:04.600><c> bye.</c>',
].join('\n');

const MANUAL_SRT = [
  '1',
  '00:00:01,000 --> 00:00:03,000',
  '오늘은 정산 구조를',
  '',
  '2',
  '00:00:03,000 --> 00:00:05,000',
  '처음부터 살펴봅니다.',
  '',
  '3',
  '00:01:02,500 --> 00:01:04,000',
  '질문 있나요? 없으면 넘어가죠.',
  '',
].join('\n');

const MANUAL_VTT = [
  'WEBVTT',
  '',
  '00:00:01.000 --> 00:00:03.000',
  '안녕하세요 <c>여러분</c>',
  '',
  '00:00:03.000 --> 00:00:05.000',
  '안녕하세요 여러분',
  '오늘은 정산 이야기입니다',
].join('\n');

describe('parseCues', () => {
  it.each([
    ['자동 자막 VTT', AUTO_VTT],
    ['수동 SRT', MANUAL_SRT],
    ['태그가 섞인 VTT', MANUAL_VTT],
  ])('%s에서 slide-extract.mjs와 결과가 같다', (_name, text) => {
    expect(parseCues(text)).toEqual(parseCuesMjs(text));
  });
});

describe('parseTimedWords', () => {
  it('단어마다 시각 태그의 시각을 쓰고 되풀이된 줄은 뺀다', () => {
    const words = parseTimedWords(AUTO_VTT);
    expect(words.slice(0, 4)).toEqual([
      { sec: 0, text: 'Hi,' },
      { sec: 0.32, text: "I'm" },
      { sec: 0.52, text: 'Anthony.' },
      { sec: 0.96, text: 'And' },
    ]);
    expect(words.filter((w) => w.text === 'Anthony.')).toHaveLength(1);
  });

  it('엔티티를 풀고 소리 표기는 버리며 >> 뒤 단어에 끊김 표시를 단다', () => {
    const words = parseTimedWords(AUTO_VTT);
    expect(words.map((w) => w.text)).not.toContain('[music]');
    expect(words.map((w) => w.text)).not.toContain('>>');
    expect(words.find((w) => w.text === 'Thanks')).toEqual({
      sec: 4,
      text: 'Thanks',
      breakBefore: true,
    });
    expect(words.some((w) => w.text === '&')).toBe(true);
  });
});

describe('captionsToSentences', () => {
  it('자동 자막은 끝 부호에서 끊고 문장 시작은 첫 단어 시각이다', () => {
    expect(captionsToSentences(AUTO_VTT)).toEqual([
      { startSec: 0, text: "Hi, I'm Anthony." },
      { startSec: 0.96, text: "And I'm excited to talk about code layers." },
      { startSec: 4, text: 'Thanks & bye.' },
    ]);
  });

  it('수동 자막은 큐를 넘는 문장을 합치고 큐 안의 두 문장은 나눈다', () => {
    expect(captionsToSentences(MANUAL_SRT)).toEqual([
      { startSec: 1, text: '오늘은 정산 구조를 처음부터 살펴봅니다.' },
      { startSec: 62.5, text: '질문 있나요?' },
      { startSec: 62.5, text: '없으면 넘어가죠.' },
    ]);
  });
});

describe('mergeSentences', () => {
  const words = (spec: Array<[number, string]>) => spec.map(([sec, text]) => ({ sec, text }));

  it('부호가 없으면 쉼 간격에서 끊는다', () => {
    const w = words([
      [0, 'so this is the first long thought'],
      [1, 'that keeps going for a while'],
      [4, 'and then a new thought starts'],
    ]);
    expect(mergeSentences(w, { pauseSec: 1.5, minChars: 10 })).toEqual([
      { startSec: 0, text: 'so this is the first long thought that keeps going for a while' },
      { startSec: 4, text: 'and then a new thought starts' },
    ]);
  });

  it('쉼이 있어도 너무 짧으면 붙인다', () => {
    const w = words([
      [0, 'yeah'],
      [3, 'right'],
    ]);
    expect(mergeSentences(w, { pauseSec: 1, minChars: 20 })).toHaveLength(1);
  });

  it('부호도 쉼도 없으면 최대 길이에서 끊는다', () => {
    const w = Array.from({ length: 30 }, (_, k) => ({ sec: k * 0.2, text: 'word' }));
    const out = mergeSentences(w, { maxChars: 50 });
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) expect(c.text.length).toBeLessThanOrEqual(54);
  });
});
