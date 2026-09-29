import { describe, expect, it } from 'vitest';
import {
  classifyGhFailure,
  createGithubSearchBackend,
  GH_SEARCH_LIMITATIONS,
  resolveGithubOwner,
} from '../../../src/harness-review/github-backend.js';

function ghFailing(stderr: string) {
  return () => {
    throw Object.assign(new Error('Command failed: gh'), { stderr });
  };
}

describe('GitHub 검색 백엔드', () => {
  it('성공 응답을 hits로 바꾸고 limitations를 싣는다', () => {
    let seen: readonly string[] = [];
    const backend = createGithubSearchBackend((args) => {
      seen = args;
      return JSON.stringify([
        {
          path: 'a/SKILL.md',
          repository: { nameWithOwner: 'acme/widget-kit' },
          textMatches: [{ fragment: 'foo' }],
        },
        { path: 'x' },
      ]);
    });
    const out = backend.search('rule-A1', { owner: 'acme' });
    expect(out).toMatchObject({
      status: 'ok',
      hits: [{ repo: 'acme/widget-kit', path: 'a/SKILL.md', fragments: ['foo'] }],
    });
    expect(out.limitations).toEqual(GH_SEARCH_LIMITATIONS);
    expect(seen.slice(0, 3)).toEqual(['search', 'code', 'rule-A1']);
    expect(backend.kind).toBe('githubSearch');
  });

  it.each([
    ['notLoggedIn', 'To get started with GitHub CLI, please run:  gh auth login'],
    ['noPermission', 'HTTP 404: Not Found (https://api.github.com/search/code)'],
    ['rateLimited', 'HTTP 403: API rate limit exceeded for user ID 1'],
    ['rateLimited', 'HTTP 403: You have exceeded a secondary rate limit'],
  ] as const)('%s 를 가른다', (reason, stderr) => {
    const backend = createGithubSearchBackend(ghFailing(stderr));
    const out = backend.search('q', { owner: 'acme' });
    expect(out).toMatchObject({ status: 'blocked', reason });
    expect(out.limitations.length).toBeGreaterThan(0);
  });

  it('속도 제한이면 rateLimitState를 남긴다', () => {
    const backend = createGithubSearchBackend(ghFailing('HTTP 403: rate limit'));
    backend.search('q', { owner: 'acme' });
    expect(backend.rateLimitState).toHaveProperty('blockedAt');
  });

  it('원격이 없으면 gh를 부르지 않고 막힘으로 돌려준다', () => {
    let called = false;
    const backend = createGithubSearchBackend(() => {
      called = true;
      return '[]';
    });
    expect(backend.search('q', { owner: null })).toMatchObject({
      status: 'blocked',
      reason: 'noGitHubRemote',
    });
    expect(called).toBe(false);
  });

  it('깨진 응답이어도 예외로 죽지 않는다', () => {
    const backend = createGithubSearchBackend(() => 'not json');
    expect(backend.search('q', { owner: 'acme' }).status).toBe('blocked');
  });

  it('classifyGhFailure는 모르는 출력에 null', () => {
    expect(classifyGhFailure('boom')).toBeNull();
  });

  it('resolveGithubOwner', () => {
    expect(resolveGithubOwner('/r', () => 'git@github.com:acme/widget-kit.git\n')).toBe('acme');
    expect(resolveGithubOwner('/r', () => 'https://github.com/acme/widget-kit\n')).toBe('acme');
    expect(resolveGithubOwner('/r', () => 'https://gitlab.example.com/acme/x.git')).toBeNull();
    expect(
      resolveGithubOwner('/r', () => {
        throw new Error('no remote');
      }),
    ).toBeNull();
  });
});
