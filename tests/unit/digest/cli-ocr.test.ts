import { afterEach, describe, expect, it, vi } from 'vitest';
import { printOcr } from '../../../src/cli/commands/digest.js';
import type { OcrResult } from '../../../src/digest/ocr.js';

const base: OcrResult = {
  path: '/repo/.gestalt/digest/s/ocr.json',
  lang: 'eng',
  intervalSec: 10,
  frames: 4,
  items: 2,
  truncated: 0,
};

function lines(r: OcrResult): string[] {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  printOcr(r);
  return log.mock.calls.map((c) => String(c[0]));
}

describe('digest ocr 출력', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('시각 로그가 모자라면 그 수를 화면 글자 줄과 저장 줄 사이에 알린다', () => {
    const out = lines({ ...base, loggedTimes: 2 });
    expect(out).toEqual([
      '화면 글자: 프레임 4장(10초 간격, eng) → 2개',
      '프레임 4장 중 시각 로그가 2개뿐이라 나머지는 간격으로 시각을 어림했어요',
      '저장: /repo/.gestalt/digest/s/ocr.json',
    ]);
  });

  it('loggedTimes가 없으면 시각 로그 줄을 찍지 않는다', () => {
    expect(lines(base).some((l) => l.includes('시각 로그'))).toBe(false);
  });
});
