import { randomUUID } from 'node:crypto';
import { EventStore } from '../../src/events/store.js';
import { PassthroughEngine } from '../../src/interview/passthrough-engine.js';
import { PassthroughSpecGenerator } from '../../src/spec/passthrough-generator.js';
import { PassthroughExecuteEngine } from '../../src/execute/passthrough-engine.js';
import type { ExternalAmbiguityScore } from '../../src/interview/passthrough-engine.js';
import type { BenchmarkScenario, StageMetrics, LLMCallMetric, LLMMetrics, PipelineMetrics } from '../types.js';

// ─── Step Types ─────────────────────────────────────────────────

export type BenchmarkStepType =
  | 'interview-question'
  | 'interview-score'
  | 'spec-gen'
  | 'plan-step'
  | 'execute-task'
  | 'evaluate-contextual'
  | 'complete';

export interface BenchmarkStepContext {
  benchmarkSessionId: string;
  step: BenchmarkStepType;
  stage: string;          // human-readable: 'interview-question-1', 'plan-figure_ground', ...
  systemPrompt: string;
  prompt: string;
  scenario: string;
  progress: string;       // e.g., '3/22'
  totalSteps: number;
  currentStepIndex: number;
}

export interface BenchmarkStepResult {
  benchmarkSessionId: string;
  step: BenchmarkStepType;
  stage: string;
  systemPrompt: string;
  prompt: string;
  scenario: string;
  progress: string;
  totalSteps: number;
  currentStepIndex: number;
}

export interface BenchmarkCompleteResult {
  benchmarkSessionId: string;
  step: 'complete';
  metrics: PipelineMetrics;
}

export type BenchmarkAdvanceResult = BenchmarkStepResult | BenchmarkCompleteResult;

export interface BenchmarkRespondInput {
  response: string;
  usage?: { inputTokens: number; outputTokens: number };
}

// ─── Runner ─────────────────────────────────────────────────────

type Phase = 'interview' | 'spec' | 'planning' | 'execution' | 'evaluate' | 'complete';

export class PassthroughBenchmarkRunner {
  readonly benchmarkSessionId: string;
  readonly scenario: BenchmarkScenario;

  private dbPath: string;
  private store: EventStore;
  private interviewEngine: PassthroughEngine;
  private specGen: PassthroughSpecGenerator;
  private executeEngine: PassthroughExecuteEngine;

  // ─── State ──────────────────────────────────
  private phase: Phase = 'interview';
  private interviewSessionId = '';
  private interviewRoundIndex = 0;
  private waitingForScore = false;
  private lastQuestion = '';
  private specJSON: Record<string, unknown> | null = null;
  private specId = '';
  private executeSessionId = '';
  private planPrincipleIndex = 0;
  private currentTaskId = '';
  private stageTimers: Map<string, number> = new Map();
  private stages: StageMetrics[] = [];
  private callLog: LLMCallMetric[] = [];
  private currentStepIndex = 0;
  private totalEstimatedSteps = 0;

  // Cached contexts
  private interviewGestaltContext: { systemPrompt: string; questionPrompt: string; scoringPrompt?: string } | null = null;
  private executeContext: { systemPrompt: string; planningPrompt: string } | null = null;
  private taskContext: { systemPrompt: string; taskPrompt: string; currentTask: { taskId: string } } | null = null;
  private contextualContext: { systemPrompt: string; evaluatePrompt: string } | null = null;

  constructor(scenario: BenchmarkScenario) {
    this.benchmarkSessionId = randomUUID();
    this.scenario = scenario;
    this.dbPath = `.gestalt-bench/bench-pt-${this.benchmarkSessionId}.db`;
    this.store = new EventStore(this.dbPath);
    this.interviewEngine = new PassthroughEngine(this.store);
    this.specGen = new PassthroughSpecGenerator(this.store);
    this.executeEngine = new PassthroughExecuteEngine(this.store);

    // Estimate: questions*2 + spec + 4 planning + tasks + evaluate
    const taskEstimate = scenario.planningSteps.closure.atomicTasks.length;
    this.totalEstimatedSteps = scenario.userResponses.length * 2 + 1 + 4 + taskEstimate + 1;
  }

  /** Initialize and return the first step context */
  start(): BenchmarkStepContext {
    this.startTimer('interview');

    const startResult = this.interviewEngine.start(this.scenario.topic);
    if (!startResult.ok) throw new Error(`Interview start failed: ${startResult.error.message}`);

    this.interviewSessionId = startResult.value.session.sessionId;
    const ctx = startResult.value.gestaltContext;
    this.interviewGestaltContext = ctx;

    this.currentStepIndex = 1;

    return {
      benchmarkSessionId: this.benchmarkSessionId,
      step: 'interview-question',
      stage: 'interview-question-1',
      systemPrompt: ctx.systemPrompt,
      prompt: ctx.questionPrompt,
      scenario: this.scenario.name,
      progress: `${this.currentStepIndex}/${this.totalEstimatedSteps}`,
      totalSteps: this.totalEstimatedSteps,
      currentStepIndex: this.currentStepIndex,
    };
  }

  /** Advance state machine with the LLM response */
  advance(input: BenchmarkRespondInput): BenchmarkAdvanceResult {
    const parsed = this.tryParseJSON(input.response);

    this.logCall(input.usage);

    if (this.phase === 'interview') {
      return this.advanceInterview(parsed, input);
    }
    if (this.phase === 'spec') {
      return this.advanceSpec(parsed);
    }
    if (this.phase === 'planning') {
      return this.advancePlanning(parsed);
    }
    if (this.phase === 'execution') {
      return this.advanceExecution(parsed);
    }
    if (this.phase === 'evaluate') {
      return this.advanceEvaluate(parsed);
    }

    throw new Error(`Unexpected phase: ${this.phase}`);
  }

  close(): void {
    this.store.close();
  }

  // ─── Interview ──────────────────────────────────────────────────

  private advanceInterview(parsed: Record<string, unknown>, input: BenchmarkRespondInput): BenchmarkAdvanceResult {
    if (this.waitingForScore) {
      return this.handleInterviewScore(parsed as unknown as ExternalAmbiguityScore);
    }
    return this.handleInterviewQuestion(parsed, input);
  }

  private handleInterviewQuestion(parsed: Record<string, unknown>, _input: BenchmarkRespondInput): BenchmarkAdvanceResult {
    this.lastQuestion = (parsed.question as string) ?? 'Follow-up question';

    // Now need score
    if (this.interviewGestaltContext?.scoringPrompt) {
      this.waitingForScore = true;
      this.currentStepIndex++;

      return {
        benchmarkSessionId: this.benchmarkSessionId,
        step: 'interview-score',
        stage: `interview-score-${this.interviewRoundIndex + 1}`,
        systemPrompt: this.interviewGestaltContext.systemPrompt,
        prompt: this.interviewGestaltContext.scoringPrompt,
        scenario: this.scenario.name,
        progress: `${this.currentStepIndex}/${this.totalEstimatedSteps}`,
        totalSteps: this.totalEstimatedSteps,
        currentStepIndex: this.currentStepIndex,
      };
    }

    // No scoring prompt — submit without score and move on
    return this.submitInterviewRound(undefined);
  }

  private handleInterviewScore(score: ExternalAmbiguityScore): BenchmarkAdvanceResult {
    this.waitingForScore = false;
    return this.submitInterviewRound(score);
  }

  private submitInterviewRound(score: ExternalAmbiguityScore | undefined): BenchmarkAdvanceResult {
    const userResponse = this.scenario.userResponses[this.interviewRoundIndex];
    if (!userResponse) throw new Error(`No user response for round ${this.interviewRoundIndex}`);

    const respondResult = this.interviewEngine.respond(
      this.interviewSessionId,
      userResponse,
      this.lastQuestion,
      score,
    );
    if (!respondResult.ok) throw new Error(`Interview respond failed: ${respondResult.error.message}`);

    this.interviewRoundIndex++;
    const ctx = respondResult.value.gestaltContext;
    this.interviewGestaltContext = ctx;

    // More rounds?
    if (this.interviewRoundIndex < this.scenario.userResponses.length) {
      this.currentStepIndex++;
      return {
        benchmarkSessionId: this.benchmarkSessionId,
        step: 'interview-question',
        stage: `interview-question-${this.interviewRoundIndex + 1}`,
        systemPrompt: ctx.systemPrompt,
        prompt: ctx.questionPrompt,
        scenario: this.scenario.name,
        progress: `${this.currentStepIndex}/${this.totalEstimatedSteps}`,
        totalSteps: this.totalEstimatedSteps,
        currentStepIndex: this.currentStepIndex,
      };
    }

    // Interview complete → Spec
    this.interviewEngine.complete(this.interviewSessionId);
    this.endTimer('interview', true);

    return this.startSpecPhase();
  }

  // ─── Spec ───────────────────────────────────────────────────────

  private startSpecPhase(): BenchmarkAdvanceResult {
    this.phase = 'spec';
    this.startTimer('spec');

    const session = this.interviewEngine.getSession(this.interviewSessionId);
    const specContext = this.specGen.buildSpecContext(session);

    this.currentStepIndex++;
    return {
      benchmarkSessionId: this.benchmarkSessionId,
      step: 'spec-gen',
      stage: 'spec-gen',
      systemPrompt: specContext.systemPrompt,
      prompt: specContext.specPrompt,
      scenario: this.scenario.name,
      progress: `${this.currentStepIndex}/${this.totalEstimatedSteps}`,
      totalSteps: this.totalEstimatedSteps,
      currentStepIndex: this.currentStepIndex,
    };
  }

  private advanceSpec(parsed: Record<string, unknown>): BenchmarkAdvanceResult {
    const session = this.interviewEngine.getSession(this.interviewSessionId);
    const result = this.specGen.validateAndStore(session, parsed as never, true);
    if (!result.ok) throw new Error(`Spec generation failed: ${result.error.message}`);

    this.specJSON = parsed;
    this.specId = result.value.metadata.specId;
    this.endTimer('spec', true);

    return this.startPlanningPhase();
  }

  // ─── Planning ───────────────────────────────────────────────────

  private static readonly PRINCIPLES = ['figure_ground', 'closure', 'proximity', 'continuity'];

  private startPlanningPhase(): BenchmarkAdvanceResult {
    this.phase = 'planning';
    this.startTimer('planning');

    const spec = {
      ...this.specJSON!,
      version: '1.0',
      metadata: {
        specId: this.specId,
        interviewSessionId: this.interviewSessionId,
        ambiguityScore: 0.15,
        generatedAt: new Date().toISOString(),
      },
    };

    const startResult = this.executeEngine.start(spec as never);
    if (!startResult.ok) throw new Error(`Execute start failed: ${startResult.error.message}`);

    this.executeSessionId = startResult.value.session.sessionId;
    this.executeContext = startResult.value.executeContext;
    this.planPrincipleIndex = 0;

    this.currentStepIndex++;
    const principle = PassthroughBenchmarkRunner.PRINCIPLES[0]!;
    return {
      benchmarkSessionId: this.benchmarkSessionId,
      step: 'plan-step',
      stage: `plan-${principle}`,
      systemPrompt: this.executeContext!.systemPrompt,
      prompt: this.executeContext!.planningPrompt,
      scenario: this.scenario.name,
      progress: `${this.currentStepIndex}/${this.totalEstimatedSteps}`,
      totalSteps: this.totalEstimatedSteps,
      currentStepIndex: this.currentStepIndex,
    };
  }

  private advancePlanning(parsed: Record<string, unknown>): BenchmarkAdvanceResult {
    const stepResult = this.executeEngine.planStep(this.executeSessionId, parsed as never);
    if (!stepResult.ok) throw new Error(`Plan step failed: ${stepResult.error.message}`);

    this.planPrincipleIndex++;

    if (this.planPrincipleIndex < PassthroughBenchmarkRunner.PRINCIPLES.length) {
      this.executeContext = stepResult.value.executeContext!;
      const principle = PassthroughBenchmarkRunner.PRINCIPLES[this.planPrincipleIndex]!;
      this.currentStepIndex++;
      return {
        benchmarkSessionId: this.benchmarkSessionId,
        step: 'plan-step',
        stage: `plan-${principle}`,
        systemPrompt: this.executeContext!.systemPrompt,
        prompt: this.executeContext!.planningPrompt,
        scenario: this.scenario.name,
        progress: `${this.currentStepIndex}/${this.totalEstimatedSteps}`,
        totalSteps: this.totalEstimatedSteps,
        currentStepIndex: this.currentStepIndex,
      };
    }

    // Plan complete
    const planResult = this.executeEngine.planComplete(this.executeSessionId);
    if (!planResult.ok) throw new Error(`Plan complete failed: ${planResult.error.message}`);

    // Update total estimate with actual task count
    const actualTasks = planResult.value.executionPlan.atomicTasks.length;
    const estimatedTasks = this.scenario.planningSteps.closure.atomicTasks.length;
    this.totalEstimatedSteps += (actualTasks - estimatedTasks);

    this.endTimer('planning', true);
    return this.startExecutionPhase();
  }

  // ─── Execution ──────────────────────────────────────────────────

  private startExecutionPhase(): BenchmarkAdvanceResult {
    this.phase = 'execution';
    this.startTimer('execution');

    const execStart = this.executeEngine.startExecution(this.executeSessionId);
    if (!execStart.ok) throw new Error(`Execution start failed: ${execStart.error.message}`);

    if (execStart.value.allTasksCompleted || !execStart.value.taskContext) {
      this.endTimer('execution', true);
      return this.startEvaluatePhase();
    }

    this.taskContext = execStart.value.taskContext;
    this.currentTaskId = this.taskContext.currentTask.taskId;

    this.currentStepIndex++;
    return {
      benchmarkSessionId: this.benchmarkSessionId,
      step: 'execute-task',
      stage: `execute-task-${this.currentTaskId}`,
      systemPrompt: this.taskContext.systemPrompt,
      prompt: this.taskContext.taskPrompt,
      scenario: this.scenario.name,
      progress: `${this.currentStepIndex}/${this.totalEstimatedSteps}`,
      totalSteps: this.totalEstimatedSteps,
      currentStepIndex: this.currentStepIndex,
    };
  }

  private advanceExecution(parsed: Record<string, unknown>): BenchmarkAdvanceResult {
    const submitResult = this.executeEngine.submitTaskResult(this.executeSessionId, {
      taskId: this.currentTaskId,
      status: 'completed',
      output: (parsed.output as string) ?? `Task ${this.currentTaskId} completed`,
      artifacts: (parsed.artifacts as string[]) ?? [],
    });
    if (!submitResult.ok) throw new Error(`Task submit failed: ${submitResult.error.message}`);

    if (submitResult.value.allTasksCompleted || !submitResult.value.taskContext) {
      this.endTimer('execution', true);
      return this.startEvaluatePhase();
    }

    this.taskContext = submitResult.value.taskContext;
    this.currentTaskId = this.taskContext.currentTask.taskId;

    this.currentStepIndex++;
    return {
      benchmarkSessionId: this.benchmarkSessionId,
      step: 'execute-task',
      stage: `execute-task-${this.currentTaskId}`,
      systemPrompt: this.taskContext.systemPrompt,
      prompt: this.taskContext.taskPrompt,
      scenario: this.scenario.name,
      progress: `${this.currentStepIndex}/${this.totalEstimatedSteps}`,
      totalSteps: this.totalEstimatedSteps,
      currentStepIndex: this.currentStepIndex,
    };
  }

  // ─── Evaluate ───────────────────────────────────────────────────

  private startEvaluatePhase(): BenchmarkAdvanceResult {
    this.phase = 'evaluate';
    this.startTimer('evaluate');

    const evalStart = this.executeEngine.startEvaluation(this.executeSessionId);
    if (!evalStart.ok) throw new Error(`Evaluation start failed: ${evalStart.error.message}`);

    // Simulate structural pass
    const structuralResult = {
      commands: [
        { name: 'lint', command: 'eslint src/', exitCode: 0, output: 'No errors found' },
        { name: 'build', command: 'tsc --noEmit', exitCode: 0, output: '' },
        { name: 'test', command: 'vitest run', exitCode: 0, output: 'Tests: all passed' },
      ],
      allPassed: true,
    };

    const structResult = this.executeEngine.submitStructuralResult(this.executeSessionId, structuralResult);
    if (!structResult.ok) throw new Error(`Structural submit failed: ${structResult.error.message}`);

    if (structResult.value.shortCircuited) {
      this.endTimer('evaluate', false);
      this.phase = 'complete';
      return this.buildCompleteResult();
    }

    this.contextualContext = structResult.value.contextualContext!;

    this.currentStepIndex++;
    return {
      benchmarkSessionId: this.benchmarkSessionId,
      step: 'evaluate-contextual',
      stage: 'evaluate-contextual',
      systemPrompt: this.contextualContext.systemPrompt,
      prompt: this.contextualContext.evaluatePrompt,
      scenario: this.scenario.name,
      progress: `${this.currentStepIndex}/${this.totalEstimatedSteps}`,
      totalSteps: this.totalEstimatedSteps,
      currentStepIndex: this.currentStepIndex,
    };
  }

  private advanceEvaluate(parsed: Record<string, unknown>): BenchmarkAdvanceResult {
    const evalSubmit = this.executeEngine.submitEvaluation(this.executeSessionId, parsed as never);
    if (!evalSubmit.ok) throw new Error(`Evaluation submit failed: ${evalSubmit.error.message}`);

    this.endTimer('evaluate', true);
    this.phase = 'complete';
    return this.buildCompleteResult();
  }

  // ─── Result ─────────────────────────────────────────────────────

  private buildCompleteResult(): BenchmarkCompleteResult {
    const session = this.executeEngine.getSession(this.executeSessionId);
    const totalTasks = session.executionPlan?.atomicTasks.length ?? 0;
    const completedTasks = session.taskResults.filter((t) => t.status === 'completed').length;
    const totalACs = (this.specJSON?.acceptanceCriteria as string[])?.length ?? 0;
    const evalResult = session.evaluationResult;
    const satisfiedACs = evalResult?.verifications.filter((v) => v.satisfied).length ?? 0;

    const totalDurationMs = this.stages.reduce((sum, s) => sum + s.durationMs, 0);

    return {
      benchmarkSessionId: this.benchmarkSessionId,
      step: 'complete',
      metrics: {
        mode: 'passthrough',
        model: 'passthrough',
        scenario: this.scenario.name,
        totalDurationMs,
        stages: this.stages,
        interview: {
          rounds: this.scenario.userResponses.length,
          finalAmbiguity: 0.15,
        },
        spec: {
          generated: !!this.specJSON,
        },
        execute: {
          taskCount: totalTasks,
          completionRate: totalTasks > 0 ? completedTasks / totalTasks : 0,
          driftAlerts: session.driftHistory.filter((d) => d.thresholdExceeded).length,
        },
        evaluate: {
          overallScore: evalResult?.overallScore ?? 0,
          goalAlignment: evalResult?.goalAlignment ?? 0,
          satisfiedACs: `${satisfiedACs}/${totalACs}`,
        },
        llmMetrics: this.buildLLMMetrics(),
      },
    };
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private startTimer(stage: string): void {
    this.stageTimers.set(stage, Date.now());
  }

  private endTimer(stage: string, success: boolean): void {
    const start = this.stageTimers.get(stage) ?? Date.now();
    this.stages.push({ name: stage, durationMs: Date.now() - start, success });
  }

  private logCall(usage?: { inputTokens: number; outputTokens: number }): void {
    this.callLog.push({
      stage: `step-${this.currentStepIndex}`,
      latencyMs: 0,   // not measurable in passthrough (caller owns the timing)
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      jsonParseSuccess: true,
      retried: false,
    });
  }

  private buildLLMMetrics(): LLMMetrics {
    const totalInput = this.callLog.reduce((s, c) => s + c.inputTokens, 0);
    const totalOutput = this.callLog.reduce((s, c) => s + c.outputTokens, 0);
    return {
      totalCalls: this.callLog.length,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalTokens: totalInput + totalOutput,
      estimatedCostUSD: 0, // passthrough — cost is on the caller
      avgLatencyMs: 0,
      jsonParseFailures: 0,
      calls: this.callLog,
    };
  }

  private tryParseJSON(raw: string): Record<string, unknown> {
    let cleaned = raw.trim();
    if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
    else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
    if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
    cleaned = cleaned.trim();

    try {
      return JSON.parse(cleaned) as Record<string, unknown>;
    } catch {
      throw new Error(`Failed to parse JSON response: ${cleaned.slice(0, 200)}`);
    }
  }
}

// ─── Session Store ──────────────────────────────────────────────

const activeSessions = new Map<string, PassthroughBenchmarkRunner>();

export function getBenchmarkRunner(sessionId: string): PassthroughBenchmarkRunner | undefined {
  return activeSessions.get(sessionId);
}

export function registerBenchmarkRunner(runner: PassthroughBenchmarkRunner): void {
  activeSessions.set(runner.benchmarkSessionId, runner);
}

export function removeBenchmarkRunner(sessionId: string): void {
  const runner = activeSessions.get(sessionId);
  if (runner) {
    runner.close();
    activeSessions.delete(sessionId);
  }
}
