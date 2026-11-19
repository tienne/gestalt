import { describe, expect, it } from 'vitest';
import {
  githubSlugOf,
  INTERNAL_VISIBILITY_VERDICT,
  resolveRepoVisibility,
} from '../../../src/architecture/repo-visibility.js';

const ROOT = '/repo';
const REMOTE = 'git@github.com:acme/widgets.git';

function gh(visibility: string) {
  return () => JSON.stringify({ visibility });
}

describe('resolveRepoVisibility', () => {
  it('PRIVATE면 비공개로 본다', () => {
    const calls: string[] = [];
    const r = resolveRepoVisibility(ROOT, {
      readRemoteUrl: () => REMOTE,
      ghRepoView: (slug) => {
        calls.push(slug);
        return JSON.stringify({ visibility: 'PRIVATE' });
      },
    });
    expect(r).toEqual({ verdict: 'private', source: 'gh', visibility: 'PRIVATE' });
    expect(calls).toEqual(['acme/widgets']);
  });

  it('PUBLIC이면 공개로 본다', () => {
    const r = resolveRepoVisibility(ROOT, {
      readRemoteUrl: () => REMOTE,
      ghRepoView: gh('PUBLIC'),
    });
    expect(r).toEqual({ verdict: 'public', source: 'gh', visibility: 'PUBLIC' });
  });

  it('INTERNAL은 한 상수로 정한 쪽을 따른다(지금은 비공개)', () => {
    const r = resolveRepoVisibility(ROOT, {
      readRemoteUrl: () => REMOTE,
      ghRepoView: gh('INTERNAL'),
    });
    expect(INTERNAL_VISIBILITY_VERDICT).toBe('private');
    expect(r).toEqual({
      verdict: INTERNAL_VISIBILITY_VERDICT,
      source: 'gh',
      visibility: 'INTERNAL',
    });
  });

  it('gh가 실패하면 공개로 보고 던지지 않는다', () => {
    const r = resolveRepoVisibility(ROOT, {
      readRemoteUrl: () => REMOTE,
      ghRepoView: () => {
        throw new Error('spawnSync gh ENOENT');
      },
    });
    expect(r).toEqual({ verdict: 'public', source: 'fallback', fallbackReason: 'gh_failed' });
  });

  it('원격이 없으면 gh를 부르지 않고 공개로 본다', () => {
    let called = false;
    const r = resolveRepoVisibility(ROOT, {
      readRemoteUrl: () => null,
      ghRepoView: () => {
        called = true;
        return '';
      },
    });
    expect(r).toEqual({ verdict: 'public', source: 'fallback', fallbackReason: 'no_remote' });
    expect(called).toBe(false);
  });

  it('원격 읽기가 던져도 원격 없음으로 본다', () => {
    const r = resolveRepoVisibility(ROOT, {
      readRemoteUrl: () => {
        throw new Error('not a git repository');
      },
      ghRepoView: gh('PRIVATE'),
    });
    expect(r.fallbackReason).toBe('no_remote');
    expect(r.verdict).toBe('public');
  });

  it.each([
    'https://gitlab.com/acme/widgets.git',
    'git@bitbucket.org:acme/widgets.git',
    '/srv/git/widgets.git',
  ])('GitHub 밖 원격 %s 는 공개로 본다', (remote) => {
    const r = resolveRepoVisibility(ROOT, {
      readRemoteUrl: () => remote,
      ghRepoView: gh('PRIVATE'),
    });
    expect(r).toEqual({
      verdict: 'public',
      source: 'fallback',
      fallbackReason: 'non_github_remote',
    });
  });

  it('gh 출력을 못 읽으면 공개로 본다', () => {
    const r = resolveRepoVisibility(ROOT, {
      readRemoteUrl: () => REMOTE,
      ghRepoView: () => 'not json',
    });
    expect(r.fallbackReason).toBe('gh_bad_output');
    expect(r.verdict).toBe('public');
  });

  it('모르는 visibility 값은 공개로 본다', () => {
    const r = resolveRepoVisibility(ROOT, {
      readRemoteUrl: () => REMOTE,
      ghRepoView: gh('SECRET_PLAN'),
    });
    expect(r).toMatchObject({ verdict: 'public', fallbackReason: 'unknown_visibility' });
  });
});

describe('githubSlugOf', () => {
  it.each([
    ['git@github.com:acme/widgets.git', 'acme/widgets'],
    ['https://github.com/acme/widgets', 'acme/widgets'],
    ['https://token@github.com/acme/widgets.git/', 'acme/widgets'],
    ['ssh://git@github.com/acme/widgets.git', 'acme/widgets'],
    ['ssh://git@github.com:443/acme/my.repo.git', 'acme/my.repo'],
  ])('%s → %s', (url, slug) => {
    expect(githubSlugOf(url)).toBe(slug);
  });

  it.each([
    'https://github.example.com/acme/widgets',
    'https://github.com/acme',
    'https://github.com/-x/widgets',
    'https://github.com/acme/widgets/extra',
  ])('%s 는 읽지 않는다', (url) => {
    expect(githubSlugOf(url)).toBeNull();
  });
});
