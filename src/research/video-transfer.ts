import { ValidationError } from '../core/errors.js';
import { err, ok, type Result } from '../core/result.js';
import { parseResearch, type Research } from './schema.js';
import { isValidSlug } from './store.js';

export interface SplitOutcome {
  /** removeFromMain이면 영상 블록을 뺀 본문, 아니면 받은 그대로 */
  main: Research;
  video: Research;
  /** 영상 문서 폴더로 옮길 캡처 이미지의 상대 경로 */
  imagePaths: string[];
}

export interface MergeOutcome {
  main: Research;
  /** 본문 폴더로 옮길 캡처 이미지의 상대 경로 */
  imagePaths: string[];
}

const fail = (message: string): Result<never, ValidationError> =>
  err(new ValidationError(message, [message]));

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function reparse(input: unknown): Result<Research, ValidationError> {
  return parseResearch(input);
}

/**
 * 본문의 영상 블록을 `video-analysis` 문서로 떼어낸다. 발견이 가리키는 제품, 프레임 캡처,
 * 그 캡처의 화면 지도 항목만 따라간다. 본문은 기본으로 그대로 둔다
 */
export function splitVideo(
  main: Research,
  videoSlug: string,
  opts: { removeFromMain?: boolean } = {},
): Result<SplitOutcome, ValidationError> {
  if (!isValidSlug(videoSlug)) return fail(`영상 문서의 slug가 올바르지 않다: ${videoSlug}`);
  if (videoSlug === main.meta.slug) return fail('영상 문서의 slug가 본문과 같다');
  if (main.meta.kind === 'video-analysis') return fail('이미 영상 분석 문서라 더 뗄 게 없다');
  const block = main.video;
  if (!block || block.clips.length === 0) return fail('떼어낼 영상 블록이 없다');

  const copy = structuredClone(main);
  const productIds = new Set(block.clips.map((c) => c.productId));
  const captureIds = new Set(
    block.findings.map((f) => f.captureId).filter((id): id is string => id !== undefined),
  );
  const captures = copy.captures.filter((c) => captureIds.has(c.id));
  const screenIds = new Set(captures.map((c) => c.screenMapId).filter(Boolean));

  const video = reparse({
    schemaVersion: copy.schemaVersion,
    meta: {
      slug: videoSlug,
      title: `${copy.meta.title} 영상 분석`,
      task: copy.meta.task,
      kind: 'video-analysis',
    },
    plan: copy.plan,
    premise: copy.premise,
    productCandidates: copy.productCandidates.filter((p) => productIds.has(p.id)),
    screenMap: copy.screenMap.filter((s) => screenIds.has(s.id)),
    captures,
    video: copy.video,
  });
  if (!video.ok) return video;

  let nextMain = main;
  if (opts.removeFromMain) {
    const { video: _removed, ...rest } = structuredClone(main);
    const parsed = reparse(rest);
    if (!parsed.ok) return parsed;
    nextMain = parsed.value;
  }
  return ok({ main: nextMain, video: video.value, imagePaths: captures.map((c) => c.path) });
}

/**
 * 영상 문서의 영상 블록을 본문에 합친다. 같은 id가 같은 내용이면 하나로 보고
 * 내용이 다르면 어느 쪽도 덮어쓰지 않고 멈춘다
 */
export function mergeVideo(
  main: Research,
  videoDoc: Research,
): Result<MergeOutcome, ValidationError> {
  const incoming = videoDoc.video;
  if (!incoming || incoming.clips.length === 0) return fail('합칠 영상 블록이 없다');
  if (videoDoc.meta.slug === main.meta.slug) return fail('본문과 영상 문서가 같은 문서다');

  const next = structuredClone(main);
  const conflicts: string[] = [];

  const mergeById = <T extends { id: string }>(
    label: string,
    target: T[],
    items: T[],
    key: (item: T) => unknown,
  ): void => {
    for (const item of items) {
      const found = target.find((t) => t.id === item.id);
      if (!found) target.push(structuredClone(item));
      else if (!same(key(found), key(item))) conflicts.push(`${label} ${item.id}`);
    }
  };

  mergeById('제품', next.productCandidates, videoDoc.productCandidates, (p) => p.name);
  mergeById('화면 지도', next.screenMap, videoDoc.screenMap, (s) => [s.productId, s.screen]);
  mergeById('캡처', next.captures, videoDoc.captures, (c) => [c.productId, c.path]);

  const clips = next.video?.clips ?? [];
  const findings = next.video?.findings ?? [];
  mergeById('영상', clips, incoming.clips, (c) => c);
  for (const f of incoming.findings) {
    if (!findings.some((x) => same(x, f))) findings.push(structuredClone(f));
  }
  if (conflicts.length > 0) {
    return fail(
      `같은 id인데 내용이 다르다: ${conflicts.join(', ')}. 한쪽 id를 바꾼 뒤 다시 합친다`,
    );
  }
  next.video = { clips, findings };

  const parsed = reparse(next);
  if (!parsed.ok) return parsed;
  const wanted = new Set(videoDoc.captures.map((c) => c.id));
  return ok({
    main: parsed.value,
    imagePaths: parsed.value.captures.filter((c) => wanted.has(c.id)).map((c) => c.path),
  });
}
