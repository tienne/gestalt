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

    beforeAll(() => {
      repoRoot = mkdtempSync(join(tmpdir(), 'gestalt-snippet-'));
      mkdirSync(join(repoRoot, 'src'), { recursive: true });
      writeFileSync(
        join(repoRoot, 'src/auth.ts'),
        [
          'import jwt from "jsonwebtoken";',
          '',
          'export function currentUser(req: Request) {',
          '  const token = req.headers.authorization;',
          '  const user = jwt.decode(token);',
          '  return user;',
          '}',
        ].join('\n'),
      );
      writeFileSync(join(repoRoot, 'src/long.ts'), `const x = "${'a'.repeat(400)}";`);
    });

    afterAll(() => {
      rmSync(repoRoot, { recursive: true, force: true });
    });

    it('지목한 라인 주변 코드를 마커와 함께 붙인다', () => {
      const report = generator.generate(
        consensusWith(issue('src/auth.ts', 5)),
        1,
        undefined,
        repoRoot,
      );

      expect(report.markdown).toContain('```ts');
      expect(report.markdown).toContain('> 5 |   const user = jwt.decode(token);');
      // 앞뒤 컨텍스트도 함께
      expect(report.markdown).toContain('  4 |   const token = req.headers.authorization;');
      expect(report.markdown).toContain('  6 |   return user;');
      // 지목 라인만 마커를 받는다
      expect(report.markdown).not.toContain('> 4 |');
    });

    it('파일 경계를 넘지 않는다', () => {
      const report = generator.generate(
        consensusWith(issue('src/auth.ts', 2)),
        1,
        undefined,
        repoRoot,
      );

      expect(report.markdown).toContain('> 2 |');
      expect(report.markdown).toContain('1 | import jwt from "jsonwebtoken";');

      const snippetLineNos = report.markdown
        .split('\n')
        .filter((l) => /^[> ] *\d+ \| /.test(l))
        .map((l) => Number(/(\d+)/.exec(l)![1]));
      expect(snippetLineNos[0]).toBe(1);
      expect(snippetLineNos).toEqual([1, 2, 3, 4, 5]);
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
      const report = generator.generate(consensusWith(issue('src/auth.ts', 5)), 1);

      expect(report.markdown).toContain('`src/auth.ts:5`');
      expect(report.markdown).not.toContain('```ts');
    });
  });
});
