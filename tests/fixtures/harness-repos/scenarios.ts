import {
  commitSeries,
  createCommitPair,
  createFakeOrg,
  createFakeRepo,
  writeIdenticalPair,
  type CommitPair,
  type FakeOrg,
  type FakeRepo,
} from '../../helpers/fake-repo.js';

// 모든 이름은 가공이다. 사내 레포 이름과 경로, 실제 스킬 문장을 넣지 않는다.

const SKILL_FM = (name: string) => `---\nname: ${name}\ndescription: ${name} 스킬\n---\n`;

export interface SelfContaminationScenario extends CommitPair {
  repo: FakeRepo;
  /** diff가 새로 금지한 단어 */
  bannedTerm: string;
  /** 같은 뜻의 다른 표기와 영어 원어. 검색어 확장이 잡아야 하는 것들 */
  synonyms: string[];
  /** 금지어(동의어 포함)를 아직 쓰고 있어 후보로 나와야 하는 md */
  contaminatedFiles: string[];
  /** 금지어 표기가 전혀 없어 후보에서 빠져야 하는 md */
  cleanFiles: string[];
}

// 룰북에 금지어를 더한 PR이 다른 문서의 용례를 놓치는 자기오염을 재현한다.
export function buildSelfContaminationRepo(): SelfContaminationScenario {
  const repo = createFakeRepo({ name: 'widget-kit' });
  const rules = 'plugin/role-agents/_shared/references/style-rules.md';
  const pair = createCommitPair(repo, {
    base: {
      [rules]: '# 스타일 규칙\n\n## A-1\n\n번역투를 쓰지 않는다.\n',
      'docs/guide.md': '# 가이드\n\n글을 쓸 때 은유를 아끼지 않는다.\n다음 줄은 평범한 문장이다.\n',
      'plugin/role-agents/writer/AGENT.md':
        '# writer\n\n- 설명은 metaphor 하나로 시작한다\n- 예시는 짧게\n',
      'plugin/skills/notes/SKILL.md': `${SKILL_FM('notes')}\n메모는 짧게 남긴다.\n`,
    },
    head: {
      [rules]:
        '# 스타일 규칙\n\n## A-1\n\n번역투를 쓰지 않는다.\n\n## A-2\n\n메타포를 쓰지 않는다.\n',
    },
    headBranch: 'add-banned-term',
  });
  return {
    ...pair,
    repo,
    bannedTerm: '메타포',
    synonyms: ['은유', 'metaphor'],
    contaminatedFiles: ['docs/guide.md', 'plugin/role-agents/writer/AGENT.md'],
    cleanFiles: ['plugin/skills/notes/SKILL.md'],
  };
}

export interface CopyDriftScenario extends CommitPair {
  repo: FakeRepo;
  /** 내용이 같아 blob SHA가 같은 사본 쌍. 한쪽만 바뀐다 */
  identicalPair: { changed: string; other: string; blobSha: string };
  /** 늘 함께 바뀌던 co-change 쌍. head에서 changed만 바뀐다 */
  coChangePair: { changed: string; other: string };
  /** 바뀐 규칙 문장이 그대로 들어 있는 숨은 사본 */
  hiddenCopy: { path: string; oldSentence: string; newSentence: string };
  /** 문서에 같게 유지하라고 적힌 쌍. LLM 판정 대상으로 넘겨야 한다 */
  keepInSyncPair: { changed: string; other: string };
}

// 사본 어긋남의 네 경로(blob SHA, co-change, 문장 grep, 같게 유지 명시)를 한 레포에 담는다.
export function buildCopyDriftRepo(): CopyDriftScenario {
  const repo = createFakeRepo({ name: 'widget-kit' });
  const oldSentence = '제목은 명사구로 끝낸다';
  const newSentence = '제목은 명사구로 끝내고 마침표를 붙이지 않는다';
  const rule = (s: string) => `# 제목 규칙\n\n${s}.\n`;

  const identical = writeIdenticalPair(
    repo,
    'plugin/role-agents/a/references/title-rule.md',
    'plugin/role-agents/b/references/title-rule.md',
    rule(oldSentence),
  );

  // co-change 이력은 커밋이 여러 번 쌓여야 잡힌다
  commitSeries(repo, [
    { 'docs/pr-template.md': '템플릿 v1\n', 'docs/pr-guide.md': '가이드 v1\n' },
    { 'docs/pr-template.md': '템플릿 v2\n', 'docs/pr-guide.md': '가이드 v2\n' },
    { 'docs/pr-template.md': '템플릿 v3\n', 'docs/pr-guide.md': '가이드 v3\n' },
  ]);

  const pair = createCommitPair(repo, {
    base: {
      'docs/hidden-note.md': `# 메모\n\n커밋 제목 규칙: ${oldSentence}.\n`,
      'docs/sync-a.md': '<!-- docs/sync-b.md와 같게 유지한다 -->\n\n설명 A\n',
      'docs/sync-b.md': '<!-- docs/sync-a.md와 같게 유지한다 -->\n\n설명 B\n',
    },
    head: {
      'plugin/role-agents/a/references/title-rule.md': rule(newSentence),
      'docs/pr-template.md': '템플릿 v4\n',
      'docs/sync-a.md': '<!-- docs/sync-b.md와 같게 유지한다 -->\n\n설명 A 개정\n',
    },
    headBranch: 'edit-title-rule',
  });

  return {
    ...pair,
    repo,
    identicalPair: {
      changed: 'plugin/role-agents/a/references/title-rule.md',
      other: 'plugin/role-agents/b/references/title-rule.md',
      blobSha: identical.blobSha,
    },
    coChangePair: { changed: 'docs/pr-template.md', other: 'docs/pr-guide.md' },
    hiddenCopy: { path: 'docs/hidden-note.md', oldSentence, newSentence },
    keepInSyncPair: { changed: 'docs/sync-a.md', other: 'docs/sync-b.md' },
  };
}

export interface PlaceholderScenario {
  org: FakeOrg;
  /** 파일 경로는 조직 안 레포 기준 상대 경로 */
  files: {
    /** {REPO_ROOT}가 design-kit을 가리킨다 */
    pointsToDesignKit: { repo: string; file: string; placeholder: string; target: string };
    /** 같은 {REPO_ROOT}인데 이 파일에서는 widget-kit을 가리킨다 */
    pointsToWidgetKit: { repo: string; file: string; placeholder: string; target: string };
    /** 자기 레포와 다른 레포에 모두 있는 경로. 자기 레포가 이겨야 한다 */
    ownRepoFirst: { repo: string; file: string; placeholder: string; target: string };
    /** 여러 레포에 다 있는 흔한 경로. LLM 판정 대상(multiple) */
    commonPathCollision: { repo: string; file: string; placeholder: string; target: string };
    /** 어느 레포에도 없다. LLM 판정 대상(none) */
    matchesNothing: { repo: string; file: string; placeholder: string; target: string };
  };
}

// 같은 자리표시자가 파일마다 다른 레포를 가리키고 README.md 같은 흔한 경로가 충돌하는 상황이다.
export function buildPlaceholderOrg(): PlaceholderScenario {
  const skill = (name: string, body: string) => `${SKILL_FM(name)}\n${body}\n`;
  const org = createFakeOrg({
    repos: {
      'design-kit': {
        'rules/naming.md': '# 이름 규칙\n',
        'package.json': '{ "name": "design-kit" }\n',
        'README.md': '# design-kit\n',
      },
      'widget-kit': {
        'src/theme.ts': 'export const theme = {};\n',
        'package.json': '{ "name": "widget-kit" }\n',
        'README.md': '# widget-kit\n',
        'plugin/skills/naming-check/SKILL.md': skill(
          'naming-check',
          '이름 규칙은 `{REPO_ROOT}/rules/naming.md`를 읽는다.',
        ),
        'plugin/skills/readme-check/SKILL.md': skill(
          'readme-check',
          '`{REPO_ROOT}/README.md`를 읽는다.',
        ),
        'plugin/skills/ghost-check/SKILL.md': skill(
          'ghost-check',
          '`{REPO_ROOT}/docs/nothing-here.md`를 읽는다.',
        ),
      },
      'acme-app': {
        'package.json': '{ "name": "acme-app" }\n',
        'README.md': '# acme-app\n',
        'plugin/skills/theme-check/SKILL.md': skill(
          'theme-check',
          '토큰은 `{REPO_ROOT}/src/theme.ts`에서 온다.',
        ),
        'plugin/skills/pkg-check/SKILL.md': skill(
          'pkg-check',
          '버전은 `$REPO_ROOT/package.json`을 본다.',
        ),
      },
    },
  });
  return {
    org,
    files: {
      pointsToDesignKit: {
        repo: 'widget-kit',
        file: 'plugin/skills/naming-check/SKILL.md',
        placeholder: '{REPO_ROOT}',
        target: 'rules/naming.md',
      },
      pointsToWidgetKit: {
        repo: 'acme-app',
        file: 'plugin/skills/theme-check/SKILL.md',
        placeholder: '{REPO_ROOT}',
        target: 'src/theme.ts',
      },
      ownRepoFirst: {
        repo: 'acme-app',
        file: 'plugin/skills/pkg-check/SKILL.md',
        placeholder: '$REPO_ROOT',
        target: 'package.json',
      },
      commonPathCollision: {
        repo: 'widget-kit',
        file: 'plugin/skills/readme-check/SKILL.md',
        placeholder: '{REPO_ROOT}',
        target: 'README.md',
      },
      matchesNothing: {
        repo: 'widget-kit',
        file: 'plugin/skills/ghost-check/SKILL.md',
        placeholder: '{REPO_ROOT}',
        target: 'docs/nothing-here.md',
      },
    },
  };
}

export interface FileNameOnlyRefScenario {
  org: FakeOrg;
  /** 하네스 문서가 이름만으로 부르는 파일 */
  fileName: string;
  /** 참조를 받는 쪽(파일이 있는 레포)의 삭제 diff */
  provider: CommitPair;
  consumerDoc: { repo: string; file: string };
  /** 여러 레포에 흔히 있어서 식별자로 못 쓰는 파일 이름 */
  commonFileName: string;
}

// 경로 없이 파일 이름만 적은 참조가 식별자로 뽑히는지 재현한다.
export function buildFileNameOnlyRefOrg(): FileNameOnlyRefScenario {
  const fileName = 'widget-palette.json';
  const org = createFakeOrg({
    repos: {
      'widget-kit': {
        [`config/${fileName}`]: '{ "colors": [] }\n',
        'config/index.json': '{}\n',
      },
      'acme-app': {
        'plugin/skills/palette/SKILL.md': `${SKILL_FM('palette')}\n색은 ${fileName}에 적힌 값만 쓴다. 그 외 index.json은 건드리지 않는다.\n`,
        'config/index.json': '{}\n',
      },
    },
  });
  const widgetKit = org.repos['widget-kit']!;
  const provider = createCommitPair(widgetKit, {
    base: {},
    head: { [`config/${fileName}`]: null },
    headBranch: 'remove-palette',
  });
  return {
    org,
    fileName,
    provider,
    consumerDoc: { repo: 'acme-app', file: 'plugin/skills/palette/SKILL.md' },
    commonFileName: 'index.json',
  };
}

export interface ReceiveOnlyScenario {
  org: FakeOrg;
  /** 이름으로 불리기만 하는 레포. 다른 레포를 부르지 않는다 */
  receiver: string;
  /** 스킬 이름이 바뀌는 diff. 역방향 후보가 나와야 한다 */
  rename: CommitPair & { oldName: string; newName: string };
  caller: { repo: string; file: string };
}

// 받기만 하는 레포에서는 순방향 후보가 0건이고 역방향 후보만 나와야 한다.
export function buildReceiveOnlyOrg(): ReceiveOnlyScenario {
  const oldName = 'widget-audit';
  const newName = 'widget-inspect';
  const org = createFakeOrg({
    repos: {
      'widget-kit': {
        [`plugin/skills/${oldName}/SKILL.md`]: `${SKILL_FM(oldName)}\n위젯을 점검한다.\n`,
        'README.md': '# widget-kit\n\n위젯 모음.\n',
      },
      'acme-app': {
        'plugin/skills/release/SKILL.md': `${SKILL_FM('release')}\n출시 전에 ${oldName} 스킬을 먼저 돌린다.\n`,
      },
    },
  });
  const receiver = org.repos['widget-kit']!;
  const pair = createCommitPair(receiver, {
    base: {},
    head: {
      [`plugin/skills/${oldName}/SKILL.md`]: null,
      [`plugin/skills/${newName}/SKILL.md`]: `${SKILL_FM(newName)}\n위젯을 점검한다.\n`,
    },
    headBranch: 'rename-skill',
  });
  return {
    org,
    receiver: 'widget-kit',
    rename: { ...pair, oldName, newName },
    caller: { repo: 'acme-app', file: 'plugin/skills/release/SKILL.md' },
  };
}

export interface IsolatedScenario {
  org: FakeOrg;
  /** 참조를 주지도 받지도 않는 레포 */
  isolated: string;
  change: CommitPair;
}

// 참조 후보와 코멘트가 모두 0건이어야 하는 기준선이다.
export function buildIsolatedOrg(): IsolatedScenario {
  const org = createFakeOrg({
    repos: {
      'lonely-kit': {
        'plugin/skills/tidy/SKILL.md': `${SKILL_FM('tidy')}\n파일을 정리한다.\n`,
        'docs/notes.md': '# 메모\n\n혼자 쓰는 문서.\n',
      },
      'acme-app': {
        'plugin/skills/deploy/SKILL.md': `${SKILL_FM('deploy')}\n배포한다.\n`,
      },
    },
  });
  const lonely = org.repos['lonely-kit']!;
  const change = createCommitPair(lonely, {
    base: {},
    head: {
      'plugin/skills/tidy/SKILL.md': `${SKILL_FM('tidy')}\n파일을 정리하고 결과를 알린다.\n`,
    },
    headBranch: 'edit-tidy',
  });
  return { org, isolated: 'lonely-kit', change };
}

export interface KnowledgeDocScenario {
  org: FakeOrg;
  /** 레포를 설명으로만 언급하는 지식 문서. 하네스 참조가 아니다 */
  knowledgeDoc: { repo: string; file: string };
  /** 진짜 하네스 참조 */
  harnessRef: { repo: string; file: string };
  change: CommitPair & { removedPath: string };
}

// 설명으로만 이름이 나오는 문서를 하네스 참조와 나눠 분류하는지 재현한다.
export function buildKnowledgeDocOrg(): KnowledgeDocScenario {
  const removedPath = 'src/legacy-loader.ts';
  const org = createFakeOrg({
    repos: {
      'widget-kit': {
        [removedPath]: 'export const load = () => {};\n',
        'src/index.ts': 'export {};\n',
      },
      'acme-app': {
        'docs/architecture.md':
          '# 구조\n\nwidget-kit은 위젯 컴포넌트 모음이다. 앱은 이걸 가져다 쓴다.\n',
        'plugin/skills/loader/SKILL.md': `${SKILL_FM('loader')}\nwidget-kit의 ${removedPath}를 읽어 구조를 파악한다.\n`,
      },
    },
  });
  const widgetKit = org.repos['widget-kit']!;
  const pair = createCommitPair(widgetKit, {
    base: {},
    head: { [removedPath]: null },
    headBranch: 'remove-loader',
  });
  return {
    org,
    knowledgeDoc: { repo: 'acme-app', file: 'docs/architecture.md' },
    harnessRef: { repo: 'acme-app', file: 'plugin/skills/loader/SKILL.md' },
    change: { ...pair, removedPath },
  };
}

export interface NoRemoteScenario {
  repo: FakeRepo;
  change: CommitPair;
}

// GitHub 원격이 없어 조직을 알 수 없는 레포. 참조 검사를 리뷰 불가로 봐야 한다.
export function buildNoRemoteRepo(): NoRemoteScenario {
  const repo = createFakeRepo({ name: 'widget-kit', remote: false });
  const change = createCommitPair(repo, {
    base: { 'plugin/skills/greet/SKILL.md': `${SKILL_FM('greet')}\n인사한다.\n` },
    head: { 'plugin/skills/greet/SKILL.md': `${SKILL_FM('greet')}\n먼저 인사한다.\n` },
    headBranch: 'edit-greet',
  });
  return { repo, change };
}

export interface McpToolScenario {
  org: FakeOrg;
  /** @modelcontextprotocol/sdk에 의존하고 도구 등록부가 패턴으로 잡히는 패키지 */
  server: { repo: string; file: string; toolNames: string[] };
  /** 패턴으로 못 잡히는 동적 등록부. LLM 판정 대상 */
  dynamicRegistry: { repo: string; file: string };
  /** 도구 이름을 부르는 다른 레포의 하네스 파일 */
  caller: { repo: string; file: string };
  /** 도구 이름을 바꾸는 diff. 하네스 문서 PR이 아니어도 역방향 검색이 돌아야 한다 */
  rename: CommitPair & { oldName: string; newName: string };
}

const SERVER_TS = (
  name: string,
) => `import { Server } from '@modelcontextprotocol/sdk/server/index.js';

const server = new Server({ name: 'widget-mcp', version: '1.0.0' });

server.tool('${name}', { limit: 'number' }, async () => ({
  content: [{ type: 'text', text: JSON.stringify({ widgets: [] }) }],
}));

server.tool('acme_get_widget', { id: 'string' }, async () => ({ content: [] }));
`;

// 하네스 문서가 아닌 코드(MCP 도구 정의) 변경이 다른 레포의 이름 참조를 깨는 상황이다.
export function buildMcpToolOrg(): McpToolScenario {
  const oldName = 'acme_list_widgets';
  const newName = 'acme_search_widgets';
  const org = createFakeOrg({
    repos: {
      'widget-mcp': {
        'package.json': JSON.stringify(
          {
            name: '@acme/widget-mcp',
            version: '1.0.0',
            dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
          },
          null,
          2,
        ),
        'src/server.ts': SERVER_TS(oldName),
        'src/dynamic.ts': `import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { tools } from './tool-table.js';

const server = new Server({ name: 'widget-mcp', version: '1.0.0' });
for (const t of tools) registerTool(server, t);
declare function registerTool(s: Server, t: unknown): void;
`,
        'src/tool-table.ts': 'export const tools: unknown[] = [];\n',
      },
      'acme-app': {
        'plugin/agents/planner/AGENT.md': `# planner\n\n위젯 목록은 ${oldName} 도구로 가져온다. 응답의 widgets 필드를 쓴다.\n`,
        '.mcp.json': JSON.stringify(
          { mcpServers: { widgets: { command: 'widget-mcp' } } },
          null,
          2,
        ),
      },
    },
  });
  const server = org.repos['widget-mcp']!;
  const pair = createCommitPair(server, {
    base: {},
    head: { 'src/server.ts': SERVER_TS(newName) },
    headBranch: 'rename-tool',
  });
  return {
    org,
    server: {
      repo: 'widget-mcp',
      file: 'src/server.ts',
      toolNames: [oldName, 'acme_get_widget'],
    },
    dynamicRegistry: { repo: 'widget-mcp', file: 'src/dynamic.ts' },
    caller: { repo: 'acme-app', file: 'plugin/agents/planner/AGENT.md' },
    rename: { ...pair, oldName, newName },
  };
}

export type ThreeStateCase = 'mergeOrder' | 'bothBroken' | 'relatedRemovesUsed';

export interface ThreeStateScenario {
  org: FakeOrg;
  kind: ThreeStateCase;
  /** 이번 PR이 있는 레포와 그 base, head */
  consumer: { repo: string; baseSha: string; headSha: string; branch: string; file: string };
  /** 참조 대상 레포. main과 연관 PR 브랜치를 가진다 */
  provider: {
    repo: string;
    mainBranch: string;
    mainSha: string;
    relatedBranch: string;
    relatedHeadSha: string;
  };
  /** 이번 PR이 쓰는 식별자 */
  identifier: string;
  expected: {
    onMain: 'ok' | 'broken';
    onRelatedHead: 'ok' | 'broken';
    verdict: 'notDefect_mergeOrder' | 'defect' | 'relatedRemovesUsed';
  };
}

const CONSUMER_FILE = 'plugin/skills/apply/SKILL.md';
const skillWith = (id: string) => `${SKILL_FM('apply')}\n스타일은 ${id} 규칙을 따른다.\n`;

// 참조 대상 레포의 main과 연관 PR 브랜치를 갈라 세 상태 판정의 세 경우를 브랜치로 표현한다.
export function buildThreeStateOrg(kind: ThreeStateCase): ThreeStateScenario {
  const spec = {
    // main에는 없고 연관 PR이 새로 만든다
    mergeOrder: { id: 'rule-new', main: [], related: { add: 'rule-new', drop: null } },
    // 어디에도 없다
    bothBroken: { id: 'rule-ghost', main: [], related: { add: 'rule-other', drop: null } },
    // main에는 있는데 연관 PR이 지운다
    relatedRemovesUsed: {
      id: 'rule-used',
      main: ['rule-used'],
      related: { add: null, drop: 'rule-used' },
    },
  }[kind];

  const ruleFile = (id: string) => `rules/${id}.md`;
  const org = createFakeOrg({
    repos: {
      'design-kit': Object.fromEntries([
        ['README.md', '# design-kit\n'],
        ...spec.main.map((id) => [ruleFile(id), `# ${id}\n`]),
      ]),
      'widget-kit': { 'README.md': '# widget-kit\n' },
    },
  });
  const provider = org.repos['design-kit']!;
  const consumer = org.repos['widget-kit']!;

  const mainSha = provider.head();
  provider.branch('related-pr');
  if (spec.related.add) provider.write(ruleFile(spec.related.add), `# ${spec.related.add}\n`);
  if (spec.related.drop) provider.remove(ruleFile(spec.related.drop));
  const relatedHeadSha = provider.commit('related change');
  provider.checkout('main');

  const pr = createCommitPair(consumer, {
    base: { [CONSUMER_FILE]: skillWith('rule-old') },
    head: { [CONSUMER_FILE]: skillWith(spec.id) },
    headBranch: 'use-rule',
  });

  const expected = {
    mergeOrder: { onMain: 'broken', onRelatedHead: 'ok', verdict: 'notDefect_mergeOrder' },
    bothBroken: { onMain: 'broken', onRelatedHead: 'broken', verdict: 'defect' },
    relatedRemovesUsed: { onMain: 'ok', onRelatedHead: 'broken', verdict: 'relatedRemovesUsed' },
  } as const;

  return {
    org,
    kind,
    consumer: {
      repo: 'widget-kit',
      baseSha: pr.baseSha,
      headSha: pr.headSha,
      branch: 'use-rule',
      file: CONSUMER_FILE,
    },
    provider: {
      repo: 'design-kit',
      mainBranch: 'main',
      mainSha,
      relatedBranch: 'related-pr',
      relatedHeadSha,
    },
    identifier: spec.id,
    expected: expected[kind],
  };
}

export interface FollowUpScenario {
  org: FakeOrg;
  /** 이번 PR에서 resolve하고 넘기는 작업 */
  planned: { originRepo: string; targetRepo: string; work: string };
  /** 후속 PR이 이미 머지된 것처럼 후속 레포에 만들어 둔 브랜치 */
  followUp: { repo: string; branch: string; headSha: string; touchedFiles: string[] };
  /** 후속 PR에 표시가 가리킨 작업이 빠진 경우의 브랜치 */
  followUpMissingWork: { branch: string; headSha: string };
}

// 후속 PR이 표시가 가리킨 작업을 했는지 안 했는지를 브랜치 둘로 표현한다.
export function buildFollowUpOrg(): FollowUpScenario {
  const work = 'widget-inspect로 스킬 이름 갱신';
  const target = 'plugin/skills/release/SKILL.md';
  const org = createFakeOrg({
    repos: {
      'widget-kit': { 'plugin/skills/widget-inspect/SKILL.md': `${SKILL_FM('widget-inspect')}\n` },
      'acme-app': { [target]: `${SKILL_FM('release')}\n출시 전에 widget-audit를 돌린다.\n` },
    },
  });
  const app = org.repos['acme-app']!;
  app.branch('follow-up-done');
  app.write(target, `${SKILL_FM('release')}\n출시 전에 widget-inspect를 돌린다.\n`);
  const doneSha = app.commit('follow up');
  app.branch('follow-up-missing', 'main');
  app.write('docs/unrelated.md', '# 관련 없는 수정\n');
  const missingSha = app.commit('unrelated change');
  app.checkout('main');
  return {
    org,
    planned: { originRepo: 'widget-kit', targetRepo: 'acme-app', work },
    followUp: {
      repo: 'acme-app',
      branch: 'follow-up-done',
      headSha: doneSha,
      touchedFiles: [target],
    },
    followUpMissingWork: { branch: 'follow-up-missing', headSha: missingSha },
  };
}

export interface PhraseRootScenario extends CommitPair {
  repo: FakeRepo;
  rulebook: string;
  /** 자리표시자 든 금지 예 구절에서 조사를 떼고 남아야 하는 어근 */
  roots: string[];
  /** 어근을 산문에 그대로 써서 후보로 나와야 하는 자리 */
  contaminated: Array<{ path: string; line: number }>;
  /** 어근이 인용 안에만 있어 후보에서 빠져야 하는 md */
  cleanFiles: string[];
}

// 대체어 표에 자리표시자 든 금지 예 구절만 더한 PR. 구절째로는 어디에도 없고 어근만 다른 문서에 남는다
export function buildPhraseRootRepo(): PhraseRootScenario {
  const repo = createFakeRepo({ name: 'widget-kit' });
  const rulebook = 'plugin/role-agents/_shared/references/ai-tell-quick-rules.md';
  const table = [
    '# 룰북',
    '',
    '### 대체어',
    '',
    '| 원어 | 쓰지 말 것 | 이렇게 |',
    '|---|---|---|',
    '| materialize | 물질화한다 | 만들어 둔다 |',
    '',
  ].join('\n');
  const pair = createCommitPair(repo, {
    base: {
      [rulebook]: table,
      'plugin/review-agents/lint-reviewer/AGENT.md':
        '# lint-reviewer\n\n룰 원본은 `rules.md`입니다. 사본을 두면 룰북과 갈라집니다.\n',
      'plugin/review-agents/tone-reviewer/AGENT.md':
        '# tone-reviewer\n\n기준은 `tone.md`에 있고 그게 정본이다.\n',
      'plugin/review-agents/quote-reviewer/AGENT.md':
        '# quote-reviewer\n\n"정본"이나 `원본` 같은 딱지는 쓰지 않는다.\n',
      'docs/guide.md': '# 가이드\n\n이 파일만 읽는다.\n',
    },
    head: {
      [rulebook]: table.replace(
        '| materialize | 물질화한다 | 만들어 둔다 |',
        '| materialize | 물질화한다 | 만들어 둔다 |\n' +
          '| canonical (사본 여럿 중 하나) | "A가 정본이다", "원본은 A다" | 파일 이름만 쓴다 |',
      ),
    },
    headBranch: 'add-phrase-row',
  });
  return {
    ...pair,
    repo,
    rulebook,
    roots: ['정본', '원본'],
    contaminated: [
      { path: 'plugin/review-agents/lint-reviewer/AGENT.md', line: 3 },
      { path: 'plugin/review-agents/tone-reviewer/AGENT.md', line: 3 },
    ],
    cleanFiles: ['plugin/review-agents/quote-reviewer/AGENT.md', 'docs/guide.md'],
  };
}
