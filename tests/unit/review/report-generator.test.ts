import { describe, it, expect } from 'vitest';
import { ReviewReportGenerator } from '../../../src/review/report-generator.js';
import type { ReviewConsensusResult } from '../../../src/core/types.js';

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
});
