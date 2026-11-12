import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { existingRepoContext, repoContextPath } from '../../../src/conductor/context.js';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

describe('repoContextPath', () => {
  it('상태 저장소 아래 context/<owner>/<name>.md를 돌려준다', () => {
    expect(repoContextPath('/state', 'acme/app')).toBe(join('/state', 'context', 'acme', 'app.md'));
  });

  it('owner/name 꼴이 아니거나 . 이나 .. 이면 거절한다', () => {
    expect(() => repoContextPath('/state', 'acme')).toThrow('owner/name');
    expect(() => repoContextPath('/state', '../x')).toThrow('레포 이름으로 쓸 수 없어요');
    expect(() => repoContextPath('/state', 'acme/..')).toThrow('레포 이름으로 쓸 수 없어요');
    expect(() => repoContextPath('/state', 'acme/.')).toThrow('레포 이름으로 쓸 수 없어요');
  });
});

describe('existingRepoContext', () => {
  it('일반 파일이 있을 때만 경로를 돌려준다', () => {
    dir = mkdtempSync(join(tmpdir(), 'gestalt-context-'));
    expect(existingRepoContext(dir, 'acme/app')).toBeUndefined();

    mkdirSync(join(dir, 'context', 'acme', 'app.md'), { recursive: true });
    expect(existingRepoContext(dir, 'acme/app')).toBeUndefined();

    writeFileSync(join(dir, 'context', 'acme', 'web.md'), '- 태그 푸시로 배포한다\n');
    expect(existingRepoContext(dir, 'acme/web')).toBe(join(dir, 'context', 'acme', 'web.md'));
  });
});
