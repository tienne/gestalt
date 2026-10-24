import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { frameFileName } from '../../../src/digest/frames.js';
import {
  DigestLintError,
  DigestLoadError,
  exportMarkdown,
  renderToFiles,
} from '../../../src/digest/render.js';
import { DigestStore } from '../../../src/digest/store.js';
import { SLUG, sampleDigest, sampleTranscript } from './fixture.js';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seeded(mutate?: (d: ReturnType<typeof sampleDigest>) => void) {
  const repo = resolve('.gestalt-test', `digest-render-files-${randomUUID()}`);
  mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  const store = new DigestStore(repo);
  store.saveTranscript(sampleTranscript());
  const d = sampleDigest();
  mutate?.(d);
  store.saveDigest(d);
  return { repo, store };
}

describe('exportMarkdown --out', () => {
  it('다른 폴더에 쓰면 프레임 경로를 그 파일 기준으로 잡고 없는 부모 폴더를 만든다', () => {
    const { repo, store } = seeded();
    const framesDir = store.framesDir(SLUG);
    mkdirSync(framesDir, { recursive: true });
    writeFileSync(join(framesDir, frameFileName(0)), 'jpg');

    const out = join(repo, 'notes', 'deep', 'video.md');
    const r = exportMarkdown(SLUG, { repoRoot: repo, out });
    expect(r.mdPath).toBe(out);
    const md = readFileSync(out, 'utf-8');
    const href = `${relative(dirname(out), framesDir)}/${frameFileName(0)}`;
    expect(md).toContain(`](${href})`);
    expect(existsSync(resolve(dirname(out), href))).toBe(true);
  });

  it('슬러그 폴더에 쓰면 frames/ 상대 경로 그대로다', () => {
    const { repo, store } = seeded();
    mkdirSync(store.framesDir(SLUG), { recursive: true });
    writeFileSync(join(store.framesDir(SLUG), frameFileName(0)), 'jpg');
    const r = exportMarkdown(SLUG, { repoRoot: repo });
    expect(readFileSync(r.mdPath, 'utf-8')).toContain(`](frames/${frameFileName(0)})`);
  });
});

describe('렌더 차단 오류', () => {
  it('lint 오류는 DigestLintError로 전부 싣는다', () => {
    const { repo } = seeded((d) => {
      d.report.sections[0]!.cite = { key: 50, from: 50, to: 50 };
    });
    let caught: unknown;
    try {
      renderToFiles(SLUG, { repoRoot: repo });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DigestLintError);
    const issues = (caught as DigestLintError).issues;
    expect(issues.every((i) => i.severity === 'error')).toBe(true);
    expect((caught as Error).message).toContain(`validate 오류 ${issues.length}개`);
  });

  it('없는 digest.json은 DigestLoadError(DIGEST_NOT_FOUND)다', () => {
    const { repo, store } = seeded();
    rmSync(store.digestPath(SLUG));
    expect(() => renderToFiles(SLUG, { repoRoot: repo })).toThrow(DigestLoadError);
    try {
      renderToFiles(SLUG, { repoRoot: repo });
    } catch (e) {
      expect((e as DigestLoadError).code).toBe('DIGEST_NOT_FOUND');
    }
  });
});
