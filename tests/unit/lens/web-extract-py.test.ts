import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LENS_VENV } from '../../../src/lens/python.js';
import { WEB_EXTRACT_PY } from '../../../src/lens/web-extract-py.js';

const python = join(LENS_VENV, 'bin', 'python');
// trafilatura는 렌즈 가상환경에만 있다. 없는 머신에서는 건너뛴다
const hasTrafilatura = (() => {
  if (!existsSync(python)) return false;
  try {
    execFileSync(python, ['-I', '-c', 'import trafilatura'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PARA =
  'Food pairing is a method of identifying which foods go well together from a flavor standpoint, and chefs have written about it for a long time.';
const HTML = `<!doctype html><html><head><title>Pairing</title></head><body><nav><a href="/">Home</a></nav><main><article>
<h1>Food pairing</h1><p>${PARA}</p><p>${PARA} It became popular in the early 2000s.</p>
<h2>Examples</h2><p>Pairings where the flavors of two foods complement one another include:</p>
<ul><li><a href="/a">Bacon and cabbage</a></li><li><a href="/b">Chocolate milk</a></li><li><a href="/c">Ham and eggs</a></li></ul>
<h2>Science</h2><p>${PARA} Some studies disagree with the hypothesis.</p></article></main></body></html>`;

describe.skipIf(!hasTrafilatura)('웹 글 추출 스크립트', () => {
  it('trafilatura가 버린 링크 목록을 원문 HTML에서 되살린다', () => {
    const dir = resolve('.gestalt-test', `lens-web-py-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    const page = join(dir, 'page.html');
    writeFileSync(page, HTML);
    const out = execFileSync(
      python,
      ['-I', '-c', WEB_EXTRACT_PY, page, 'https://example.com/pairing'],
      {
        cwd: dir,
        encoding: 'utf-8',
      },
    );
    const x = JSON.parse(out.trim().split('\n').pop()!) as {
      units: Array<{ text: string; rescued?: boolean }>;
    };
    const at = x.units.findIndex((u) => u.text.endsWith('include:'));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(x.units[at + 1]?.text).toBe('Bacon and cabbage / Chocolate milk / Ham and eggs');
  });
});
