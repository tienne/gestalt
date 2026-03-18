import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchmarkResult } from '../types.js';

export class ReportGenerator {
  private outputDir: string;

  constructor(outputDir: string) {
    this.outputDir = outputDir;
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }
  }

  generate(result: BenchmarkResult, prefix = 'bench'): { jsonPath: string; mdPath: string } {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const jsonPath = join(this.outputDir, `${prefix}-${timestamp}.json`);
    const mdPath = join(this.outputDir, `${prefix}-${timestamp}.md`);

    writeFileSync(jsonPath, JSON.stringify(result, null, 2));
    writeFileSync(mdPath, this.renderMarkdown(result));

    // Also write latest
    writeFileSync(join(this.outputDir, 'latest.json'), JSON.stringify(result, null, 2));
    writeFileSync(join(this.outputDir, 'latest.md'), this.renderMarkdown(result));

    return { jsonPath, mdPath };
  }

  private renderMarkdown(result: BenchmarkResult): string {
    const lines: string[] = [];

    lines.push('# Gestalt Benchmark Results');
    lines.push('');
    lines.push(`**Date**: ${result.timestamp}`);
    lines.push(`**Node**: ${result.nodeVersion}`);
    lines.push(`**Mode**: passthrough`);
    lines.push('');

    // Summary
    lines.push('## Summary');
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| Scenarios | ${result.summary.totalScenarios} |`);
    lines.push(`| All Passed | ${result.summary.allPassed ? 'Yes' : 'No'} |`);
    lines.push(`| Avg Score | ${result.summary.avgScore.toFixed(2)} |`);
    lines.push(`| Avg Goal Alignment | ${result.summary.avgGoalAlignment.toFixed(2)} |`);
    lines.push(`| Total Duration | ${result.summary.totalDurationMs}ms |`);
    lines.push(`| Total LLM Calls | ${result.summary.totalCalls} |`);
    lines.push('');

    // Per-scenario table
    lines.push('## Scenario Results');
    lines.push('');
    lines.push('| Scenario | Tasks | Completion | Score | Goal Align | ACs | Calls | Duration |');
    lines.push('|----------|-------|------------|-------|------------|-----|-------|----------|');

    for (const s of result.scenarios) {
      lines.push(
        `| ${s.scenario} | ${s.execute.taskCount} | ${(s.execute.completionRate * 100).toFixed(0)}% | ${s.evaluate.overallScore.toFixed(2)} | ${s.evaluate.goalAlignment.toFixed(2)} | ${s.evaluate.satisfiedACs} | ${s.llmMetrics.totalCalls} | ${s.totalDurationMs}ms |`,
      );
    }
    lines.push('');

    // Stage breakdown
    lines.push('## Stage Breakdown');
    lines.push('');

    for (const scenario of result.scenarios) {
      lines.push(`### ${scenario.scenario}`);
      lines.push('');
      lines.push('| Stage | Duration | Status |');
      lines.push('|-------|----------|--------|');
      for (const stage of scenario.stages) {
        lines.push(`| ${stage.name} | ${stage.durationMs}ms | ${stage.success ? 'Pass' : 'Fail'} |`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}
