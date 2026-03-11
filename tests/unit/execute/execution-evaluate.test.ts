import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PassthroughExecuteEngine } from '../../../src/execute/passthrough-engine.js';
import { EventStore } from '../../../src/events/store.js';
import { isOk, isErr } from '../../../src/core/result.js';
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type {
  Spec,
  FigureGroundResult,
  ClosureResult,
  ProximityResult,
  ContinuityResult,
  TaskExecutionResult,
  EvaluationResult,
  StructuralResult,
} from '../../../src/core/types.js';

function createTestSpec(): Spec {
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
      specId: randomUUID(),
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

function completePlanningPhase(engine: PassthroughExecuteEngine, spec: Spec): string {
  const startResult = engine.start(spec);
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
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);

      const result = engine.startExecution(sessionId);
      expect(isOk(result)).toBe(true);

      if (result.ok) {
        expect(result.value.session.status).toBe('executing');
        expect(result.value.allTasksCompleted).toBe(false);
        expect(result.value.taskContext).not.toBeNull();
      }
    });

    it('returns first executable task (root of DAG)', () => {
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);

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
      const spec = createTestSpec();
      const startResult = engine.start(spec);
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
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);
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
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);
      engine.startExecution(sessionId);

      const result = engine.submitTaskResult(sessionId, createTaskResult('nonexistent-task'));
      expect(isErr(result)).toBe(true);
      if (!result.ok) {
        expect(result.error.message).toContain('not found in execution plan');
      }
    });

    it('rejects when session not in executing state', () => {
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);
      // Don't call startExecution

      const result = engine.submitTaskResult(sessionId, createTaskResult('task-0'));
      expect(isErr(result)).toBe(true);
    });

    it('signals allTasksCompleted when all tasks are done', () => {
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);
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
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);
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
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);
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

describe('Evaluate Phase (2-Stage Pipeline)', () => {
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

  const passingStructuralResult: StructuralResult = {
    commands: [
      { name: 'lint', command: 'npm run lint', exitCode: 0, output: 'No errors' },
      { name: 'build', command: 'npm run build', exitCode: 0, output: 'Build success' },
      { name: 'test', command: 'npm test', exitCode: 0, output: '10 tests passed' },
    ],
    allPassed: true,
  };

  const failingStructuralResult: StructuralResult = {
    commands: [
      { name: 'lint', command: 'npm run lint', exitCode: 1, output: '3 errors found' },
      { name: 'build', command: 'npm run build', exitCode: 0, output: 'Build success' },
      { name: 'test', command: 'npm test', exitCode: 0, output: '10 tests passed' },
    ],
    allPassed: false,
  };

  describe('startEvaluation (Structural Stage)', () => {
    it('returns structural commands to run', () => {
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);
      engine.startExecution(sessionId);
      executeAllTasks(engine, sessionId);

      const result = engine.startEvaluation(sessionId);
      expect(isOk(result)).toBe(true);

      if (result.ok) {
        expect(result.value.stage).toBe('structural');
        expect(result.value.structuralContext).toBeDefined();
        expect(result.value.structuralContext!.phase).toBe('evaluating');
        expect(result.value.structuralContext!.stage).toBe('structural');
        expect(result.value.structuralContext!.commands).toHaveLength(3);
        expect(result.value.structuralContext!.commands.map((c) => c.name)).toEqual(['lint', 'build', 'test']);
      }
    });

    it('sets evaluateStage to structural on session', () => {
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);
      engine.startExecution(sessionId);
      executeAllTasks(engine, sessionId);

      engine.startEvaluation(sessionId);
      const session = engine.getSession(sessionId);
      expect(session.evaluateStage).toBe('structural');
    });

    it('rejects when session not in executing state', () => {
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);

      const result = engine.startEvaluation(sessionId);
      expect(isErr(result)).toBe(true);
    });
  });

  describe('submitStructuralResult', () => {
    it('advances to contextual stage when structural passes', () => {
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);
      engine.startExecution(sessionId);
      executeAllTasks(engine, sessionId);
      engine.startEvaluation(sessionId);

      const result = engine.submitStructuralResult(sessionId, passingStructuralResult);
      expect(isOk(result)).toBe(true);

      if (result.ok) {
        expect(result.value.stage).toBe('contextual');
        expect(result.value.shortCircuited).toBeFalsy();
        expect(result.value.contextualContext).toBeDefined();
        expect(result.value.contextualContext!.phase).toBe('evaluating');
        expect(result.value.contextualContext!.stage).toBe('contextual');
        expect(result.value.contextualContext!.evaluatePrompt).toContain('Contextual Evaluation');
        expect(result.value.contextualContext!.classifiedACs).toHaveLength(4);
        expect(result.value.contextualContext!.taskResults).toHaveLength(6);
      }
    });

    it('short-circuits when structural fails', () => {
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);
      engine.startExecution(sessionId);
      executeAllTasks(engine, sessionId);
      engine.startEvaluation(sessionId);

      const result = engine.submitStructuralResult(sessionId, failingStructuralResult);
      expect(isOk(result)).toBe(true);

      if (result.ok) {
        expect(result.value.stage).toBe('complete');
        expect(result.value.shortCircuited).toBe(true);
        expect(result.value.evaluationResult).toBeDefined();
        expect(result.value.evaluationResult!.overallScore).toBe(0);
        expect(result.value.session.status).toBe('completed');
      }
    });

    it('rejects when not in structural stage', () => {
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);
      engine.startExecution(sessionId);
      executeAllTasks(engine, sessionId);
      // Don't call startEvaluation

      const result = engine.submitStructuralResult(sessionId, passingStructuralResult);
      expect(isErr(result)).toBe(true);
    });
  });

  describe('submitEvaluation (Contextual Stage)', () => {
    function advanceToContextual(engine: PassthroughExecuteEngine, sessionId: string): void {
      engine.startEvaluation(sessionId);
      engine.submitStructuralResult(sessionId, passingStructuralResult);
    }

    it('completes session with contextual evaluation result', () => {
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);
      engine.startExecution(sessionId);
      executeAllTasks(engine, sessionId);
      advanceToContextual(engine, sessionId);

      const evaluationResult: EvaluationResult = {
        verifications: [
          { acIndex: 0, satisfied: true, evidence: 'Register endpoint implemented', gaps: [] },
          { acIndex: 1, satisfied: true, evidence: 'Login endpoint with JWT implemented', gaps: [] },
          { acIndex: 2, satisfied: true, evidence: 'Password reset via email implemented', gaps: [] },
          { acIndex: 3, satisfied: true, evidence: 'OAuth2 Google login implemented', gaps: [] },
        ],
        overallScore: 1.0,
        goalAlignment: 0.95,
        recommendations: [],
      };

      const result = engine.submitEvaluation(sessionId, evaluationResult);
      expect(isOk(result)).toBe(true);

      if (result.ok) {
        expect(result.value.session.status).toBe('completed');
        expect(result.value.stage).toBe('complete');
        expect(result.value.evaluationResult).toBeDefined();
        expect(result.value.evaluationResult!.overallScore).toBe(1.0);
        expect(result.value.evaluationResult!.goalAlignment).toBe(0.95);
        expect(result.value.session.evaluationResult).toBeDefined();
      }
    });

    it('rejects evaluation missing AC verification', () => {
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);
      engine.startExecution(sessionId);
      executeAllTasks(engine, sessionId);
      advanceToContextual(engine, sessionId);

      const evaluationResult: EvaluationResult = {
        verifications: [
          { acIndex: 0, satisfied: true, evidence: 'done', gaps: [] },
        ],
        overallScore: 0.25,
        goalAlignment: 0.5,
        recommendations: ['Incomplete evaluation'],
      };

      const result = engine.submitEvaluation(sessionId, evaluationResult);
      expect(isErr(result)).toBe(true);
      if (!result.ok) {
        expect(result.error.message).toContain('AC index');
      }
    });

    it('rejects evaluation with invalid score range', () => {
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);
      engine.startExecution(sessionId);
      executeAllTasks(engine, sessionId);
      advanceToContextual(engine, sessionId);

      const evaluationResult: EvaluationResult = {
        verifications: [
          { acIndex: 0, satisfied: true, evidence: 'done', gaps: [] },
          { acIndex: 1, satisfied: true, evidence: 'done', gaps: [] },
          { acIndex: 2, satisfied: true, evidence: 'done', gaps: [] },
          { acIndex: 3, satisfied: true, evidence: 'done', gaps: [] },
        ],
        overallScore: 1.5,
        goalAlignment: 0.8,
        recommendations: [],
      };

      const result = engine.submitEvaluation(sessionId, evaluationResult);
      expect(isErr(result)).toBe(true);
      if (!result.ok) {
        expect(result.error.message).toContain('overallScore');
      }
    });

    it('rejects when not in contextual stage', () => {
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);

      const evaluationResult: EvaluationResult = {
        verifications: [],
        overallScore: 0,
        goalAlignment: 0,
        recommendations: [],
      };

      const result = engine.submitEvaluation(sessionId, evaluationResult);
      expect(isErr(result)).toBe(true);
    });

    it('handles partial success with gaps', () => {
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);
      engine.startExecution(sessionId);
      executeAllTasks(engine, sessionId);
      advanceToContextual(engine, sessionId);

      const evaluationResult: EvaluationResult = {
        verifications: [
          { acIndex: 0, satisfied: true, evidence: 'Register works', gaps: [] },
          { acIndex: 1, satisfied: true, evidence: 'Login works', gaps: [] },
          { acIndex: 2, satisfied: false, evidence: 'Email service partially done', gaps: ['Email templates missing'] },
          { acIndex: 3, satisfied: false, evidence: 'OAuth not fully integrated', gaps: ['Token refresh not handled'] },
        ],
        overallScore: 0.6,
        goalAlignment: 0.7,
        recommendations: ['Complete email templates', 'Add OAuth token refresh'],
      };

      const result = engine.submitEvaluation(sessionId, evaluationResult);
      expect(isOk(result)).toBe(true);

      if (result.ok) {
        expect(result.value.session.status).toBe('completed');
        expect(result.value.evaluationResult!.overallScore).toBe(0.6);
        expect(result.value.evaluationResult!.goalAlignment).toBe(0.7);
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
    const spec = createTestSpec();

    // Phase 1: Planning
    const startResult = engine.start(spec);
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

    // Phase 3: Evaluate — Stage 1: Structural
    const evalStart = engine.startEvaluation(sessionId);
    expect(isOk(evalStart)).toBe(true);
    if (evalStart.ok) {
      expect(evalStart.value.structuralContext).toBeDefined();
      expect(evalStart.value.stage).toBe('structural');
    }

    // Stage 2: Submit structural results
    const structuralResult: StructuralResult = {
      commands: [
        { name: 'lint', command: 'npm run lint', exitCode: 0, output: 'OK' },
        { name: 'build', command: 'npm run build', exitCode: 0, output: 'OK' },
        { name: 'test', command: 'npm test', exitCode: 0, output: 'OK' },
      ],
      allPassed: true,
    };

    const structResult = engine.submitStructuralResult(sessionId, structuralResult);
    expect(isOk(structResult)).toBe(true);
    if (structResult.ok) {
      expect(structResult.value.stage).toBe('contextual');
      expect(structResult.value.contextualContext).toBeDefined();
    }

    // Stage 3: Submit contextual evaluation
    const evaluationResult: EvaluationResult = {
      verifications: spec.acceptanceCriteria.map((_, i) => ({
        acIndex: i,
        satisfied: true,
        evidence: `AC ${i} fully satisfied`,
        gaps: [],
      })),
      overallScore: 1.0,
      goalAlignment: 0.95,
      recommendations: [],
    };

    const evalResult = engine.submitEvaluation(sessionId, evaluationResult);
    expect(isOk(evalResult)).toBe(true);

    if (evalResult.ok) {
      expect(evalResult.value.session.status).toBe('completed');
      expect(evalResult.value.evaluationResult!.overallScore).toBe(1.0);
      expect(evalResult.value.evaluationResult!.goalAlignment).toBe(0.95);
    }

    // Final session state check
    const finalSession = engine.getSession(sessionId);
    expect(finalSession.status).toBe('completed');
    expect(finalSession.evaluateStage).toBe('complete');
    expect(finalSession.planningSteps).toHaveLength(4);
    expect(finalSession.taskResults).toHaveLength(6);
    expect(finalSession.evaluationResult).toBeDefined();
    expect(finalSession.evaluationResult!.overallScore).toBe(1.0);
    expect(finalSession.evaluationResult!.goalAlignment).toBe(0.95);
  });
});
