import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewReportGenerator } from '../../../src/review/report-generator.js';
import type {
  DroppedReviewIssue,
  ReviewConsensusResult,
  ReviewIssue,
} from '../../../src/core/types.js';

/** 3.7단계 제안 검증 결과가 리포트 어디에 어떤 꼴로 실리는지 본다 */

const generator = new ReviewReportGenerator();

function issue(overrides: Partial<ReviewIssue> & Pick<ReviewIssue, 'id'>): ReviewIssue {
  return {
    severity: 'high',
    category: 'quality',
    file: 'src/a.ts',
    message: `문제 ${overrides.id}`,
    suggestion: `제안 ${overrides.id}`,
    reportedBy: 'quality-reviewer',
    ...overrides,
  };
}

function drop(base: ReviewIssue, extra?: Partial<DroppedReviewIssue>): DroppedReviewIssue {
  return {
    ...base,
    dropReason: '근거로 든 규칙이 최신 base에서 폐지됐다',
    dropEvidence: 'git log --oneline abc..def -- docs/rule.md\n1a2b3c4 규칙 폐지',
    ...extra,
  };
}

function consensus(
  merged: ReviewIssue[],
  droppedIssues?: DroppedReviewIssue[],
): ReviewConsensusResult {
  return {
    mergedIssues: merged,
    approvedBy: [],
    blockedBy: [],
    summary: '요약',
    overallApproved: merged.every((i) => i.severity === 'warning'),
    ...(droppedIssues ? { droppedIssues } : {}),
  };
}

function lines(markdown: string): string[] {
  return markdown.split('\n');
}

describe('리포트: revise와 alsoCheck', () => {
  let repoRoot: string;

  beforeAll(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'gestalt-report-verify-'));
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(
      join(repoRoot, 'src/a.ts'),
      ['export function a() {', '  return 1;', '}'].join('\n'),
    );
  });

  afterAll(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('revise는 고친 이유와 원래 제안을 Suggestion 줄 바로 다음에 붙인다', () => {
    const report = generator.generate(
      consensus([
        issue({
          id: 'r',
          suggestion: '토큰을 뺀 필드만 싣는다',
          verification: {
            verdict: 'revise',
            reason: '원본을 그대로 실으면 Authorization 헤더가 직렬화된다.',
            originalSuggestion: 'AxiosError 원본을 extra에 싣는다',
          },
        }),
      ]),
      1,
    );

    const all = lines(report.markdown);
    const at = all.indexOf('- **Suggestion**: 토큰을 뺀 필드만 싣는다');
    expect(at).toBeGreaterThan(-1);
    expect(all[at + 1]).toBe(
      '- **제안 검증**: 원래 제안을 고쳤습니다. 원본을 그대로 실으면 Authorization 헤더가 직렬화된다.',
    );
    expect(all[at + 2]).toBe('- **원래 제안**: AxiosError 원본을 extra에 싣는다');
  });

  it('revise인데 originalSuggestion이 없으면 원래 제안 줄만 뺀다', () => {
    const report = generator.generate(
      consensus([issue({ id: 'r', verification: { verdict: 'revise', reason: '충돌' } })]),
      1,
    );

    expect(report.markdown).toContain('- **제안 검증**: 원래 제안을 고쳤습니다. 충돌');
    expect(report.markdown).not.toContain('**원래 제안**');
  });

  it('keep은 reason을 리포트에 싣지 않는다', () => {
    const report = generator.generate(
      consensus([issue({ id: 'k', verification: { verdict: 'keep', reason: '호출부 확인함' } })]),
      1,
    );

    expect(report.markdown).not.toContain('호출부 확인함');
    expect(report.markdown).not.toContain('- **제안 검증**');
  });

  it('alsoCheck는 제목 줄 아래 중첩 목록으로 싣고 스니펫은 그 뒤에 온다', () => {
    const report = generator.generate(
      consensus([
        issue({
          id: 'k',
          line: 2,
          verification: {
            verdict: 'keep',
            reason: '',
            alsoCheck: ['src/a.test.ts:12 단언', 'docs/a.md 예시 코드'],
          },
        }),
      ]),
      1,
      undefined,
      repoRoot,
    );

    const all = lines(report.markdown);
    const at = all.indexOf('- **반영할 때 같이 볼 자리**:');
    expect(at).toBeGreaterThan(-1);
    expect(all[at - 1]).toBe('- **Suggestion**: 제안 k');
    expect(all[at + 1]).toBe('  - src/a.test.ts:12 단언');
    expect(all[at + 2]).toBe('  - docs/a.md 예시 코드');

    const fence = all.findIndex((l) => /^```[a-z]*$/.test(l));
    expect(fence, '스니펫이 안 붙었다').toBeGreaterThan(at + 2);
  });

  it('revise와 alsoCheck가 함께 있으면 둘 다 싣는다', () => {
    const report = generator.generate(
      consensus([
        issue({
          id: 'r',
          verification: {
            verdict: 'revise',
            reason: '이유',
            originalSuggestion: '원래',
            alsoCheck: ['src/b.ts:3'],
          },
        }),
      ]),
      1,
    );

    const all = lines(report.markdown);
    const revise = all.indexOf('- **원래 제안**: 원래');
    expect(all[revise + 1]).toBe('- **반영할 때 같이 볼 자리**:');
    expect(all[revise + 2]).toBe('  - src/b.ts:3');
  });

  it('alsoCheck가 빈 배열이면 제목 줄도 안 싣는다', () => {
    const report = generator.generate(
      consensus([issue({ id: 'k', verification: { verdict: 'keep', reason: '', alsoCheck: [] } })]),
      1,
    );

    expect(report.markdown).not.toContain('반영할 때 같이 볼 자리');
  });
});

describe('리포트: 검증에서 뺀 이슈 절', () => {
  let repoRoot: string;

  beforeAll(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'gestalt-report-dropped-'));
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(join(repoRoot, 'src/d.ts'), ['const a = 1;', 'const b = 2;'].join('\n'));
  });

  afterAll(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('뺀 수를 제목에 적고 이슈 절 다음, 통계 표 앞에 둔다', () => {
    const report = generator.generate(
      consensus(
        [issue({ id: 'w', severity: 'warning' })],
        [drop(issue({ id: 'd1' })), drop(issue({ id: 'd2', severity: 'warning' }))],
      ),
      1,
    );

    const all = lines(report.markdown);
    const heading = all.indexOf('## 검증에서 뺀 이슈 (2개)');
    expect(heading).toBeGreaterThan(all.indexOf('## 🟡 Warnings'));
    expect(heading).toBeLessThan(all.indexOf('---'));
    expect(all[heading + 2]).toBe('판정에 넣지 않았고 코멘트로도 올리지 않습니다.');
  });

  it('통계 표의 Total과 severity 수에는 뺀 이슈가 안 들어간다', () => {
    const report = generator.generate(
      consensus(
        [issue({ id: 'w', severity: 'warning' })],
        [drop(issue({ id: 'd1', severity: 'high' })), drop(issue({ id: 'd2', severity: 'high' }))],
      ),
      1,
    );

    expect(report.markdown).toContain('| High | 0 |');
    expect(report.markdown).toContain('| Warning | 1 |');
    expect(report.markdown).toContain('| **Total** | **1** |');
  });

  it('항목마다 위치와 분류, 뺀 이유를 적고 근거는 text 펜스에 넣는다', () => {
    const report = generator.generate(
      consensus(
        [],
        [
          drop(issue({ id: 'd', line: 7, message: '규칙 위반', category: 'performance' }), {
            dropReason: '규칙이 폐지됐다',
            dropEvidence: 'git show abc:docs/rule.md\nfatal: path does not exist',
          }),
        ],
      ),
      1,
    );

    const all = lines(report.markdown);
    const at = all.indexOf('### 규칙 위반');
    expect(at).toBeGreaterThan(all.indexOf('## 검증에서 뺀 이슈 (1개)'));
    expect(all.slice(at + 2, at + 8)).toEqual([
      '- **Location**: `src/a.ts:7`',
      '- **Severity**: high',
      '- **Category**: performance',
      '- **Reported by**: quality-reviewer',
      '- **Suggestion**: 제안 d',
      '- **뺀 이유**: 규칙이 폐지됐다',
    ]);
    expect(all.slice(at + 9, at + 13)).toEqual([
      '```text',
      'git show abc:docs/rule.md',
      'fatal: path does not exist',
      '```',
    ]);
  });

  it('line이 없으면 위치에 파일만 적는다', () => {
    const report = generator.generate(consensus([], [drop(issue({ id: 'd' }))]), 1);

    expect(report.markdown).toContain('- **Location**: `src/a.ts`');
  });

  it('근거에 백틱 펜스가 들어 있으면 더 긴 펜스로 감싸 닫히지 않게 한다', () => {
    const evidence = ['$ cat notes.md', '```ts', 'const x = 1;', '```', '끝'].join('\n');
    const report = generator.generate(
      consensus([], [drop(issue({ id: 'd' }), { dropEvidence: evidence })]),
      1,
    );

    const all = lines(report.markdown);
    const open = all.indexOf('````text');
    expect(open, '네 칸 펜스로 열어야 한다').toBeGreaterThan(-1);
    expect(all.slice(open + 1, open + 6)).toEqual(evidence.split('\n'));
    expect(all[open + 6]).toBe('````');
  });

  it('뺀 이슈에는 line과 repoRoot가 있어도 스니펫을 안 붙인다', () => {
    const report = generator.generate(
      consensus([], [drop(issue({ id: 'd', file: 'src/d.ts', line: 2 }))]),
      1,
      undefined,
      repoRoot,
    );

    expect(report.markdown).not.toContain('const b = 2;');
    expect(report.markdown).not.toMatch(/^> *2 \| /m);
  });

  it('mergedIssues가 비어도 No issues found 다음에 뺀 이슈 절을 싣는다', () => {
    const report = generator.generate(consensus([], [drop(issue({ id: 'd' }))]), 1);

    const all = lines(report.markdown);
    expect(all.indexOf('No issues found.')).toBeGreaterThan(-1);
    expect(all.indexOf('## 검증에서 뺀 이슈 (1개)')).toBeGreaterThan(
      all.indexOf('No issues found.'),
    );
    expect(report.passed).toBe(true);
  });

  it('droppedIssues가 없거나 비면 절을 안 싣는다', () => {
    const none = generator.generate(consensus([issue({ id: 'w', severity: 'warning' })]), 1);
    const empty = generator.generate(consensus([issue({ id: 'w', severity: 'warning' })], []), 1);

    expect(none.markdown).not.toContain('검증에서 뺀 이슈');
    expect(empty.markdown).not.toContain('검증에서 뺀 이슈');
  });
});

describe('리포트: 검증을 거치지 않은 critical과 high', () => {
  const UNVERIFIED = /^\*\*제안 검증\*\*: 검증을 거치지 않은 critical\/high 이슈 (\d+)개$/;

  function unverifiedLine(markdown: string): string | undefined {
    return lines(markdown).find((l) => UNVERIFIED.test(l));
  }

  it('verification 없는 critical과 high 수를 한 줄로 적는다', () => {
    const report = generator.generate(
      consensus([
        issue({ id: 'c', severity: 'critical' }),
        issue({ id: 'h', severity: 'high' }),
        issue({ id: 'v', severity: 'high', verification: { verdict: 'keep', reason: '' } }),
        issue({ id: 'w', severity: 'warning' }),
      ]),
      1,
    );

    expect(unverifiedLine(report.markdown)).toBe(
      '**제안 검증**: 검증을 거치지 않은 critical/high 이슈 2개',
    );
  });

  it('severity 절보다 앞에 둔다', () => {
    const report = generator.generate(consensus([issue({ id: 'c', severity: 'critical' })]), 1);

    const all = lines(report.markdown);
    const at = all.findIndex((l) => UNVERIFIED.test(l));
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(all.indexOf('## 🔴 Critical Issues'));
  });

  it('정합 심급 절이 있으면 그 절 다음에 둔다', () => {
    const report = generator.generate(consensus([issue({ id: 'h', severity: 'high' })]), 1, {
      coherent: false,
      driftFindings: [{ axis: 'drift', message: '범위 밖 변경' }],
      escalate: false,
      summary: '정합 요약',
    });

    const all = lines(report.markdown);
    const at = all.findIndex((l) => UNVERIFIED.test(l));
    expect(at).toBeGreaterThan(all.findIndex((l) => l.includes('Continuity Instance')));
    expect(at).toBeLessThan(all.indexOf('## 🟠 High Issues'));
  });

  it('critical과 high가 전부 검증을 거쳤거나 warning뿐이면 줄을 안 싣는다', () => {
    const verified = generator.generate(
      consensus([
        issue({ id: 'c', severity: 'critical', verification: { verdict: 'keep', reason: '' } }),
        issue({
          id: 'h',
          severity: 'high',
          verification: { verdict: 'revise', reason: 'r', originalSuggestion: 'o' },
        }),
      ]),
      1,
    );
    const warningsOnly = generator.generate(
      consensus([issue({ id: 'w', severity: 'warning' })]),
      1,
    );

    expect(unverifiedLine(verified.markdown)).toBeUndefined();
    expect(unverifiedLine(warningsOnly.markdown)).toBeUndefined();
  });

  it('뺀 이슈는 미검증 수에 안 들어간다', () => {
    const report = generator.generate(
      consensus([], [drop(issue({ id: 'd', severity: 'critical' }))]),
      1,
    );

    expect(unverifiedLine(report.markdown)).toBeUndefined();
  });
});
