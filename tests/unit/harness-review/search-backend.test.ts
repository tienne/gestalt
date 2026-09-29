import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalCloneBackend } from '../../../src/harness-review/search-backend.js';
import { cleanupFakeRepos, createFakeOrg, createFakeRepo } from '../../helpers/fake-repo.js';

afterEach(cleanupFakeRepos);

describe('LocalCloneBackend', () => {
  it('kind와 capabilities를 노출한다', () => {
    const b = new LocalCloneBackend([]);
    expect(b.kind).toBe('localClone');
    expect(b.capabilities).toMatchObject({ rateLimited: false });
    expect(b.rateLimitState).toBeUndefined();
  });

  it('워킹트리에서 파일 경로, 줄, 매치 텍스트를 돌려준다', async () => {
    const repo = createFakeRepo({
      files: {
        'skills/review/SKILL.md': 'intro\nrun SKILL_TOKEN here\n',
        'docs/a.md': 'nothing',
        'node_modules/x/README.md': 'SKILL_TOKEN',
      },
    });
    const b = new LocalCloneBackend([{ repo: 'acme/widget-kit', dir: repo.root }]);
    const r = await b.search('SKILL_TOKEN', ['acme/widget-kit']);
    expect(r.skipped).toEqual([]);
    expect(r.hits).toEqual([
      {
        repo: 'acme/widget-kit',
        path: 'skills/review/SKILL.md',
        line: 2,
        text: 'run SKILL_TOKEN here',
      },
    ]);
  });

  it('git 레포가 아닌 디렉토리도 파일을 직접 훑어 찾는다', async () => {
    const dir = resolve('.gestalt-test', `plain-${randomUUID()}`);
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs/a.md'), 'x\nPLAIN_TOKEN\n');
    try {
      const b = new LocalCloneBackend([{ repo: 'acme/plain', dir }]);
      const r = await b.search('PLAIN_TOKEN', ['acme/plain']);
      expect(r.hits.map((h) => `${h.path}:${h.line}`)).toEqual(['docs/a.md:2']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('정규식 문자를 고정 문자열로 취급한다', async () => {
    const repo = createFakeRepo({ files: { 'a.md': 'see a.b(c)\nsee aXb(c)\n' } });
    const b = new LocalCloneBackend([{ repo: 'acme/r', dir: repo.root }]);
    const r = await b.search('a.b(c)', ['acme/r']);
    expect(r.hits.map((h) => h.line)).toEqual([1]);
  });

  it('여러 레포를 훑고 등록되지 않은 레포는 skipped에 싣는다', async () => {
    const org = createFakeOrg({
      owner: 'acme',
      repos: {
        'widget-kit': { files: { 'a.md': 'FIND_ME' } },
        'design-kit': { files: { 'b.md': 'FIND_ME\nFIND_ME' } },
      },
    });
    const b = new LocalCloneBackend([
      { repo: 'acme/widget-kit', dir: org.repos['widget-kit']!.root },
      { repo: 'acme/design-kit', dir: org.repos['design-kit']!.root },
    ]);
    const r = await b.search('FIND_ME', ['acme/widget-kit', 'acme/design-kit', 'acme/ghost']);
    expect(r.hits.map((h) => `${h.repo}:${h.path}:${h.line}`)).toEqual([
      'acme/widget-kit:a.md:1',
      'acme/design-kit:b.md:1',
      'acme/design-kit:b.md:2',
    ]);
    expect(r.skipped).toEqual([{ repo: 'acme/ghost', reason: expect.any(String) }]);
  });

  it('ref를 주면 워킹트리가 아니라 그 시점의 트리를 본다', async () => {
    const repo = createFakeRepo({ files: { 'a.md': 'OLD_NAME\n' } });
    const before = repo.head();
    repo.commit('rename', { 'a.md': 'NEW_NAME\n' });
    const at = new LocalCloneBackend([{ repo: 'acme/r', dir: repo.root, ref: before }]);
    const now = new LocalCloneBackend([{ repo: 'acme/r', dir: repo.root }]);

    expect((await at.search('OLD_NAME', ['acme/r'])).hits).toEqual([
      { repo: 'acme/r', path: 'a.md', line: 1, text: 'OLD_NAME' },
    ]);
    expect((await at.search('NEW_NAME', ['acme/r'])).hits).toEqual([]);
    expect((await now.search('OLD_NAME', ['acme/r'])).hits).toEqual([]);
  });

  it('잘못된 ref는 예외 대신 skipped로 알린다', async () => {
    const repo = createFakeRepo({ files: { 'a.md': 'x' } });
    const b = new LocalCloneBackend([{ repo: 'acme/r', dir: repo.root, ref: 'no-such-ref' }]);
    const r = await b.search('x', ['acme/r']);
    expect(r.hits).toEqual([]);
    expect(r.skipped).toHaveLength(1);
  });

  it('레포당 상한을 지키고 빈 식별자는 아무것도 찾지 않는다', async () => {
    const repo = createFakeRepo({ files: { 'a.md': 'K\nK\nK\n' } });
    const b = new LocalCloneBackend([{ repo: 'acme/r', dir: repo.root }]);
    expect((await b.search('K', ['acme/r'], { maxHitsPerRepo: 2 })).hits).toHaveLength(2);
    expect((await b.search('', ['acme/r'])).hits).toEqual([]);
  });
});
