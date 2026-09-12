import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stateDir, stateRoot } from '../../../src/review-loop/state.js';

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

  const at = (o: Partial<{ owner: string; repo: string; prNumber: number }> = {}) => ({
    owner: 'o',
    repo: 'r',
    prNumber: 18,
    ...o,
  });

  it('git 디렉토리 아래에 레포와 번호로 가른다', () => {
    const dir = stateDir(at(), repo);
    expect(dir.endsWith(join('gestalt-review-loop', 'o--r--18'))).toBe(true);
    expect(dir).toContain('.git');
  });

  /**
   * 번호만으로 가르면 남의 레포 PR 을 볼 때 이쪽 같은 번호와 자리를 나눠 쓴다. 그
   * reviewed-head 로 새 커밋이 왔는지 보는 순간 재리뷰 판정이 뒤집힌다.
   */
  it('레포가 다르면 같은 번호라도 자리가 갈린다', () => {
    expect(stateDir(at({ owner: 'cli', repo: 'cli' }), repo)).not.toBe(stateDir(at(), repo));
  });

  it('뿌리는 번호를 몰라도 낸다 — 대상 파일을 둘 자리다', () => {
    const root = stateRoot(repo);
    expect(root.endsWith('gestalt-review-loop')).toBe(true);
    expect(stateDir(at(), repo).startsWith(root)).toBe(true);
  });

  it.each([
    ['경로를 벗어나는 레포', { owner: '../../etc' }],
    ['구분자가 든 레포', { repo: 'a/b' }],
    ['빈 레포', { repo: '' }],
    ['점으로 시작', { owner: '.hidden' }],
  ])('%s 는 거부한다', (_name, bad) => {
    expect(() => stateDir(at(bad), repo)).toThrow(/레포/);
  });

  /**
   * 레포 루트에서 부르면 git 이 `.git` 이라는 상대 경로를 준다. 그대로 두면 cwd 가 바뀐
   * 단계에서 다른 자리를 가리켜 앞 라운드가 쓴 파일을 못 찾는다.
   */
  it('어느 디렉토리에서 불러도 같은 절대 경로가 나온다', () => {
    const fromRoot = stateDir(at(), repo);
    const fromNested = stateDir(at(), join(repo, 'nested', 'deeper'));
    expect(fromNested).toBe(fromRoot);
    expect(resolve(fromRoot)).toBe(fromRoot);
  });

  it('PR 번호가 다르면 자리도 다르다', () => {
    expect(stateDir(at(), repo)).not.toBe(stateDir(at({ prNumber: 19 }), repo));
  });

  /**
   * 이 값이 경로 조각이 되므로 정수가 아니면 `.git` 밖을 가리키거나 이름이 깨진다.
   */
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])('%p 는 거부한다', (bad) => {
    expect(() => stateDir(at({ prNumber: bad }), repo)).toThrow(/양의 정수/);
  });
});
