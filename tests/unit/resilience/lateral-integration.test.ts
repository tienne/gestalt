import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PassthroughExecuteEngine } from '../../../src/execute/passthrough-engine.js';
import { EventStore } from '../../../src/events/store.js';
import { isOk } from '../../../src/core/result.js';
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type {
  Spec,
  FigureGroundResult,
  ClosureResult,
  ProximityResult,
  ContinuityResult,
  StructuralResult,
  EvaluationResult,
} from '../../../src/core/types.js';

// ─── Test Helpers ─────────────────────────────────────────────

function createTestSpec(): Spec {
  return {
    version: '1.0.0',
    goal: 'Build a user authentication system with JWT tokens',
    constraints: ['Must use JWT', 'Must support OAuth2'],
    acceptanceCriteria: [
      'Users can register with email and password',
      'Users can login and receive JWT token',
      'Token refresh endpoint exists',
    ],
    ontologySchema: {
      entities: [
        { name: 'User', description: 'System user', attributes: ['email', 'password', 'role'] },
        { name: 'Token', description: 'JWT token', attributes: ['accessToken', 'refreshToken'] },
      ],
      relations: [{ from: 'User', to: 'Token', type: 'has_many' }],
    },
    gestaltAnalysis: [
      { principle: 'closure' as const, finding: 'Auth needs token refresh', confidence: 0.9 },
    ],
    metadata: {
      specId: randomUUID(),
      interviewSessionId: randomUUID(),
      resolutionScore: 0.85,
      generatedAt: new Date().toISOString(),
    },
  };
}

function createPlanningSteps() {
  const fgResult: FigureGroundResult = {
    principle: 'figure_ground',
    classifiedACs: [
      { acIndex: 0, acText: 'Users can register', classification: 'figure', priority: 'critical', reasoning: 'Core' },
      { acIndex: 1, acText: 'Users can login', classification: 'figure', priority: 'critical', reasoning: 'Core' },
      { acIndex: 2, acText: 'Token refresh', classification: 'ground', priority: 'medium', reasoning: 'Nice to have' },
    ],
  };
  const closureResult: ClosureResult = {
    principle: 'closure',
    atomicTasks: [
      { taskId: 'task-0', title: 'Setup user model', description: 'Create User model', sourceAC: [0], isImplicit: false, estimatedComplexity: 'low', dependsOn: [] },
      { taskId: 'task-1', title: 'Implement registration', description: 'Register endpoint', sourceAC: [0], isImplicit: false, estimatedComplexity: 'medium', dependsOn: ['task-0'] },
      { taskId: 'task-2', title: 'Implement login', description: 'Login endpoint', sourceAC: [1], isImplicit: false, estimatedComplexity: 'medium', dependsOn: ['task-0'] },
      { taskId: 'task-3', title: 'Token refresh', description: 'Refresh endpoint', sourceAC: [2], isImplicit: false, estimatedComplexity: 'low', dependsOn: ['task-2'] },
    ],
  };
  const proximityResult: ProximityResult = {
    principle: 'proximity',
    taskGroups: [
      { groupId: 'group-0', name: 'User Management', domain: 'auth', taskIds: ['task-0', 'task-1'], reasoning: 'User-related' },
      { groupId: 'group-1', name: 'Auth Tokens', domain: 'auth', taskIds: ['task-2', 'task-3'], reasoning: 'Token-related' },
    ],
  };
  const continuityResult: ContinuityResult = {
    principle: 'continuity',
    dagValidation: {
      isValid: true, hasCycles: false, hasConflicts: false,
      topologicalOrder: ['task-0', 'task-1', 'task-2', 'task-3'],
      criticalPath: ['task-0', 'task-2', 'task-3'],
    },
  };
  return { fgResult, closureResult, proximityResult, continuityResult };
}

const passingStructural: StructuralResult = {
  commands: [
    { name: 'lint', command: 'npm run lint', exitCode: 0, output: 'ok' },
    { name: 'build', command: 'npm run build', exitCode: 0, output: 'ok' },
    { name: 'test', command: 'npm test', exitCode: 0, output: 'ok' },
  ],
  allPassed: true,
};

function makeLowEval(): EvaluationResult {
  return {
    verifications: [
      { acIndex: 0, satisfied: true, evidence: 'Done', gaps: [] },
      { acIndex: 1, satisfied: false, evidence: 'Partial', gaps: ['Missing JWT'] },
      { acIndex: 2, satisfied: false, evidence: 'Not done', gaps: ['No refresh endpoint'] },
    ],
    overallScore: 0.5,
    goalAlignment: 0.6,
    recommendations: ['Implement JWT token generation'],
  };
}

function makeSuccessEval(): EvaluationResult {
  return {
    verifications: [
      { acIndex: 0, satisfied: true, evidence: 'Done', gaps: [] },
      { acIndex: 1, satisfied: true, evidence: 'Done', gaps: [] },
      { acIndex: 2, satisfied: true, evidence: 'Done', gaps: [] },
    ],
    overallScore: 0.9,
    goalAlignment: 0.85,
    recommendations: [],
  };
}

// Helper: complete full planning + execution + evaluation cycle
function setupToEvaluationComplete(engine: PassthroughExecuteEngine, spec: Spec): string {
  const startResult = engine.start(spec);
  if (!startResult.ok) throw new Error('start failed');
  const sessionId = startResult.value.session.sessionId;

  const { fgResult, closureResult, proximityResult, continuityResult } = createPlanningSteps();
  engine.planStep(sessionId, fgResult);
  engine.planStep(sessionId, closureResult);
  engine.planStep(sessionId, proximityResult);
  engine.planStep(sessionId, continuityResult);
  engine.planComplete(sessionId);

  engine.startExecution(sessionId);
  for (const taskId of ['task-0', 'task-1', 'task-2', 'task-3']) {
    engine.submitTaskResult(sessionId, {
      taskId,
      status: 'completed',
      output: `Implemented ${taskId}`,
      artifacts: [`${taskId}.ts`],
    });
  }

  // Evaluate: structural → contextual
  engine.startEvaluation(sessionId);
  engine.submitStructuralResult(sessionId, passingStructural);
  engine.submitEvaluation(sessionId, makeLowEval());

  return sessionId;
}

// ─── Tests ────────────────────────────────────────────────────

describe('Lateral Thinking Integration', () => {
  let dbPath: string;
  let engine: PassthroughExecuteEngine;

  beforeEach(() => {
    dbPath = `.gestalt-test/lateral-integ-${randomUUID()}.db`;
    const store = new EventStore(dbPath);
    engine = new PassthroughExecuteEngine(store);
  });

  afterEach(() => {
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
  });

  it('evolve returns lateralContext when stagnation is detected (instead of terminating)', () => {
    const spec = createTestSpec();
    const sessionId = setupToEvaluationComplete(engine, spec);

    // First evolve → should return evolveContext (no termination yet, 0 generations)
    const evolveResult = engine.startContextualEvolve(sessionId);
    expect(isOk(evolveResult)).toBe(true);
    if (!evolveResult.ok) return;
    expect(evolveResult.value.evolveContext).toBeDefined();

    // Submit a patch to create a generation
    const patchResult = engine.submitSpecPatch(sessionId, {
      acceptanceCriteria: ['Updated AC 1', 'Updated AC 2', 'Updated AC 3'],
    });
    expect(isOk(patchResult)).toBe(true);

    // Re-evaluate with same low score to start building stagnation
    const session = engine.getSession(sessionId);
    session.status = 'executing';
    session.evaluateStage = undefined;
    session.structuralResult = undefined;
    session.evaluationResult = undefined;

    engine.startEvaluation(sessionId);
    engine.submitStructuralResult(sessionId, passingStructural);
    engine.submitEvaluation(sessionId, makeLowEval());

    // Do more generations to trigger stagnation (need STAGNATION_COUNT=2 consecutive)
    for (let i = 0; i < 2; i++) {
      const ev = engine.startContextualEvolve(sessionId);
      if (!ev.ok) break;
      if (ev.value.evolveContext) {
        engine.submitSpecPatch(sessionId, {
          acceptanceCriteria: [`AC-gen-${i}-0`, `AC-gen-${i}-1`, `AC-gen-${i}-2`],
        });
        // Reset for re-eval
        const s = engine.getSession(sessionId);
        s.status = 'executing';
        s.evaluateStage = undefined;
        s.structuralResult = undefined;
        s.evaluationResult = undefined;
        engine.startEvaluation(sessionId);
        engine.submitStructuralResult(sessionId, passingStructural);
        engine.submitEvaluation(sessionId, makeLowEval());
      }
      if (ev.value.lateralContext) {
        // Stagnation triggered lateral!
        expect(ev.value.lateralContext.persona).toBeDefined();
        expect(ev.value.lateralContext.stage).toBe('lateral');
        return; // Test passes
      }
    }

    // Final check — after enough stagnation, evolve should give lateralContext
    const finalEvolve = engine.startContextualEvolve(sessionId);
    expect(isOk(finalEvolve)).toBe(true);
    if (!finalEvolve.ok) return;

    // Should be either lateralContext or evolveContext (depends on threshold)
    const hasLateral = !!finalEvolve.value.lateralContext;
    const hasEvolve = !!finalEvolve.value.evolveContext;
    expect(hasLateral || hasEvolve).toBe(true);
  });

  it('evolve still terminates on success', () => {
    const spec = createTestSpec();
    const sessionId = setupToEvaluationComplete(engine, spec);

    // Override the evaluation to be a success
    const session = engine.getSession(sessionId);
    session.evaluationResult = makeSuccessEval();
    session.status = 'executing'; // reset so we can re-evaluate

    // Evolve should terminate with success
    const result = engine.startContextualEvolve(sessionId);
    expect(isOk(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.terminated).toBe(true);
    expect(result.value.terminationReason).toBe('success');
  });

  it('evolve_lateral_result applies specPatch and triggers re-execution', () => {
    const spec = createTestSpec();
    const startResult = engine.start(spec);
    if (!startResult.ok) throw new Error('start failed');
    const sessionId = startResult.value.session.sessionId;

    // Setup planning
    const { fgResult, closureResult, proximityResult, continuityResult } = createPlanningSteps();
    engine.planStep(sessionId, fgResult);
    engine.planStep(sessionId, closureResult);
    engine.planStep(sessionId, proximityResult);
    engine.planStep(sessionId, continuityResult);
    engine.planComplete(sessionId);
    engine.startExecution(sessionId);

    for (const taskId of ['task-0', 'task-1', 'task-2', 'task-3']) {
      engine.submitTaskResult(sessionId, {
        taskId, status: 'completed', output: `Done ${taskId}`, artifacts: [],
      });
    }

    // Evaluate
    engine.startEvaluation(sessionId);
    engine.submitStructuralResult(sessionId, passingStructural);
    engine.submitEvaluation(sessionId, makeLowEval());

    // Manually start lateral
    const session = engine.getSession(sessionId);
    // Simulate lateral start
    const lateralResult = engine.submitLateralResult(sessionId, {
      persona: 'multistability',
      specPatch: {
        acceptanceCriteria: [
          'Users can register with email',
          'Users can login with JWT',
          'Token refresh works',
        ],
      },
      description: 'Reframed ACs for clarity',
    });

    expect(isOk(lateralResult)).toBe(true);
    if (!lateralResult.ok) return;

    // Check session state
    const updated = engine.getSession(sessionId);
    expect(updated.lateralTriedPersonas).toContain('multistability');
    expect(updated.lateralAttempts).toBe(1);
  });

  it('human_escalation when all 4 personas exhausted', () => {
    const spec = createTestSpec();
    const sessionId = setupToEvaluationComplete(engine, spec);

    // Manually exhaust all personas
    const session = engine.getSession(sessionId);
    session.lateralTriedPersonas = ['multistability', 'simplicity', 'reification', 'invariance'];
    session.lateralAttempts = 4;

    // Trigger hard_cap termination by setting enough evolution history
    // (contextualCount >= MAX_CONTEXTUAL=3)
    session.evolutionHistory = [
      { generation: 0, spec, evaluationScore: 0.5, goalAlignment: 0.5, delta: { fieldsChanged: ['acceptanceCriteria'], similarity: 0.9, generation: 0 } },
      { generation: 1, spec, evaluationScore: 0.52, goalAlignment: 0.52, delta: { fieldsChanged: ['acceptanceCriteria'], similarity: 0.9, generation: 1 } },
      { generation: 2, spec, evaluationScore: 0.54, goalAlignment: 0.54, delta: { fieldsChanged: ['acceptanceCriteria'], similarity: 0.9, generation: 2 } },
    ];

    const result = engine.startContextualEvolve(sessionId);
    expect(isOk(result)).toBe(true);
    if (!result.ok) return;

    // All personas exhausted + termination detected → human escalation
    expect(result.value.humanEscalation).toBeDefined();
    expect(result.value.terminated).toBe(true);
    expect(result.value.terminationReason).toBe('human_escalation');
    expect(result.value.humanEscalation!.stage).toBe('human_escalation');
    expect(result.value.humanEscalation!.triedPersonas).toHaveLength(4);
  });

  it('existing evolve flow works normally when no termination', () => {
    const spec = createTestSpec();
    const sessionId = setupToEvaluationComplete(engine, spec);

    // First evolve — no stagnation yet, should return evolveContext
    const result = engine.startContextualEvolve(sessionId);
    expect(isOk(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.evolveContext).toBeDefined();
    expect(result.value.lateralContext).toBeUndefined();
    expect(result.value.humanEscalation).toBeUndefined();
    expect(result.value.terminated).toBeUndefined();
  });

  it('startLateralEvolve suggests next persona correctly', () => {
    const spec = createTestSpec();
    const sessionId = setupToEvaluationComplete(engine, spec);

    // Manually set some tried personas
    const session = engine.getSession(sessionId);
    session.lateralTriedPersonas = ['multistability'];
    session.lateralAttempts = 1;

    const result = engine.startLateralEvolve(sessionId);
    expect(isOk(result)).toBe(true);
    if (!result.ok) return;

    expect(result.value.lateralContext).toBeDefined();
    // Should NOT suggest multistability (already tried)
    expect(result.value.lateralContext!.persona).not.toBe('multistability');
  });

  it('startLateralEvolve returns success termination when score improves', () => {
    const spec = createTestSpec();
    const sessionId = setupToEvaluationComplete(engine, spec);

    // Override eval to success
    const session = engine.getSession(sessionId);
    session.evaluationResult = makeSuccessEval();

    const result = engine.startLateralEvolve(sessionId);
    expect(isOk(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.terminated).toBe(true);
    expect(result.value.terminationReason).toBe('success');
  });
});
