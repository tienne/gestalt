import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyHarnessTarget,
  dependsOnMcpSdk,
  extractIdentifiers,
  extractIdentifiersFromGit,
  extractMcpToolNames,
  isHarnessPath,
  isMcpToolRegistry,
  isPublicPackageJson,
  isRuleDocPath,
  parseUnifiedDiff,
} from '../../../src/harness-review/identifiers.js';
import type { Identifier } from '../../../src/harness-review/types.js';
import { cleanupFakeRepos, createCommitPair, createFakeRepo } from '../../helpers/fake-repo.js';

afterEach(cleanupFakeRepos);

const pick = (ids: Identifier[], kind: Identifier['kind']) =>
  ids
    .filter((i) => i.kind === kind)
    .map((i) => `${i.value}:${i.changeType}:${i.extractedBy}`)
    .sort();

const MCP_PKG = JSON.stringify(
  {
    name: '@acme/widget-mcp',
    version: '1.0.0',
    dependencies: { '@modelcontextprotocol/sdk': '^1.0.0', zod: '^3.0.0' },
  },
  null,
  2,
);

describe('parseUnifiedDiff', () => {
  it('추가, 삭제, 이름 변경, 줄 번호를 읽는다', () => {
    const diff = [
      'diff --git a/docs/old.md b/docs/new.md',
      'similarity index 90%',
      'rename from docs/old.md',
      'rename to docs/new.md',
      'index 1111111..2222222 100644',
      '--- a/docs/old.md',
      '+++ b/docs/new.md',
      '@@ -3,2 +3,2 @@ ctx',
      ' keep',
      '-gone',
      '+came',
      'diff --git a/x.ts b/x.ts',
      'deleted file mode 100644',
      '--- a/x.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-export {};',
    ].join('\n');
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      oldPath: 'docs/old.md',
      newPath: 'docs/new.md',
      status: 'renamed',
    });
    expect(files[0]!.hunks[0]!.lines).toEqual([
      { type: 'context', text: 'keep', lineNumber: 3 },
      { type: 'removed', text: 'gone', lineNumber: 4 },
      { type: 'added', text: 'came', lineNumber: 4 },
    ]);
    expect(files[1]).toMatchObject({ oldPath: 'x.ts', newPath: null, status: 'deleted' });
  });
});

describe('경로 판정', () => {
  it.each([
    ['plugin/skills/review/SKILL.md', true],
    ['AGENTS.md', true],
    ['sub/GEMINI.md', true],
    ['.claude/settings.json', true],
    ['.agents/plugins/marketplace.json', true],
    ['.cursor/rules/style.mdc', true],
    ['packages/kit/skills/foo/notes.txt', true],
    ['plugins/widget/README.md', true],
    ['.claude-plugin/plugin.json', true],
    ['.mcp.json', true],
    ['src/index.ts', false],
    ['docs/guide.md', false],
    ['skills', false],
  ])('isHarnessPath(%s) = %s', (p, expected) => {
    expect(isHarnessPath(p)).toBe(expected);
  });

  it.each([
    ['SKILL.md', true],
    ['.cursorrules', true],
    ['.windsurfrules', true],
    ['.claude/commands/ship.md', true],
    ['.claude/settings.json', false],
    ['.cursor/rules/a.mdc', true],
    ['skills/foo/notes.md', false],
    ['package.json', false],
  ])('isRuleDocPath(%s) = %s', (p, expected) => {
    expect(isRuleDocPath(p)).toBe(expected);
  });
});

describe('패키지와 MCP 등록부 판정', () => {
  it('private 아닌 package.json만 공개 패키지로 본다', () => {
    expect(isPublicPackageJson('package.json', '{"name":"widget-kit"}')).toBe(true);
    expect(isPublicPackageJson('a/package.json', '{"name":"x","private":true}')).toBe(false);
    expect(isPublicPackageJson('package.json', '{"version":"1"}')).toBe(false);
    expect(isPublicPackageJson('tsconfig.json', '{"name":"x"}')).toBe(false);
  });

  it('MCP SDK 의존과 등록부 꼴을 알아본다', () => {
    expect(dependsOnMcpSdk(MCP_PKG)).toBe(true);
    expect(dependsOnMcpSdk('{"dependencies":{"zod":"1"}}')).toBe(false);
    const src = [
      "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
      "const server = new McpServer({ name: 'widget', version: '1' });",
      "server.tool('widget_list', 'list', {}, cb);",
      "server.registerTool('widget_get', {}, cb);",
      "guardedTool('widget_put', 'put', {}, cb);",
    ].join('\n');
    expect(isMcpToolRegistry(src)).toBe(true);
    expect(extractMcpToolNames(src).sort()).toEqual(['widget_get', 'widget_list', 'widget_put']);
    expect(isMcpToolRegistry('export const x = 1;')).toBe(false);
  });

  it('classifyHarnessTarget는 ruleDocs, MCP 등록부, 공개 패키지를 가른다', () => {
    const registry = "import '@modelcontextprotocol/sdk';\nserver.tool('a', 'b', {}, cb);";
    expect(classifyHarnessTarget('skills/x/SKILL.md')).toBe('ruleDoc');
    expect(classifyHarnessTarget('src/server.ts', registry)).toBe('mcpToolRegistry');
    expect(classifyHarnessTarget('package.json', '{"name":"widget-kit"}')).toBe('publicPackage');
    expect(classifyHarnessTarget('src/util.ts', 'export const a = 1;')).toBeNull();
    // SDK를 직접 import하지 않아도 가장 가까운 package.json이 의존하면 등록부다
    const readFile = (p: string) => (p === 'packages/mcp/package.json' ? MCP_PKG : undefined);
    expect(
      classifyHarnessTarget(
        'packages/mcp/src/tools.ts',
        "server.tool('a', 'b', {}, cb);",
        readFile,
      ),
    ).toBe('mcpToolRegistry');
    expect(classifyHarnessTarget('src/tools.ts', "server.tool('a', 'b', {}, cb);")).toBeNull();
  });
});

describe('extractIdentifiers — 하네스 문서', () => {
  it('헤딩과 범주 ID와 스킬 이름을 뽑는다', () => {
    const repo = createFakeRepo();
    const { diff } = createCommitPair(repo, {
      base: {
        'skills/widget-sync/SKILL.md': [
          '---',
          'name: widget-sync',
          'description: sync widgets',
          '---',
          '# Widget Sync',
          '## 준비',
          'text',
          '## 정리',
          'end',
          '```bash',
          '# not a heading',
          '```',
        ].join('\n'),
        'docs/rules.md': [
          '# 규칙',
          '| ID | 규칙 |',
          '|---|---|',
          '| A-1 | 번역체 금지 |',
          '| A-2 | 가운뎃점 절제 |',
          '- B-3 A-1을 먼저 본다',
        ].join('\n'),
      },
      head: {
        'skills/widget-sync/SKILL.md': [
          '---',
          'name: widget-pull',
          'description: sync widgets',
          '---',
          '# Widget Sync',
          '## 준비 단계',
          'text',
          'end',
          '```bash',
          '```',
        ].join('\n'),
        'docs/rules.md': ['# 규칙', '| ID | 규칙 |', '|---|---|', '| A-1 | 번역투 금지 |'].join(
          '\n',
        ),
      },
    });
    const ids = extractIdentifiers(diff);
    expect(pick(ids, 'skillName')).toEqual(['widget-sync:renamed:pattern']);
    expect(pick(ids, 'heading')).toEqual(['정리:renamed:pattern', '준비:renamed:pattern']);
    expect(pick(ids, 'ruleId')).toEqual([
      'A-1:modified:pattern',
      'A-2:removed:pattern',
      'B-3:removed:pattern',
    ]);
    expect(pick(ids, 'path')).toEqual([
      'docs/rules.md:modified:pattern',
      'skills/widget-sync/SKILL.md:modified:pattern',
    ]);
  });

  it('범주 ID를 언급만 하던 줄이 지워지면 식별자로 안 뽑는다', () => {
    const diff = [
      'diff --git a/docs/a.md b/docs/a.md',
      '--- a/docs/a.md',
      '+++ b/docs/a.md',
      '@@ -1,2 +1,1 @@',
      ' 본문',
      '-자세한 건 C-12를 본다',
    ].join('\n');
    expect(pick(extractIdentifiers(diff), 'ruleId')).toEqual([]);
  });

  it('지운 에이전트는 frontmatter 이름과 경로가 removed로 나온다', () => {
    const repo = createFakeRepo();
    const { diff } = createCommitPair(repo, {
      base: {
        'agents/lint-bot/AGENT.md': '---\nname: lint-bot\n---\n# Lint Bot\n',
        '.claude/agents/helper.md': 'no frontmatter\n',
      },
      head: { 'agents/lint-bot/AGENT.md': null, '.claude/agents/helper.md': null },
    });
    const ids = extractIdentifiers(diff);
    expect(pick(ids, 'agentName')).toEqual(['helper:removed:pattern', 'lint-bot:removed:pattern']);
    expect(pick(ids, 'heading')).toEqual(['Lint Bot:removed:pattern']);
    expect(pick(ids, 'path')).toEqual([
      '.claude/agents/helper.md:removed:pattern',
      'agents/lint-bot/AGENT.md:removed:pattern',
    ]);
  });

  it('frontmatter를 안 건드리고 스킬 디렉토리만 옮기면 디렉토리 이름을 쓴다', () => {
    const diff = [
      'diff --git a/skills/old-name/SKILL.md b/skills/new-name/SKILL.md',
      'similarity index 100%',
      'rename from skills/old-name/SKILL.md',
      'rename to skills/new-name/SKILL.md',
    ].join('\n');
    const ids = extractIdentifiers(diff);
    expect(pick(ids, 'skillName')).toEqual(['old-name:renamed:pattern']);
    expect(pick(ids, 'path')).toEqual(['skills/old-name/SKILL.md:renamed:pattern']);
  });

  it('하네스 경로가 아닌 코드 파일은 수정만으로 경로 식별자가 안 나온다', () => {
    const repo = createFakeRepo();
    const { diff } = createCommitPair(repo, {
      base: { 'src/a.ts': 'export const a = 1;\n' },
      head: { 'src/a.ts': 'export const a = 2;\n' },
    });
    expect(extractIdentifiers(diff)).toEqual([]);
  });
});

describe('extractIdentifiers — 레포에 하나뿐인 파일 이름', () => {
  it('다른 레포가 파일 이름만 적어 부르는 문서를 옮기면 그 파일 이름이 뽑힌다', () => {
    const repo = createFakeRepo();
    const base = repo.commit('base', {
      'docs/references/tone-guide.md': '# Tone\n',
      'docs/a/notes.md': 'a\n',
      'docs/b/notes.md': 'b\n',
      'README.md': '# widget-kit\n',
    });
    repo.git('mv', 'docs/references/tone-guide.md', 'docs/tone-guide.md');
    repo.remove('docs/a/notes.md');
    repo.remove('README.md');
    const head = repo.commit('move');

    const ids = extractIdentifiersFromGit(repo.root, base, head);
    // 이름 그대로 디렉토리만 옮긴 경우는 파일 이름 참조가 안 깨진다
    expect(pick(ids, 'uniqueFileName')).toEqual([]);
    expect(pick(ids, 'path')).toEqual(
      expect.arrayContaining([
        'docs/references/tone-guide.md:renamed:pattern',
        'docs/a/notes.md:removed:pattern',
        'README.md:removed:pattern',
      ]),
    );

    const base2 = repo.head();
    repo.git('mv', 'docs/tone-guide.md', 'docs/voice-guide.md');
    const head2 = repo.commit('rename');
    const ids2 = extractIdentifiersFromGit(repo.root, base2, head2);
    expect(pick(ids2, 'uniqueFileName')).toEqual(['tone-guide.md:renamed:pattern']);
  });

  it('같은 이름 파일이 여럿이거나 흔한 이름이면 파일 이름을 안 뽑는다', () => {
    const repo = createFakeRepo();
    const base = repo.commit('base', {
      'docs/a/notes.md': 'a\n',
      'docs/b/notes.md': 'b\n',
      'CHANGELOG.md': '# log\n',
    });
    repo.remove('docs/a/notes.md');
    repo.remove('CHANGELOG.md');
    const head = repo.commit('rm');
    expect(pick(extractIdentifiersFromGit(repo.root, base, head), 'uniqueFileName')).toEqual([]);
  });

  it('지운 파일의 이름이 base에 하나뿐이면 뽑는다', () => {
    const diff = [
      'diff --git a/docs/style-guide.md b/docs/style-guide.md',
      'deleted file mode 100644',
      '--- a/docs/style-guide.md',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-본문',
    ].join('\n');
    const ids = extractIdentifiers(diff, { baseFiles: ['docs/style-guide.md', 'src/a.ts'] });
    expect(pick(ids, 'uniqueFileName')).toEqual(['style-guide.md:removed:pattern']);
    // baseFiles가 없으면 하나뿐인지 모르므로 안 뽑는다
    expect(pick(extractIdentifiers(diff), 'uniqueFileName')).toEqual([]);
  });
});

describe('extractIdentifiers — 플러그인과 패키지 이름', () => {
  it('플러그인 매니페스트 이름 변경을 뽑고 owner.name은 무시한다', () => {
    const repo = createFakeRepo();
    const manifest = (name: string, owner: string) =>
      JSON.stringify({ name: 'acme-market', owner: { name: owner }, plugins: [{ name }] }, null, 2);
    const { diff } = createCommitPair(repo, {
      base: {
        '.claude-plugin/plugin.json': JSON.stringify(
          { name: 'widget-kit', version: '1.0.0' },
          null,
          2,
        ),
        '.claude-plugin/marketplace.json': manifest('widget-kit', 'Kim'),
      },
      head: {
        '.claude-plugin/plugin.json': JSON.stringify(
          { name: 'widget-tools', version: '1.0.0' },
          null,
          2,
        ),
        '.claude-plugin/marketplace.json': manifest('widget-tools', 'Lee'),
      },
    });
    const ids = extractIdentifiers(diff);
    expect(pick(ids, 'pluginName')).toEqual(['widget-kit:renamed:pattern']);
  });

  it('공개 package.json의 최상위 name 변경만 뽑는다', () => {
    const repo = createFakeRepo();
    const pkg = (name: string, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ name, version: '1.0.0', ...extra, workspaces: { name: 'nested' } }, null, 2);
    const { baseSha, headSha, diff } = createCommitPair(repo, {
      base: {
        'package.json': pkg('@acme/widget-kit'),
        'internal/package.json': pkg('@acme/internal', { private: true }),
      },
      head: {
        'package.json': pkg('@acme/widget-core'),
        'internal/package.json': pkg('@acme/internal-2', { private: true }),
      },
    });
    expect(pick(extractIdentifiers(diff), 'packageName')).toEqual([
      '@acme/widget-kit:renamed:pattern',
    ]);
    expect(pick(extractIdentifiersFromGit(repo.root, baseSha, headSha), 'packageName')).toEqual([
      '@acme/widget-kit:renamed:pattern',
    ]);
  });

  it('지운 공개 package.json은 removed다', () => {
    const repo = createFakeRepo();
    const { baseSha, headSha } = createCommitPair(repo, {
      base: { 'pkgs/a/package.json': JSON.stringify({ name: 'widget-a' }, null, 2) },
      head: { 'pkgs/a/package.json': null },
    });
    expect(pick(extractIdentifiersFromGit(repo.root, baseSha, headSha), 'packageName')).toEqual([
      'widget-a:removed:pattern',
    ]);
  });
});

describe('extractIdentifiers — MCP 도구 (하네스 문서가 아닌 코드 PR)', () => {
  const serverSrc = (tools: string[], response: string) =>
    [
      "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
      "import { z } from 'zod';",
      '',
      "const server = new McpServer({ name: 'widget-mcp', version: '1.0.0' });",
      '',
      ...tools.map(
        (t) =>
          `server.tool('${t}', 'desc', { id: z.string() }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));`,
      ),
      '',
      "server.registerTool('widget_stats', { description: 'stats' }, async () => {",
      '  const data = load();',
      `  return { content: [{ type: 'text', text: JSON.stringify(${response}) }] };`,
      '});',
      '',
    ].join('\n');

  it('도구 이름 삭제와 응답 필드 변경을 패턴으로 뽑는다', () => {
    const repo = createFakeRepo({ name: 'widget-mcp' });
    const { baseSha, headSha, diff } = createCommitPair(repo, {
      base: {
        'package.json': MCP_PKG,
        'src/server.ts': serverSrc(
          ['widget_list', 'widget_get'],
          '{ items: data.items, totalCount: data.total }',
        ),
      },
      head: {
        'src/server.ts': serverSrc(['widget_list'], '{ items: data.items, total: data.total }'),
      },
    });
    const ids = extractIdentifiersFromGit(repo.root, baseSha, headSha);
    expect(pick(ids, 'mcpToolName')).toEqual(['widget_get:removed:pattern']);
    expect(pick(ids, 'responseField')).toEqual(['totalCount:renamed:pattern']);
    // package.json 없이도 파일 자체가 SDK를 import하면 MCP 파일로 본다
    const readFile = (p: string) =>
      p === 'src/server.ts' ? repo.git('show', `${headSha}:${p}`) : undefined;
    expect(pick(extractIdentifiers(diff, { readFile }), 'mcpToolName')).toEqual([
      'widget_get:removed:pattern',
    ]);
  });

  it('여러 줄에 걸친 응답 객체의 최상위 키를 본다', () => {
    const diff = [
      'diff --git a/src/handler.ts b/src/handler.ts',
      '--- a/src/handler.ts',
      '+++ b/src/handler.ts',
      '@@ -1,6 +1,5 @@',
      " import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';",
      ' return JSON.stringify({',
      '   sessionId,',
      '-  resolution: { score: 1 },',
      '-  legacyField,',
      '   ...rest,',
      ' });',
    ].join('\n');
    expect(pick(extractIdentifiers(diff), 'responseField')).toEqual([
      'legacyField:removed:pattern',
      'resolution:removed:pattern',
    ]);
  });

  it('ListTools 응답의 name: 필드를 도구 이름으로 보고 서버 name은 무시한다', () => {
    const diff = [
      'diff --git a/src/index.ts b/src/index.ts',
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -1,8 +1,8 @@',
      " import { Server } from '@modelcontextprotocol/sdk/server/index.js';",
      " import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';",
      ' const server = new Server({',
      "-  name: 'widget-server',",
      "+  name: 'widget-server-2',",
      ' });',
      ' server.setRequestHandler(ListToolsRequestSchema, async () => ({',
      "-  tools: [{ name: 'widget_search', inputSchema: {} }],",
      "+  tools: [{ name: 'widget_find', inputSchema: {} }],",
      ' }));',
    ].join('\n');
    expect(pick(extractIdentifiers(diff), 'mcpToolName')).toEqual([
      'widget_search:renamed:pattern',
    ]);
  });

  it('등록부 패턴으로 이름을 못 잡으면 extractedBy=llm 후보로 파일을 표시한다', () => {
    const repo = createFakeRepo({ name: 'widget-mcp' });
    const tools = (ids: string[]) =>
      [
        'export const TOOLS = [',
        ...ids.map((id) => `  { id: '${id}', description: 'd', params: {} },`),
        '];',
        '',
      ].join('\n');
    const { baseSha, headSha } = createCommitPair(repo, {
      base: {
        'package.json': MCP_PKG,
        'src/server.ts':
          "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\nimport { TOOLS } from './tools.js';\nfor (const t of TOOLS) server.tool(t.id, t.description, t.params, run);\n",
        'src/tools.ts': tools(['widget_list', 'widget_drop']),
      },
      head: { 'src/tools.ts': tools(['widget_list']) },
    });
    const ids = extractIdentifiersFromGit(repo.root, baseSha, headSha);
    expect(ids.filter((i) => i.kind === 'mcpToolName')).toEqual([
      { kind: 'mcpToolName', value: 'src/tools.ts', changeType: 'modified', extractedBy: 'llm' },
    ]);
  });

  it('MCP SDK와 무관한 패키지의 코드는 도구 이름을 안 뽑는다', () => {
    const repo = createFakeRepo();
    const { baseSha, headSha } = createCommitPair(repo, {
      base: {
        'package.json': JSON.stringify({ name: 'plain', private: true }, null, 2),
        'src/a.ts': "cli.tool('widget_list');\nexport const d = { description: 'x' };\n",
      },
      head: { 'src/a.ts': "export const d = { description: 'y' };\n" },
    });
    expect(extractIdentifiersFromGit(repo.root, baseSha, headSha)).toEqual([]);
  });
});
