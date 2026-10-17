import { describe, expect, it } from 'vitest';
import { parseResearch, type Research } from '../../../src/research/schema.js';
import { mergeVideo, splitVideo } from '../../../src/research/video-transfer.js';
import { sampleResearch, sampleVideo, videoFrameCapture } from './fixture.js';

type Input = Parameters<typeof sampleResearch>[0];

function parse(input: Input): Research {
  const parsed = parseResearch(input);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

function mainWithVideo(): Research {
  const base = sampleResearch();
  return parse({
    ...base,
    captures: [...(base.captures ?? []), videoFrameCapture()],
    video: sampleVideo(),
  });
}

describe('영상 떼어내기', () => {
  it('영상 문서에는 영상이 가리키는 제품과 프레임만 따라가고 본문은 그대로 둔다', () => {
    const main = mainWithVideo();
    const result = splitVideo(main, 'sample-giftcard-video');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { video, main: nextMain, imagePaths } = result.value;
    expect(video.meta).toMatchObject({ slug: 'sample-giftcard-video', kind: 'video-analysis' });
    expect(video.productCandidates.map((p) => p.id)).toEqual(['a']);
    expect(video.captures.map((c) => c.id)).toEqual(['cap-v1']);
    expect(video.video?.findings).toHaveLength(3);
    expect(video.premise.goalMetric).toBe(main.premise.goalMetric);
    expect(imagePaths).toEqual(['captures/a-01.jpg']);
    expect(nextMain.video).toBeDefined();
    expect(main.video?.clips).toHaveLength(2);
  });

  it('removeFromMain이면 본문에서 영상 블록을 지운다', () => {
    const result = splitVideo(mainWithVideo(), 'sample-giftcard-video', { removeFromMain: true });
    expect(result.ok && result.value.main.video).toBeUndefined();
  });

  it('영상 블록이 없거나 slug가 올바르지 않거나 본문과 같으면 거절한다', () => {
    expect(splitVideo(parse(sampleResearch()), 'x-video').ok).toBe(false);
    expect(splitVideo(mainWithVideo(), 'Bad Slug').ok).toBe(false);
    expect(splitVideo(mainWithVideo(), 'sample-giftcard').ok).toBe(false);
  });

  it('영상 분석 문서는 다시 떼지 않는다', () => {
    const result = splitVideo(mainWithVideo(), 'sample-giftcard-video');
    if (!result.ok) throw new Error('split failed');
    expect(splitVideo(result.value.video, 'again-video').ok).toBe(false);
  });
});

describe('영상 합치기', () => {
  function splitOnly(): { main: Research; video: Research } {
    const main = mainWithVideo();
    const result = splitVideo(main, 'sample-giftcard-video', { removeFromMain: true });
    if (!result.ok) throw new Error('split failed');
    return { main: result.value.main, video: result.value.video };
  }

  it('떼어낸 문서를 다시 합치면 영상과 프레임이 돌아온다', () => {
    const { main, video } = splitOnly();
    const merged = mergeVideo(main, video);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.value.main.video?.clips.map((c) => c.id)).toEqual(['v1', 'v2']);
    expect(merged.value.main.video?.findings).toHaveLength(3);
    expect(merged.value.main.captures.map((c) => c.id)).toContain('cap-v1');
    expect(merged.value.imagePaths).toEqual(['captures/a-01.jpg']);
  });

  it('두 번 합쳐도 겹쳐 쌓이지 않는다', () => {
    const { main, video } = splitOnly();
    const once = mergeVideo(main, video);
    if (!once.ok) throw new Error('merge failed');
    const twice = mergeVideo(once.value.main, video);
    expect(twice.ok && twice.value.main.video?.findings).toHaveLength(3);
    expect(twice.ok && twice.value.main.captures.filter((c) => c.id === 'cap-v1')).toHaveLength(1);
  });

  it('같은 id인데 내용이 다르면 어느 쪽도 덮어쓰지 않고 거절한다', () => {
    const { main, video } = splitOnly();
    const changedCapture = structuredClone(video);
    changedCapture.captures[0]!.path = 'captures/other.jpg';
    const merged = mergeVideo(main, changedCapture);
    expect(merged.ok).toBe(false);
    if (!merged.ok) expect(merged.error.message).toContain('캡처 cap-v1');
  });

  it('제품 이름이 다르면 거절한다', () => {
    const { main, video } = splitOnly();
    const other = structuredClone(video);
    other.productCandidates[0]!.name = '다른 이름';
    const merged = mergeVideo(main, other);
    expect(merged.ok).toBe(false);
  });

  it('합칠 영상이 없거나 같은 문서면 거절한다', () => {
    const { main } = splitOnly();
    expect(
      mergeVideo(
        main,
        parse(sampleResearch({ meta: { slug: 'zz', title: 't', task: 't', kind: 'ux-research' } })),
      ).ok,
    ).toBe(false);
    expect(mergeVideo(mainWithVideo(), mainWithVideo()).ok).toBe(false);
  });
});
