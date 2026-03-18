import {
  PassthroughBenchmarkRunner,
  getBenchmarkRunner,
  registerBenchmarkRunner,
  removeBenchmarkRunner,
} from '../../../benchmarks/runners/passthrough-benchmark-runner.js';
import { authSystemScenario } from '../../../benchmarks/scenarios/auth-system.scenario.js';
import { dashboardScenario } from '../../../benchmarks/scenarios/dashboard.scenario.js';
import { apiGatewayScenario } from '../../../benchmarks/scenarios/api-gateway.scenario.js';
import type { BenchmarkScenario } from '../../../benchmarks/types.js';
import type { BenchmarkInput } from '../schemas.js';

const SCENARIOS: Record<string, BenchmarkScenario> = {
  'auth-system': authSystemScenario,
  'dashboard': dashboardScenario,
  'api-gateway': apiGatewayScenario,
};

export function handleBenchmarkPassthrough(input: BenchmarkInput): string {
  try {
    switch (input.action) {
      case 'start':
        return handleStart(input);
      case 'respond':
        return handleRespond(input);
      case 'status':
        return handleStatus(input);
      default:
        return JSON.stringify({ error: `Unknown action: ${input.action}` });
    }
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

function handleStart(input: BenchmarkInput): string {
  const scenarioName = input.scenario;
  if (!scenarioName) {
    return JSON.stringify({
      error: 'scenario is required for start action',
      availableScenarios: Object.keys(SCENARIOS),
    });
  }

  const scenario = SCENARIOS[scenarioName];
  if (!scenario) {
    return JSON.stringify({
      error: `Unknown scenario: ${scenarioName}`,
      availableScenarios: Object.keys(SCENARIOS),
    });
  }

  const runner = new PassthroughBenchmarkRunner(scenario);
  registerBenchmarkRunner(runner);

  const firstStep = runner.start();

  return JSON.stringify({
    status: 'started',
    ...firstStep,
  }, null, 2);
}

function handleRespond(input: BenchmarkInput): string {
  const sessionId = input.benchmarkSessionId;
  if (!sessionId) {
    return JSON.stringify({ error: 'benchmarkSessionId is required for respond action' });
  }

  const response = input.response;
  if (!response) {
    return JSON.stringify({ error: 'response is required for respond action' });
  }

  const runner = getBenchmarkRunner(sessionId);
  if (!runner) {
    return JSON.stringify({ error: `No active benchmark session: ${sessionId}` });
  }

  const result = runner.advance({
    response,
    usage: input.usage,
  });

  if (result.step === 'complete') {
    removeBenchmarkRunner(sessionId);
    return JSON.stringify({
      status: 'complete',
      ...result,
    }, null, 2);
  }

  return JSON.stringify({
    status: 'in_progress',
    ...result,
  }, null, 2);
}

function handleStatus(input: BenchmarkInput): string {
  if (input.benchmarkSessionId) {
    const runner = getBenchmarkRunner(input.benchmarkSessionId);
    if (!runner) {
      return JSON.stringify({ error: `No active benchmark session: ${input.benchmarkSessionId}` });
    }
    return JSON.stringify({
      benchmarkSessionId: runner.benchmarkSessionId,
      scenario: runner.scenario.name,
      status: 'in_progress',
    });
  }

  return JSON.stringify({
    availableScenarios: Object.keys(SCENARIOS),
  });
}
