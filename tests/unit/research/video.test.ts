import { describe, expect, it } from 'vitest';
import { buildFigmaPlan } from '../../../src/research/figma-plan.js';
import { renderResearchHtml } from '../../../src/research/render-html.js';
import { lintResearch, parseResearch, type Research } from '../../../src/research/schema.js';
import { sampleResearch, sampleVideo, videoFrameCapture } from './fixture.js';

type Input = Parameters<typeof sampleResearch>[0];

function withVideo(overrides: Input = {}): Input {
  const base = sampleResearch();
  return {
    captures: [...(base.captures ?? []), videoFrameCapture()],
    video: sampleVideo(),
    ...overrides,
  };
}

function research(overrides: Input = {}): Research {
  const parsed = parseResearch(sampleResearch(overrides));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

const image = (): { mime: string; data: Buffer } => ({
  mime: 'image/jpeg',
  data: Buffer.from('x'),
});

function standalone(): Research {
  return research({
    ...withVideo(),
    meta: {
      slug: 'sample-video',
      title: '샘플 영상 분석',
      task: '영상 두 개',
      kind: 'video-analysis',
    },
    screenMap: [],
    captures: [videoFrameCapture()],
    references: [],
    comparison: [],
    wowPain: undefined,
    reasons: [],
    judgment: [],
    verification: [],
    openQuestions: undefined,
  });
}

describe('영상 블록 스키마', () => {
  it('영상 블록이 없는 리서치도 그대로 받는다', () => {
    expect(research().video).toBeUndefined();
  });

  it('영상과 발견을 받는다', () => {
    expect(research(withVideo()).video?.clips).toHaveLength(2);
  });

  it('없는 제품을 가리키는 영상과 없는 영상을 가리키는 발견을 거절한다', () => {
    const video = sampleVideo();
    video.clips![0]!.productId = 'zz';
    video.findings![0]!.clipId = 'nope';
    const parsed = parseResearch(sampleResearch(withVideo({ video })));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).toContain('없는 제품: zz');
    expect(parsed.error.message).toContain('없는 영상: nope');
  });

  it('관찰과 회사 발언은 시각이 없으면 거절하고 해석은 받는다', () => {
    const video = sampleVideo();
    delete video.findings![0]!.at;
    expect(parseResearch(sampleResearch(withVideo({ video }))).ok).toBe(false);
    video.findings![0]!.evidence = 'interpretation';
    expect(parseResearch(sampleResearch(withVideo({ video }))).ok).toBe(true);
  });

  it('없는 캡처나 다른 제품의 캡처를 가리키는 발견을 거절한다', () => {
    const missing = sampleVideo();
    missing.findings![0]!.captureId = 'none';
    expect(parseResearch(sampleResearch(withVideo({ video: missing }))).ok).toBe(false);

    const other = sampleVideo();
    other.clips![0]!.productId = 'b';
    expect(parseResearch(sampleResearch(withVideo({ video: other }))).ok).toBe(false);
  });

  it('겹치는 영상 id를 거절한다', () => {
    const video = sampleVideo();
    video.clips![1]!.id = 'v1';
    expect(parseResearch(sampleResearch(withVideo({ video }))).ok).toBe(false);
  });

  it('http 주소는 거절한다', () => {
    const video = sampleVideo();
    video.clips![1]!.url = 'http://example.com/a';
    expect(parseResearch(sampleResearch(withVideo({ video }))).ok).toBe(false);
  });
});

describe('영상 블록 경고', () => {
  it('영상 분석 문서에 영상이 없으면 경고한다', () => {
    const r = research({
      meta: { slug: 'v', title: 't', task: 't', kind: 'video-analysis' },
      video: { clips: [], findings: [] },
    });
    expect(lintResearch(r).map((w) => w.path)).toContain('video.clips');
  });

  it('발견이 없는 영상을 알려준다', () => {
    const video = sampleVideo();
    video.findings = video.findings!.filter((f) => f.clipId === 'v1');
    const warnings = lintResearch(research(withVideo({ video })));
    expect(warnings.some((w) => w.path === 'video.clips.1')).toBe(true);
  });

  it('영상 분석 문서는 열린 질문이 비어도 경고하지 않는다', () => {
    expect(lintResearch(standalone()).map((w) => w.path)).not.toContain('openQuestions');
  });
});

describe('영상 섹션 렌더', () => {
  it('합칠 때는 9번에 묶음 순서대로 그리고 근거에 시각을 붙인다', () => {
    const r = renderResearchHtml(research(withVideo()), { audience: 'private', loadImage: image });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html).toContain('<h2>9. 영상 분석</h2>');
    const order = ['영상 목록', '제품별 흐름', '구좌별', '종합'].map((h) =>
      r.html.indexOf(`<h3>${h}</h3>`),
    );
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(r.html).not.toContain('<h3>유형별</h3>');
    expect(r.html).toContain('관찰 (영상 12.5초)');
    expect(r.html).toContain('[방향성] [상시]');
    expect(r.html).toContain('홈 구좌 진입');
  });

  it('영상 블록이 없으면 9번을 만들지 않는다', () => {
    const r = renderResearchHtml(research(), { audience: 'private', loadImage: image });
    expect(r.ok && r.html.includes('영상 분석')).toBe(false);
  });

  it('단독 문서는 0, 1, 2번만 그린다', () => {
    const r = renderResearchHtml(standalone(), { audience: 'private', loadImage: image });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html).toContain('<h2>2. 영상 분석</h2>');
    for (const gone of ['2. 시안', '3. 비교표', '8. 열린 질문']) expect(r.html).not.toContain(gone);
    expect(r.html).toContain('0. 전제');
  });

  it('제목과 본문의 HTML을 이스케이프한다', () => {
    const video = sampleVideo();
    video.findings![0]!.text = '<script>alert(1)</script>';
    const r = renderResearchHtml(research(withVideo({ video })), {
      audience: 'private',
      loadImage: image,
    });
    expect(r.ok && r.html.includes('<script>alert')).toBe(false);
  });
});

describe('영상 섹션 Figma 계획', () => {
  const titlesOf = (r: Research): string[] => {
    const result = buildFigmaPlan(r, { audience: 'private' });
    if (!result.ok) throw new Error(result.message);
    return result.plan.nodes.filter((n) => n.type === 'section').map((n) => n.title);
  };

  it('합칠 때는 8번 뒤에 9번을 붙이고 없으면 기존 9개 섹션 그대로다', () => {
    expect(titlesOf(research())).toHaveLength(9);
    const titles = titlesOf(research(withVideo()));
    expect(titles).toHaveLength(10);
    expect(titles[9]).toBe('9. 영상 분석');
  });

  it('단독 문서는 0, 1, 2번만 담는다', () => {
    expect(titlesOf(standalone())).toEqual(['0. 전제', '1. 레퍼런스 선정', '2. 영상 분석']);
  });
});
