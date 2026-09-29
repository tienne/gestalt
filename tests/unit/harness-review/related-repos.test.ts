import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DETECTION_CACHE_PATH,
  detectRelatedRepos,
  extractMcpPackages,
  extractRepoMentions,
  isHarnessPath,
  parseGitHubRepo,
  readDetectionCache,
  type GhRunner,
} from '../../../src/harness-review/related-repos.js';
import type { Identifier } from '../../../src/harness-review/types.js';
import { cleanupFakeRepos, createFakeRepo } from '../../helpers/fake-repo.js';

afterEach(cleanupFakeRepos);

function fakeGh(branches: Record<string, string> = {}) {
  const calls: string[][] = [];
  const run: GhRunner = (args) => {
    calls.push(args);
    const target = args[2] ?? '';
    return `${branches[target] ?? 'main'}\n`;
  };
  return { run, calls };
}

const NO_PKG = () => null;

function names(repos: { owner: string; name: string }[]): string[] {
  return repos.map((r) => `${r.owner}/${r.name}`).sort();
}

describe('parseGitHubRepo', () => {
  it.each([
    ['https://github.com/acme/widget-kit.git', 'acme/widget-kit'],
    ['git@github.com:acme/widget-kit.git', 'acme/widget-kit'],
    ['git+https://github.com/acme/design-kit.git', 'acme/design-kit'],
    ['github:acme/design-kit', 'acme/design-kit'],
    ['acme/design-kit', 'acme/design-kit'],
  ])('%s → %s', (input, expected) => {
    const r = parseGitHubRepo(input);
    expect(r && `${r.owner}/${r.name}`).toBe(expected);
  });

  it('GitHub가 아닌 주소는 못 읽는다', () => {
    expect(parseGitHubRepo('https://gitlab.com/acme/x.git')).toBeNull();
  });
});

describe('extractRepoMentions', () => {
  it('owner/repo 표기, GitHub URL, gh repo clone 대상을 조직 기준으로 뽑는다', () => {
    const text = [
      '디자인 토큰은 acme/design-kit에 있다.',
      '문서: https://github.com/acme/docs-site/blob/main/README.md',
      '```sh',
      'gh repo clone acme/tokens',
      '```',
      '남의 조직 https://github.com/other/thing 은 안 본다.',
      '경로 src/acme/local 과 스코프 패키지 @acme/cli, 메일 dev@acme/x 도 레포가 아니다.',
    ].join('\n');
    expect(names(extractRepoMentions(text, 'acme'))).toEqual([
      'acme/design-kit',
      'acme/docs-site',
      'acme/tokens',
    ]);
  });

  it('조직 이름 대소문자가 달라도 원격 owner 표기로 맞춘다', () => {
    expect(names(extractRepoMentions('see ACME/design-kit.', 'acme'))).toEqual(['acme/design-kit']);
  });
});

describe('extractMcpPackages', () => {
  it('npx와 pnpm dlx로 띄우는 패키지 이름에서 버전 핀을 뗀다', () => {
    const pkgs = extractMcpPackages({
      mcpServers: {
        a: { command: 'npx', args: ['-y', '@acme/widget-mcp@1.2.3'] },
        b: { command: 'pnpm', args: ['dlx', 'plain-mcp@2'] },
        c: { command: 'node', args: ['server.js'] },
      },
    });
    expect(pkgs).toEqual(['@acme/widget-mcp', 'plain-mcp']);
  });
});

describe('isHarnessPath', () => {
  it.each([
    ['CLAUDE.md', true],
    ['docs/AGENTS.md', true],
    ['plugin/skills/foo/SKILL.md', true],
    ['.claude/settings.json', true],
    ['.cursor/rules/a.mdc', true],
    ['.claude-plugin/marketplace.json', true],
    ['.mcp.json', true],
    ['README.md', false],
    ['src/skills/index.ts', false],
  ])('%s → %s', (p, expected) => {
    expect(isHarnessPath(p)).toBe(expected);
  });
});

describe('detectRelatedRepos', () => {
  it('GitHub 원격이 없으면 noGitHubRemote 사유를 돌려주고 캐시를 안 만든다', () => {
    const repo = createFakeRepo({ remote: false, files: { 'CLAUDE.md': 'acme/design-kit' } });
    const res = detectRelatedRepos(repo.root, { gh: fakeGh().run });
    expect(res.noGitHubRemote).toBe(true);
    if (res.noGitHubRemote) expect(res.reason).toMatch(/원격/);
    expect(existsSync(join(repo.root, DETECTION_CACHE_PATH))).toBe(false);
  });

  it('GitHub가 아닌 원격도 noGitHubRemote로 본다', () => {
    const repo = createFakeRepo({ remote: 'https://gitlab.com/acme/widget-kit.git' });
    expect(detectRelatedRepos(repo.root, { gh: fakeGh().run }).noGitHubRemote).toBe(true);
  });

  it('하네스 문서의 순방향 언급에서 같은 조직 레포를 뽑고 자기 레포와 하네스 밖 문서는 뺀다', () => {
    const repo = createFakeRepo({
      name: 'widget-kit',
      files: {
        'CLAUDE.md': '토큰은 acme/design-kit, 자기 자신 acme/widget-kit 도 적혀 있다.',
        'plugin/skills/setup/SKILL.md': 'gh repo clone acme/tokens\nhttps://github.com/other/x',
        'README.md': '하네스 밖 문서의 acme/readme-only 는 안 센다.',
      },
    });
    const gh = fakeGh({ 'acme/design-kit': 'develop' });
    const res = detectRelatedRepos(repo.root, { gh: gh.run, resolvePackageRepository: NO_PKG });
    if (res.noGitHubRemote) throw new Error('원격이 있어야 한다');
    expect(res.org).toBe('acme');
    expect(names(res.relatedRepos)).toEqual(['acme/design-kit', 'acme/tokens']);
    expect(res.relatedRepos.every((r) => r.discoveredBy === 'forwardMention')).toBe(true);
    expect(res.relatedRepos.find((r) => r.name === 'design-kit')?.defaultBranch).toBe('develop');
    expect(res.fromCache).toBe(false);
  });

  it('매니페스트의 marketplace 소스와 플러그인 이름을 따라간 레포를 뽑는다', () => {
    const repo = createFakeRepo({
      files: {
        '.claude/settings.json': JSON.stringify({
          enabledPlugins: { 'design-tools@acme-market': true },
          extraKnownMarketplaces: {
            'acme-market': { source: { source: 'github', repo: 'acme/plugin-market' } },
            other: { source: { source: 'github', repo: 'partner/elsewhere' } },
          },
        }),
        '.claude-plugin/marketplace.json': JSON.stringify({
          name: 'widget',
          plugins: [
            { name: 'local', source: './' },
            { name: 'remote', source: { source: 'github', repo: 'acme/remote-plugin' } },
          ],
        }),
      },
    });
    const res = detectRelatedRepos(repo.root, {
      gh: fakeGh().run,
      resolvePackageRepository: NO_PKG,
    });
    if (res.noGitHubRemote) throw new Error('원격이 있어야 한다');
    expect(names(res.relatedRepos)).toEqual(['acme/plugin-market', 'acme/remote-plugin']);
  });

  it('문서에 적힌 plugin@marketplace도 marketplace 레포로 따라간다', () => {
    const repo = createFakeRepo({
      files: {
        '.claude/settings.json': JSON.stringify({
          extraKnownMarketplaces: {
            kit: { source: { source: 'git', url: 'https://github.com/acme/kit-market.git' } },
          },
        }),
        'AGENTS.md': '설치: `/plugin install lint-rules@kit`',
      },
    });
    const res = detectRelatedRepos(repo.root, {
      gh: fakeGh().run,
      resolvePackageRepository: NO_PKG,
    });
    if (res.noGitHubRemote) throw new Error('원격이 있어야 한다');
    expect(names(res.relatedRepos)).toEqual(['acme/kit-market']);
  });

  it('MCP 패키지는 package.json repository로 레포를 찾는다', () => {
    const repo = createFakeRepo({
      files: {
        '.mcp.json': JSON.stringify({
          mcpServers: { w: { command: 'npx', args: ['-y', '@acme/widget-mcp@1.0.0'] } },
        }),
        'packages/tool-server/package.json': JSON.stringify({
          name: '@acme/tool-server',
          dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
          repository: { type: 'git', url: 'git+https://github.com/acme/tool-server.git' },
        }),
        'packages/private-server/package.json': JSON.stringify({
          name: 'private-server',
          private: true,
          dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
          repository: 'acme/private-server',
        }),
      },
    });
    const asked: string[] = [];
    const res = detectRelatedRepos(repo.root, {
      gh: fakeGh().run,
      resolvePackageRepository: (pkg) => {
        asked.push(pkg);
        return pkg === '@acme/widget-mcp' ? 'github:acme/widget-mcp' : null;
      },
    });
    if (res.noGitHubRemote) throw new Error('원격이 있어야 한다');
    expect(asked).toEqual(['@acme/widget-mcp']);
    expect(names(res.relatedRepos)).toEqual(['acme/tool-server', 'acme/widget-mcp']);
  });

  it('기본 해석기는 node_modules의 package.json repository를 읽는다', () => {
    const repo = createFakeRepo({
      files: {
        '.mcp.json': JSON.stringify({
          mcpServers: { w: { command: 'npx', args: ['@acme/x-mcp'] } },
        }),
      },
    });
    repo.write(
      'node_modules/@acme/x-mcp/package.json',
      JSON.stringify({ name: '@acme/x-mcp', repository: 'https://github.com/acme/x-mcp' }),
    );
    const res = detectRelatedRepos(repo.root, { gh: fakeGh().run });
    if (res.noGitHubRemote) throw new Error('원격이 있어야 한다');
    expect(names(res.relatedRepos)).toEqual(['acme/x-mcp']);
  });

  it('설정 레포는 discoveredBy=config로 합치고 자동 탐지와 겹치면 하나만 남긴다', () => {
    const repo = createFakeRepo({ files: { 'CLAUDE.md': 'acme/design-kit' } });
    const res = detectRelatedRepos(repo.root, {
      gh: fakeGh().run,
      resolvePackageRepository: NO_PKG,
      extraRepos: [
        'acme/design-kit',
        'https://github.com/partner/shared-rules.git',
        { owner: 'acme', name: 'widget-kit' },
        'not a repo',
      ],
    });
    if (res.noGitHubRemote) throw new Error('원격이 있어야 한다');
    expect(res.relatedRepos.map((r) => [`${r.owner}/${r.name}`, r.discoveredBy])).toEqual([
      ['acme/design-kit', 'forwardMention'],
      ['partner/shared-rules', 'config'],
    ]);
  });

  describe('캐시', () => {
    const now = new Date('2026-09-01T00:00:00Z');
    const ids: Identifier[] = [
      { kind: 'skillName', value: 'setup', changeType: 'modified', extractedBy: 'pattern' },
    ];

    function setup() {
      const repo = createFakeRepo({ files: { 'CLAUDE.md': 'acme/design-kit' } });
      const gh = fakeGh();
      let extracted = 0;
      const run = (at: Date, extra: Partial<Parameters<typeof detectRelatedRepos>[1]> = {}) =>
        detectRelatedRepos(repo.root, {
          gh: gh.run,
          resolvePackageRepository: NO_PKG,
          now: at,
          ttlMs: 60_000,
          extractIdentifiers: () => {
            extracted += 1;
            return ids;
          },
          ...extra,
        });
      return { repo, gh, run, extractedCount: () => extracted };
    }

    it('.gestalt/harness-refs-cache.json에 레포와 식별자, 해시, 만료를 저장한다', () => {
      const { repo, run } = setup();
      const res = run(now);
      if (res.noGitHubRemote) throw new Error('원격이 있어야 한다');

      const stored = readDetectionCache(repo.root);
      expect(stored).not.toBeNull();
      expect(stored!.selfRepo).toBe('acme/widget-kit');
      expect(names(stored!.relatedRepos)).toEqual(['acme/design-kit']);
      expect(stored!.relatedRepos[0]!.lastDetectedAt).toEqual(now);
      expect(stored!.identifiers).toEqual(ids);
      expect(stored!.harnessDocsHash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored!.expiresAt).toEqual(new Date(now.getTime() + 60_000));
    });

    it('해시가 같고 만료 전이면 캐시를 쓰고 gh와 식별자 추출을 다시 안 부른다', () => {
      const { run, gh, extractedCount } = setup();
      run(now);
      const callsAfterFirst = gh.calls.length;
      const second = run(new Date(now.getTime() + 30_000));
      if (second.noGitHubRemote) throw new Error('원격이 있어야 한다');
      expect(second.fromCache).toBe(true);
      expect(second.identifiers).toEqual(ids);
      expect(names(second.relatedRepos)).toEqual(['acme/design-kit']);
      expect(gh.calls.length).toBe(callsAfterFirst);
      expect(extractedCount()).toBe(1);
    });

    it('하네스 문서가 바뀌면 다시 탐지한다', () => {
      const { repo, run } = setup();
      run(now);
      repo.write('CLAUDE.md', 'acme/design-kit 과 acme/tokens');
      const res = run(new Date(now.getTime() + 1_000));
      if (res.noGitHubRemote) throw new Error('원격이 있어야 한다');
      expect(res.fromCache).toBe(false);
      expect(names(res.relatedRepos)).toEqual(['acme/design-kit', 'acme/tokens']);
    });

    it('하네스 밖 파일이 바뀌어도 캐시는 유지된다', () => {
      const { repo, run } = setup();
      run(now);
      repo.write('README.md', 'acme/other');
      const res = run(new Date(now.getTime() + 1_000));
      expect(!res.noGitHubRemote && res.fromCache).toBe(true);
    });

    it('expiresAt이 지나면 다시 탐지한다', () => {
      const { run, extractedCount } = setup();
      run(now);
      const res = run(new Date(now.getTime() + 60_000));
      expect(!res.noGitHubRemote && res.fromCache).toBe(false);
      expect(extractedCount()).toBe(2);
    });

    it('refresh를 주면 캐시를 무시한다', () => {
      const { run } = setup();
      run(now);
      const res = run(new Date(now.getTime() + 1_000), { refresh: true });
      expect(!res.noGitHubRemote && res.fromCache).toBe(false);
    });

    it('캐시가 맞아도 설정 레포는 지금 설정으로 다시 합친다', () => {
      const { run } = setup();
      run(now, { extraRepos: ['acme/old-extra'] });
      const res = run(new Date(now.getTime() + 1_000), { extraRepos: ['acme/new-extra'] });
      if (res.noGitHubRemote) throw new Error('원격이 있어야 한다');
      expect(res.fromCache).toBe(true);
      expect(res.relatedRepos.map((r) => [r.name, r.discoveredBy])).toEqual([
        ['design-kit', 'forwardMention'],
        ['new-extra', 'config'],
      ]);
    });

    it('원격이 바뀌었거나 깨진 캐시는 버린다', () => {
      const { repo, run } = setup();
      run(now);
      repo.git('remote', 'set-url', 'origin', 'https://github.com/acme/renamed.git');
      const renamed = run(new Date(now.getTime() + 1_000));
      expect(!renamed.noGitHubRemote && renamed.fromCache).toBe(false);
      const moved = run(new Date(now.getTime() + 2_000));
      expect(!moved.noGitHubRemote && moved.fromCache).toBe(true);
      expect(readDetectionCache(repo.root)!.selfRepo).toBe('acme/renamed');

      writeFileSync(join(repo.root, DETECTION_CACHE_PATH), '{broken');
      expect(readDetectionCache(repo.root)).toBeNull();
      const res = run(new Date(now.getTime() + 3_000));
      expect(!res.noGitHubRemote && res.fromCache).toBe(false);
      expect(JSON.parse(readFileSync(join(repo.root, DETECTION_CACHE_PATH), 'utf-8')).version).toBe(
        1,
      );
    });
  });

  it('이 레포의 .gitignore가 캐시 파일을 이미 걸러 커밋되지 않는다', () => {
    const out = execFileSync('git', ['check-ignore', DETECTION_CACHE_PATH], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });
    expect(out.trim()).toBe(DETECTION_CACHE_PATH);
  });
});
