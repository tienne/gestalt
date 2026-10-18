import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkLineExcerpt,
  readSourceLines,
  resolveInsideRoot,
  type SourceFileCache,
} from '../../../src/core/source-location.js';

const tmpRoot = resolve('.gestalt-test', `source-location-${randomUUID()}`);

beforeAll(() => {
  mkdirSync(tmpRoot, { recursive: true });
  writeFileSync(join(tmpRoot, 'small.ts'), 'a\nb\nc\n');
  writeFileSync(join(tmpRoot, 'big.ts'), 'x'.repeat(2_000_001));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('checkLineExcerpt', () => {
  const lines = ['import x', '', '  export function foo(a, b) {', '    return a;', '  }'];

  it('줄이 excerpt로 시작하면 match다. 앞뒤 공백과 들여쓰기는 무시한다', () => {
    expect(checkLineExcerpt(lines, 3, 'export function foo(')).toEqual({ status: 'match' });
    expect(checkLineExcerpt(lines, 3, '   export function foo(a, b) {  ')).toEqual({
      status: 'match',
    });
  });

  it('excerpt가 없거나 공백뿐이면 범위만 본다', () => {
    expect(checkLineExcerpt(lines, 2, undefined)).toEqual({ status: 'match' });
    expect(checkLineExcerpt(lines, 2, '  \n ')).toEqual({ status: 'match' });
  });

  it('줄이 밀리면 moved이고 candidates가 가까운 순으로 나온다', () => {
    const file = Array.from({ length: 30 }, (_, i) => `row ${i + 1}`);
    file[9] = 'target()';
    file[14] = 'target()';
    file[11] = 'target()';
    expect(checkLineExcerpt(file, 13, 'target()')).toEqual({
      status: 'moved',
      candidates: [12, 15, 10],
    });
  });

  it('후보는 최대 3개다', () => {
    const file = Array.from({ length: 20 }, () => 'dup');
    file[0] = 'other';
    const result = checkLineExcerpt(file, 1, 'dup');
    expect(result).toEqual({ status: 'moved', candidates: [2, 3, 4] });
  });

  it('창 밖이면 mismatch다', () => {
    const file = Array.from({ length: 500 }, (_, i) => `row ${i + 1}`);
    file[0] = 'target()';
    expect(checkLineExcerpt(file, 400, 'target()')).toEqual({ status: 'mismatch' });
    expect(checkLineExcerpt(file, 400, 'target()', { window: 500 })).toEqual({
      status: 'moved',
      candidates: [1],
    });
  });

  it('여러 줄 excerpt가 이어지는 줄과 맞는다', () => {
    expect(checkLineExcerpt(lines, 3, 'export function foo\nreturn a;')).toEqual({
      status: 'match',
    });
    const shifted = ['pad', ...lines];
    expect(checkLineExcerpt(shifted, 3, 'export function foo\nreturn a;')).toEqual({
      status: 'moved',
      candidates: [4],
    });
    expect(checkLineExcerpt(lines, 3, 'export function foo\nreturn b;')).toEqual({
      status: 'mismatch',
    });
  });

  it('줄 번호 0, 음수, 마지막 줄 다음은 out_of_range다', () => {
    expect(checkLineExcerpt(['a', 'b'], 0, undefined)).toEqual({
      status: 'out_of_range',
      lineCount: 2,
    });
    expect(checkLineExcerpt(['a', 'b'], -1, 'a')).toEqual({ status: 'out_of_range', lineCount: 2 });
    expect(checkLineExcerpt(['a', 'b'], 3, 'a')).toEqual({ status: 'out_of_range', lineCount: 2 });
  });

  it('읽지 못한 파일은 missing_file이다', () => {
    expect(checkLineExcerpt(null, 1, 'a')).toEqual({ status: 'missing_file' });
  });
});

describe('readSourceLines', () => {
  it('마지막 빈 줄은 세지 않는다', () => {
    const cache: SourceFileCache = new Map();
    expect(readSourceLines(join(tmpRoot, 'small.ts'), cache)).toEqual(['a', 'b', 'c']);
    expect(checkLineExcerpt(['a', 'b', 'c'], 4, undefined)).toMatchObject({
      status: 'out_of_range',
      lineCount: 3,
    });
  });

  it('2MB를 넘는 파일과 없는 파일은 null이다', () => {
    const cache: SourceFileCache = new Map();
    expect(readSourceLines(join(tmpRoot, 'big.ts'), cache)).toBeNull();
    expect(readSourceLines(join(tmpRoot, 'nope.ts'), cache)).toBeNull();
  });

  it('같은 파일을 두 번 물어도 한 번만 읽는다', () => {
    const cache: SourceFileCache = new Map();
    const abs = join(tmpRoot, 'small.ts');
    const first = readSourceLines(abs, cache);
    writeFileSync(abs, 'changed\n');
    expect(readSourceLines(abs, cache)).toBe(first);
    writeFileSync(abs, 'a\nb\nc\n');
  });
});

describe('resolveInsideRoot', () => {
  it('루트 안의 상대 경로는 절대 경로로 풀린다', () => {
    expect(resolveInsideRoot(tmpRoot, 'src/a.ts')).toEqual({
      ok: true,
      abs: join(tmpRoot, 'src/a.ts'),
    });
  });

  it('절대 경로와 ../ 경로는 거부한다', () => {
    expect(resolveInsideRoot(tmpRoot, '/etc/passwd')).toEqual({ ok: false, reason: 'absolute' });
    expect(resolveInsideRoot(tmpRoot, '../outside.ts')).toEqual({
      ok: false,
      reason: 'outside_root',
    });
    expect(resolveInsideRoot(tmpRoot, '.')).toEqual({ ok: false, reason: 'outside_root' });
  });
});
