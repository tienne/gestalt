import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OLD_VERSION,
  buildLabelSheet,
  buildReplayReport,
  collectLabelItems,
  commentsFromCollect,
  commentsFromReview,
  isReadOnlyGhCall,
  checkoutLabel,
  matchesExpectation,
  parseReplayArgs,
  parseReplayList,
  summarizeVersion,
  type ReplayComment,
  type ReplayEntryResult,
  type ReplayReportInput,
  type ReplayRun,
} from '../../../src/harness-review/replay.js';

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

function comment(over: Partial<ReplayComment> = {}): ReplayComment {
  return {
    source: 'collect',
    kind: 'selfContamination',
    path: 'docs/rules.md',
    line: 10,
    relatedPath: null,
    relatedLine: null,
    body: '금지어가 본문에 있다',
    ...over,
  };
}

function run(version: 'old' | 'new', iteration: number, comments: ReplayComment[]): ReplayRun {
  return {
    version,
    iteration,
    collect: { status: version === 'old' ? 'unsupported' : 'ok' },
    review: { status: 'skipped' },
    comments,
  };
}

describe('parseReplayArgs', () => {
  it('기본값을 채운다', () => {
    const a = unwrap(parseReplayArgs(['--pr-list', 'list.json'], '/work'));
    expect(a).toEqual({
      prList: 'list.json',
      repoDir: '/work',
      oldVersion: DEFAULT_OLD_VERSION,
      repeat: 3,
      backend: 'local',
      relatedDirs: [],
      reviewCmd: null,
      codeGraphDb: null,
    });
  });

  it('옵션을 모두 받는다', () => {
    const a = unwrap(
      parseReplayArgs(
        [
          '--pr-list',
          'l.json',
          '--repo-dir',
          '/r',
          '--old-version',
          '0.80.0',
          '--repeat',
          '5',
          '--backend',
          'github',
          '--related-dir',
          'acme/widget-kit=/w',
          '--related-dir',
          '/x',
          '--review-cmd',
          'echo "[]" > "$GESTALT_REPLAY_OUT"',
          '--code-graph-db',
          '/g/code-graph.db',
        ],
        '/work',
      ),
    );
    expect(a.repeat).toBe(5);
    expect(a.backend).toBe('github');
    expect(a.relatedDirs).toEqual(['acme/widget-kit=/w', '/x']);
    expect(a.reviewCmd).toContain('GESTALT_REPLAY_OUT');
    expect(a.codeGraphDb).toBe('/g/code-graph.db');
  });

  it.each([
    [[], '--pr-list가 필요하다'],
    [['--pr-list'], '값이 없다'],
    [['--pr-list', 'l', '--repeat', '0'], '--repeat'],
    [['--pr-list', 'l', '--backend', 'remote'], '--backend'],
    [['--pr-list', 'l', '--old-version', 'latest'], '--old-version'],
    [['--pr-list', 'l', '--post'], '값이 없다'],
    [['--pr-list', 'l', '--post', 'yes'], '모르는 옵션'],
  ])('%j는 거부한다', (argv, message) => {
    const r = parseReplayArgs(argv, '/work');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });
});

describe('parseReplayList', () => {
  it('pr 번호 항목과 커밋 범위 항목을 받는다', () => {
    const entries = unwrap(
      parseReplayList(
        JSON.stringify({
          entries: [
            { pr: 12, repo: 'acme/design-kit' },
            {
              base: 'abc1234def',
              head: 'fed4321cba',
              expected: [{ id: 'fix-1', path: 'docs/a.md', line: 16, text: '사본을 두면' }],
            },
          ],
        }),
      ),
    );
    expect(entries[0]).toMatchObject({ id: 'pr-12', pr: 12, followedByFix: false });
    expect(entries[1]).toMatchObject({ id: 'abc1234..fed4321', followedByFix: true });
    expect(entries[1]!.expected[0]).toEqual({
      id: 'fix-1',
      description: 'fix-1',
      path: 'docs/a.md',
      line: 16,
      text: '사본을 두면',
    });
  });

  it('followedByFix를 적으면 그 값을 따른다', () => {
    const [e] = unwrap(parseReplayList(JSON.stringify([{ pr: 3, followedByFix: true }])));
    expect(e!.followedByFix).toBe(true);
  });

  it.each([
    ['not json', 'JSON이 아니다'],
    ['[]', '비었다'],
    [JSON.stringify([{ repo: 'acme/x' }]), 'base와 head'],
    [JSON.stringify([{ pr: 1, repo: 'acme' }]), 'owner/name'],
    [JSON.stringify([{ base: '--upload-pack=x', head: 'a' }]), '쓸 수 없는 값'],
    [JSON.stringify([{ pr: 1 }, { pr: 1 }]), 'id가 겹친다'],
    [JSON.stringify([{ pr: 1, expected: [{ id: 'x' }] }]), 'path나 text'],
    [JSON.stringify([{ pr: 1, expected: [{ id: 'x', path: 'a', line: 0 }] }]), 'line'],
  ])('%s는 거부한다', (text, message) => {
    const r = parseReplayList(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });
});

describe('commentsFromCollect', () => {
  it('kind별 후보를 코멘트로 편다', () => {
    const out = commentsFromCollect({
      candidates: {
        selfContamination: [
          {
            sourceFile: 'rules/a.md',
            sourceLine: 4,
            targetRepo: 'acme/rules',
            targetPath: 'rules/a.md',
            targetLine: 9,
            matchedText: '원본',
          },
        ],
        copyDrift: [],
        forwardRef: [
          {
            sourceFile: 'README.md',
            sourceLine: 0,
            targetRepo: 'acme/widget-kit',
            targetPath: 'x.md',
          },
        ],
        backwardRef: 'broken',
      },
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      kind: 'selfContamination',
      path: 'rules/a.md',
      line: 4,
      relatedLine: 9,
    });
    expect(out[0]!.body).toBe('acme/rules:rules/a.md — 원본');
    expect(out[1]).toMatchObject({
      kind: 'forwardRef',
      line: null,
      relatedPath: 'x.md',
      relatedLine: null,
    });
  });

  it('역방향 후보는 걸린 줄 내용이 본문에 실려 기대 문구와 맞춰볼 수 있다', () => {
    const [c] = commentsFromCollect({
      candidates: {
        backwardRef: [
          {
            sourceFile: 'skills/pick/SKILL.md',
            sourceLine: 7,
            targetRepo: 'acme/widget-kit',
            targetPath: 'skills/pick/SKILL.md',
            matchedText: 'guides/',
            contextLines: ['목록은 `find ./guides`로 만든다'],
          },
        ],
      },
    });
    expect(
      matchesExpectation(c!, {
        id: 'x',
        description: '',
        path: 'skills/pick/SKILL.md',
        line: 7,
        text: 'find ./guides',
      }),
    ).toBe(true);
  });

  it('모양이 다르면 빈 배열이다', () => {
    expect(commentsFromCollect(null)).toEqual([]);
    expect(commentsFromCollect({ candidates: [] })).toEqual([]);
  });
});

describe('commentsFromReview', () => {
  it('ReviewIssue 배열, issues 묶음, ReviewResult 배열을 모두 받는다', () => {
    const issue = { file: 'a.ts', line: 3, message: '누락', category: 'harness:copyDrift' };
    expect(commentsFromReview([issue])).toHaveLength(1);
    expect(commentsFromReview({ issues: [issue] })).toHaveLength(1);
    const out = commentsFromReview([
      { agentName: 'x', issues: [issue] },
      { agentName: 'y', issues: [{ path: 'b.md', startLine: 2, body: '본문' }] },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      source: 'review',
      kind: 'harness:copyDrift',
      path: 'a.ts',
      line: 3,
    });
    expect(out[1]).toMatchObject({ kind: 'review', path: 'b.md', line: 2, body: '본문' });
  });

  it('본문 없는 항목은 버린다', () => {
    expect(commentsFromReview([{ file: 'a.ts', line: 1 }])).toEqual([]);
  });
});

describe('matchesExpectation', () => {
  it('path는 코멘트 자리나 후보가 가리키는 자리 중 하나와 맞으면 된다', () => {
    expect(
      matchesExpectation(comment({ relatedPath: 'b.md' }), {
        id: 'x',
        description: '',
        path: 'b.md',
      }),
    ).toBe(true);
    expect(matchesExpectation(comment(), { id: 'x', description: '', path: 'c.md' })).toBe(false);
  });

  it('줄 번호는 lineTolerance가 없으면 정확히 같아야 한다', () => {
    const e = { id: 'x', description: '', path: 'docs/rules.md', line: 11 };
    expect(matchesExpectation(comment(), e)).toBe(false);
    expect(matchesExpectation(comment(), { ...e, lineTolerance: 1 })).toBe(true);
    expect(matchesExpectation(comment({ line: null }), { ...e, lineTolerance: 5 })).toBe(false);
  });

  it('후보가 가리키는 자리와 맞출 때는 그 자리의 줄 번호로 잰다', () => {
    const c = comment({ relatedPath: 'agents/writer.md', relatedLine: 16 });
    const e = { id: 'x', description: '', path: 'agents/writer.md', line: 17 };
    expect(matchesExpectation(c, e)).toBe(false);
    expect(matchesExpectation(c, { ...e, lineTolerance: 1 })).toBe(true);
    // 룰 자리의 줄(10)이 우연히 맞아도 다른 파일이면 안 걸린다
    expect(matchesExpectation(c, { ...e, line: 10 })).toBe(false);
    expect(matchesExpectation(comment({ relatedPath: 'b.md' }), { ...e, path: 'b.md' })).toBe(
      false,
    );
  });

  it('text는 본문에 들어 있어야 한다', () => {
    expect(matchesExpectation(comment(), { id: 'x', description: '', text: '금지어' })).toBe(true);
    expect(matchesExpectation(comment(), { id: 'x', description: '', text: '사본' })).toBe(false);
  });

  it('리뷰 코멘트는 리뷰어 말로 쓰므로 text 없이 자리만 맞으면 잡은 것으로 본다', () => {
    const review = comment({ source: 'review', kind: 'review', body: '옛 경로를 가리킨다' });
    const e = { id: 'x', description: '', path: 'docs/rules.md', line: 11, lineTolerance: 3 };
    expect(matchesExpectation(review, { ...e, text: '`components/a.md` 파일을 읽는다' })).toBe(
      true,
    );
    expect(matchesExpectation(review, { ...e, path: 'other.md', text: 'x' })).toBe(false);
  });
});

describe('summarizeVersion', () => {
  it('회차 순서대로 개수를 모으고 평균과 상태를 적는다', () => {
    const s = summarizeVersion(
      [run('new', 2, [comment(), comment()]), run('new', 1, []), run('old', 1, [comment()])],
      'new',
    );
    expect(s.counts).toEqual([0, 2]);
    expect(s.mean).toBe(1);
    expect(s.notes).toContain('리뷰 안 돌림 2/2회');
    const old = summarizeVersion([run('old', 1, [])], 'old');
    expect(old.notes).toContain('collect 명령 없음 1/1회');
  });
});

function fixture(): ReplayReportInput {
  const hit = comment({
    path: 'agents/writer.md',
    line: 17,
    body: '룰 원본은 한 곳에 둔다. 사본을 두면',
  });
  const noise = comment({ path: 'README.md', line: 3, body: '관련 없는 후보' });
  const clean: ReplayEntryResult = {
    entry: {
      id: 'pr-1',
      pr: 1,
      repo: null,
      base: null,
      head: null,
      followedByFix: false,
      expected: [],
      note: null,
    },
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    error: null,
    runs: [
      run('old', 1, []),
      run('new', 1, [noise]),
      run('old', 2, []),
      run('new', 2, [noise, noise]),
    ],
  };
  const fixed: ReplayEntryResult = {
    entry: {
      id: 'series',
      pr: null,
      repo: null,
      base: 'c',
      head: 'd',
      followedByFix: true,
      expected: [
        { id: 'e-hit', description: '사본 문장', path: 'agents/writer.md', line: 17 },
        { id: 'e-miss', description: '금지 목록 누락', text: 'output-style' },
      ],
      note: '뒤따른 fix 두 개',
    },
    base: 'c'.repeat(40),
    head: 'd'.repeat(40),
    error: null,
    runs: [run('old', 1, []), run('new', 1, [hit]), run('old', 2, []), run('new', 2, [])],
  };
  const broken: ReplayEntryResult = {
    entry: { ...clean.entry, id: 'pr-9', pr: 9 },
    base: null,
    head: null,
    error: '범위를 못 구했다: gh 막힘',
    runs: [],
  };
  return {
    runId: 'r1',
    createdAt: '2026-09-29T00:00:00.000Z',
    repoLabel: 'widget-kit',
    backend: 'local',
    repeat: 2,
    reviewCmdGiven: false,
    versions: { old: '0.83.2', new: checkoutLabel('abc1234') },
    results: [clean, fixed, broken],
  };
}

describe('checkoutLabel', () => {
  it('옛 버전과 같은 번호가 안 찍히게 커밋으로 이름을 붙인다', () => {
    expect(checkoutLabel('abc1234')).toBe('현재 체크아웃(abc1234)');
    expect(checkoutLabel('abc1234', true)).toBe('현재 체크아웃(abc1234, 미커밋 변경 포함)');
    expect(checkoutLabel(null)).toBe('현재 체크아웃(커밋 모름)');
  });
});

describe('buildReplayReport', () => {
  const md = buildReplayReport(fixture());

  it('fix가 안 따라온 PR은 회차별 코멘트 수와 평균 차이를 적는다', () => {
    expect(md).toContain('## fix가 안 따라온 PR');
    expect(md).toMatch(
      /\| pr-1 \| `aaaaaaa\.\.bbbbbbb` \| 0, 0 \(평균 0\.0\) \| 1, 2 \(평균 1\.5\) \| \+1\.5 \|/,
    );
    expect(md).toContain('0.83.2 collect 명령 없음 2/2회');
  });

  it('fix가 따라온 PR은 기대 항목마다 잡은 회차를 적는다', () => {
    expect(md).toContain('### series');
    expect(md).toContain('| e-hit | 사본 문장 | agents/writer.md:17 | 0/2 | 1/2 |');
    expect(md).toContain('| e-miss | 금지 목록 누락 | "output-style" | 0/2 | 0/2 |');
    expect(md).toContain(
      '현재 체크아웃(abc1234): 한 번이라도 잡은 항목 1개, 한 번도 못 잡은 항목 1개',
    );
  });

  it('재현 못 한 항목을 따로 적는다', () => {
    expect(md).toContain('- pr-9: 범위를 못 구했다: gh 막힘');
  });

  it('합격이나 불합격 판정을 적지 않는다', () => {
    expect(md).not.toMatch(/통과|불합격|합격|PASS|FAIL/i);
  });
});

describe('collectLabelItems / buildLabelSheet', () => {
  it('새 버전 코멘트를 회차를 넘어 하나로 묶는다', () => {
    const items = collectLabelItems(fixture().results);
    const readme = items.find((i) => i.comment.path === 'README.md');
    expect(readme).toMatchObject({
      entryId: 'pr-1',
      seenRuns: 2,
      totalRuns: 2,
      inOldVersion: false,
    });
    expect(items).toHaveLength(2);
  });

  it('옛 버전에도 같은 자리가 있으면 표시한다', () => {
    const input = fixture();
    input.results[0]!.runs[0]!.comments.push(
      comment({ path: 'README.md', line: 3, body: '다른 문장' }),
    );
    const readme = collectLabelItems(input.results).find((i) => i.comment.path === 'README.md');
    expect(readme!.inOldVersion).toBe(true);
  });

  it('코멘트마다 빈 label 줄을 둔다', () => {
    const sheet = buildLabelSheet(fixture());
    expect(sheet.match(/^label: $/gm)).toHaveLength(2);
    expect(sheet).toContain('> 룰 원본은 한 곳에 둔다. 사본을 두면');
    expect(sheet).toContain('`correct`나 `incorrect`');
  });
});

describe('isReadOnlyGhCall', () => {
  it.each([
    ['search', 'code', 'foo', '--owner', 'acme'],
    ['pr', 'view', '12', '--json', 'body'],
    ['pr', 'diff', '12'],
    ['api', 'user', '--jq', '.login'],
    ['api', '-X', 'GET', 'repos/acme/x'],
    ['auth', 'status'],
  ])('읽기 호출 %j는 통과시킨다', (...args) => {
    expect(isReadOnlyGhCall(args)).toBe(true);
  });

  it.each([
    ['pr', 'review', '12', '--approve'],
    ['pr', 'comment', '12', '--body', 'x'],
    ['pr', 'merge', '12'],
    ['issue', 'comment', '1'],
    ['api', 'repos/acme/x/pulls/1/reviews', '-f', 'event=APPROVE'],
    ['api', 'graphql', '-F', 'query=mutation{}'],
    ['api', '-X', 'POST', 'repos/acme/x/issues/1/comments'],
    ['api', '--method=PATCH', 'repos/acme/x'],
    ['api', '-XDELETE', 'repos/acme/x'],
    ['api', 'x', '--input', 'body.json'],
    ['pr'],
    [],
  ])('쓰기 호출 %j는 막는다', (...args) => {
    expect(isReadOnlyGhCall(args)).toBe(false);
  });
});
