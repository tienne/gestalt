import type { PipelineMetrics, BenchmarkResult } from '../types.js';

export class MetricsCollector {
  private results: PipelineMetrics[] = [];

  add(metrics: PipelineMetrics): void {
    this.results.push(metrics);
  }

  getAll(): PipelineMetrics[] {
    return [...this.results];
  }

  buildResult(): BenchmarkResult {
    const scores = this.results.map((r) => r.evaluate.overallScore);
    const goalAlignments = this.results.map((r) => r.evaluate.goalAlignment);
    const totalDuration = this.results.reduce((sum, r) => sum + r.totalDurationMs, 0);
    const totalCalls = this.results.reduce((sum, r) => sum + r.llmMetrics.totalCalls, 0);

    return {
      timestamp: new Date().toISOString(),
      nodeVersion: process.version,
      scenarios: this.results,
      summary: {
        totalScenarios: this.results.length,
        allPassed: this.results.every((r) => r.evaluate.overallScore >= 0.85),
        avgScore: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
        avgGoalAlignment: goalAlignments.length > 0 ? goalAlignments.reduce((a, b) => a + b, 0) / goalAlignments.length : 0,
        totalDurationMs: totalDuration,
        totalCalls,
      },
    };
  }
}
