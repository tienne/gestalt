import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  lensSourceForLint,
  lensSourcePath,
  readLensSource,
  readLensSourceResult,
  sourcePageSchema,
  sourceTableSchema,
} from '../../../src/digest/lens-source.js';
import { DigestStore } from '../../../src/digest/store.js';
import { LENS_SLUG, lensSource } from './fixture.js';

const tmpDirs: string[] = [];

function makeStore(): DigestStore {
  const repo = resolve('.gestalt-test', `lens-source-${randomUUID()}`);
  tmpDirs.push(repo);
  const store = new DigestStore(repo);
  mkdirSync(store.dir(LENS_SLUG), { recursive: true });
  return store;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('source.json 자산 경로', () => {
  const page = (image: string) =>
    sourcePageSchema.safeParse({ n: 1, width: 595, height: 842, image }).success;

  it('추출기가 쓰는 꼴은 받는다', () => {
    expect(page('pages/p1.jpg')).toBe(true);
    expect(page('figures/figure-1.png')).toBe(true);
    expect(page('tables/table-4.png')).toBe(true);
  });

  it('폴더 밖이나 다른 확장자, 다른 폴더를 가리키면 실패한다', () => {
    for (const bad of [
      '../x.png',
      'pages/../../a.png',
      'pages/p1.gif',
      'a/b.png',
      '/etc/p1.png',
      'pages/sub/p1.png',
    ]) {
      expect(page(bad)).toBe(false);
    }
  });

  it('표 크롭 경로도 같은 규칙을 받는다', () => {
    const table = { ...lensSource().tables[0]!, image: 'tables/../../t.png' };
    expect(sourceTableSchema.safeParse(table).success).toBe(false);
  });
});

describe('source.json 읽기', () => {
  it('없으면 missing, 형식이 틀리면 invalid, 맞으면 ok', () => {
    const store = makeStore();
    expect(readLensSourceResult(store, LENS_SLUG)).toEqual({ kind: 'missing' });
    expect(lensSourceForLint(store, LENS_SLUG)).toEqual({ source: null, sourceProblem: 'missing' });

    writeFileSync(lensSourcePath(store, LENS_SLUG), '{not json');
    expect(readLensSourceResult(store, LENS_SLUG).kind).toBe('invalid');

    const broken = { ...lensSource(), pages: [{ n: 1, width: 1, height: 1, image: '../x.png' }] };
    writeFileSync(lensSourcePath(store, LENS_SLUG), JSON.stringify(broken));
    const invalid = readLensSourceResult(store, LENS_SLUG);
    expect(invalid.kind).toBe('invalid');
    if (invalid.kind === 'invalid') expect(invalid.message).toContain('pages.0.image');
    expect(readLensSource(store, LENS_SLUG)).toBeNull();
    expect(lensSourceForLint(store, LENS_SLUG)).toEqual({ source: null, sourceProblem: 'invalid' });

    writeFileSync(lensSourcePath(store, LENS_SLUG), JSON.stringify(lensSource()));
    expect(readLensSourceResult(store, LENS_SLUG).kind).toBe('ok');
    expect(readLensSource(store, LENS_SLUG)?.tables).toHaveLength(2);
    expect(lensSourceForLint(store, LENS_SLUG).sourceProblem).toBeUndefined();
  });
});
