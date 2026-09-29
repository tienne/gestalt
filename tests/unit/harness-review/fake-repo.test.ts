import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupFakeRepos,
  commitSeries,
  createCommitPair,
  createFakeOrg,
  createFakeRepo,
  writeIdenticalPair,
} from '../../helpers/fake-repo.js';

afterEach(cleanupFakeRepos);

describe('fake-repo 헬퍼', () => {
  it('호출마다 고유 경로에 원격이 붙은 레포를 만든다', () => {
    const a = createFakeRepo();
    const b = createFakeRepo();
    expect(a.root).not.toBe(b.root);
    expect(a.git('remote', 'get-url', 'origin').trim()).toBe(
      'https://github.com/acme/widget-kit.git',
    );
    expect(a.git('branch', '--show-current').trim()).toBe('main');
  });

  it('remote: false면 원격이 없다', () => {
    const r = createFakeRepo({ remote: false });
    expect(r.remoteUrl).toBeNull();
    expect(r.git('remote').trim()).toBe('');
  });

  it('커밋을 쌓고 브랜치와 diff를 낸다', () => {
    const r = createFakeRepo({ files: { 'a.md': 'one\n' } });
    const pair = createCommitPair(r, {
      base: { 'b.md': 'x\n' },
      head: { 'a.md': 'two\n', 'b.md': null },
      headBranch: 'pr-head',
    });
    expect(r.git('branch', '--show-current').trim()).toBe('pr-head');
    expect(pair.diff).toContain('+two');
    expect(r.changedFiles(pair.baseSha, pair.headSha).sort()).toEqual(['a.md', 'b.md']);
    r.checkout('main');
    expect(existsSync(`${r.root}/b.md`)).toBe(true);
  });

  it('같은 내용의 두 파일은 blob SHA가 같다', () => {
    const r = createFakeRepo();
    const { blobSha } = writeIdenticalPair(r, 'a/RULES.md', 'b/RULES.md', 'same\n');
    expect(r.blobSha('b/RULES.md')).toBe(blobSha);
  });

  it('조직 하나에 레포 여럿을 만든다', () => {
    const org = createFakeOrg({
      owner: 'acme',
      repos: {
        'widget-kit': { 'a.md': 'x' },
        'design-kit': { remote: false, files: { 'b.md': 'y' } },
      },
    });
    expect(org.repos['widget-kit']!.remoteUrl).toBe('https://github.com/acme/widget-kit.git');
    expect(org.repos['design-kit']!.remoteUrl).toBeNull();
    expect(org.repos['design-kit']!.root).toBe(`${org.root}/design-kit`);
  });

  it('commitSeries는 커밋 SHA를 순서대로 돌려준다', () => {
    const r = createFakeRepo();
    const shas = commitSeries(r, [
      { 'a.ts': '1', 'b.ts': '1' },
      { 'a.ts': '2', 'b.ts': '2' },
    ]);
    expect(new Set(shas).size).toBe(2);
    expect(r.git('log', '--format=%H').trim().split('\n')[0]).toBe(shas[1]);
  });
});
