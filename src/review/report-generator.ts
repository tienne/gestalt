import type { ReviewConsensusResult, ReviewIssue, ReviewReport } from '../core/types.js';

export class ReviewReportGenerator {
  generate(consensus: ReviewConsensusResult, attempt: number): ReviewReport {
    const passed = consensus.overallApproved;
    const markdown = this.renderMarkdown(consensus, attempt, passed);

    return {
      markdown,
      generatedAt: new Date().toISOString(),
      attempt,
      passed,
    };
  }

  private renderMarkdown(
    consensus: ReviewConsensusResult,
    attempt: number,
    passed: boolean,
  ): string {
    const lines: string[] = [];
    const statusEmoji = passed ? '✅' : '❌';

    lines.push(`# Code Review Report ${statusEmoji}`);
    lines.push('');
    lines.push(`**Attempt**: ${attempt}`);
    lines.push(`**Status**: ${passed ? 'PASSED' : 'BLOCKED'}`);
    lines.push('');

    // Summary
    lines.push('## Summary');
    lines.push('');
    lines.push(consensus.summary);
    lines.push('');

    // Agent decisions
    if (consensus.approvedBy.length > 0) {
      lines.push(`**Approved by**: ${consensus.approvedBy.join(', ')}`);
    }
    if (consensus.blockedBy.length > 0) {
      lines.push(`**Blocked by**: ${consensus.blockedBy.join(', ')}`);
    }
    lines.push('');

    // Issues by severity
    const criticals = consensus.mergedIssues.filter((i) => i.severity === 'critical');
    const highs = consensus.mergedIssues.filter((i) => i.severity === 'high');
    const warnings = consensus.mergedIssues.filter((i) => i.severity === 'warning');

    if (criticals.length > 0) {
      lines.push('## 🔴 Critical Issues');
      lines.push('');
      this.renderIssueList(lines, criticals);
    }

    if (highs.length > 0) {
      lines.push('## 🟠 High Issues');
      lines.push('');
      this.renderIssueList(lines, highs);
    }

    if (warnings.length > 0) {
      lines.push('## 🟡 Warnings');
      lines.push('');
      this.renderIssueList(lines, warnings);
    }

    if (consensus.mergedIssues.length === 0) {
      lines.push('## Issues');
      lines.push('');
      lines.push('No issues found.');
      lines.push('');
    }

    // Stats
    lines.push('---');
    lines.push('');
    lines.push(`| Severity | Count |`);
    lines.push(`|----------|-------|`);
    lines.push(`| Critical | ${criticals.length} |`);
    lines.push(`| High | ${highs.length} |`);
    lines.push(`| Warning | ${warnings.length} |`);
    lines.push(`| **Total** | **${consensus.mergedIssues.length}** |`);

    return lines.join('\n');
  }

  private renderIssueList(lines: string[], issues: ReviewIssue[]): void {
    for (const issue of issues) {
      const location = issue.line ? `${issue.file}:${issue.line}` : issue.file;
      lines.push(`### ${issue.message}`);
      lines.push('');
      lines.push(`- **Location**: \`${location}\``);
      lines.push(`- **Category**: ${issue.category}`);
      lines.push(`- **Reported by**: ${issue.reportedBy}`);
      lines.push(`- **Suggestion**: ${issue.suggestion}`);
      lines.push('');
    }
  }
}
