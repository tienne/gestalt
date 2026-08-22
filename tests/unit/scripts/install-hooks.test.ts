import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHooks } from '../../../scripts/install-hooks.js';

/**
 * 게이트를 사람이 안 부르면 소용이 없다.
 *
 * 이 레포에서 게이트 출력을 grep에 물려 종료 코드를 삼킨 채 커밋한 일이 두 번 났다.
 * 훅이 그 자리를 막는다. 다만 훅 설치가 남의 훅을 덮으면 더 나쁜 일이 된다.
 */
describe('pre-commit 훅 설치', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), `gestalt-hooks-${randomUUID().slice(0, 8)}-`));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('git 저장소가 아니면 아무것도 안 한다', () => {
    expect(installHooks(dir)).toBe('skipped');
  });

  it('훅을 설치하고 실행 권한을 준다', () => {
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });

    expect(installHooks(dir)).toBe('installed');

    const hook = readFileSync(join(dir, '.git', 'hooks', 'pre-commit'), 'utf-8');
    expect(hook).toContain('pnpm verify:rules');
    expect(hook).toContain('pnpm lint');
    expect(hook).toContain('pnpm format:check');
    // set -e가 없으면 앞 명령이 실패해도 훅이 0으로 끝나 커밋이 통과한다
    expect(hook).toContain('set -e');
  });

  it('남이 둔 훅은 안 덮는다', () => {
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    const path = join(dir, '.git', 'hooks', 'pre-commit');
    writeFileSync(path, '#!/bin/sh\necho 남의 훅\n', 'utf-8');
    chmodSync(path, 0o755);

    expect(installHooks(dir)).toBe('kept');
    expect(readFileSync(path, 'utf-8')).toContain('남의 훅');
  });

  it('우리가 둔 훅은 갱신한다', () => {
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    installHooks(dir);

    expect(installHooks(dir)).toBe('installed');
  });
});
