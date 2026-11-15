import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PRD_HTML_MARKER,
  PrdViewStore,
  resolveOutDir,
  slugFromSource,
  writeHtmlTo,
} from '../../../src/digest/prd-store.js';
import { SLUG_PATTERN } from '../../../src/digest/schema-base.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
function tmp(): string {
  const d = resolve('.gestalt-test', `prd-store-${randomUUID()}`);
  mkdirSync(d, { recursive: true });
  dirs.push(d);
  return d;
}
const html = `${PRD_HTML_MARKER}\n<p>뷰</p>`;

describe('PrdViewStore', () => {
  it('경로를 벗어나는 slug는 throw한다', () => {
    expect(() => new PrdViewStore(tmp()).dir('../x')).toThrow();
  });

  it('slugFromSource는 slug 패턴을 지키고 경로가 다르면 달라진다', () => {
    const a = slugFromSource('/a/PRD.md');
    expect(a).toMatch(SLUG_PATTERN);
    expect(a.startsWith('prd-')).toBe(true);
    expect(slugFromSource('/b/PRD.md')).not.toBe(a);
    expect(slugFromSource('/a/기획서.md')).toMatch(/^prd-[0-9a-f]{6}$/);
  });
});

describe('resolveOutDir', () => {
  it('상대 경로는 repoRoot 기준으로 풀고 없으면 만든다', () => {
    const root = tmp();
    const r = resolveOutDir(root, 'out/view');
    expect(r).toEqual({ ok: true, dir: join(root, 'out', 'view') });
    expect(existsSync(join(root, 'out', 'view'))).toBe(true);
    const absDir = join(root, 'abs');
    expect(resolveOutDir('/elsewhere', absDir)).toEqual({ ok: true, dir: absDir });
  });

  it('빈 값과 파일 경로를 거절한다', () => {
    const root = tmp();
    writeFileSync(join(root, 'f'), 'x');
    expect(resolveOutDir(root, ' ')).toMatchObject({ ok: false, code: 'INVALID_OUT_DIR' });
    expect(resolveOutDir(root, 'f')).toMatchObject({ ok: false, code: 'OUT_DIR_NOT_DIRECTORY' });
  });
});

describe('writeHtmlTo', () => {
  it('표시가 없는 index.html은 overwrite일 때만 덮는다', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'index.html'), '<html>앱</html>');
    expect(writeHtmlTo(dir, html)).toMatchObject({ ok: false, code: 'OUT_FILE_EXISTS' });
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe('<html>앱</html>');
    expect(writeHtmlTo(dir, html, { overwrite: true })).toMatchObject({ ok: true });
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe(html);
  });

  it('우리가 쓴 파일은 그냥 갱신한다', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'index.html'), `${PRD_HTML_MARKER}\n옛 뷰`);
    expect(writeHtmlTo(dir, html)).toMatchObject({ ok: true });
  });

  it('심볼릭 링크는 overwrite여도 쓰지 않는다', () => {
    const dir = tmp();
    const target = join(dir, 'target.html');
    writeFileSync(target, 'x');
    symlinkSync(target, join(dir, 'index.html'));
    expect(writeHtmlTo(dir, html, { overwrite: true })).toMatchObject({
      ok: false,
      code: 'OUT_FILE_EXISTS',
    });
    expect(readFileSync(target, 'utf8')).toBe('x');
  });
});
