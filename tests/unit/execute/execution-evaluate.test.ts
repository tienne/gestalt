import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PassthroughExecuteEngine } from '../../../src/execute/passthrough-engine.js';
import { EventStore } from '../../../src/events/store.js';
import { isOk, isErr } from '../../../src/core/result.js';
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type {
  Seed,
  FigureGroundResult,
  ClosureResult,
  ProximityResult,
  ContinuityResult,
  TaskExecutionResult,
  EvaluationResult,
} from '../../../src/core/types.js';

function createTestSeed(): Seed {
  return {
    version: '1.0.0',
    goal: 'Build a user authentication system',
    constraints: ['Must use JWT', 'Must support OAuth2'],
    acceptanceCriteria: [
      'Users can register with email/password',
      'Users can login and receive JWT',
      'Users can reset password via email',
      'OAuth2 login with Google supported',
    ],
    ontologySchema: {
      entities: [
        { name: 'User', description: 'System user', attributes: ['email', 'password', 'role'] },
        { name: 'Token', description: 'JWT token', attributes: ['accessToken', 'refreshToken', 'expiresAt'] },
      ],
      relations: [
        { from: 'User', to: 'Token', type: 'has_many' },
      ],
    },
    gestaltAnalysis: [
      { principle: 'closure' as const, finding: 'Password reset flow needs email service', confidence: 0.9 },
    ],
    metadata: {
      seedId: randomUUID(),
      interviewSessionId: randomUUID(),
      ambiguityScore: 0.15,
      generatedAt: new Date().toISOString(),
    },
  };
}

function createFigureGroundResult(): FigureGroundResult {
  return {
    principle: 'figure_ground',
    classifiedACs: [
      { acIndex: 0, acText: 'Users can register with email/password', classification: 'figure', priority: 'critical', reasoning: 'Core feature' },
      { acIndex: 1, acText: 'Users can login and receive JWT', classification: 'figure', priority: 'critical', reasoning: 'Core feature' },
      { acIndex: 2, acText: 'Users can reset password via email', classification: 'ground', priority: 'medium', reasoning: 'Supplementary' },
      { acIndex: 3, acText: 'OAuth2 login with Google supported', classification: 'ground', priority: 'high', reasoning: 'Important but not MVP' },
    ],
  };
}

function createClosureResult(): ClosureResult {
  return {
    principle: 'closure',
    atomicTasks: [
      { taskId: 'task-0', title: 'Setup user model', description: 'Create User entity', sourceAC: [0], isImplicit: false, estimatedComplexity: 'low', dependsOn: [] },
      { taskId: 'task-1', title: 'Register endpoint', description: 'POST /register', sourceAC: [0], isImplicit: false, estimatedComplexity: 'medium', dependsOn: ['task-0'] },
      { taskId: 'task-2', title: 'Login endpoint', description: 'POST /login with JWT', sourceAC: [1], isImplicit: false, estimatedComplexity: 'medium', dependsOn: ['task-0'] },
      { taskId: 'task-3', title: 'Password reset', description: 'Reset via email', sourceAC: [2], isImplicit: false, estimatedComplexity: 'high', dependsOn: ['task-0'] },
      { taskId: 'task-4', title: 'OAuth2 Google', description: 'Google OAuth integration', sourceAC: [3], isImplicit: false, estimatedComplexity: 'high', dependsOn: ['task-0'] },
      { taskId: 'task-5', title: 'Email service', description: 'Setup email sending', sourceAC: [2], isImplicit: true, estimatedComplexity: 'medium', dependsOn: [] },
    ],
  };
}

function createProximityResult(): ProximityResult {
  return {
    principle: 'proximity',
    taskGroups: [
      { groupId: 'group-0', name: 'Core Auth', domain: 'authentication', taskIds: ['task-0', 'task-1', 'task-2'], reasoning: 'Core auth tasks' },
      { groupId: 'group-1', name: 'Password Recovery', domain: 'recovery', taskIds: ['task-3', 'task-5'], reasoning: 'Password recovery related' },
      { groupId: 'group-2', name: 'OAuth', domain: 'oauth', taskIds: ['task-4'], reasoning: 'OAuth integration' },
    ],
  };
}

function createContinuityResult(): ContinuityResult {
  return {
    principle: 'continuity',
    dagValidation: {
      isValid: true,
      hasCycles: false,
      hasConflicts: false,
      topologicalOrder: ['task-0', 'task-5', 'task-1', 'task-2', 'task-3', 'task-4'],
      criticalPath: ['task-0', 'task-1'],
    },
  };
}

function completePlanningPhase(engine: PassthroughExecuteEngine, seed: Seed): string {
  const startResult = engine.start(seed);
  if (!startResult.ok) throw new Error('start failed');
  const { sessionId } = startResult.value.session;
  engine.planStep(sessionId, createFigureGroundResult());
  engine.planStep(sessionId, createClosureResult());
  engine.planStep(sessionId, createProximityResult());
  engine.planStep(sessionId, createContinuityResult());
  engine.planComplete(sessionId);
  return sessionId;
}

function createTaskResult(taskId: string, status: 'completed' | 'failed' = 'completed'): TaskExecutionResult {
  return {
    taskId,
    status,
    output: `Implemented ${taskId} successfully`,
    artifacts: [`src/${taskId}.ts`],
  };
}

describe('Execution Phase', () => {
  let store: EventStore;
  let engine: PassthroughExecuteEngine;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/exec-phase-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    engine = new PassthroughExecuteEngine(store);
  });

  afterEach(() => {
    store.close();
    try {
      if (existsSync(dbPath)) rmSync(dbPath);
      if (existsSync(dbPath + '-wal')) rmSync(dbPath + '-wal');
      if (existsSync(dbPath + '-shm')) rmSync(dbPath + '-shm');
    } catch { /* ignore */ }
  });

  describe('startExecution', () => {
    it('transitions from plan_complete to executing', () => {
      const seed = createTestSeed();
      const sessionId = completePlanningPhase(engine, seed);

      const result = engine.startExecution(sessionId);
      expect(isOk(result)).toBe(true);

      if (result.ok) {
        expect(result.value.session.status).toBe('executing');
        expect(result.value.allTasksCompleted).toBe(false);
        expect(result.value.taskContext).not.toBeNull();
      }
    });

    it('returns first executable task (root of DAG)', () => {
      const seed = createTestSeed();
      const sessionId = completePlanningPhase(engine, seed);

      const result = engine.startExecution(sessionId);
      if (!result.ok) return;

      const ctx = result.value.taskContext!;
      expect(ctx.phase).toBe('executing');
      expect(ctx.systemPrompt).toContain('task executor');
      // First task should have no dependencies (task-0 or task-5)
      expect(['task-0', 'task-5']).toContain(ctx.currentTask.taskId);
      expect(ctx.taskPrompt).toContain('Task Execution');
    });

    it('rejects startExecution when not in plan_complete state', () => {
      const seed = createTestSeed();
      const startResult = engine.start(seed);
      if (!startResult.ok) return;

      const result = engine.startExecution(startResult.value.session.sessionId);
      expect(isErr(result)).toBe(true);
      if (!result.ok) {
        expect(result.error.message).toContain('plan_complete');
      }
    });
  });

  describe('submitTaskResult', () => {
    it('records task result and returns next task context', () => {
      const seed = createTestSeed();
      const sessionId = completePlanningPhase(engine, seed);
      engine.startExecution(sessionId);

      // Get first task from context
      const execResult = engine.startExecution(sessionId);
      // Session is already executing, so re-get context
      const session = engine.getSession(sessionId);
      const plan = session.executionPlan!;
      const firstTaskId = plan.dagValidation.topologicalOrder[0]!;

      const result = engine.submitTaskResult(sessionId, createTaskResult(firstTaskId));
      expect(isOk(result)).toBe(true);

      if (result.ok) {
        expect(result.value.session.taskResults).toHaveLength(1);
        expect(result.value.allTasksCompleted).toBe(false);
        expect(result.value.taskContext).not.toBeNull();
      }
    });

    it('rejects invalid taskId', () => {
      const seed = createTestSeed();
      const sessionId = completePlanningPhase(engine, seed);
      engine.startExecution(sessionId);

      const result = engine.submitTaskResult(sessionId, createTaskResult('nonexistent-task'));
      expect(isErr(result)).toBe(true);
      if (!result.ok) {
        expect(result.error.message).toContain('not found in execution plan');
      }
    });

    it('rejects when session not in executing state', () => {
      const seed = createTestSeed();
      const sessionId = completePlanningPhase(engine, seed);
      // Don't call startExecution

      const result = engine.submitTaskResult(sessionId, createTaskResult('task-0'));
      expect(isErr(result)).toBe(true);
    });

    it('signals allTasksCompleted when all tasks are done', () => {
      const seed = createTestSeed();
      const sessionId = completePlanningPhase(engine, seed);
      engine.startExecution(sessionId);

      const session = engine.getSession(sessionId);
      const topoOrder = session.executionPlan!.dagValidation.topologicalOrder;

      let lastResult;
      for (const taskId of topoOrder) {
        lastResult = engine.submitTaskResult(sessionId, createTaskResult(taskId));
        expect(isOk(lastResult!)).toBe(true);
      }

      if (lastResult && lastResult.ok) {
        expect(lastResult.value.allTasksCompleted).toBe(true);
        expect(lastResult.value.taskContext).toBeNull();
        expect(lastResult.value.session.taskResults).toHaveLength(topoOrder.length);
      }
    });

    it('handles failed tasks and moves to next', () => {
      const seed = createTestSeed();
      const sessionId = completePlanningPhase(engine, seed);
      engine.startExecution(sessionId);

      const session = engine.getSession(sessionId);
      const firstTaskId = session.executionPlan!.dagValidation.topologicalOrder[0]!;

      const result = engine.submitTaskResult(sessionId, createTaskResult(firstTaskId, 'failed'));
      expect(isOk(result)).toBe(true);
      // Even though task-0 failed, dependent tasks should be unblocked
      if (result.ok) {
        expect(result.value.session.taskResults).toHaveLength(1);
        expect(result.value.session.taskResults[0]!.status).toBe('failed');
      }
    });

    it('provides similar task context via Similarity principle', () => {
      const seed = createTestSeed();
      const sessionId = completePlanningPhase(engine, seed);
      engine.startExecution(sessionId);

      // Complete task-0 (low complexity, sourceAC [0])
      engine.submitTaskResult(sessionId, createTaskResult('task-0'));
      // Complete task-5 (medium complexity, sourceAC [2])
      engine.submitTaskResult(sessionId, createTaskResult('task-5'));

      // Now task-1 (medium complexity, sourceAC [0]) should have similar context
      const result = engine.submitTaskResult(sessionId, createTaskResult('task-1'));
      if (result.ok && result.value.taskContext) {
        expect(result.value.taskContext.similarityStrategy).toBeDefined();
        expect(result.value.taskContext.completedTaskIds).toContain('task-0');
      }
    });
  });
});

describe('Evaluate Phase', () => {
  let store: EventStore;
  let engine: PassthroughExecuteEngine;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/eval-phase-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    engine = new PassthroughExecuteEngine(store);
  });

  afterEach(() => {
    store.close();
    try {
      if (existsSync(dbPath)) rmSync(dbPath);
      if (existsSync(dbPath + '-wal')) rmSync(dbPath + '-wal');
      if (existsSync(dbPath + '-shm')) rmSync(dbPath + '-shm');
    } catch { /* ignore */ }
  });

  function executeAllTasks(engine: PassthroughExecuteEngine, sessionId: string): void {
    const session = engine.getSession(sessionId);
    const topoOrder = session.executionPlan!.dagValidation.topologicalOrder;
    for (const taskId of topoOrder) {
      engine.submitTaskResult(sessionId, createTaskResult(taskId));
    }
  }

  describe('startEvaluation', () => {
    it('returns evaluate context with AC and task results', () => {
      const seed = createTestSeed();
      const sessionId = completePlanningPhase(engine, seed);
      engine.startExecution(sessionId);
      executeAllTasks(engine, sessionId);

      const result = engine.startEvaluation(sessionId);
      expect(isOk(result)).toBe(true);

      if (result.ok) {
        const ctx = result.value.evaluateContext!;
        expect(ctx.phase).toBe('evaluating');
        expect(ctx.systemPrompt).toContain('evaluator');
        expect(ctx.evaluatePrompt).toContain('Evaluation');
        expect(ctx.classifiedACs).toHaveLength(4);
        expect(ctx.taskResults).toHaveLength(6);
        expect(ctx.seed.goal).toBe(seed.goal);
      }
    });

    it('rejects when session not in executing state', () => {
      const seed = createTestSeed();
      const sessionId = completePlanningPhase(engine, seed);
      // Don't start execution

      const result = engine.startEvaluation(sessionId);
      expect(isErr(result)).toBe(true);
    });
  });

  describe('submitEvaluation', () => {
    it('completes session with evaluation result', () => {
      const seed = createTestSeed();
      const sessionId = completePlanningPhase(engine, seed);
      engine.startExecution(sessionId);
      executeAllTasks(engine, sessionId);

      const evaluationResult: EvaluationResult = {
        verifications: [
          { acIndex: 0, satisfied: true, evidence: 'Register endpoint implemented', gaps: [] },
          { acIndex: 1, satisfied: true, evidence: 'Login endpoint with JWT implemented', gaps: [] },
          { acIndex: 2, satisfied: true, evidence: 'Password reset via email implemented', gaps: [] },
          { acIndex: 3, satisfied: true, evidence: 'OAuth2 Google login implemented', gaps: [] },
        ],
        overallScore: 1.0,
        recommendations: [],
      };

      const result = engine.submitEvaluation(sessionId, evaluationResult);
      expect(isOk(result)).toBe(true);

      if (result.ok) {
        expect(result.value.session.status).toBe('completed');
        expect(result.value.evaluationResult).toBeDefined();
        expect(result.value.evaluationResult!.overallScore).toBe(1.0);
        expect(result.value.session.evaluationResult).toBeDefined();
      }
    });

    it('rejects evaluation missing AC verification', () => {
      const seed = createTestSeed();
      const sessionId = completePlanningPhase(engine, seed);
      engine.startExecution(sessionId);
      executeAllTasks(engine, sessionId);

      const evaluationResult: EvaluationResult = {
        verifications: [
          { acIndex: 0, satisfied: true, evidence: 'done', gaps: [] },
          // Missing acIndex 1, 2, 3
        ],
        overallScore: 0.25,
        recommendations: ['Incomplete evaluation'],
      };

      const result = engine.submitEvaluation(sessionId, evaluationResult);
      expect(isErr(result)).toBe(true);
      if (!result.ok) {
        expect(result.error.message).toContain('AC index');
      }
    });

    it('rejects evaluation with invalid score range', () => {
      const seed = createTestSeed();
      const sessionId = completePlanningPhase(engine, seed);
      engine.startExecution(sessionId);
      executeAllTasks(engine, sessionId);

      const evaluationResult: EvaluationResult = {
        verifications: [
          { acIndex: 0, satisfied: true, evidence: 'done', gaps: [] },
          { acIndex: 1, satisfied: true, evidence: 'done', gaps: [] },
          { acIndex: 2, satisfied: true, evidence: 'done', gaps: [] },
          { acIndex: 3, satisfied: true, evidence: 'done', gaps: [] },
        ],
        overallScore: 1.5, // Invalid
        recommendations: [],
      };

      const result = engine.submitEvaluation(sessionId, evaluationResult);
      expect(isErr(result)).toBe(true);
      if (!result.ok) {
        expect(result.error.message).toContain('overallScore');
      }
    });

    it('rejects when session not in executing state', () => {
      const seed = createTestSeed();
      const sessionId = completePlanningPhase(engine, seed);

      const evaluationResult: EvaluationResult = {
        verifications: [],
        overallScore: 0,
        recommendations: [],
      };

      const result = engine.submitEvaluation(sessionId, evaluationResult);
      expect(isErr(result)).toBe(true);
    });

    it('handles partial success with gaps', () => {
      const seed = createTestSeed();
      const sessionId = completePlanningPhase(engine, seed);
      engine.startExecution(sessionId);
      executeAllTasks(engine, sessionId);

      const evaluationResult: EvaluationResult = {
        verifications: [
          { acIndex: 0, satisfied: true, evidence: 'Register works', gaps: [] },
          { acIndex: 1, satisfied: true, evidence: 'Login works', gaps: [] },
          { acIndex: 2, satisfied: false, evidence: 'Email service partially done', gaps: ['Email templates missing'] },
          { acIndex: 3, satisfied: false, evidence: 'OAuth not fully integrated', gaps: ['Token refresh not handled'] },
        ],
        overallScore: 0.6,
        recommendations: ['Complete email templates', 'Add OAuth token refresh'],
      };

      const result = engine.submitEvaluation(sessionId, evaluationResult);
      expect(isOk(result)).toBe(true);

      if (result.ok) {
        expect(result.value.session.status).toBe('completed');
        expect(result.value.evaluationResult!.overallScore).toBe(0.6);
        expect(result.value.evaluationResult!.recommendations).toHaveLength(2);
      }
    });
  });
});

describe('Full Pipeline: Planning → Execution → Evaluate', () => {
  let store: EventStore;
  let engine: PassthroughExecuteEngine;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/full-pipeline-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    engine = new PassthroughExecuteEngine(store);
  });

  afterEach(() => {
    store.close();
    try {
      if (existsSync(dbPath)) rmSync(dbPath);
      if (existsSync(dbPath + '-wal')) rmSync(dbPath + '-wal');
      if (existsSync(dbPath + '-shm')) rmSync(dbPath + '-shm');
    } catch { /* ignore */ }
  });

  it('completes the entire pipeline from planning to evaluation', () => {
    const seed = createTestSeed();

    // Phase 1: Planning
    const startResult = engine.start(seed);
    expect(isOk(startResult)).toBe(true);
    if (!startResult.ok) return;
    const { sessionId } = startResult.value.session;

    engine.planStep(sessionId, createFigureGroundResult());
    engine.planStep(sessionId, createClosureResult());
    engine.planStep(sessionId, createProximityResult());
    engine.planStep(sessionId, createContinuityResult());
    const planResult = engine.planComplete(sessionId);
    expect(isOk(planResult)).toBe(true);

    // Phase 2: Execution
    const execStart = engine.startExecution(sessionId);
    expect(isOk(execStart)).toBe(true);
    expect(engine.getSession(sessionId).status).toBe('executing');

    const session = engine.getSession(sessionId);
    const topoOrder = session.executionPlan!.dagValidation.topologicalOrder;

    for (const taskId of topoOrder) {
      const submitResult = engine.submitTaskResult(sessionId, createTaskResult(taskId));
      expect(isOk(submitResult)).toBe(true);
    }

    // Verify all tasks completed
    const afterExec = engine.getSession(sessionId);
    expect(afterExec.taskResults).toHaveLength(topoOrder.length);

    // Phase 3: Evaluate
    const evalStart = engine.startEvaluation(sessionId);
    expect(isOk(evalStart)).toBe(true);
    if (evalStart.ok) {
      expect(evalStart.value.evaluateContext).toBeDefined();
    }

    const evaluationResult: EvaluationResult = {
      verifications: seed.acceptanceCriteria.map((_, i) => ({
        acIndex: i,
        satisfied: true,
        evidence: `AC ${i} fully satisfied`,
        gaps: [],
      })),
      overallScore: 1.0,
      recommendations: [],
    };

    const evalResult = engine.submitEvaluation(sessionId, evaluationResult);
    expect(isOk(evalResult)).toBe(true);

    if (evalResult.ok) {
      expect(evalResult.value.session.status).toBe('completed');
      expect(evalResult.value.evaluationResult!.overallScore).toBe(1.0);
    }

    // Final session state check
    const finalSession = engine.getSession(sessionId);
    expect(finalSession.status).toBe('completed');
    expect(finalSession.planningSteps).toHaveLength(4);
    expect(finalSession.taskResults).toHaveLength(6);
    expect(finalSession.evaluationResult).toBeDefined();
    expect(finalSession.evaluationResult!.overallScore).toBe(1.0);
  });
});
