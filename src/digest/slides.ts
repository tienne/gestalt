import { readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { lensSourceSchema, type LensSource } from './lens-source.js';
import { isLensKind, parseTranscript, type Cite, type Transcript } from './schema.js';
import { SLIDE_SOURCE_PATTERN } from './schema-base.js';
import { readRaw, type DigestStore } from './store.js';

export interface SlideSource {
  transcript: Transcript;
  source: LensSource;
}

export interface SlideContext {
  slides: ReadonlyMap<string, SlideSource>;
  slidesFailed: boolean;
}

export const SLIDE_STATUS_FILE = 'slides-status.json';
export const SLIDES_FAILED_NOTICE =
  '슬라이드 PDF를 수집하지 못했어요. 이번 수집에는 영상 스크립트만 사용할 수 있어요.';

export function readSlideContext(store: DigestStore, slug: string): SlideContext {
  const dir = store.dir(slug);
  const slides = new Map<string, SlideSource>();
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !SLIDE_SOURCE_PATTERN.test(entry.name)) continue;
    const transcript = readRaw(join(dir, entry.name, 'transcript.json'));
    const source = readRaw(join(dir, entry.name, 'source.json'));
    if (transcript.kind !== 'ok' || source.kind !== 'ok') continue;
    const t = parseTranscript(transcript.value);
    const s = lensSourceSchema.safeParse(source.value);
    if (
      t.ok &&
      s.success &&
      t.value.slug === s.data.slug &&
      t.value.meta.source === 'pdf' &&
      s.data.kind === 'pdf'
    ) {
      slides.set(entry.name, { transcript: t.value, source: s.data });
    }
  }
  const status = readRaw(join(dir, SLIDE_STATUS_FILE));
  return { slides, slidesFailed: status.kind === 'ok' && status.value === 'failed' };
}

export function citeTranscript(
  cite: Cite,
  primary: Transcript,
  slides: SlideContext['slides'] | undefined,
): Transcript | undefined {
  return cite.source === undefined
    ? primary
    : isLensKind(primary.meta.source)
      ? undefined
      : slides?.get(cite.source)?.transcript;
}
