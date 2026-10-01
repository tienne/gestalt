import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PassthroughExecuteEngine } from '../../../src/execute/passthrough-engine.js';
import { EventStore } from '../../../src/events/store.js';
import { isOk, isErr } from '../../../src/core/result.js';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { asRequested } from '../../helpers/structural.js';
import { createFakeRepo, cleanupFakeRepos } from '../../helpers/fake-repo.js';
import { codeGraphEngine } from '../../../src/code-graph/index.js';
import type { BlastRadiusResult } from '../../../src/code-graph/types.js';

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
        {
          name: 'Token',
          description: 'JWT token',
          attributes: ['accessToken', 'refreshToken', 'expiresAt'],
        },
      ],
      relations: [{ from: 'User', to: 'Token', type: 'has_many' }],
    },
    gestaltAnalysis: [
      {
        principle: 'closure' as const,
        finding: 'Password reset flow needs email service',
        confidence: 0.9,
      },
    ],
    metadata: {
      specId: randomUUID(),
      interviewSessionId: randomUUID(),
      resolutionScore: 0.85,
      generatedAt: new Date().toISOString(),
    },
  };
}

function createFigureGroundResult(): FigureGroundResult {
  return {
    principle: 'figure_ground',
    classifiedACs: [
      {
        acIndex: 0,
        acText: 'Users can register with email/password',
        classification: 'figure',
        priority: 'critical',
        reasoning: 'Core feature',
      },
      {
        acIndex: 1,
        acText: 'Users can login and receive JWT',
        classification: 'figure',
        priority: 'critical',
        reasoning: 'Core feature',
      },
      {
        acIndex: 2,
        acText: 'Users can reset password via email',
        classification: 'ground',
        priority: 'medium',
        reasoning: 'Supplementary',
      },
      {
        acIndex: 3,
        acText: 'OAuth2 login with Google supported',
        classification: 'ground',
        priority: 'high',
        reasoning: 'Important but not MVP',
      },
    ],
  };
}

function createClosureResult(): ClosureResult {
  return {
    principle: 'closure',
    atomicTasks: [
      {
        taskId: 'task-0',
        title: 'Setup user model',
        description: 'Create User entity',
        sourceAC: [0],
        isImplicit: false,
        estimatedComplexity: 'low',
        dependsOn: [],
      },
      {
        taskId: 'task-1',
        title: 'Register endpoint',
        description: 'POST /register',
        sourceAC: [0],
        isImplicit: false,
        estimatedComplexity: 'medium',
        dependsOn: ['task-0'],
      },
      {
        taskId: 'task-2',
        title: 'Login endpoint',
        description: 'POST /login with JWT',
        sourceAC: [1],
        isImplicit: false,
        estimatedComplexity: 'medium',
        dependsOn: ['task-0'],
      },
      {
        taskId: 'task-3',
        title: 'Password reset',
        description: 'Reset via email',
        sourceAC: [2],
        isImplicit: false,
        estimatedComplexity: 'high',
        dependsOn: ['task-0'],
      },
      {
        taskId: 'task-4',
        title: 'OAuth2 Google',
        description: 'Google OAuth integration',
        sourceAC: [3],
        isImplicit: false,
        estimatedComplexity: 'high',
        dependsOn: ['task-0'],
      },
      {
        taskId: 'task-5',
        title: 'Email service',
        description: 'Setup email sending',
        sourceAC: [2],
        isImplicit: true,
        estimatedComplexity: 'medium',
        dependsOn: [],
      },
    ],
  };
}

function createProximityResult(): ProximityResult {
  return {
    principle: 'proximity',
    taskGroups: [
      {
        groupId: 'group-0',
        name: 'Core Auth',
        domain: 'authentication',
        taskIds: ['task-0', 'task-1', 'task-2'],
        reasoning: 'Core auth tasks',
      },
      {
        groupId: 'group-1',
        name: 'Password Recovery',
        domain: 'recovery',
        taskIds: ['task-3', 'task-5'],
        reasoning: 'Password recovery related',
      },
      {
        groupId: 'group-2',
        name: 'OAuth',
        domain: 'oauth',
        taskIds: ['task-4'],
        reasoning: 'OAuth integration',
      },
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

function completePlanningPhase(
  engine: PassthroughExecuteEngine,
  spec: Spec,
  opts: { codeGraphRepoRoot?: string } = {},
): string {
  const startResult = engine.start(spec, opts);
  if (!startResult.ok) throw new Error('start failed');
  const { sessionId } = startResult.value.session;
  engine.planStep(sessionId, createFigureGroundResult());
  engine.planStep(sessionId, createClosureResult());
  engine.planStep(sessionId, createProximityResult());
  engine.planStep(sessionId, createContinuityResult());
  engine.planComplete(sessionId);
  return sessionId;
}

function createTaskResult(
  taskId: string,
  status: 'completed' | 'failed' = 'completed',
): TaskExecutionResult {
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
    } catch {
      /* ignore */
    }
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
    it('records task result and returns next task context', async () => {
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);
      engine.startExecution(sessionId);

      // Get first task from context
      engine.startExecution(sessionId);
      // Session is already executing, so re-get context
      const session = engine.getSession(sessionId);
      const plan = session.executionPlan!;
      const firstTaskId = plan.dagValidation.topologicalOrder[0]!;

      const result = await engine.submitTaskResult(sessionId, createTaskResult(firstTaskId));
      expect(isOk(result)).toBe(true);

      if (result.ok) {
        expect(result.value.session.taskResults).toHaveLength(1);
        expect(result.value.allTasksCompleted).toBe(false);
        expect(result.value.taskContext).not.toBeNull();
      }
    });

    it('rejects invalid taskId', async () => {
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);
      engine.startExecution(sessionId);

      const result = await engine.submitTaskResult(sessionId, createTaskResult('nonexistent-task'));
      expect(isErr(result)).toBe(true);
      if (!result.ok) {
        expect(result.error.message).toContain('not found in execution plan');
      }
    });

    it('rejects when session not in executing state', async () => {
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);
      // Don't call startExecution

      const result = await engine.submitTaskResult(sessionId, createTaskResult('task-0'));
      expect(isErr(result)).toBe(true);
    });

    it('signals allTasksCompleted when all tasks are done', async () => {
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);
      engine.startExecution(sessionId);

      const session = engine.getSession(sessionId);
      const topoOrder = session.executionPlan!.dagValidation.topologicalOrder;

      let lastResult;
      for (const taskId of topoOrder) {
        lastResult = await engine.submitTaskResult(sessionId, createTaskResult(taskId));
        expect(isOk(lastResult!)).toBe(true);
      }

      if (lastResult && lastResult.ok) {
        expect(lastResult.value.allTasksCompleted).toBe(true);
        expect(lastResult.value.taskContext).toBeNull();
        expect(lastResult.value.session.taskResults).toHaveLength(topoOrder.length);
      }
    });

    it('handles failed tasks and moves to next', async () => {
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);
      engine.startExecution(sessionId);

      const session = engine.getSession(sessionId);
      const firstTaskId = session.executionPlan!.dagValidation.topologicalOrder[0]!;

      const result = await engine.submitTaskResult(
        sessionId,
        createTaskResult(firstTaskId, 'failed'),
      );
      expect(isOk(result)).toBe(true);
      // Even though task-0 failed, dependent tasks should be unblocked
      if (result.ok) {
        expect(result.value.session.taskResults).toHaveLength(1);
        expect(result.value.session.taskResults[0]!.status).toBe('failed');
      }
    });

    it('provides similar task context via Similarity principle', async () => {
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);
      engine.startExecution(sessionId);

      // Complete task-0 (low complexity, sourceAC [0])
      await engine.submitTaskResult(sessionId, createTaskResult('task-0'));
      // Complete task-5 (medium complexity, sourceAC [2])
      await engine.submitTaskResult(sessionId, createTaskResult('task-5'));

      // Now task-1 (medium complexity, sourceAC [0]) should have similar context
      const result = await engine.submitTaskResult(sessionId, createTaskResult('task-1'));
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
    } catch {
      /* ignore */
    }
  });

  async function executeAllTasks(
    engine: PassthroughExecuteEngine,
    sessionId: string,
  ): Promise<void> {
    const session = engine.getSession(sessionId);
    const topoOrder = session.executionPlan!.dagValidation.topologicalOrder;
    for (const taskId of topoOrder) {
      await engine.submitTaskResult(sessionId, createTaskResult(taskId));
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
    it('returns structural commands to run', async () => {
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);
      engine.startExecution(sessionId);
      await executeAllTasks(engine, sessionId);

      const result = engine.startEvaluation(sessionId);
      expect(isOk(result)).toBe(true);

      if (result.ok) {
        expect(result.value.stage).toBe('structural');
        expect(result.value.structuralContext).toBeDefined();
        expect(result.value.structuralContext!.phase).toBe('evaluating');
        expect(result.value.structuralContext!.stage).toBe('structural');
        expect(result.value.structuralContext!.commands).toHaveLength(3);
        expect(result.value.structuralContext!.commands.map((c) => c.name)).toEqual([
          'lint',
          'build',
          'test',
        ]);
      }
    });

    it('sets evaluateStage to structural on session', async () => {
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);
      engine.startExecution(sessionId);
      await executeAllTasks(engine, sessionId);

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
    it('advances to contextual stage when structural passes', async () => {
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);
      engine.startExecution(sessionId);
      await executeAllTasks(engine, sessionId);
      const result = engine.submitStructuralResult(
        sessionId,
        asRequested(engine.startEvaluation(sessionId), passingStructuralResult),
      );
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

    it('short-circuits when structural fails', async () => {
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);
      engine.startExecution(sessionId);
      await executeAllTasks(engine, sessionId);
      const result = engine.submitStructuralResult(
        sessionId,
        asRequested(engine.startEvaluation(sessionId), failingStructuralResult),
      );
      expect(isOk(result)).toBe(true);

      if (result.ok) {
        expect(result.value.stage).toBe('complete');
        expect(result.value.shortCircuited).toBe(true);
        expect(result.value.evaluationResult).toBeDefined();
        expect(result.value.evaluationResult!.overallScore).toBe(0);
        expect(result.value.session.status).toBe('completed');
      }
    });

    it('rejects when not in structural stage', async () => {
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);
      engine.startExecution(sessionId);
      await executeAllTasks(engine, sessionId);
      // Don't call startEvaluation

      const result = engine.submitStructuralResult(sessionId, passingStructuralResult);
      expect(isErr(result)).toBe(true);
    });
  });

  describe('submitEvaluation (Contextual Stage)', () => {
    function advanceToContextual(engine: PassthroughExecuteEngine, sessionId: string): void {
      engine.submitStructuralResult(
        sessionId,
        asRequested(engine.startEvaluation(sessionId), passingStructuralResult),
      );
    }

    it('completes session with contextual evaluation result', async () => {
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);
      engine.startExecution(sessionId);
      await executeAllTasks(engine, sessionId);
      advanceToContextual(engine, sessionId);

      const evaluationResult: EvaluationResult = {
        verifications: [
          { acIndex: 0, satisfied: true, evidence: 'Register endpoint implemented', gaps: [] },
          {
            acIndex: 1,
            satisfied: true,
            evidence: 'Login endpoint with JWT implemented',
            gaps: [],
          },
          {
            acIndex: 2,
            satisfied: true,
            evidence: 'Password reset via email implemented',
            gaps: [],
          },
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

    it('rejects evaluation missing AC verification', async () => {
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);
      engine.startExecution(sessionId);
      await executeAllTasks(engine, sessionId);
      advanceToContextual(engine, sessionId);

      const evaluationResult: EvaluationResult = {
        verifications: [{ acIndex: 0, satisfied: true, evidence: 'done', gaps: [] }],
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

    it('rejects evaluation with invalid score range', async () => {
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);
      engine.startExecution(sessionId);
      await executeAllTasks(engine, sessionId);
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

    it('handles partial success with gaps', async () => {
      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec);
      engine.startExecution(sessionId);
      await executeAllTasks(engine, sessionId);
      advanceToContextual(engine, sessionId);

      const evaluationResult: EvaluationResult = {
        verifications: [
          { acIndex: 0, satisfied: true, evidence: 'Register works', gaps: [] },
          { acIndex: 1, satisfied: true, evidence: 'Login works', gaps: [] },
          {
            acIndex: 2,
            satisfied: false,
            evidence: 'Email service partially done',
            gaps: ['Email templates missing'],
          },
          {
            acIndex: 3,
            satisfied: false,
            evidence: 'OAuth not fully integrated',
            gaps: ['Token refresh not handled'],
          },
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
    } catch {
      /* ignore */
    }
  });

  it('completes the entire pipeline from planning to evaluation', async () => {
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
      const submitResult = await engine.submitTaskResult(sessionId, createTaskResult(taskId));
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

    const structResult = engine.submitStructuralResult(
      sessionId,
      asRequested(evalStart, structuralResult),
    );
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

describe('Evaluate Phase — structural command integrity', () => {
  let store: EventStore;
  let engine: PassthroughExecuteEngine;
  let dbPath: string;

  const PKG = JSON.stringify({ scripts: { lint: 'x', build: 'x', test: 'x' } });

  beforeEach(() => {
    dbPath = `.gestalt-test/eval-integrity-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    engine = new PassthroughExecuteEngine(store);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanupFakeRepos();
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    }
  });

  async function readyForEvaluation(codeGraphRepoRoot?: string): Promise<string> {
    const sessionId = completePlanningPhase(engine, createTestSpec(), { codeGraphRepoRoot });
    engine.startExecution(sessionId);
    const order = engine.getSession(sessionId).executionPlan!.dagValidation.topologicalOrder;
    for (const taskId of order) {
      await engine.submitTaskResult(sessionId, createTaskResult(taskId));
    }
    return sessionId;
  }

  function requestedCommands(sessionId: string, cwd?: string) {
    const start = engine.startEvaluation(sessionId, cwd);
    if (!start.ok) throw start.error;
    return start.value.structuralContext!.commands;
  }

  function passing(commands: Array<{ name: string; command: string }>): StructuralResult {
    return {
      commands: commands.map((c) => ({ ...c, exitCode: 0, output: 'ok' })),
      allPassed: true,
    };
  }

  function fakeBlast(impactedFiles: string[], rankedFiles: string[] = []): BlastRadiusResult {
    return { impactedFiles, rankedFiles } as unknown as BlastRadiusResult;
  }

  it('detects the package manager from the project lockfile', async () => {
    const repo = createFakeRepo({ files: { 'package.json': PKG, 'pnpm-lock.yaml': '' } });
    const sessionId = await readyForEvaluation();

    const commands = requestedCommands(sessionId, repo.root);
    expect(commands.map((c) => c.command)).toEqual([
      'pnpm run lint',
      'pnpm run build',
      'pnpm run test',
    ]);
  });

  it('rejects a submission whose commands differ from the requested ones', async () => {
    const repo = createFakeRepo({ files: { 'package.json': PKG, 'pnpm-lock.yaml': '' } });
    const sessionId = await readyForEvaluation();
    const commands = requestedCommands(sessionId, repo.root);

    const swapped = passing(
      commands.map((c) => (c.name === 'test' ? { ...c, command: 'echo "No affected tests"' } : c)),
    );
    const result = engine.submitStructuralResult(sessionId, swapped);
    expect(isErr(result)).toBe(true);
    if (!result.ok) expect(result.error.message).toContain('echo "No affected tests"');
    expect(engine.getSession(sessionId).evaluateStage).toBe('structural');

    expect(isOk(engine.submitStructuralResult(sessionId, passing(commands)))).toBe(true);
  });

  it('rejects a submission that leaves out a requested command', async () => {
    const repo = createFakeRepo({ files: { 'package.json': PKG, 'pnpm-lock.yaml': '' } });
    const sessionId = await readyForEvaluation();
    const commands = requestedCommands(sessionId, repo.root);

    const result = engine.submitStructuralResult(
      sessionId,
      passing(commands.filter((c) => c.name !== 'test')),
    );
    expect(isErr(result)).toBe(true);
  });

  it('short-circuits on a non-zero exit code even when allPassed is reported true', async () => {
    const repo = createFakeRepo({ files: { 'package.json': PKG, 'pnpm-lock.yaml': '' } });
    const sessionId = await readyForEvaluation();
    const commands = requestedCommands(sessionId, repo.root);

    const lying = passing(commands);
    lying.commands[2]!.exitCode = 1;
    const result = engine.submitStructuralResult(sessionId, lying);
    expect(isOk(result)).toBe(true);
    if (result.ok) {
      expect(result.value.shortCircuited).toBe(true);
      expect(engine.getSession(sessionId).structuralResult!.allPassed).toBe(false);
    }
  });

  it('still checks commands after the session is restored from events', async () => {
    const repo = createFakeRepo({ files: { 'package.json': PKG, 'pnpm-lock.yaml': '' } });
    const sessionId = await readyForEvaluation();
    const commands = requestedCommands(sessionId, repo.root);

    const restored = new PassthroughExecuteEngine(store);
    expect(restored.getSession(sessionId).structuralCommands).toEqual(commands);
    const result = restored.submitStructuralResult(
      sessionId,
      passing(commands.map((c) => ({ ...c, command: 'true' }))),
    );
    expect(isErr(result)).toBe(true);
  });

  describe('blast-radius test selection', () => {
    function graphRepo() {
      const repo = createFakeRepo({ files: { 'package.json': PKG, 'pnpm-lock.yaml': '' } });
      vi.spyOn(codeGraphEngine, 'dbExists').mockReturnValue(true);
      return repo;
    }

    it('runs the full suite instead of skipping when no tests are affected', async () => {
      const repo = graphRepo();
      repo.write('src/a.ts', 'changed');
      vi.spyOn(codeGraphEngine, 'blastRadius').mockReturnValue(fakeBlast(['/x/src/a.ts']));
      const sessionId = await readyForEvaluation(repo.root);

      const test = requestedCommands(sessionId).find((c) => c.name === 'test')!;
      expect(test.command).toBe('pnpm run test');
    });

    it('feeds uncommitted changes to blast-radius and passes only impactedFiles tests', async () => {
      const repo = graphRepo();
      repo.write('src/a.ts', 'uncommitted');
      const blast = vi
        .spyOn(codeGraphEngine, 'blastRadius')
        .mockReturnValue(
          fakeBlast(['/x/a.test.ts', '/x/src/a.ts'], ['/x/README.md', '/x/b.test.ts']),
        );
      const sessionId = await readyForEvaluation(repo.root);

      const test = requestedCommands(sessionId).find((c) => c.name === 'test')!;
      expect(test.command).toBe('pnpm run test /x/a.test.ts');
      expect(blast.mock.calls[0]![1]!.changedFiles).toContain(resolve(repo.root, 'src/a.ts'));
    });

    it('runs the full suite when blast-radius throws', async () => {
      const repo = graphRepo();
      repo.write('src/a.ts', 'changed');
      vi.spyOn(codeGraphEngine, 'blastRadius').mockImplementation(() => {
        throw new Error('graph corrupted');
      });
      const sessionId = await readyForEvaluation(repo.root);

      const test = requestedCommands(sessionId).find((c) => c.name === 'test')!;
      expect(test.command).toBe('pnpm run test');
    });
  });
});
