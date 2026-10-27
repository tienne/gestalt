import { describe, expect, it } from 'vitest';
import { detectLensKind, pdfUrlOf } from '../../../src/lens/kind.js';
import { lensPython } from '../../../src/lens/python.js';

describe('렌즈 자료 종류 판단', () => {
  it.each([
    ['https://www.youtube.com/watch?v=abc', 'youtube'],
    ['https://youtu.be/abc', 'youtube'],
    ['https://aclanthology.org/2025.aisd-main.7.pdf', 'pdf'],
    ['https://arxiv.org/abs/1706.03762', 'pdf'],
    ['paper.PDF', 'pdf'],
    ['https://cdn.example.com/ep12.mp3?x=1', 'podcast'],
    ['https://feeds.example.com/show', 'podcast'],
    ['https://example.com/podcast/feed/', 'podcast'],
    ['episode.m4a', 'podcast'],
    ['https://example.com/blog/post', 'web'],
    ['saved.html', 'web'],
    ['notes.txt', null],
  ])('%s → %s', (input, want) => {
    expect(detectLensKind(input)).toBe(want);
  });

  it('arXiv 초록 주소는 PDF 주소로 바꾼다', () => {
    expect(pdfUrlOf('https://arxiv.org/abs/1706.03762v7')).toBe(
      'https://arxiv.org/pdf/1706.03762v7',
    );
    expect(pdfUrlOf('https://example.com/a.pdf')).toBe('https://example.com/a.pdf');
  });

  it('GESTALT_LENS_PYTHON은 절대 경로만 받는다', () => {
    expect(lensPython({ GESTALT_LENS_PYTHON: '/opt/py/bin/python' })).toBe('/opt/py/bin/python');
    expect(() => lensPython({ GESTALT_LENS_PYTHON: 'venv/bin/python' })).toThrow(/절대 경로/);
  });
});
