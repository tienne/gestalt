import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewReportGenerator } from '../../../src/review/report-generator.js';
import type { ReviewConsensusResult, ReviewIssue } from '../../../src/core/types.js';

describe('ReviewReportGenerator', () => {
  const generator = new ReviewReportGenerator();

  it('generates passed report for clean consensus', () => {
    const consensus: ReviewConsensusResult = {
      mergedIssues: [],
      approvedBy: ['architect', 'security-reviewer'],
      blockedBy: [],
      summary: 'All good.',
      overallApproved: true,
    };

    const report = generator.generate(consensus, 1);

    expect(report.passed).toBe(true);
    expect(report.attempt).toBe(1);
    expect(report.markdown).toContain('PASSED');
    expect(report.markdown).toContain('No issues found');
    expect(report.generatedAt).toBeDefined();
  });

  it('generates blocked report with issues grouped by severity', () => {
    const consensus: ReviewConsensusResult = {
      mergedIssues: [
        {
          id: '1',
          severity: 'critical',
          category: 'security',
          file: 'a.ts',
          line: 10,
          message: 'SQL injection',
          suggestion: 'Use params',
          reportedBy: 'sec',
        },
        {
          id: '2',
          severity: 'high',
          category: 'perf',
          file: 'b.ts',
          message: 'N+1 query',
          suggestion: 'Batch',
          reportedBy: 'perf',
        },
        {
          id: '3',
          severity: 'warning',
          category: 'quality',
          file: 'c.ts',
          message: 'Magic number',
          suggestion: 'Extract const',
          reportedBy: 'qual',
        },
      ],
      approvedBy: ['architect'],
      blockedBy: ['security-reviewer'],
      summary: 'Critical issues.',
      overallApproved: false,
    };

    const report = generator.generate(consensus, 2);

    expect(report.passed).toBe(false);
    expect(report.markdown).toContain('BLOCKED');
    expect(report.markdown).toContain('Critical Issues');
    expect(report.markdown).toContain('High Issues');
    expect(report.markdown).toContain('Warnings');
    expect(report.markdown).toContain('SQL injection');
    expect(report.markdown).toContain('a.ts:10');
    expect(report.markdown).toContain('Blocked by');
  });

  it('includes severity count table', () => {
    const consensus: ReviewConsensusResult = {
      mergedIssues: [
        {
          id: '1',
          severity: 'critical',
          category: 'sec',
          file: 'a.ts',
          message: 'm',
          suggestion: 's',
          reportedBy: 'r',
        },
        {
          id: '2',
          severity: 'critical',
          category: 'sec',
          file: 'b.ts',
          message: 'm',
          suggestion: 's',
          reportedBy: 'r',
        },
        {
          id: '3',
          severity: 'warning',
          category: 'q',
          file: 'c.ts',
          message: 'm',
          suggestion: 's',
          reportedBy: 'r',
        },
      ],
      approvedBy: [],
      blockedBy: ['sec'],
      summary: 'Issues.',
      overallApproved: false,
    };

    const report = generator.generate(consensus, 1);

    expect(report.markdown).toContain('| Critical | 2 |');
    expect(report.markdown).toContain('| High | 0 |');
    expect(report.markdown).toContain('| Warning | 1 |');
    expect(report.markdown).toContain('| **Total** | **3** |');
  });

  it('shows file location without line when line is undefined', () => {
    const consensus: ReviewConsensusResult = {
      mergedIssues: [
        {
          id: '1',
          severity: 'high',
          category: 'q',
          file: 'src/app.ts',
          message: 'Issue',
          suggestion: 'Fix',
          reportedBy: 'r',
        },
      ],
      approvedBy: [],
      blockedBy: ['r'],
      summary: 'Issue.',
      overallApproved: false,
    };

    const report = generator.generate(consensus, 1);
    expect(report.markdown).toContain('`src/app.ts`');
    expect(report.markdown).not.toContain('src/app.ts:undefined');
  });

  describe('코드 스니펫', () => {
    let repoRoot: string;

    const issue = (file: string, line?: number): ReviewIssue => ({
      id: '1',
      severity: 'critical',
      category: 'security',
      file,
      line,
      message: 'Token decoded without verification',
      suggestion: 'Use jwt.verify',
      reportedBy: 'security-reviewer',
    });

    const consensusWith = (...issues: ReviewIssue[]): ReviewConsensusResult => ({
      mergedIssues: issues,
      approvedBy: [],
      blockedBy: ['security-reviewer'],
      summary: 'Issues.',
      overallApproved: false,
    });

    /** 스니펫 코드펜스 안쪽 라인만 뽑는다 */
    const snippetBody = (markdown: string): string[] => {
      const all = markdown.split('\n');
      const open = all.findIndex((l) => /^```[a-z]*$/.test(l));
      if (open === -1) return [];
      const close = all.indexOf('```', open + 1);
      return all.slice(open + 1, close);
    };

    const lineNos = (markdown: string): number[] =>
      snippetBody(markdown)
        .filter((l) => /^[> ] *\d+ \| /.test(l))
        .map((l) => Number(/(\d+)/.exec(l)![1]));

    beforeAll(() => {
      repoRoot = mkdtempSync(join(tmpdir(), 'gestalt-snippet-'));
      mkdirSync(join(repoRoot, 'src'), { recursive: true });

      // 1  import jwt from 'jsonwebtoken';
      // 2  (빈 줄)
      // 3  export function currentUser(req: Request) {
      // 4 ~ 12  본문 (12번이 닫는 중괄호)
      // 13 (빈 줄)
      // 14 export function logout() {  ← 다음 함수
      writeFileSync(
        join(repoRoot, 'src/auth.ts'),
        [
          "import jwt from 'jsonwebtoken';", // 1
          '', // 2
          'export function currentUser(req: Request) {', // 3
          '  const header = req.headers.authorization;', // 4
          '  if (!header) {', // 5
          '    return null;', // 6
          '  }', // 7
          '', // 8
          '  const token = header.slice(7);', // 9
          '  const user = jwt.decode(token);', // 10
          '  return user;', // 11
          '}', // 12
          '', // 13
          'export function logout() {', // 14
          '  session.destroy();', // 15
          '}', // 16
        ].join('\n'),
      );

      writeFileSync(join(repoRoot, 'src/long.ts'), `const x = '${'a'.repeat(400)}';`);
      writeFileSync(
        join(repoRoot, 'src/deep.py'),
        [
          'def handler(event):', // 1
          '    for item in event:', // 2
          ...Array.from({ length: 12 }, (_, i) => `        step_${i}()`), // 3~14
          '        risky(item)', // 15
          '    return True', // 16
          '', // 17
          'def other():', // 18
          '    pass', // 19
        ].join('\n'),
      );
    });

    afterAll(() => {
      rmSync(repoRoot, { recursive: true, force: true });
    });

    it('지목한 라인 주변 코드를 마커와 함께 붙인다', () => {
      const report = generator.generate(
        consensusWith(issue('src/auth.ts', 10)),
        1,
        undefined,
        repoRoot,
      );

      expect(report.markdown).toContain('```ts');
      expect(report.markdown).toContain('> 10 |   const user = jwt.decode(token);');
      expect(report.markdown).toContain('  11 |   return user;');
      // 지목 라인만 마커를 받는다
      expect(report.markdown).not.toContain('> 11 |');
    });

    it('기본 창은 위아래 5줄이고 감싸는 선언이 함께 붙는다', () => {
      const report = generator.generate(
        consensusWith(issue('src/auth.ts', 10)),
        1,
        undefined,
        repoRoot,
      );

      // 3: 감싸는 함수 선언 / 5~12: 위로 5줄, 아래는 블록 끝(12)에서 멈춤
      expect(lineNos(report.markdown)).toEqual([3, 5, 6, 7, 8, 9, 10, 11, 12]);
    });

    it('아래로 감싸는 블록이 끝나면 멈춰서 다음 함수를 넘보지 않는다', () => {
      const report = generator.generate(
        consensusWith(issue('src/auth.ts', 11)),
        1,
        undefined,
        repoRoot,
      );

      const nos = lineNos(report.markdown);
      // 12번(닫는 중괄호)까지만. 14번 다음 함수 선언은 포함하지 않는다
      expect(nos.at(-1)).toBe(12);
      expect(report.markdown).not.toContain('logout');
    });

    it('감싸는 선언이 창 밖이면 함수까지 체인으로 붙이고 생략 표시를 넣는다', () => {
      const report = generator.generate(
        consensusWith(issue('src/deep.py', 15)),
        1,
        undefined,
        repoRoot,
      );

      // 1: def handler / 2: for 문 / 그 다음이 생략 표시
      expect(lineNos(report.markdown)).toEqual([1, 2, 10, 11, 12, 13, 14, 15, 16]);
      const body = snippetBody(report.markdown);
      expect(body[0]).toContain('def handler(event):');
      expect(body[1]).toContain('for item in event:');
      expect(body[2]).toContain('…');
      expect(report.markdown).toContain('> 15 |         risky(item)');
      expect(report.markdown).toContain('```python');
    });

    it('선언이 이미 창 안에 있으면 생략 표시를 넣지 않는다', () => {
      const report = generator.generate(
        consensusWith(issue('src/auth.ts', 6)),
        1,
        undefined,
        repoRoot,
      );

      const body = snippetBody(report.markdown);
      expect(body.some((l) => l.includes('export function currentUser'))).toBe(true);
      expect(body.some((l) => l.trim().endsWith('| …'))).toBe(false);
    });

    it('최상위 라인은 기본 창을 그대로 쓴다', () => {
      const report = generator.generate(
        consensusWith(issue('src/auth.ts', 3)),
        1,
        undefined,
        repoRoot,
      );

      expect(lineNos(report.markdown)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it('긴 라인은 잘라낸다', () => {
      const report = generator.generate(
        consensusWith(issue('src/long.ts', 1)),
        1,
        undefined,
        repoRoot,
      );

      expect(report.markdown).toContain('…');
      const snippetLine = report.markdown.split('\n').find((l) => l.startsWith('> 1 |'))!;
      expect(snippetLine.length).toBeLessThan(230);
    });

    it('line이 없으면 스니펫을 붙이지 않는다', () => {
      const report = generator.generate(
        consensusWith(issue('src/auth.ts')),
        1,
        undefined,
        repoRoot,
      );

      expect(report.markdown).toContain('`src/auth.ts`');
      expect(report.markdown).not.toContain('```ts');
    });

    it('없는 파일이나 범위를 벗어난 라인은 기존 출력을 유지한다', () => {
      const report = generator.generate(
        consensusWith(issue('src/gone.ts', 3), issue('src/auth.ts', 9999)),
        1,
        undefined,
        repoRoot,
      );

      expect(report.markdown).toContain('`src/gone.ts:3`');
      expect(report.markdown).toContain('`src/auth.ts:9999`');
      expect(report.markdown).not.toContain('```ts');
    });

    it('repoRoot가 없으면 스니펫 없이 렌더링한다', () => {
      const report = generator.generate(consensusWith(issue('src/auth.ts', 10)), 1);

      expect(report.markdown).toContain('`src/auth.ts:10`');
      expect(report.markdown).not.toContain('```ts');
    });
  });
});
