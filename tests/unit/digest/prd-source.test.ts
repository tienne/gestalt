import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyLines,
  MAX_SOURCE_BYTES,
  numberedText,
  readPrdSource,
  sourceFromText,
} from '../../../src/digest/prd-source.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
function tmp(): string {
  const d = resolve('.gestalt-test', `prd-source-${randomUUID()}`);
  mkdirSync(d, { recursive: true });
  dirs.push(d);
  return d;
}

describe('prd 원문 읽기', () => {
  it('CRLF와 LF는 같은 줄과 같은 해시가 된다', () => {
    const a = sourceFromText('a', 'x\ny\n');
    const b = sourceFromText('a', 'x\r\ny\r\n');
    expect(a.lines).toEqual(['x', 'y']);
    expect(b.lines).toEqual(a.lines);
    expect(b.sha256).toBe(a.sha256);
  });

  it('줄을 내용 줄과 아닌 줄로 가른다', () => {
    const lines = [
      '---',
      'k: v',
      '---',
      '# 제목',
      '| | |',
      '|:---|---:|',
      '| a | b |',
      '',
      '<details>',
      '<details><summary>펼치기</summary>',
      '```ts',
      'const x = 1;',
      '```',
      '***',
      '본문',
    ];
    expect(classifyLines(lines)).toEqual([
      'frontmatter',
      'frontmatter',
      'frontmatter',
      'headingOnly',
      'tableEmptyHead',
      'tableSep',
      'content',
      'blank',
      'htmlOnly',
      'content',
      'fence',
      'content',
      'fence',
      'rule',
      'content',
    ]);
  });

  it('긴 줄은 600자에서 자르고 400줄씩 끊어 nextFrom을 준다', () => {
    const lines = Array.from({ length: 450 }, (_, k) => (k === 0 ? 'x'.repeat(700) : `줄 ${k}`));
    const page = numberedText(lines, 1, 450);
    expect(page.to).toBe(400);
    expect(page.nextFrom).toBe(401);
    expect(page.truncatedLines).toEqual([1]);
    expect(page.text.split('\n')[0]).toMatch(/^ {2}1: x{600}…$/);
    const rest = numberedText(lines, 401, 450);
    expect(rest.nextFrom).toBeNull();
  });

  it('2MB 초과와 NUL, 없는 파일을 거절한다', () => {
    const d = tmp();
    const big = join(d, 'big.md');
    writeFileSync(big, 'a'.repeat(MAX_SOURCE_BYTES + 1));
    const bin = join(d, 'bin.md');
    writeFileSync(bin, Buffer.from([0x61, 0, 0x62]));
    expect(readPrdSource(big)).toMatchObject({ ok: false, code: 'SOURCE_TOO_LARGE' });
    expect(readPrdSource(bin)).toMatchObject({ ok: false, code: 'SOURCE_NOT_TEXT' });
    expect(readPrdSource(join(d, 'none.md'))).toMatchObject({
      ok: false,
      code: 'SOURCE_NOT_FOUND',
    });
  });
});
