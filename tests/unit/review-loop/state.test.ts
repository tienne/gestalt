import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stateDir } from '../../../src/review-loop/state.js';

/**
 * 상태 자리가 어긋나면 라운드가 지난 실행의 값을 읽는다. 이 모듈이 그걸 막는 유일한
 * 자리인데 여덟 라운드 동안 테스트가 없었다.
 */
describe('라운드 상태를 두는 자리', () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'gestalt-statedir-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    mkdirSync(join(repo, 'nested', 'deeper'), { recursive: true });
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('git 디렉토리 아래에 PR 번호로 가른다', () => {
    const dir = stateDir(18, repo);
    expect(dir.endsWith(join('gestalt-review-loop', 'pr-18'))).toBe(true);
    expect(dir).toContain('.git');
  });

  /**
   * 레포 루트에서 부르면 git 이 `.git` 이라는 상대 경로를 준다. 그대로 두면 cwd 가 바뀐
   * 단계에서 다른 자리를 가리켜 앞 라운드가 쓴 파일을 못 찾는다.
   */
  it('어느 디렉토리에서 불러도 같은 절대 경로가 나온다', () => {
    const fromRoot = stateDir(18, repo);
    const fromNested = stateDir(18, join(repo, 'nested', 'deeper'));
    expect(fromNested).toBe(fromRoot);
    expect(resolve(fromRoot)).toBe(fromRoot);
  });

  it('PR 번호가 다르면 자리도 다르다', () => {
    expect(stateDir(18, repo)).not.toBe(stateDir(19, repo));
  });

  /**
   * 이 값이 경로 조각이 되므로 정수가 아니면 `.git` 밖을 가리키거나 이름이 깨진다.
   */
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])('%p 는 거부한다', (bad) => {
    expect(() => stateDir(bad, repo)).toThrow(/양의 정수/);
  });
});
