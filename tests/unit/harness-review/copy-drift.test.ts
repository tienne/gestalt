import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { syncCoChange } from '../../../src/code-graph/cochange.js';
import { CodeGraphStore } from '../../../src/code-graph/storage.js';
import {
  extractKeyPhrase,
  findCopyDrift,
  findListInsertions,
  summarizeDiff,
} from '../../../src/harness-review/copy-drift.js';
import {
  cleanupFakeRepos,
  commitSeries,
  createCommitPair,
  createFakeRepo,
  writeIdenticalPair,
} from '../../helpers/fake-repo.js';

const dbs: string[] = [];

function tempDbPath(): string {
  const dir = resolve('.gestalt-test');
  mkdirSync(dir, { recursive: true });
  const p = resolve(dir, `copy-drift-${randomUUID()}.db`);
  dbs.push(p);
  return p;
}

// 테스트마다 DB 없는 경로를 명시해 레포의 실제 코드 그래프를 읽지 않게 한다
function noDb(): string {
  return resolve('.gestalt-test', `missing-${randomUUID()}.db`);
}

afterEach(() => {
  cleanupFakeRepos();
  for (const p of dbs.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(p + suffix, { force: true });
  }
});

const RULE_DOC = [
  '# 주석 규칙',
  '',
  '- 주석은 WHY만 남긴다.',
  '- 자명한 코드에는 주석을 달지 않는다.',
  '',
].join('\n');

describe('findCopyDrift — blob SHA가 같던 쌍', () => {
  it('base에서 같던 두 파일 중 한쪽만 바뀌면 후보가 나온다', () => {
    const repo = createFakeRepo();
    writeIdenticalPair(repo, 'plugin/a/rules.md', 'plugin/b/rules.md', RULE_DOC);
    const { baseSha, headSha } = createCommitPair(repo, {
      base: { 'README.md': '# widget-kit\n' },
      head: { 'plugin/a/rules.md': RULE_DOC + '- TODO는 남기지 않는다.\n' },
    });

    const r = findCopyDrift({
      repoRoot: repo.root,
      base: baseSha,
      head: headSha,
      codeGraphDbPath: noDb(),
    });

    expect(r.bySource.identicalBlob).toHaveLength(1);
    const c = r.bySource.identicalBlob[0]!;
    expect(c).toMatchObject({
      kind: 'copyDrift',
      sourceFile: 'plugin/a/rules.md',
      targetPath: 'plugin/b/rules.md',
      targetRepo: '.',
      needsLlmJudgment: false,
    });
    expect(c.sourceLine).toBe(5);
    expect(c.contextLines).toContain('+- TODO는 남기지 않는다.');
  });

  it('두 파일이 똑같이 바뀌었거나 한쪽이 지워졌으면 후보가 없다', () => {
    const repo = createFakeRepo();
    writeIdenticalPair(repo, 'a.md', 'b.md', RULE_DOC);
    writeIdenticalPair(repo, 'c.md', 'd.md', RULE_DOC + 'x\n');
    const next = RULE_DOC + '- 추가 규칙 문장이다.\n';
    const { baseSha, headSha } = createCommitPair(repo, {
      base: {},
      head: { 'a.md': next, 'b.md': next, 'c.md': null },
    });

    const r = findCopyDrift({
      repoRoot: repo.root,
      base: baseSha,
      head: headSha,
      codeGraphDbPath: noDb(),
    });
    expect(r.bySource.identicalBlob).toEqual([]);
  });

  it('빈 파일끼리는 같은 blob이어도 사본으로 보지 않는다', () => {
    const repo = createFakeRepo();
    writeIdenticalPair(repo, 'src/a/.gitkeep', 'src/b/.gitkeep', '');
    const { baseSha, headSha } = createCommitPair(repo, {
      base: {},
      head: { 'src/a/.gitkeep': 'x\n' },
    });
    const r = findCopyDrift({
      repoRoot: repo.root,
      base: baseSha,
      head: headSha,
      codeGraphDbPath: noDb(),
    });
    expect(r.bySource.identicalBlob).toEqual([]);
  });

  it('양쪽이 서로 다르게 바뀌면 쌍 하나만 낸다', () => {
    const repo = createFakeRepo();
    writeIdenticalPair(repo, 'a.md', 'b.md', RULE_DOC);
    const { baseSha, headSha } = createCommitPair(repo, {
      base: {},
      head: { 'a.md': RULE_DOC + '- 가\n', 'b.md': RULE_DOC + '- 나\n' },
    });
    const r = findCopyDrift({
      repoRoot: repo.root,
      base: baseSha,
      head: headSha,
      codeGraphDbPath: noDb(),
    });
    expect(r.bySource.identicalBlob).toHaveLength(1);
  });
});

describe('findCopyDrift — co-change', () => {
  it('함께 바뀌던 이웃 중 이번에 안 바뀐 파일이 후보로 나온다', () => {
    const repo = createFakeRepo();
    commitSeries(repo, [
      { 'src/detector.ts': 'detector v1\n', 'docs/rules.md': 'rules v1\n' },
      { 'src/detector.ts': 'detector v2\n', 'docs/rules.md': 'rules v2\n' },
      { 'src/detector.ts': 'detector v3\n', 'docs/rules.md': 'rules v3\n' },
    ]);
    const { baseSha, headSha } = createCommitPair(repo, {
      base: {},
      head: { 'docs/rules.md': 'rules v4\n' },
    });

    const dbPath = tempDbPath();
    const store = new CodeGraphStore(dbPath);
    expect(syncCoChange(store, repo.root)).toBeDefined();
    store.close();

    const r = findCopyDrift({
      repoRoot: repo.root,
      base: baseSha,
      head: headSha,
      codeGraphDbPath: dbPath,
    });

    expect(r.coChange.checked).toBe(true);
    expect(r.bySource.coChange).toHaveLength(1);
    expect(r.bySource.coChange[0]).toMatchObject({
      kind: 'copyDrift',
      sourceFile: 'docs/rules.md',
      targetPath: 'src/detector.ts',
      needsLlmJudgment: false,
    });
    expect(r.bySource.coChange[0]!.matchedText).toMatch(/co-change 3회/);
  });

  it('이웃도 함께 바뀌었으면 후보가 없다', () => {
    const repo = createFakeRepo();
    commitSeries(repo, [
      { 'a.ts': 'a1\n', 'b.ts': 'b1\n' },
      { 'a.ts': 'a2\n', 'b.ts': 'b2\n' },
      { 'a.ts': 'a3\n', 'b.ts': 'b3\n' },
    ]);
    const { baseSha, headSha } = createCommitPair(repo, {
      base: {},
      head: { 'a.ts': 'a4\n', 'b.ts': 'b4\n' },
    });
    const dbPath = tempDbPath();
    const store = new CodeGraphStore(dbPath);
    syncCoChange(store, repo.root);
    store.close();

    const r = findCopyDrift({
      repoRoot: repo.root,
      base: baseSha,
      head: headSha,
      codeGraphDbPath: dbPath,
    });
    expect(r.coChange.checked).toBe(true);
    expect(r.bySource.coChange).toEqual([]);
  });

  it('코드 그래프 DB가 없으면 co-change 경로만 건너뛰고 리포트에 적는다', () => {
    const repo = createFakeRepo();
    writeIdenticalPair(repo, 'a.md', 'b.md', RULE_DOC);
    const { baseSha, headSha } = createCommitPair(repo, {
      base: {},
      head: { 'a.md': RULE_DOC + '- 새 문장\n' },
    });

    const r = findCopyDrift({ repoRoot: repo.root, base: baseSha, head: headSha });

    expect(r.coChange.checked).toBe(false);
    expect(r.coChange.reason).toMatch(/코드 그래프 DB가 없어/);
    expect(r.limitations.some((l) => l.includes('co-change'))).toBe(true);
    expect(r.bySource.identicalBlob).toHaveLength(1);
  });
});

describe('findCopyDrift — 숨은 사본', () => {
  const OLD = '- 룰 원본은 이 파일이고 사본을 두면 어긋나기 쉽다.';

  it('바뀐 규칙 문장의 핵심 구절이 다른 파일에 남아 있으면 후보가 나온다', () => {
    const repo = createFakeRepo();
    const { baseSha, headSha } = createCommitPair(repo, {
      base: {
        'docs/rules.md': ['# 규칙', '', OLD, ''].join('\n'),
        'plugin/agents/reviewer/AGENT.md': [
          '# reviewer',
          '',
          '판정 전에 룰북을 읽는다.',
          '룰 원본은 이 파일이고 사본을 두면 어긋나기 쉽다',
          '끝.',
          '',
        ].join('\n'),
      },
      head: {
        'docs/rules.md': ['# 규칙', '', '- 룰북은 여러 곳에 두고 함께 고친다.', ''].join('\n'),
      },
    });

    const r = findCopyDrift({
      repoRoot: repo.root,
      base: baseSha,
      head: headSha,
      codeGraphDbPath: noDb(),
    });

    expect(r.bySource.hiddenCopy).toHaveLength(1);
    const c = r.bySource.hiddenCopy[0]!;
    expect(c).toMatchObject({
      kind: 'copyDrift',
      sourceFile: 'docs/rules.md',
      sourceLine: 3,
      targetPath: 'plugin/agents/reviewer/AGENT.md',
      matchedText: '룰 원본은 이 파일이고 사본을 두면 어긋나기 쉽다',
      needsLlmJudgment: false,
    });
    expect(c.contextLines).toEqual([
      '',
      '판정 전에 룰북을 읽는다.',
      '룰 원본은 이 파일이고 사본을 두면 어긋나기 쉽다',
      '끝.',
      '',
    ]);
  });

  it('문장을 같은 파일 안에서 옮기기만 했으면 후보가 없다', () => {
    const repo = createFakeRepo();
    const { baseSha, headSha } = createCommitPair(repo, {
      base: {
        'docs/rules.md': ['# 규칙', OLD, '- 다른 줄', ''].join('\n'),
        'other.md': '룰 원본은 이 파일이고 사본을 두면 어긋나기 쉽다\n',
      },
      head: { 'docs/rules.md': ['# 규칙', '- 다른 줄', OLD, ''].join('\n') },
    });
    const r = findCopyDrift({
      repoRoot: repo.root,
      base: baseSha,
      head: headSha,
      codeGraphDbPath: noDb(),
    });
    expect(r.bySource.hiddenCopy).toEqual([]);
  });

  it('파일을 다른 디렉토리로 옮기기만 했으면 옮긴 파일을 사본으로 보지 않는다', () => {
    const repo = createFakeRepo();
    const doc = ['# 규칙', OLD, '- 다른 줄', ''].join('\n');
    const { baseSha, headSha } = createCommitPair(repo, {
      base: { 'docs/rules.md': doc },
      head: { 'docs/rules.md': null, 'guide/docs/rules.md': doc },
    });
    const r = findCopyDrift({
      repoRoot: repo.root,
      base: baseSha,
      head: headSha,
      codeGraphDbPath: noDb(),
    });
    expect(r.bySource.hiddenCopy).toEqual([]);
  });

  it('중복을 한 곳으로 모은 PR이면 모인 자리는 빼고 diff 밖에 남은 사본만 낸다', () => {
    const repo = createFakeRepo();
    const doc = ['# 규칙', OLD, '- 다른 줄', ''].join('\n');
    const { baseSha, headSha } = createCommitPair(repo, {
      base: { 'CLAUDE.md': doc, 'docs/strategy.md': `${doc}- 전략 문서에만 있는 줄\n` },
      head: { 'CLAUDE.md': '# 규칙\n\n- 규칙은 docs/rules.md에 있다\n', 'docs/rules.md': doc },
    });
    const r = findCopyDrift({
      repoRoot: repo.root,
      base: baseSha,
      head: headSha,
      codeGraphDbPath: noDb(),
    });
    expect(r.bySource.hiddenCopy.map((c) => c.targetPath)).toEqual(['docs/strategy.md']);
  });
});

describe('findCopyDrift — 같게 유지 선언', () => {
  const CLAUDE = [
    '# widget-kit',
    '',
    '- 배포 클라이언트는 `plugin/.mcp.json`(점 파일)을 읽는다. `plugin/mcp.json`과 내용을 같게 유지한다.',
    '- local 명령도 규칙은 동일하게 지킨다.',
    '',
  ].join('\n');

  it('선언된 쌍 중 한쪽만 바뀌면 LLM 판정 대상으로 분리된다', () => {
    const repo = createFakeRepo();
    const { baseSha, headSha } = createCommitPair(repo, {
      base: {
        'CLAUDE.md': CLAUDE,
        'plugin/mcp.json': '{ "a": 1 }\n',
        'plugin/.mcp.json': '{ "a": 1, "note": true }\n',
      },
      head: { 'plugin/mcp.json': '{ "a": 2 }\n' },
    });

    const r = findCopyDrift({
      repoRoot: repo.root,
      base: baseSha,
      head: headSha,
      codeGraphDbPath: noDb(),
    });

    expect(r.bySource.syncDeclared).toHaveLength(1);
    const c = r.bySource.syncDeclared[0]!;
    expect(c).toMatchObject({
      kind: 'copyDrift',
      sourceFile: 'plugin/mcp.json',
      targetPath: 'plugin/.mcp.json',
      needsLlmJudgment: true,
    });
    expect(c.matchedText).toMatch(/^CLAUDE\.md:3: /);
    expect(r.candidates.filter((x) => x.needsLlmJudgment)).toEqual([c]);
  });

  it('blob이 같던 쌍에 선언도 있으면 선언 쪽에만 남는다', () => {
    const repo = createFakeRepo();
    writeIdenticalPair(repo, 'plugin/mcp.json', 'plugin/.mcp.json', '{ "a": 1 }\n');
    const { baseSha, headSha } = createCommitPair(repo, {
      base: { 'CLAUDE.md': CLAUDE },
      head: { 'plugin/.mcp.json': '{ "a": 2 }\n' },
    });
    const r = findCopyDrift({
      repoRoot: repo.root,
      base: baseSha,
      head: headSha,
      codeGraphDbPath: noDb(),
    });
    expect(r.bySource.identicalBlob).toEqual([]);
    expect(r.bySource.syncDeclared).toHaveLength(1);
    expect(r.candidates).toHaveLength(1);
  });

  it('선언 표현이 있어도 줄에 파일 쌍이 없으면 후보가 없다', () => {
    const repo = createFakeRepo();
    const { baseSha, headSha } = createCommitPair(repo, {
      base: {
        'CLAUDE.md': '- 규칙은 동일하게 지킨다.\n- keep in sync with upstream.\n',
        'a.md': 'x\n',
      },
      head: { 'a.md': 'y\n' },
    });
    const r = findCopyDrift({
      repoRoot: repo.root,
      base: baseSha,
      head: headSha,
      codeGraphDbPath: noDb(),
    });
    expect(r.bySource.syncDeclared).toEqual([]);
  });

  it('"이 파일" 선언은 선언한 문서 자신과 짝을 짓는다', () => {
    const repo = createFakeRepo();
    const { baseSha, headSha } = createCommitPair(repo, {
      base: {
        'docs/voice.md': '이 파일은 `../plugin/voice.md`와 같게 유지한다.\n',
        'plugin/voice.md': '원문\n',
      },
      head: { 'plugin/voice.md': '바뀐 원문\n' },
    });
    const r = findCopyDrift({
      repoRoot: repo.root,
      base: baseSha,
      head: headSha,
      codeGraphDbPath: noDb(),
    });
    expect(r.bySource.syncDeclared.map((c) => [c.sourceFile, c.targetPath])).toEqual([
      ['plugin/voice.md', 'docs/voice.md'],
    ]);
  });
});

describe('findCopyDrift — 변경 없음', () => {
  it('관련 없는 변경이면 어느 경로에서도 후보가 없다', () => {
    const repo = createFakeRepo();
    const { baseSha, headSha } = createCommitPair(repo, {
      base: { 'a.md': '# a\n', 'b.md': '# b\n' },
      head: { 'a.md': '# a2\n' },
    });
    const r = findCopyDrift({
      repoRoot: repo.root,
      base: baseSha,
      head: headSha,
      codeGraphDbPath: noDb(),
    });
    expect(r.candidates).toEqual([]);
  });
});

describe('extractKeyPhrase', () => {
  it('서식 기호에서 끊고 가장 긴 구절을 고른다', () => {
    expect(extractKeyPhrase('- **룰 원본**은 `style.md`이고, 사본을 두면 어긋나기 쉽다.')).toBe(
      '사본을 두면 어긋나기 쉽다',
    );
  });

  it('짧은 줄, 코드 펜스, 표 구분선은 버린다', () => {
    expect(extractKeyPhrase('- 짧다')).toBeNull();
    expect(extractKeyPhrase('```ts')).toBeNull();
    expect(extractKeyPhrase('|---|:--:|')).toBeNull();
  });

  it('영어만 있는 구절은 네 낱말 이상일 때만 쓴다', () => {
    expect(extractKeyPhrase('  throw new Error(msg);')).toBeNull();
    expect(extractKeyPhrase('- Always run the full review pipeline.')).toBe(
      'Always run the full review pipeline',
    );
  });
});

describe('summarizeDiff', () => {
  it('파일별 삭제 줄과 추가 줄의 번호를 base와 head 기준으로 매긴다', () => {
    const raw = [
      'diff --git a/x.md b/x.md',
      '--- a/x.md',
      '+++ b/x.md',
      '@@ -3 +3,2 @@',
      '-old',
      '+new1',
      '+new2',
      'diff --git a/gone.md b/gone.md',
      '--- a/gone.md',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-bye',
    ].join('\n');
    const files = summarizeDiff(raw);
    expect(files.get('x.md')).toEqual({
      firstLine: 3,
      removed: [{ line: 3, text: 'old' }],
      added: [
        { line: 3, text: 'new1' },
        { line: 4, text: 'new2' },
      ],
    });
    expect(files.get('gone.md')!.removed).toEqual([{ line: 1, text: 'bye' }]);
  });
});

describe('findListInsertions', () => {
  const summary = (removed: string, added: string) => ({
    firstLine: 3,
    removed: [{ line: 3, text: removed }],
    added: [{ line: 3, text: added }],
  });

  it('목록 끝에 항목 하나를 더한 줄에서 원래 목록과 새 항목을 뽑는다', () => {
    expect(
      findListInsertions(
        summary(
          '지침(`AGENTS.md`·`CLAUDE.md`·`GEMINI.md`)을 먼저 읽는다',
          '지침(`AGENTS.md`·`CLAUDE.md`·`GEMINI.md`·`.rules/`)을 먼저 읽는다',
        ),
      ),
    ).toEqual([{ anchor: '`AGENTS.md`·`CLAUDE.md`·`GEMINI.md`', item: '.rules/', sourceLine: 3 }]);
  });

  it('한 줄의 두 목록에 각각 끼운 항목을 따로 뽑는다', () => {
    const found = findListInsertions(
      summary(
        '(`a.md`·`b.md`·`c.md`)를 읽고 (`x.md`·`y.md`·`z.md`)를 본다',
        '(`a.md`·`b.md`·`c.md`·`d/`)를 읽고 (`x.md`·`y.md`·`z.md`·`d/`)를 본다',
      ),
    );
    expect(found.map((f) => f.anchor)).toEqual(['`a.md`·`b.md`·`c.md`', '`x.md`·`y.md`·`z.md`']);
  });

  it('항목이 둘뿐이거나 지운 글자가 있으면 끼움으로 안 본다', () => {
    expect(findListInsertions(summary('A·B를 읽는다', 'A·B·C를 읽는다'))).toEqual([]);
    expect(findListInsertions(summary('`a`·`b`·`c`를 읽는다', '`a`·`b`·`d`·`e`를 읽는다'))).toEqual(
      [],
    );
  });
});

describe('findCopyDrift — 목록 끼움', () => {
  afterEach(() => cleanupFakeRepos());

  it('diff 밖의 같은 목록 중 새 항목이 없는 줄만 낸다', () => {
    const repo = createFakeRepo();
    const list = '지침(`AGENTS.md`·`CLAUDE.md`·`GEMINI.md`)을 먼저 읽는다';
    const { baseSha, headSha } = createCommitPair(repo, {
      base: {
        'plugin/skills/a/SKILL.md': `# a\n\n${list}\n`,
        'plugin/skills/b/SKILL.md': `# b\n\n배포 전 ${list}\n`,
        'plugin/skills/c/SKILL.md': '# c\n\n`AGENTS.md`·`CLAUDE.md`·`GEMINI.md`·`.rules/`를 본다\n',
      },
      head: {
        'plugin/skills/a/SKILL.md': `# a\n\n${list.replace('`GEMINI.md`', '`GEMINI.md`·`.rules/`')}\n`,
      },
    });
    const r = findCopyDrift({
      repoRoot: repo.root,
      base: baseSha,
      head: headSha,
      codeGraphDbPath: noDb(),
    });
    expect(
      r.bySource.hiddenCopy.map((c) => [c.targetPath, c.targetLine, c.needsLlmJudgment]),
    ).toEqual([['plugin/skills/b/SKILL.md', 3, true]]);
  });
});
