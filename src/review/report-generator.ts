import type {
  ContinuityVerdict,
  ReviewConsensusResult,
  ReviewIssue,
  ReviewReport,
} from '../core/types.js';

export class ReviewReportGenerator {
  generate(
    consensus: ReviewConsensusResult,
    attempt: number,
    continuityVerdict?: ContinuityVerdict,
  ): ReviewReport {
    const passed = consensus.overallApproved;
    const markdown = this.renderMarkdown(consensus, attempt, passed, continuityVerdict);

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
    continuityVerdict?: ContinuityVerdict,
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

    // Continuity instance (정합 심급) — only rendered when a verdict is present
    // and it has something to say (incoherent or has drift findings).
    if (
      continuityVerdict &&
      (!continuityVerdict.coherent || continuityVerdict.driftFindings.length > 0)
    ) {
      const emoji = continuityVerdict.coherent ? '🧭' : '🧭❌';
      lines.push(`## ${emoji} Continuity Instance (정합 심급)`);
      lines.push('');
      lines.push(continuityVerdict.summary);
      lines.push('');
      if (continuityVerdict.driftFindings.length > 0) {
        for (const finding of continuityVerdict.driftFindings) {
          const where = finding.file ? ` \`${finding.file}\`` : '';
          lines.push(`- **[${finding.axis}]**${where}: ${finding.message}`);
        }
        lines.push('');
      }
      if (continuityVerdict.escalate) {
        lines.push(
          '> ⚠️ 목표에서 벗어나는 변경이라 라인 수정으로는 부족합니다. 스펙 재정리 또는 결정 재확인이 필요합니다.',
        );
        lines.push('');
      }
    }

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
