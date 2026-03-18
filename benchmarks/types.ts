export interface BenchmarkScenario {
  name: string;
  description: string;
  topic: string;
  userResponses: string[];
  expectedSpec: {
    goal: string;
    constraints: string[];
    acceptanceCriteria: string[];
    ontologySchema: {
      entities: Array<{ name: string; description: string; attributes: string[] }>;
      relations: Array<{ from: string; to: string; type: string }>;
    };
    gestaltAnalysis: Array<{ principle: string; finding: string; confidence: number }>;
  };
  planningSteps: {
    figureGround: { classifiedACs: Array<{ acIndex: number; classification: 'essential' | 'supplementary'; reasoning: string }> };
    closure: { atomicTasks: Array<{ taskId: string; title: string; acIndices: number[]; dependencies: string[] }> };
    proximity: { taskGroups: Array<{ groupId: string; name: string; taskIds: string[] }> };
    continuity: { dagValidation: { isValid: boolean; hasCycles: boolean; hasConflicts: boolean; topologicalOrder: string[]; criticalPath: string[] } };
  };
  taskOutputs: Array<{ taskId: string; output: string; artifacts: string[] }>;
  structuralResult: { commands: Array<{ name: string; command: string; exitCode: number; output: string }>; allPassed: boolean };
  evaluationResult: {
    verifications: Array<{ acIndex: number; satisfied: boolean; evidence: string; gaps: string[] }>;
    overallScore: number;
    goalAlignment: number;
    recommendations: string[];
  };
}

export interface StageMetrics {
  name: string;
  durationMs: number;
  success: boolean;
}

export interface LLMCallMetric {
  stage: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  jsonParseSuccess: boolean;
  retried: boolean;
}

export interface LLMMetrics {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  estimatedCostUSD: number;
  avgLatencyMs: number;
  jsonParseFailures: number;
  calls: LLMCallMetric[];
}

export interface PipelineMetrics {
  mode: 'passthrough';
  model: string;
  scenario: string;
  totalDurationMs: number;
  stages: StageMetrics[];
  interview: {
    rounds: number;
    finalAmbiguity: number;
  };
  spec: {
    generated: boolean;
  };
  execute: {
    taskCount: number;
    completionRate: number;
    driftAlerts: number;
  };
  evaluate: {
    overallScore: number;
    goalAlignment: number;
    satisfiedACs: string;
  };
  llmMetrics: LLMMetrics;
}

export interface BenchmarkResult {
  timestamp: string;
  nodeVersion: string;
  scenarios: PipelineMetrics[];
  summary: {
    totalScenarios: number;
    allPassed: boolean;
    avgScore: number;
    avgGoalAlignment: number;
    totalDurationMs: number;
    totalCalls: number;
  };
}
