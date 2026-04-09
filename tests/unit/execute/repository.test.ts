import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ExecuteSessionRepository } from '../../../src/execute/repository.js';
import { ExecuteSessionManager } from '../../../src/execute/session.js';
import { EventStore } from '../../../src/events/store.js';
import type {
  Spec,
  PlanningStepResult,
  ExecutionPlan,
  TaskExecutionResult,
  EvaluationResult,
} from '../../../src/core/types.js';
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const createTestSpec = (): Spec => ({
  version: '1.0',
  goal: 'Test goal',
  constraints: ['C1', 'C2'],
  acceptanceCriteria: ['AC0', 'AC1', 'AC2'],
  ontologySchema: {
    entities: [{ name: 'User', description: 'A user', attributes: ['id', 'name'] }],
    relations: [{ from: 'User', to: 'User', type: 'follows' }],
  },
  gestaltAnalysis: [{ principle: 'closure' as const, finding: 'Test finding', confidence: 0.9 }],
  metadata: {
    specId: `spec-${randomUUID()}`,
    interviewSessionId: `interview-${randomUUID()}`,
    resolutionScore: 0.85,
    generatedAt: new Date().toISOString(),
  },
});

const figureGroundStep: PlanningStepResult = {
  principle: 'figure_ground',
  classifiedACs: [
    {
      acIndex: 0,
      acText: 'AC0',
      classification: 'figure',
      priority: 'critical',
      reasoning: 'Core',
    },
    {
      acIndex: 1,
      acText: 'AC1',
      classification: 'figure',
      priority: 'high',
      reasoning: 'Important',
    },
    {
      acIndex: 2,
      acText: 'AC2',
      classification: 'ground',
      priority: 'medium',
      reasoning: 'Nice to have',
    },
  ],
};

const closureStep: PlanningStepResult = {
  principle: 'closure',
  atomicTasks: [
    {
      taskId: 'task-0',
      title: 'Setup',
      description: 'Setup project',
      sourceAC: [0],
      isImplicit: false,
      estimatedComplexity: 'low',
      dependsOn: [],
    },
    {
      taskId: 'task-1',
      title: 'Core',
      description: 'Core feature',
      sourceAC: [0, 1],
      isImplicit: false,
      estimatedComplexity: 'high',
      dependsOn: ['task-0'],
    },
    {
      taskId: 'task-2',
      title: 'Polish',
      description: 'Nice to have',
      sourceAC: [2],
      isImplicit: false,
      estimatedComplexity: 'low',
      dependsOn: ['task-1'],
    },
  ],
};

const proximityStep: PlanningStepResult = {
  principle: 'proximity',
  taskGroups: [
    {
      groupId: 'group-0',
      name: 'Infrastructure',
      domain: 'setup',
      taskIds: ['task-0'],
      reasoning: 'Setup tasks',
    },
    {
      groupId: 'group-1',
      name: 'Features',
      domain: 'core',
      taskIds: ['task-1', 'task-2'],
      reasoning: 'Feature tasks',
    },
  ],
};

const continuityStep: PlanningStepResult = {
  principle: 'continuity',
  dagValidation: {
    isValid: true,
    hasCycles: false,
    hasConflicts: false,
    topologicalOrder: ['task-0', 'task-1', 'task-2'],
    criticalPath: ['task-0', 'task-1', 'task-2'],
  },
};

describe('ExecuteSessionRepository', () => {
  let store: EventStore;
  let repo: ExecuteSessionRepository;
  let manager: ExecuteSessionManager;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/execute-repo-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    repo = new ExecuteSessionRepository(store);
    manager = new ExecuteSessionManager(store);
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

  it('returns null for non-existent session', () => {
    expect(repo.reconstruct('non-existent')).toBeNull();
  });

  it('reconstructs a basic planning session', () => {
    const spec = createTestSpec();
    const session = manager.create(spec);

    const reconstructed = repo.reconstruct(session.sessionId);

    expect(reconstructed).not.toBeNull();
    expect(reconstructed!.sessionId).toBe(session.sessionId);
    expect(reconstructed!.specId).toBe(spec.metadata.specId);
    expect(reconstructed!.status).toBe('planning');
    expect(reconstructed!.spec.goal).toBe('Test goal');
    expect(reconstructed!.spec.acceptanceCriteria).toEqual(['AC0', 'AC1', 'AC2']);
  });

  it('reconstructs planning steps', () => {
    const spec = createTestSpec();
    const session = manager.create(spec);
    manager.addPlanningStep(session.sessionId, figureGroundStep);
    manager.addPlanningStep(session.sessionId, closureStep);

    const reconstructed = repo.reconstruct(session.sessionId);

    expect(reconstructed!.planningSteps).toHaveLength(2);
    expect(reconstructed!.planningSteps[0]!.principle).toBe('figure_ground');
    expect(reconstructed!.planningSteps[1]!.principle).toBe('closure');
    expect(reconstructed!.currentStep).toBe(3);

    // Verify full data is preserved
    const fg = reconstructed!.planningSteps[0] as typeof figureGroundStep;
    expect(fg.classifiedACs).toHaveLength(3);
    expect(fg.classifiedACs[0]!.acText).toBe('AC0');
  });

  it('reconstructs plan_complete with ExecutionPlan', () => {
    const spec = createTestSpec();
    const session = manager.create(spec);
    manager.addPlanningStep(session.sessionId, figureGroundStep);
    manager.addPlanningStep(session.sessionId, closureStep);
    manager.addPlanningStep(session.sessionId, proximityStep);
    manager.addPlanningStep(session.sessionId, continuityStep);

    const plan: ExecutionPlan = {
      planId: randomUUID(),
      specId: spec.metadata.specId,
      classifiedACs: figureGroundStep.classifiedACs,
      atomicTasks: closureStep.atomicTasks,
      taskGroups: proximityStep.taskGroups,
      dagValidation: continuityStep.dagValidation,
      createdAt: new Date().toISOString(),
    };
    manager.completePlan(session.sessionId, plan);

    const reconstructed = repo.reconstruct(session.sessionId);

    expect(reconstructed!.status).toBe('plan_complete');
    expect(reconstructed!.executionPlan).toBeDefined();
    expect(reconstructed!.executionPlan!.atomicTasks).toHaveLength(3);
    expect(reconstructed!.executionPlan!.taskGroups).toHaveLength(2);
  });

  it('reconstructs executing session with task results', () => {
    const spec = createTestSpec();
    const session = manager.create(spec);
    manager.addPlanningStep(session.sessionId, figureGroundStep);
    manager.addPlanningStep(session.sessionId, closureStep);
    manager.addPlanningStep(session.sessionId, proximityStep);
    manager.addPlanningStep(session.sessionId, continuityStep);

    const plan: ExecutionPlan = {
      planId: randomUUID(),
      specId: spec.metadata.specId,
      classifiedACs: figureGroundStep.classifiedACs,
      atomicTasks: closureStep.atomicTasks,
      taskGroups: proximityStep.taskGroups,
      dagValidation: continuityStep.dagValidation,
      createdAt: new Date().toISOString(),
    };
    manager.completePlan(session.sessionId, plan);
    manager.startExecution(session.sessionId);

    const result: TaskExecutionResult = {
      taskId: 'task-0',
      status: 'completed',
      output: 'Setup done with TypeScript config',
      artifacts: ['tsconfig.json', 'package.json'],
    };
    manager.addTaskResult(session.sessionId, result);

    const reconstructed = repo.reconstruct(session.sessionId);

    expect(reconstructed!.status).toBe('executing');
    expect(reconstructed!.taskResults).toHaveLength(1);
    expect(reconstructed!.taskResults[0]!.taskId).toBe('task-0');
    expect(reconstructed!.taskResults[0]!.output).toBe('Setup done with TypeScript config');
    expect(reconstructed!.taskResults[0]!.artifacts).toEqual(['tsconfig.json', 'package.json']);
  });

  it('reconstructs completed session with evaluation', () => {
    const spec = createTestSpec();
    const session = manager.create(spec);
    manager.addPlanningStep(session.sessionId, figureGroundStep);
    manager.addPlanningStep(session.sessionId, closureStep);
    manager.addPlanningStep(session.sessionId, proximityStep);
    manager.addPlanningStep(session.sessionId, continuityStep);

    const plan: ExecutionPlan = {
      planId: randomUUID(),
      specId: spec.metadata.specId,
      classifiedACs: figureGroundStep.classifiedACs,
      atomicTasks: closureStep.atomicTasks,
      taskGroups: proximityStep.taskGroups,
      dagValidation: continuityStep.dagValidation,
      createdAt: new Date().toISOString(),
    };
    manager.completePlan(session.sessionId, plan);
    manager.startExecution(session.sessionId);
    manager.addTaskResult(session.sessionId, {
      taskId: 'task-0',
      status: 'completed',
      output: 'Done',
      artifacts: [],
    });
    manager.addTaskResult(session.sessionId, {
      taskId: 'task-1',
      status: 'completed',
      output: 'Done',
      artifacts: [],
    });
    manager.addTaskResult(session.sessionId, {
      taskId: 'task-2',
      status: 'completed',
      output: 'Done',
      artifacts: [],
    });

    const evaluation: EvaluationResult = {
      verifications: [
        { acIndex: 0, satisfied: true, evidence: 'All good', gaps: [] },
        { acIndex: 1, satisfied: true, evidence: 'All good', gaps: [] },
        { acIndex: 2, satisfied: false, evidence: 'Partial', gaps: ['Missing polish'] },
      ],
      overallScore: 0.85,
      goalAlignment: 0.9,
      recommendations: ['Add more polish'],
    };
    manager.completeEvaluation(session.sessionId, evaluation);

    const reconstructed = repo.reconstruct(session.sessionId);

    expect(reconstructed!.status).toBe('completed');
    expect(reconstructed!.evaluationResult).toBeDefined();
    expect(reconstructed!.evaluationResult!.overallScore).toBe(0.85);
    expect(reconstructed!.evaluationResult!.verifications).toHaveLength(3);
    expect(reconstructed!.evaluationResult!.recommendations).toEqual(['Add more polish']);
  });

  it('lists all session IDs', () => {
    manager.create(createTestSpec());
    manager.create(createTestSpec());

    const ids = repo.list();
    expect(ids).toHaveLength(2);
  });

  it('reconstructs all sessions', () => {
    manager.create(createTestSpec());
    manager.create(createTestSpec());

    const sessions = repo.reconstructAll();
    expect(sessions).toHaveLength(2);
  });

  it('reconstructs from a fresh EventStore (simulates restart)', () => {
    const spec = createTestSpec();
    const session = manager.create(spec);
    manager.addPlanningStep(session.sessionId, figureGroundStep);
    manager.addPlanningStep(session.sessionId, closureStep);
    manager.addPlanningStep(session.sessionId, proximityStep);
    manager.addPlanningStep(session.sessionId, continuityStep);

    const plan: ExecutionPlan = {
      planId: randomUUID(),
      specId: spec.metadata.specId,
      classifiedACs: figureGroundStep.classifiedACs,
      atomicTasks: closureStep.atomicTasks,
      taskGroups: proximityStep.taskGroups,
      dagValidation: continuityStep.dagValidation,
      createdAt: new Date().toISOString(),
    };
    manager.completePlan(session.sessionId, plan);
    manager.startExecution(session.sessionId);
    manager.addTaskResult(session.sessionId, {
      taskId: 'task-0',
      status: 'completed',
      output: 'Persisted output',
      artifacts: ['file.ts'],
    });

    // Simulate restart
    store.close();
    const newStore = new EventStore(dbPath);
    const newRepo = new ExecuteSessionRepository(newStore);

    const reconstructed = newRepo.reconstruct(session.sessionId);

    expect(reconstructed).not.toBeNull();
    expect(reconstructed!.spec.goal).toBe('Test goal');
    expect(reconstructed!.planningSteps).toHaveLength(4);
    expect(reconstructed!.executionPlan).toBeDefined();
    expect(reconstructed!.status).toBe('executing');
    expect(reconstructed!.taskResults).toHaveLength(1);
    expect(reconstructed!.taskResults[0]!.output).toBe('Persisted output');
    expect(reconstructed!.taskResults[0]!.artifacts).toEqual(['file.ts']);

    newStore.close();
  });

  it('ExecuteSessionManager.loadFromStore() restores sessions into memory', () => {
    const spec = createTestSpec();
    const session = manager.create(spec);
    manager.addPlanningStep(session.sessionId, figureGroundStep);

    // Simulate restart
    store.close();
    const newStore = new EventStore(dbPath);
    const newManager = new ExecuteSessionManager(newStore);
    newManager.loadFromStore();

    const restored = newManager.get(session.sessionId);
    expect(restored.specId).toBe(spec.metadata.specId);
    expect(restored.planningSteps).toHaveLength(1);
    expect(restored.spec.goal).toBe('Test goal');

    newStore.close();
  });

  it('handles failed session reconstruction', () => {
    const spec = createTestSpec();
    const session = manager.create(spec);
    manager.fail(session.sessionId, 'Something went wrong');

    const reconstructed = repo.reconstruct(session.sessionId);

    expect(reconstructed!.status).toBe('failed');
  });
});
