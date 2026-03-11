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

describe('PassthroughExecuteEngine', () => {
  let store: EventStore;
  let engine: PassthroughExecuteEngine;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/execute-pt-${randomUUID()}.db`;
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

  describe('start', () => {
    it('creates session and returns Figure-Ground context', () => {
      const seed = createTestSeed();
      const result = engine.start(seed);
      expect(isOk(result)).toBe(true);

      if (result.ok) {
        const { session, executeContext } = result.value;
        expect(session.status).toBe('planning');
        expect(session.seedId).toBe(seed.metadata.seedId);
        expect(session.currentStep).toBe(1);
        expect(session.planningSteps).toHaveLength(0);
        expect(executeContext.systemPrompt).toContain('Gestalt');
        expect(executeContext.currentPrinciple).toBe('figure_ground');
        expect(executeContext.stepNumber).toBe(1);
        expect(executeContext.totalSteps).toBe(4);
        expect(executeContext.phase).toBe('planning');
        expect(executeContext.planningPrompt).toContain('Figure-Ground');
      }
    });
  });

  describe('planStep', () => {
    it('accepts Figure-Ground result and returns Closure context', () => {
      const seed = createTestSeed();
      const startResult = engine.start(seed);
      if (!startResult.ok) return;

      const { sessionId } = startResult.value.session;
      const result = engine.planStep(sessionId, createFigureGroundResult());
      expect(isOk(result)).toBe(true);

      if (result.ok) {
        expect(result.value.isLastStep).toBe(false);
        expect(result.value.executeContext).toBeDefined();
        expect(result.value.executeContext!.currentPrinciple).toBe('closure');
        expect(result.value.executeContext!.stepNumber).toBe(2);
        expect(result.value.session.planningSteps).toHaveLength(1);
      }
    });

    it('accepts Closure result and returns Proximity context', () => {
      const seed = createTestSeed();
      const startResult = engine.start(seed);
      if (!startResult.ok) return;

      const { sessionId } = startResult.value.session;
      engine.planStep(sessionId, createFigureGroundResult());

      const result = engine.planStep(sessionId, createClosureResult());
      expect(isOk(result)).toBe(true);

      if (result.ok) {
        expect(result.value.isLastStep).toBe(false);
        expect(result.value.executeContext!.currentPrinciple).toBe('proximity');
        expect(result.value.executeContext!.stepNumber).toBe(3);
      }
    });

    it('accepts Proximity result and returns Continuity context', () => {
      const seed = createTestSeed();
      const startResult = engine.start(seed);
      if (!startResult.ok) return;

      const { sessionId } = startResult.value.session;
      engine.planStep(sessionId, createFigureGroundResult());
      engine.planStep(sessionId, createClosureResult());

      const result = engine.planStep(sessionId, createProximityResult());
      expect(isOk(result)).toBe(true);

      if (result.ok) {
        expect(result.value.isLastStep).toBe(false);
        expect(result.value.executeContext!.currentPrinciple).toBe('continuity');
        expect(result.value.executeContext!.stepNumber).toBe(4);
      }
    });

    it('accepts Continuity result and signals last step', () => {
      const seed = createTestSeed();
      const startResult = engine.start(seed);
      if (!startResult.ok) return;

      const { sessionId } = startResult.value.session;
      engine.planStep(sessionId, createFigureGroundResult());
      engine.planStep(sessionId, createClosureResult());
      engine.planStep(sessionId, createProximityResult());

      const result = engine.planStep(sessionId, createContinuityResult());
      expect(isOk(result)).toBe(true);

      if (result.ok) {
        expect(result.value.isLastStep).toBe(true);
        expect(result.value.executeContext).toBeUndefined();
        expect(result.value.session.planningSteps).toHaveLength(4);
      }
    });

    it('rejects wrong principle order', () => {
      const seed = createTestSeed();
      const startResult = engine.start(seed);
      if (!startResult.ok) return;

      const { sessionId } = startResult.value.session;
      const result = engine.planStep(sessionId, createClosureResult());
      expect(isErr(result)).toBe(true);

      if (!result.ok) {
        expect(result.error.message).toContain('Expected principle "figure_ground"');
      }
    });

    it('rejects Figure-Ground with missing AC', () => {
      const seed = createTestSeed();
      const startResult = engine.start(seed);
      if (!startResult.ok) return;

      const { sessionId } = startResult.value.session;
      const badResult: FigureGroundResult = {
        principle: 'figure_ground',
        classifiedACs: [
          { acIndex: 0, acText: 'AC 0', classification: 'figure', priority: 'critical', reasoning: 'test' },
          // Missing indices 1, 2, 3
        ],
      };

      const result = engine.planStep(sessionId, badResult);
      expect(isErr(result)).toBe(true);
    });

    it('rejects Closure with duplicate taskId', () => {
      const seed = createTestSeed();
      const startResult = engine.start(seed);
      if (!startResult.ok) return;

      const { sessionId } = startResult.value.session;
      engine.planStep(sessionId, createFigureGroundResult());

      const badClosure: ClosureResult = {
        principle: 'closure',
        atomicTasks: [
          { taskId: 'task-0', title: 'A', description: 'A', sourceAC: [0], isImplicit: false, estimatedComplexity: 'low', dependsOn: [] },
          { taskId: 'task-0', title: 'B', description: 'B', sourceAC: [1], isImplicit: false, estimatedComplexity: 'low', dependsOn: [] },
        ],
      };

      const result = engine.planStep(sessionId, badClosure);
      expect(isErr(result)).toBe(true);
      if (!result.ok) {
        expect(result.error.message).toContain('Duplicate taskId');
      }
    });

    it('rejects Proximity with task not in any group', () => {
      const seed = createTestSeed();
      const startResult = engine.start(seed);
      if (!startResult.ok) return;

      const { sessionId } = startResult.value.session;
      engine.planStep(sessionId, createFigureGroundResult());
      engine.planStep(sessionId, createClosureResult());

      const badProximity: ProximityResult = {
        principle: 'proximity',
        taskGroups: [
          { groupId: 'g-0', name: 'Partial', domain: 'test', taskIds: ['task-0', 'task-1'], reasoning: 'test' },
          // Missing task-2, task-3, task-4, task-5
        ],
      };

      const result = engine.planStep(sessionId, badProximity);
      expect(isErr(result)).toBe(true);
    });

    it('returns error for nonexistent session', () => {
      const result = engine.planStep('nonexistent', createFigureGroundResult());
      expect(isErr(result)).toBe(true);
    });
  });

  describe('planComplete', () => {
    it('assembles ExecutionPlan after all 4 steps', () => {
      const seed = createTestSeed();
      const startResult = engine.start(seed);
      if (!startResult.ok) return;

      const { sessionId } = startResult.value.session;
      engine.planStep(sessionId, createFigureGroundResult());
      engine.planStep(sessionId, createClosureResult());
      engine.planStep(sessionId, createProximityResult());
      engine.planStep(sessionId, createContinuityResult());

      const result = engine.planComplete(sessionId);
      expect(isOk(result)).toBe(true);

      if (result.ok) {
        const { executionPlan, session } = result.value;
        expect(session.status).toBe('plan_complete');
        expect(executionPlan.planId).toBeDefined();
        expect(executionPlan.seedId).toBe(seed.metadata.seedId);
        expect(executionPlan.classifiedACs).toHaveLength(4);
        expect(executionPlan.atomicTasks).toHaveLength(6);
        expect(executionPlan.taskGroups).toHaveLength(3);
        expect(executionPlan.dagValidation.isValid).toBe(true);
        expect(executionPlan.dagValidation.topologicalOrder.length).toBe(6);
      }
    });

    it('rejects planComplete before all steps', () => {
      const seed = createTestSeed();
      const startResult = engine.start(seed);
      if (!startResult.ok) return;

      const { sessionId } = startResult.value.session;
      engine.planStep(sessionId, createFigureGroundResult());

      const result = engine.planComplete(sessionId);
      expect(isErr(result)).toBe(true);
      if (!result.ok) {
        expect(result.error.message).toContain('not complete');
      }
    });
  });

  describe('session management', () => {
    it('lists sessions', () => {
      engine.start(createTestSeed());
      engine.start(createTestSeed());

      const sessions = engine.listSessions();
      expect(sessions).toHaveLength(2);
    });

    it('gets session by ID', () => {
      const startResult = engine.start(createTestSeed());
      if (!startResult.ok) return;

      const session = engine.getSession(startResult.value.session.sessionId);
      expect(session).toBeDefined();
      expect(session.status).toBe('planning');
    });

    it('throws for nonexistent session', () => {
      expect(() => engine.getSession('nonexistent')).toThrow();
    });
  });

  describe('full flow', () => {
    it('completes the entire planning pipeline', () => {
      const seed = createTestSeed();

      // Step 1: Start
      const startResult = engine.start(seed);
      expect(isOk(startResult)).toBe(true);
      if (!startResult.ok) return;
      const { sessionId } = startResult.value.session;

      // Step 2: Figure-Ground
      const fgResult = engine.planStep(sessionId, createFigureGroundResult());
      expect(isOk(fgResult)).toBe(true);
      if (!fgResult.ok) return;
      expect(fgResult.value.isLastStep).toBe(false);

      // Step 3: Closure
      const closureResult = engine.planStep(sessionId, createClosureResult());
      expect(isOk(closureResult)).toBe(true);
      if (!closureResult.ok) return;
      expect(closureResult.value.isLastStep).toBe(false);

      // Step 4: Proximity
      const proximityResult = engine.planStep(sessionId, createProximityResult());
      expect(isOk(proximityResult)).toBe(true);
      if (!proximityResult.ok) return;
      expect(proximityResult.value.isLastStep).toBe(false);

      // Step 5: Continuity
      const continuityResult = engine.planStep(sessionId, createContinuityResult());
      expect(isOk(continuityResult)).toBe(true);
      if (!continuityResult.ok) return;
      expect(continuityResult.value.isLastStep).toBe(true);

      // Step 6: Plan Complete
      const planResult = engine.planComplete(sessionId);
      expect(isOk(planResult)).toBe(true);
      if (!planResult.ok) return;

      expect(planResult.value.session.status).toBe('plan_complete');
      expect(planResult.value.executionPlan.dagValidation.isValid).toBe(true);
      expect(planResult.value.executionPlan.atomicTasks).toHaveLength(6);
    });
  });
});
