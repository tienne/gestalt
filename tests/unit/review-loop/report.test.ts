import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GhRunner } from '../../../src/review-loop/fetch.js';
import { readLoopState } from '../../../src/review-loop/report.js';
import { stateDir } from '../../../src/review-loop/state.js';

/**
 * 조회와 집계와 신호 도출을 잇는 자리다. 라운드 6의 critical 셋이 전부 여기서 났는데
 * (빈 로그인으로 승인이 열림, 파일 경로가 갈림, 스크립트가 안 만들어짐) 정작 이 조립을
 * 도는 테스트가 없었다.
 */
describe('판정에 쓰는 수를 만든다', () => {
  const PR = 7;
  let repo: string;
  let dir: string;

  const snapshot = (
    o: {
      state?: string;
      head?: string;
      threads?: unknown[];
      reviewers?: string[];
    } = {},
  ) =>
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            state: o.state ?? 'OPEN',
            headRefOid: o.head ?? 'newhead',
            reviewRequests: {
              nodes: (o.reviewers ?? []).map((login) => ({ requestedReviewer: { login } })),
            },
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: '' },
              nodes: o.threads ?? [],
            },
          },
        },
      },
    });

  /** 내가 열고 작성자가 아직 안 건드린 스레드 */
  const mine = (login = 'reviewer') => ({
    isResolved: false,
    isOutdated: false,
    opener: { nodes: [{ author: { login } }] },
    latest: { nodes: [{ author: { login } }] },
  });

  /** gh 호출을 종류별로 갈라 답한다. 호출 인자도 기록해 둔다 */
  const stub = (o: { graphql?: string; login?: string; repo?: string } = {}) => {
    const calls: string[][] = [];
    const run: GhRunner = (args) => {
      calls.push([...args]);
      if (args[0] === 'api' && args[1] === 'graphql') return o.graphql ?? snapshot();
      if (args[0] === 'api' && args[1] === 'user') return o.login ?? 'reviewer\n';
      if (args[0] === 'repo') return o.repo ?? JSON.stringify({ owner: { login: 'o' }, name: 'r' });
      throw new Error(`예상 못 한 호출: ${args.join(' ')}`);
    };
    return { run, calls };
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gestalt-report-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    dir = stateDir(PR, repo);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  /**
   * 첫 라운드는 비교할 이전 head 가 없다. changed 를 참으로 두면 리뷰한 적도 없는
   * 커밋을 "새 커밋이 왔다"로 읽어 재리뷰로 바로 넘어간다.
   */
  it('리뷰한 적 없으면 새 커밋이 온 게 아니다', () => {
    const r = readLoopState({ prNumber: PR, cwd: repo }, stub().run);
    expect(r.reviewedHead).toBeNull();
    expect(r.changed).toBe(false);
    expect(r.signal).toBe('REPLIES_ONLY');
  });

  it('리뷰한 head 와 다르면 새 커밋이 온 것이다', () => {
    writeFileSync(join(dir, 'reviewed-head'), 'oldhead\n');
    const r = readLoopState({ prNumber: PR, cwd: repo }, stub().run);
    expect(r.changed).toBe(true);
    expect(r.signal).toBe('READY');
  });

  it('리뷰한 head 와 같으면 코드가 그대로다', () => {
    writeFileSync(join(dir, 'reviewed-head'), 'newhead\n');
    const r = readLoopState({ prNumber: PR, cwd: repo }, stub().run);
    expect(r.changed).toBe(false);
    expect(r.signal).toBe('REPLIES_ONLY');
  });

  it('비어 있는 reviewed-head 는 없는 것으로 본다', () => {
    writeFileSync(join(dir, 'reviewed-head'), '\n');
    expect(readLoopState({ prNumber: PR, cwd: repo }, stub().run).reviewedHead).toBeNull();
  });

  it('닫힌 PR 은 다른 값을 볼 것도 없이 끝이다', () => {
    writeFileSync(join(dir, 'reviewed-head'), 'oldhead\n');
    const gh = stub({ graphql: snapshot({ state: 'MERGED', reviewers: ['reviewer'] }) });
    const r = readLoopState({ prNumber: PR, cwd: repo }, gh.run);
    expect(r.open).toBe(false);
    expect(r.signal).toBe('CLOSED');
  });

  it('재리뷰 요청이 들어와 있으면 미대응이 남아도 간다', () => {
    const gh = stub({ graphql: snapshot({ threads: [mine(), mine()], reviewers: ['reviewer'] }) });
    const r = readLoopState({ prNumber: PR, cwd: repo }, gh.run);
    expect(r.pending).toBe(2);
    expect(r.rerequested).toBe(true);
    expect(r.signal).toBe('REREVIEW_REQUESTED');
  });

  it('미대응이 남으면 기다린다', () => {
    const gh = stub({ graphql: snapshot({ threads: [mine()] }) });
    expect(readLoopState({ prNumber: PR, cwd: repo }, gh.run).signal).toBe('WAITING');
  });

  /**
   * GitHub 로그인은 대소문자를 안 가린다. 그대로 비교하면 캐시에 적힌 철자가 응답과
   * 한 글자만 달라도 미대응이 0이 되고 승인이 열린다.
   */
  it('로그인 철자가 응답과 달라도 같은 사람으로 센다', () => {
    writeFileSync(join(dir, 'my-login'), 'Reviewer\n');
    const gh = stub({
      graphql: snapshot({ threads: [mine('reviewer')], reviewers: ['REVIEWER'] }),
    });
    const r = readLoopState({ prNumber: PR, cwd: repo }, gh.run);
    expect(r.pending).toBe(1);
    expect(r.rerequested).toBe(true);
  });

  it('캐시가 있으면 조회하지 않는다', () => {
    writeFileSync(join(dir, 'my-login'), 'reviewer\n');
    const gh = stub();
    readLoopState({ prNumber: PR, cwd: repo }, gh.run);
    expect(gh.calls.some((c) => c[1] === 'user')).toBe(false);
  });

  /**
   * 셸로 적던 때는 리다이렉트가 종료 코드를 안 봐서 인증이 끊긴 순간 0 바이트 파일이
   * 남았다. 그 뒤 모든 라운드가 빈 로그인으로 집계했다.
   */
  it('캐시가 비었으면 다시 조회한다', () => {
    writeFileSync(join(dir, 'my-login'), '');
    const gh = stub({ graphql: snapshot({ threads: [mine()] }) });
    const r = readLoopState({ prNumber: PR, cwd: repo }, gh.run);
    expect(gh.calls.some((c) => c[1] === 'user')).toBe(true);
    expect(r.pending).toBe(1);
  });

  it.each([
    ['빈 응답', '\n'],
    ['보이지 않는 문자', '​\n'],
    ['공백이 든 값', 'two words\n'],
    ['하이픈으로 시작', '-bad\n'],
  ])('조회가 %s 을 주면 0 을 내지 않고 멈춘다', (_name, login) => {
    const gh = stub({ login });
    expect(() => readLoopState({ prNumber: PR, cwd: repo }, gh.run)).toThrow(/로그인/);
  });

  /**
   * 번호만 뽑고 레포를 버리면 남의 레포 PR 을 가리켜도 현재 레포의 같은 번호를 본다.
   */
  it('레포를 주면 현재 레포를 조회하지 않는다', () => {
    const gh = stub();
    const r = readLoopState({ prNumber: PR, owner: 'cli', repo: 'cli', cwd: repo }, gh.run);
    expect(r.owner).toBe('cli');
    expect(r.repo).toBe('cli');
    expect(gh.calls.some((c) => c[0] === 'repo')).toBe(false);
  });

  it('레포를 안 주면 현재 레포를 쓴다', () => {
    const r = readLoopState({ prNumber: PR, cwd: repo }, stub().run);
    expect(`${r.owner}/${r.repo}`).toBe('o/r');
  });

  it('조회가 실패하면 수를 만들지 않는다', () => {
    const gh: GhRunner = (args) => {
      if (args[1] === 'graphql') throw new Error('rate limited');
      if (args[0] === 'repo') return JSON.stringify({ owner: { login: 'o' }, name: 'r' });
      return 'reviewer\n';
    };
    expect(() => readLoopState({ prNumber: PR, cwd: repo }, gh)).toThrow(/rate limited/);
  });
});
