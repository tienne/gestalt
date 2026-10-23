import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DigestStore, isValidSlug, slugFromMeta } from '../../../src/digest/index.js';
import { SLUG, sampleDigest, sampleTranscript } from './fixture.js';

const tmpDirs: string[] = [];

function tmpRepo(): string {
  const dir = resolve('.gestalt-test', `digest-store-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('slugFromMeta', () => {
  it('영문 제목은 줄이고 videoId를 붙인다', () => {
    expect(slugFromMeta('ukY9Dvwm7Gc', 'Design with Code Layers | Figma')).toBe(
      'design-with-code-layers-figma-uky9dvwm7gc',
    );
  });

  it('한국어 제목은 videoId만 남는다', () => {
    expect(slugFromMeta('abcDEF12345', '코드 레이어로 디자인하기')).toBe('abcdef12345');
  });

  it('길어도 패턴 안으로 자른다', () => {
    const slug = slugFromMeta('ukY9Dvwm7Gc', 'a very long title '.repeat(10));
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(isValidSlug(slug)).toBe(true);
    expect(slug.endsWith('-uky9dvwm7gc')).toBe(true);
  });
});

describe('DigestStore', () => {
  it('상대 경로로 받아도 root는 절대 경로다', () => {
    const store = new DigestStore('.gestalt-test');
    expect(isAbsolute(store.root)).toBe(true);
    expect(store.root).toBe(resolve('.gestalt-test', '.gestalt', 'digest'));
  });

  it('경로 조각이 될 수 없는 slug는 거절한다', () => {
    const store = new DigestStore(tmpRepo());
    expect(() => store.dir('../etc')).toThrow();
    expect(() => store.dir('A')).toThrow();
  });

  it('저장하고 다시 읽는다. 임시 파일은 남지 않는다', () => {
    const store = new DigestStore(tmpRepo());
    store.saveTranscript(sampleTranscript());
    store.saveDigest(sampleDigest());
    const t = store.readTranscript(SLUG);
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.transcript.segments).toHaveLength(12);
    expect(store.loadDigest(SLUG)?.slug).toBe(SLUG);
    expect(readdirSync(store.dir(SLUG)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('깨진 digest.json은 옮기지 않고 그대로 둔다', () => {
    const store = new DigestStore(tmpRepo());
    mkdirSync(store.dir(SLUG), { recursive: true });
    writeFileSync(store.digestPath(SLUG), '{ broken', 'utf-8');
    expect(store.readDigestFile(SLUG).kind).toBe('invalid-json');
    expect(store.loadDigest(SLUG)).toBeNull();
    expect(readdirSync(store.dir(SLUG))).toEqual(['digest.json']);
  });

  it('없으면 TRANSCRIPT_NOT_FOUND', () => {
    expect(new DigestStore(tmpRepo()).readTranscript(SLUG)).toMatchObject({
      ok: false,
      code: 'TRANSCRIPT_NOT_FOUND',
    });
  });

  it('형식이 틀린 transcript.json은 옮기지 않고 이유와 다시 받으라는 안내를 준다', () => {
    const store = new DigestStore(tmpRepo());
    const t = sampleTranscript();
    t.meta.url = 'javascript:alert(1)';
    mkdirSync(store.dir(SLUG), { recursive: true });
    writeFileSync(store.transcriptPath(SLUG), JSON.stringify(t), 'utf-8');
    const r = store.readTranscript(SLUG);
    expect(r).toMatchObject({ ok: false, code: 'TRANSCRIPT_INVALID' });
    if (r.ok) return;
    expect(r.message).toContain('meta.url');
    expect(r.message).toContain('ingest');
    expect(readdirSync(store.dir(SLUG))).toEqual(['transcript.json']);

    writeFileSync(store.transcriptPath(SLUG), '{', 'utf-8');
    expect(store.readTranscript(SLUG)).toMatchObject({ ok: false, code: 'TRANSCRIPT_INVALID' });
    expect(readdirSync(store.dir(SLUG))).toEqual(['transcript.json']);
  });
});
