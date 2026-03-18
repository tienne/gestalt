import 'dotenv/config';
import { Command } from 'commander';
import { PassthroughBenchmarkRunner, type BenchmarkStepContext, type BenchmarkAdvanceResult } from './runners/passthrough-benchmark-runner.js';
import { MetricsCollector } from './runners/metrics-collector.js';
import { ReportGenerator } from './runners/report-generator.js';
import { authSystemScenario } from './scenarios/auth-system.scenario.js';
import { dashboardScenario } from './scenarios/dashboard.scenario.js';
import { apiGatewayScenario } from './scenarios/api-gateway.scenario.js';
import type { BenchmarkScenario } from './types.js';

const ALL_SCENARIOS: BenchmarkScenario[] = [
  authSystemScenario,
  dashboardScenario,
  apiGatewayScenario,
];

// ─── Response Generator ──────────────────────────────────────────
// Generates deterministic LLM-like responses based on scenario expected data.

function generateResponse(step: BenchmarkStepContext, scenario: BenchmarkScenario): string {
  switch (step.step) {
    case 'interview-question':
      return JSON.stringify({
        question: `${scenario.topic}에 대해 더 자세히 설명해주세요. 어떤 기술 스택과 요구사항이 있나요?`,
      });

    case 'interview-score':
      return JSON.stringify({
        goalClarity: 0.7,
        constraintClarity: 0.6,
        successCriteria: 0.5,
        priorityClarity: 0.6,
      });

    case 'spec-gen':
      return JSON.stringify(scenario.expectedSpec);

    case 'plan-step': {
      const stage = step.stage;
      if (stage.includes('figure_ground')) {
        return JSON.stringify({
          principle: 'figure_ground',
          classifiedACs: scenario.expectedSpec.acceptanceCriteria.map((ac, i) => ({
            acIndex: i,
            acText: ac,
            classification: i < 3 ? 'figure' : 'ground',
            priority: i < 2 ? 'critical' : i < 3 ? 'high' : 'medium',
            reasoning: scenario.planningSteps.figureGround.classifiedACs[i]?.reasoning ?? 'Classified by relevance',
          })),
        });
      }
      if (stage.includes('closure')) {
        return JSON.stringify({
          principle: 'closure',
          atomicTasks: scenario.planningSteps.closure.atomicTasks.map((t) => ({
            taskId: t.taskId,
            title: t.title,
            description: `${t.title} 구현`,
            sourceAC: t.acIndices,
            isImplicit: false,
            estimatedComplexity: 'medium',
            dependsOn: t.dependencies,
          })),
        });
      }
      if (stage.includes('proximity')) {
        return JSON.stringify({
          principle: 'proximity',
          taskGroups: scenario.planningSteps.proximity.taskGroups.map((g) => ({
            groupId: g.groupId,
            name: g.name,
            domain: g.name,
            taskIds: g.taskIds,
            reasoning: `${g.name} 관련 태스크 그룹`,
          })),
        });
      }
      if (stage.includes('continuity')) {
        return JSON.stringify({
          principle: 'continuity',
          dagValidation: scenario.planningSteps.continuity.dagValidation,
        });
      }
      return '{}';
    }

    case 'execute-task': {
      const taskId = step.stage.replace('execute-task-', '');
      const taskOutput = scenario.taskOutputs.find((t) => t.taskId === taskId);
      return JSON.stringify({
        output: taskOutput?.output ?? `Task ${taskId} completed`,
        artifacts: taskOutput?.artifacts ?? [],
      });
    }

    case 'evaluate-contextual':
      return JSON.stringify(scenario.evaluationResult);

    default:
      return '{}';
  }
}

// ─── CLI ─────────────────────────────────────────────────────────

const program = new Command();

program
  .name('gestalt-bench')
  .description('Run Gestalt pipeline benchmarks (passthrough mode)')
  .option('-s, --scenario <name>', 'Run a specific scenario (auth-system, dashboard, api-gateway)')
  .option('-o, --output <dir>', 'Output directory for results', 'benchmarks/results')
  .option('--json', 'Output JSON only (no markdown)')
  .action(async (opts) => {
    const scenarios = opts.scenario
      ? ALL_SCENARIOS.filter((s) => s.name === opts.scenario)
      : ALL_SCENARIOS;

    if (scenarios.length === 0) {
      console.error(`Unknown scenario: ${opts.scenario}`);
      console.error(`Available: ${ALL_SCENARIOS.map((s) => s.name).join(', ')}`);
      process.exit(1);
    }

    const collector = new MetricsCollector();
    console.log(`\nRunning ${scenarios.length} benchmark scenario(s)...\n`);

    for (const scenario of scenarios) {
      const runner = new PassthroughBenchmarkRunner(scenario);

      try {
        process.stdout.write(`  ${scenario.name}: `);

        let current: BenchmarkStepContext = runner.start();

        while (true) {
          const response = generateResponse(current, scenario);
          const result: BenchmarkAdvanceResult = runner.advance({ response });

          if (result.step === 'complete') {
            collector.add(result.metrics);
            console.log(
              `${result.metrics.evaluate.overallScore.toFixed(2)} score, ` +
              `${result.metrics.totalDurationMs}ms, ` +
              `${result.metrics.llmMetrics.totalCalls} calls`,
            );
            break;
          }

          current = result as BenchmarkStepContext;
        }
      } catch (err) {
        console.log(`FAILED — ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        runner.close();
      }
    }

    const result = collector.buildResult();
    const reporter = new ReportGenerator(opts.output);
    const { jsonPath, mdPath } = reporter.generate(result);

    console.log('\n--- Summary ---');
    console.log(`Scenarios: ${result.summary.totalScenarios}`);
    console.log(`Avg Score: ${result.summary.avgScore.toFixed(2)}`);
    console.log(`Avg Goal Alignment: ${result.summary.avgGoalAlignment.toFixed(2)}`);
    console.log(`All Passed: ${result.summary.allPassed}`);
    console.log(`Total Duration: ${result.summary.totalDurationMs}ms`);
    console.log(`Total LLM Calls: ${result.summary.totalCalls}`);

    console.log(`\nResults: ${jsonPath}`);
    if (!opts.json) {
      console.log(`Report: ${mdPath}`);
    }
  });

program.parse();
