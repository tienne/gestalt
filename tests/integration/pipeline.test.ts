import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PassthroughEngine } from '../../src/interview/passthrough-engine.js';
import { PassthroughSpecGenerator } from '../../src/spec/passthrough-generator.js';
import { PassthroughExecuteEngine } from '../../src/execute/passthrough-engine.js';
import { EventStore } from '../../src/events/store.js';
import { isOk } from '../../src/core/result.js';
import type {
  ExternalResolutionScore,
} from '../../src/interview/passthrough-engine.js';
import type { ExternalSpec } from '../../src/spec/passthrough-generator.js';
import type {
  Spec,
  FigureGroundResult,
  ClosureResult,
  ProximityResult,
  ContinuityResult,
} from '../../src/core/types.js';

// ─── Helpers (mirrors tests/unit/execute/passthrough-engine.test.ts) ───

const HIGH_SCORE: ExternalResolutionScore = {
  goalClarity: 0.9,
  constraintClarity: 0.85,
  successCriteria: 0.9,
  priorityClarity: 0.85,
  contextClarity: 0.8,
  contradictions: [],
};

function createExternalSpec(): ExternalSpec {
  return {
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
        principle: 'closure',
        finding: 'Password reset flow needs email service',
        confidence: 0.9,
      },
    ],
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

// ─── e2e: interview → spec → execute ─────────────────────────────

describe('pipeline integration (passthrough)', () => {
  let store: EventStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/integration-${randomUUID()}.db`;
    store = new EventStore(dbPath);
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

  it('runs the full interview → spec → execute pipeline', () => {
    // ── Phase 1: Interview ──
    const interview = new PassthroughEngine(store);

    const startResult = interview.start('user authentication system');
    expect(isOk(startResult)).toBe(true);
    if (!startResult.ok) return;

    const { sessionId } = startResult.value.session;
    expect(startResult.value.gestaltContext).toBeDefined();
    expect(startResult.value.session.status).toBe('in_progress');

    // 3 rounds of respond, final round carries a high resolution score
    const r1 = interview.respond(
      sessionId,
      'Goal: secure auth with email/password and Google OAuth2.',
      'What is the core goal of this system?',
    );
    expect(isOk(r1)).toBe(true);

    const r2 = interview.respond(
      sessionId,
      'Constraints: JWT for sessions, OAuth2 for social login.',
      'What technical constraints must be satisfied?',
    );
    expect(isOk(r2)).toBe(true);

    const r3 = interview.respond(
      sessionId,
      'Success: register, login with JWT, reset password, Google OAuth all working.',
      'How will you know it succeeds?',
      HIGH_SCORE,
    );
    expect(isOk(r3)).toBe(true);
    if (!r3.ok) return;
    expect(r3.value.resolutionScore).not.toBeNull();
    expect(r3.value.resolutionScore!.overall).toBeGreaterThanOrEqual(0.8);

    // score (idempotent re-check using external score)
    const scoreResult = interview.score(sessionId, HIGH_SCORE);
    expect(isOk(scoreResult)).toBe(true);
    if (!scoreResult.ok) return;
    expect(scoreResult.value.resolutionScore!.overall).toBeGreaterThanOrEqual(0.8);

    // complete
    const completeResult = interview.complete(sessionId);
    expect(isOk(completeResult)).toBe(true);
    if (!completeResult.ok) return;
    const completedSession = completeResult.value;
    expect(completedSession.status).toBe('completed');

    // ── Phase 2: Spec ──
    const specGen = new PassthroughSpecGenerator(store);
    const specContext = specGen.buildSpecContext(completedSession);
    expect(specContext.systemPrompt).toBeTruthy();
    expect(specContext.specPrompt).toBeTruthy();

    const specResult = specGen.validateAndStore(completedSession, createExternalSpec(), true);
    expect(isOk(specResult)).toBe(true);
    if (!specResult.ok) return;
    const spec: Spec = specResult.value;
    expect(spec.goal).toBe('Build a user authentication system');
    expect(spec.acceptanceCriteria).toHaveLength(4);
    expect(spec.metadata.specId).toBeTruthy();
    expect(spec.metadata.interviewSessionId).toBe(sessionId);

    // ── Phase 3: Execute (planning) ──
    const execute = new PassthroughExecuteEngine(store);

    const execStart = execute.start(spec);
    expect(isOk(execStart)).toBe(true);
    if (!execStart.ok) return;
    const executeSessionId = execStart.value.session.sessionId;
    expect(execStart.value.session.status).toBe('planning');
    expect(execStart.value.executeContext.currentPrinciple).toBe('figure_ground');

    // 4 planning steps in Gestalt order
    const fg = execute.planStep(executeSessionId, createFigureGroundResult());
    expect(isOk(fg)).toBe(true);
    if (!fg.ok) return;
    expect(fg.value.executeContext!.currentPrinciple).toBe('closure');

    const closure = execute.planStep(executeSessionId, createClosureResult());
    expect(isOk(closure)).toBe(true);
    if (!closure.ok) return;
    expect(closure.value.executeContext!.currentPrinciple).toBe('proximity');

    const proximity = execute.planStep(executeSessionId, createProximityResult());
    expect(isOk(proximity)).toBe(true);
    if (!proximity.ok) return;
    expect(proximity.value.executeContext!.currentPrinciple).toBe('continuity');

    const continuity = execute.planStep(executeSessionId, createContinuityResult());
    expect(isOk(continuity)).toBe(true);
    if (!continuity.ok) return;
    expect(continuity.value.isLastStep).toBe(true);

    // plan_complete → ExecutionPlan
    const planComplete = execute.planComplete(executeSessionId);
    expect(isOk(planComplete)).toBe(true);
    if (!planComplete.ok) return;

    const { executionPlan, session: execSession } = planComplete.value;
    expect(execSession.status).toBe('plan_complete');
    expect(executionPlan.specId).toBe(spec.metadata.specId);
    expect(executionPlan.atomicTasks.length).toBeGreaterThan(0);
    expect(executionPlan.atomicTasks).toHaveLength(6);
    expect(executionPlan.dagValidation.isValid).toBe(true);
    expect(executionPlan.dagValidation.topologicalOrder).toHaveLength(6);
  });
});
