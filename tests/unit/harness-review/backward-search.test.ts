import { afterEach, describe, expect, it } from 'vitest';
import { cleanupFakeRepos, createFakeRepo, type FakeOrg } from '../../helpers/fake-repo.js';
import {
  buildFileNameOnlyRefOrg,
  buildIsolatedOrg,
  buildKnowledgeDocOrg,
  buildMcpToolOrg,
  buildReceiveOnlyOrg,
} from '../../fixtures/harness-repos/scenarios.js';
import {
  backwardSearch,
  MIN_SEARCH_TERM_LENGTH,
} from '../../../src/harness-review/backward-search.js';
import { forwardSearch } from '../../../src/harness-review/forward-search.js';
import {
  extractIdentifiersFromGit,
  isHarnessPath,
} from '../../../src/harness-review/identifiers.js';
import { isHarnessPath as isHarnessPathFromRelated } from '../../../src/harness-review/related-repos.js';
import { LocalCloneBackend } from '../../../src/harness-review/search-backend.js';
import type { Identifier } from '../../../src/harness-review/types.js';

afterEach(cleanupFakeRepos);

const noGh = () => {
  throw new Error('gh를 부르면 안 된다');
};

function slug(org: FakeOrg, name: string): string {
  return `${org.owner}/${name}`;
}

function backendFor(org: FakeOrg): LocalCloneBackend {
  return new LocalCloneBackend(
    Object.entries(org.repos).map(([name, repo]) => ({ repo: slug(org, name), dir: repo.root })),
  );
}

function othersOf(org: FakeOrg, self: string): string[] {
  return Object.keys(org.repos)
    .filter((n) => n !== self)
    .map((n) => slug(org, n));
}

describe('하네스 경로 필터', () => {
  it.each([
    ['plugin/skills/review/SKILL.md', true],
    ['GEMINI.md', true],
    ['.claude/hooks/pre-commit.sh', true],
    ['.agents/plugins/marketplace.json', true],
    ['.cursor/rules/style.mdc', true],
    ['.claude-plugin/plugin.json', true],
    ['.mcp.json', true],
    ['plugins/widget/notes.md', true],
    ['src/skills/index.ts', false],
    ['docs/architecture.md', false],
    ['src/server.ts', false],
  ])('%s → %s (두 모듈이 같은 판정)', (p, expected) => {
    expect(isHarnessPath(p)).toBe(expected);
    expect(isHarnessPathFromRelated(p)).toBe(expected);
  });
});

describe('backwardSearch', () => {
  it('파일 이름만 적은 참조가 uniqueFileName 식별자로 뽑히고 하네스 참조로 걸린다', async () => {
    const s = buildFileNameOnlyRefOrg();
    const provider = s.org.repos['widget-kit']!;
    const ids = extractIdentifiersFromGit(provider.root, s.provider.baseSha, s.provider.headSha);

    expect(ids).toContainEqual(
      expect.objectContaining({ kind: 'uniqueFileName', value: s.fileName }),
    );
    expect(ids.map((i) => i.value)).not.toContain(s.commonFileName);

    const r = await backwardSearch({
      identifiers: ids,
      repos: othersOf(s.org, 'widget-kit'),
      backend: backendFor(s.org),
      selfRepo: slug(s.org, 'widget-kit'),
    });

    expect(r.backwardRefs).toHaveLength(1);
    expect(r.backwardRefs[0]).toMatchObject({
      kind: 'backwardRef',
      targetRepo: slug(s.org, s.consumerDoc.repo),
      targetPath: s.consumerDoc.file,
      matchedText: s.fileName,
      needsLlmJudgment: false,
    });
    expect(r.knowledgeDocs).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it('레포 이름이 설명으로만 나오는 문서는 knowledgeDoc으로 하네스 참조와 나뉜다', async () => {
    const s = buildKnowledgeDocOrg();
    const provider = s.org.repos['widget-kit']!;
    const ids = extractIdentifiersFromGit(provider.root, s.change.baseSha, s.change.headSha);

    const r = await backwardSearch({
      identifiers: ids,
      repos: othersOf(s.org, 'widget-kit'),
      backend: backendFor(s.org),
      selfRepo: slug(s.org, 'widget-kit'),
    });

    expect(r.backwardRefs.map((c) => c.targetPath)).toEqual([s.harnessRef.file]);
    expect(r.backwardRefs[0]!.matchedText).toBe(s.change.removedPath);
    expect(r.knowledgeDocs).toHaveLength(1);
    expect(r.knowledgeDocs[0]).toMatchObject({
      kind: 'knowledgeDoc',
      targetRepo: slug(s.org, s.knowledgeDoc.repo),
      targetPath: s.knowledgeDoc.file,
      matchedText: 'widget-kit',
    });
    const knowledgePaths = new Set(r.knowledgeDocs.map((c) => c.targetPath));
    expect(r.backwardRefs.some((c) => knowledgePaths.has(c.targetPath))).toBe(false);
  });

  it('하네스 문서 PR이 아니어도 MCP 도구 이름이 바뀌면 다른 레포의 하네스 참조를 찾는다', async () => {
    const s = buildMcpToolOrg();
    const server = s.org.repos['widget-mcp']!;
    const ids = extractIdentifiersFromGit(server.root, s.rename.baseSha, s.rename.headSha);
    expect(ids).toContainEqual(
      expect.objectContaining({
        kind: 'mcpToolName',
        value: s.rename.oldName,
        extractedBy: 'pattern',
      }),
    );

    const r = await backwardSearch({
      identifiers: ids,
      repos: othersOf(s.org, 'widget-mcp'),
      backend: backendFor(s.org),
      selfRepo: slug(s.org, 'widget-mcp'),
    });

    expect(r.backwardRefs).toContainEqual(
      expect.objectContaining({
        targetRepo: slug(s.org, s.caller.repo),
        targetPath: s.caller.file,
        matchedText: s.rename.oldName,
      }),
    );
  });

  it('extractedBy=llm 식별자는 검색하지 않고 needsLlmJudgment로 넘긴다', async () => {
    const s = buildMcpToolOrg();
    const calls: string[] = [];
    const inner = backendFor(s.org);
    const backend = Object.assign(Object.create(inner) as LocalCloneBackend, {
      search: (term: string, repos: string[]) => {
        calls.push(term);
        return inner.search(term, repos);
      },
    });
    const llmId: Identifier = {
      kind: 'mcpToolName',
      value: s.dynamicRegistry.file,
      changeType: 'modified',
      extractedBy: 'llm',
    };

    const r = await backwardSearch({
      identifiers: [llmId],
      repos: othersOf(s.org, 'widget-mcp'),
      backend,
    });

    expect(calls).toEqual([]);
    expect(r.needsLlmJudgment).toEqual([expect.objectContaining({ identifier: llmId })]);
    expect(r.backwardRefs).toEqual([]);
  });

  it('조회 못 한 레포는 skipped에 실린다', async () => {
    const s = buildReceiveOnlyOrg();
    const r = await backwardSearch({
      identifiers: [
        {
          kind: 'skillName',
          value: s.rename.oldName,
          changeType: 'renamed',
          extractedBy: 'pattern',
        },
      ],
      repos: [...othersOf(s.org, s.receiver), 'acme/not-cloned'],
      backend: backendFor(s.org),
      selfRepo: slug(s.org, s.receiver),
    });

    expect(r.skipped).toEqual([{ repo: 'acme/not-cloned', reason: expect.any(String) }]);
    expect(r.backwardRefs).toHaveLength(1);
  });

  it('너무 짧은 값은 검색어로 쓰지 않고 skippedIdentifiers에 남긴다', async () => {
    const s = buildIsolatedOrg();
    const id: Identifier = {
      kind: 'responseField',
      value: 'id',
      changeType: 'removed',
      extractedBy: 'pattern',
    };
    const r = await backwardSearch({
      identifiers: [id],
      repos: othersOf(s.org, s.isolated),
      backend: backendFor(s.org),
    });
    expect(id.value.length).toBeLessThan(MIN_SEARCH_TERM_LENGTH);
    expect(r.skippedIdentifiers).toEqual([expect.objectContaining({ identifier: id })]);
  });

  // 재현 리플레이에서 이렇게 걸린 스킬 이름 70건이 전부 더 긴 다른 스킬 이름이었다
  it('다른 이름의 일부로만 걸린 줄은 이름 식별자면 버린다', async () => {
    const s = buildReceiveOnlyOrg();
    const r = await backwardSearch({
      identifiers: [
        { kind: 'skillName', value: 'widget-aud', changeType: 'removed', extractedBy: 'pattern' },
      ],
      repos: othersOf(s.org, s.receiver),
      backend: backendFor(s.org),
    });
    expect(r.backwardRefs).toEqual([]);
  });
});

describe('참조 없는 레포와 받기만 하는 레포 (대칭)', () => {
  it('참조를 주지도 받지도 않는 레포는 역방향과 순방향 후보가 모두 0건이다', async () => {
    const s = buildIsolatedOrg();
    const lonely = s.org.repos[s.isolated]!;
    const ids = extractIdentifiersFromGit(lonely.root, s.change.baseSha, s.change.headSha);

    const back = await backwardSearch({
      identifiers: ids,
      repos: othersOf(s.org, s.isolated),
      backend: backendFor(s.org),
      selfRepo: slug(s.org, s.isolated),
    });
    const fwd = forwardSearch({
      ownRepo: { repo: slug(s.org, s.isolated), dir: lonely.root },
      otherRepos: othersOf(s.org, s.isolated).map((r) => ({
        repo: r,
        dir: s.org.repos[r.split('/')[1]!]!.root,
      })),
      files: ['plugin/skills/tidy/SKILL.md'],
      gh: noGh,
    });

    expect(back.backwardRefs).toEqual([]);
    expect(back.knowledgeDocs).toEqual([]);
    expect(back.skipped).toEqual([]);
    expect(fwd.candidates).toEqual([]);
  });

  it('받기만 하는 레포에서 이름을 바꾸면 역방향 후보만 나오고 순방향 후보는 0건이다', async () => {
    const s = buildReceiveOnlyOrg();
    const receiver = s.org.repos[s.receiver]!;
    const ids = extractIdentifiersFromGit(receiver.root, s.rename.baseSha, s.rename.headSha);
    expect(ids).toContainEqual(
      expect.objectContaining({ kind: 'skillName', value: s.rename.oldName }),
    );

    const back = await backwardSearch({
      identifiers: ids,
      repos: othersOf(s.org, s.receiver),
      backend: backendFor(s.org),
      selfRepo: slug(s.org, s.receiver),
    });
    const fwd = forwardSearch({
      ownRepo: { repo: slug(s.org, s.receiver), dir: receiver.root },
      otherRepos: othersOf(s.org, s.receiver).map((r) => ({
        repo: r,
        dir: s.org.repos[r.split('/')[1]!]!.root,
      })),
      files: [`plugin/skills/${s.rename.newName}/SKILL.md`],
      gh: noGh,
    });

    expect(back.backwardRefs).toEqual([
      expect.objectContaining({
        targetRepo: slug(s.org, s.caller.repo),
        targetPath: s.caller.file,
        matchedText: s.rename.oldName,
      }),
    ]);
    expect(fwd.candidates).toEqual([]);
  });
});

describe('backwardSearch — 흔한 파일 이름', () => {
  it('다른 레포가 제 파일을 가리킨 줄은 빼고 이 레포 이름을 적은 줄은 남긴다', async () => {
    const other = createFakeRepo({
      name: 'gadget-kit',
      files: {
        'INDEX.md': '# 목차\n',
        'plugins/gadget/SKILL.md': [
          '1. `INDEX.md`에서 문서를 고른다',
          '2. widget-kit의 `INDEX.md`도 본다',
          '',
        ].join('\n'),
      },
    });
    const id: Identifier = {
      kind: 'uniqueFileName',
      value: 'INDEX.md',
      changeType: 'modified',
      extractedBy: 'pattern',
    };
    const r = await backwardSearch({
      identifiers: [id],
      repos: ['acme/gadget-kit'],
      backend: new LocalCloneBackend([{ repo: 'acme/gadget-kit', dir: other.root }]),
      selfRepo: 'acme/widget-kit',
    });
    expect(r.backwardRefs.map((c) => c.sourceLine)).toEqual([2]);
  });
});

describe('backwardSearch — 흔한 헤딩', () => {
  it('헤딩 글자만 나온 줄은 빼고 앵커나 이 레포 이름이 있는 줄은 남긴다', async () => {
    const other = createFakeRepo({
      name: 'gadget-kit',
      files: {
        'plugins/gadget/SKILL.md': [
          '## 환경 변수',
          '자세한 건 widget-kit의 환경 변수 절을 본다',
          '설정은 `#환경-변수` 앵커로 건다',
          '',
        ].join('\n'),
      },
    });
    const id: Identifier = {
      kind: 'heading',
      value: '환경 변수',
      changeType: 'removed',
      extractedBy: 'pattern',
    };
    const r = await backwardSearch({
      identifiers: [id],
      repos: ['acme/gadget-kit'],
      backend: new LocalCloneBackend([{ repo: 'acme/gadget-kit', dir: other.root }]),
      selfRepo: 'acme/widget-kit',
    });
    expect(r.backwardRefs.map((c) => c.sourceLine).sort()).toEqual([2, 3]);
  });
});
