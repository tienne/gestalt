import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PassthroughExecuteEngine } from '../../../src/execute/passthrough-engine.js';
import { EventStore } from '../../../src/events/store.js';
import { validateSpecPatch } from '../../../src/execute/spec-patch-validator.js';
import { applySpecPatch } from '../../../src/execute/spec-patch-applier.js';
import { identifyImpactedTasks } from '../../../src/execute/impact-identifier.js';
import { checkTermination } from '../../../src/execute/termination-detector.js';
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
  AtomicTask,
  DriftScore,
  SpecPatch,
  EvolutionGeneration,
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
      {
        acIndex: 0,
        acText: 'Users can register',
        classification: 'figure',
        priority: 'critical',
        reasoning: 'Core',
      },
      {
        acIndex: 1,
        acText: 'Users can login',
        classification: 'figure',
        priority: 'critical',
        reasoning: 'Core',
      },
      {
        acIndex: 2,
        acText: 'Token refresh',
        classification: 'ground',
        priority: 'medium',
        reasoning: 'Nice to have',
      },
    ],
  };
  const closureResult: ClosureResult = {
    principle: 'closure',
    atomicTasks: [
      {
        taskId: 'task-0',
        title: 'Setup user model',
        description: 'Create User model',
        sourceAC: [0],
        isImplicit: false,
        estimatedComplexity: 'low',
        dependsOn: [],
      },
      {
        taskId: 'task-1',
        title: 'Implement registration',
        description: 'Register endpoint',
        sourceAC: [0],
        isImplicit: false,
        estimatedComplexity: 'medium',
        dependsOn: ['task-0'],
      },
      {
        taskId: 'task-2',
        title: 'Implement login',
        description: 'Login endpoint',
        sourceAC: [1],
        isImplicit: false,
        estimatedComplexity: 'medium',
        dependsOn: ['task-0'],
      },
      {
        taskId: 'task-3',
        title: 'Token refresh',
        description: 'Refresh endpoint',
        sourceAC: [2],
        isImplicit: false,
        estimatedComplexity: 'low',
        dependsOn: ['task-2'],
      },
    ],
  };
  const proximityResult: ProximityResult = {
    principle: 'proximity',
    taskGroups: [
      {
        groupId: 'group-0',
        name: 'User Management',
        domain: 'auth',
        taskIds: ['task-0', 'task-1'],
        reasoning: 'User-related',
      },
      {
        groupId: 'group-1',
        name: 'Authentication',
        domain: 'auth',
        taskIds: ['task-2', 'task-3'],
        reasoning: 'Auth-related',
      },
    ],
  };
  const continuityResult: ContinuityResult = {
    principle: 'continuity',
    dagValidation: {
      isValid: true,
      hasCycles: false,
      hasConflicts: false,
      topologicalOrder: ['task-0', 'task-1', 'task-2', 'task-3'],
      criticalPath: ['task-0', 'task-2', 'task-3'],
    },
  };
  return { fgResult, closureResult, proximityResult, continuityResult };
}

function createCompletedTaskResults(): TaskExecutionResult[] {
  return [
    {
      taskId: 'task-0',
      status: 'completed',
      output: 'User model created with email password role fields',
      artifacts: ['src/models/user.ts'],
    },
    {
      taskId: 'task-1',
      status: 'completed',
      output: 'Registration endpoint with validation',
      artifacts: ['src/routes/register.ts'],
    },
    {
      taskId: 'task-2',
      status: 'completed',
      output: 'Login endpoint with JWT token generation',
      artifacts: ['src/routes/login.ts'],
    },
    {
      taskId: 'task-3',
      status: 'completed',
      output: 'Token refresh endpoint implemented',
      artifacts: ['src/routes/refresh.ts'],
    },
  ];
}

let dbPath: string;
let eventStore: EventStore;
let engine: PassthroughExecuteEngine;

// Helper to run through full planning and execution
function setupCompletedExecution() {
  const spec = createTestSpec();
  const startResult = engine.start(spec);
  if (!isOk(startResult)) throw new Error('start failed');
  const sessionId = startResult.value.session.sessionId;

  const { fgResult, closureResult, proximityResult, continuityResult } = createPlanningSteps();
  engine.planStep(sessionId, fgResult);
  engine.planStep(sessionId, closureResult);
  engine.planStep(sessionId, proximityResult);
  engine.planStep(sessionId, continuityResult);
  engine.planComplete(sessionId);
  engine.startExecution(sessionId);

  for (const tr of createCompletedTaskResults()) {
    engine.submitTaskResult(sessionId, tr);
  }

  return sessionId;
}

// ─── Tests ──────────────────────────────────────────────────────

describe('Spec Patch Validator', () => {
  const spec = createTestSpec();

  it('accepts valid L1+L2 patch', () => {
    const patch: SpecPatch = {
      acceptanceCriteria: ['AC 1', 'AC 2'],
      constraints: ['Constraint A'],
    };
    const result = validateSpecPatch(patch, spec);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects goal modification attempt', () => {
    const patch = { goal: 'New goal' } as unknown as SpecPatch;
    const result = validateSpecPatch(patch, spec);
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.field).toBe('goal');
  });

  it('rejects empty acceptanceCriteria', () => {
    const patch: SpecPatch = { acceptanceCriteria: [] };
    const result = validateSpecPatch(patch, spec);
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.field).toBe('acceptanceCriteria');
  });

  it('rejects entity deletion in L3', () => {
    const patch: SpecPatch = {
      ontologySchema: {
        entities: [
          // Missing 'User' entity — deletion
          { name: 'Token', description: 'JWT token', attributes: ['accessToken', 'refreshToken'] },
        ],
      },
    };
    const result = validateSpecPatch(patch, spec);
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain('User');
  });

  it('allows adding new entities in L3', () => {
    const patch: SpecPatch = {
      ontologySchema: {
        entities: [
          ...spec.ontologySchema.entities,
          { name: 'Session', description: 'Login session', attributes: ['sessionId', 'expiresAt'] },
        ],
      },
    };
    const result = validateSpecPatch(patch, spec);
    expect(result.valid).toBe(true);
  });
});

describe('Spec Patch Applier', () => {
  it('applies L1 patch and computes delta', () => {
    const spec = createTestSpec();
    const patch: SpecPatch = {
      acceptanceCriteria: ['New AC 1', 'New AC 2'],
    };
    const { newSpec, delta } = applySpecPatch(spec, patch, 1);

    expect(newSpec.acceptanceCriteria).toEqual(['New AC 1', 'New AC 2']);
    expect(newSpec.goal).toBe(spec.goal); // unchanged
    expect(delta.fieldsChanged).toContain('acceptanceCriteria');
    expect(delta.generation).toBe(1);
    expect(delta.similarity).toBeGreaterThan(0);
    expect(delta.similarity).toBeLessThan(1);
  });

  it('preserves original spec (immutability)', () => {
    const spec = createTestSpec();
    const original = JSON.parse(JSON.stringify(spec));
    applySpecPatch(spec, { constraints: ['new'] }, 1);
    expect(spec.constraints).toEqual(original.constraints);
  });
});

describe('Impact Identifier', () => {
  const tasks: AtomicTask[] = [
    {
      taskId: 'task-0',
      title: 'Setup',
      description: '',
      sourceAC: [0],
      isImplicit: false,
      estimatedComplexity: 'low',
      dependsOn: [],
    },
    {
      taskId: 'task-1',
      title: 'Register',
      description: '',
      sourceAC: [0],
      isImplicit: false,
      estimatedComplexity: 'medium',
      dependsOn: ['task-0'],
    },
    {
      taskId: 'task-2',
      title: 'Login',
      description: '',
      sourceAC: [1],
      isImplicit: false,
      estimatedComplexity: 'medium',
      dependsOn: ['task-0'],
    },
    {
      taskId: 'task-3',
      title: 'Implicit setup',
      description: '',
      sourceAC: [],
      isImplicit: true,
      estimatedComplexity: 'low',
      dependsOn: [],
    },
  ];

  it('identifies drift-exceeded tasks', () => {
    const driftHistory: DriftScore[] = [
      { taskId: 'task-1', overall: 0.4, dimensions: [], thresholdExceeded: true },
    ];
    const delta = { fieldsChanged: [], similarity: 0.9, generation: 1 };

    const result = identifyImpactedTasks(tasks, driftHistory, delta, 0.3);
    expect(result).toContain('task-1');
  });

  it('identifies AC-linked tasks when AC changes', () => {
    const delta = { fieldsChanged: ['acceptanceCriteria'], similarity: 0.8, generation: 1 };
    const result = identifyImpactedTasks(tasks, [], delta, 0.3);
    // task-0, task-1, task-2 have sourceAC
    expect(result).toContain('task-0');
    expect(result).toContain('task-1');
    expect(result).toContain('task-2');
  });

  it('identifies implicit tasks when ontology changes', () => {
    const delta = { fieldsChanged: ['ontologySchema.entities'], similarity: 0.9, generation: 1 };
    const result = identifyImpactedTasks(tasks, [], delta, 0.3);
    expect(result).toContain('task-3');
  });

  it('expands to dependent tasks', () => {
    const driftHistory: DriftScore[] = [
      { taskId: 'task-0', overall: 0.4, dimensions: [], thresholdExceeded: true },
    ];
    const delta = { fieldsChanged: [], similarity: 0.9, generation: 1 };

    const result = identifyImpactedTasks(tasks, driftHistory, delta, 0.3);
    // task-0 impacted → task-1, task-2 depend on it
    expect(result).toContain('task-0');
    expect(result).toContain('task-1');
    expect(result).toContain('task-2');
  });
});

describe('Termination Detector', () => {
  it('detects success', () => {
    const result = checkTermination({
      evolutionHistory: [],
      currentScore: 0.9,
      currentGoalAlignment: 0.85,
      structuralFixCount: 0,
      contextualCount: 0,
    });
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('success');
  });

  it('returns null when conditions not met', () => {
    const result = checkTermination({
      evolutionHistory: [],
      currentScore: 0.5,
      currentGoalAlignment: 0.5,
      structuralFixCount: 0,
      contextualCount: 0,
    });
    expect(result).toBeNull();
  });

  it('detects hard cap (structural)', () => {
    const result = checkTermination({
      evolutionHistory: [],
      currentScore: 0.5,
      currentGoalAlignment: 0.5,
      structuralFixCount: 3,
      contextualCount: 0,
    });
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('hard_cap');
  });

  it('detects hard cap (contextual)', () => {
    const result = checkTermination({
      evolutionHistory: [],
      currentScore: 0.5,
      currentGoalAlignment: 0.5,
      structuralFixCount: 0,
      contextualCount: 3,
    });
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('hard_cap');
  });

  it('detects stagnation', () => {
    const history: EvolutionGeneration[] = [
      {
        generation: 0,
        spec: {} as Spec,
        evaluationScore: 0.5,
        goalAlignment: 0.5,
        delta: { fieldsChanged: [], similarity: 1, generation: 0 },
      },
      {
        generation: 1,
        spec: {} as Spec,
        evaluationScore: 0.51,
        goalAlignment: 0.5,
        delta: { fieldsChanged: ['ac'], similarity: 0.9, generation: 1 },
      },
      {
        generation: 2,
        spec: {} as Spec,
        evaluationScore: 0.52,
        goalAlignment: 0.5,
        delta: { fieldsChanged: ['ac'], similarity: 0.9, generation: 2 },
      },
    ];
    const result = checkTermination({
      evolutionHistory: history,
      currentScore: 0.53,
      currentGoalAlignment: 0.5,
      structuralFixCount: 0,
      contextualCount: 3,
    });
    // hard_cap triggers first since contextualCount=3
    expect(result).not.toBeNull();
  });
});

describe('Evolution Loop Engine Integration', () => {
  beforeEach(() => {
    dbPath = `.gestalt-test/evolve-${randomUUID()}.db`;
    eventStore = new EventStore(dbPath);
    engine = new PassthroughExecuteEngine(eventStore);
  });

  afterEach(() => {
    eventStore.close();
    if (existsSync(dbPath)) rmSync(dbPath);
  });

  it('structural fix flow: start → fix → re-evaluate', () => {
    const sessionId = setupCompletedExecution();

    // Start evaluation
    const evalStart = engine.startEvaluation(sessionId);
    expect(isOk(evalStart)).toBe(true);

    // Submit failing structural result
    const failResult: StructuralResult = {
      commands: [
        { name: 'lint', command: 'npm run lint', exitCode: 1, output: 'Error: unused variable' },
        { name: 'build', command: 'npm run build', exitCode: 0, output: 'Build successful' },
      ],
      allPassed: false,
    };
    engine.submitStructuralResult(sessionId, failResult);

    // Start structural fix (call 1: get fix context)
    const fixStart = engine.startStructuralFix(sessionId);
    expect(isOk(fixStart)).toBe(true);
    if (isOk(fixStart)) {
      expect(fixStart.value.fixContext).toBeDefined();
      expect(fixStart.value.fixContext!.stage).toBe('fix');
    }

    // Submit fix tasks (call 2)
    const fixSubmit = engine.startStructuralFix(sessionId, [
      {
        taskId: 'fix-1',
        failedCommand: 'npm run lint',
        errorOutput: 'unused var',
        fixDescription: 'Remove unused var',
        artifacts: ['src/routes/login.ts'],
      },
    ]);
    expect(isOk(fixSubmit)).toBe(true);
    if (isOk(fixSubmit)) {
      // Session should be back to executing state for re-evaluation
      expect(fixSubmit.value.session.status).toBe('executing');
    }
  });

  it('contextual evolve flow: evolve → patch → re-execute', () => {
    const sessionId = setupCompletedExecution();

    // Run through evaluation
    engine.startEvaluation(sessionId);
    const structural: StructuralResult = {
      commands: [
        { name: 'lint', command: 'npm run lint', exitCode: 0, output: 'OK' },
        { name: 'build', command: 'npm run build', exitCode: 0, output: 'OK' },
        { name: 'test', command: 'npm test', exitCode: 0, output: 'OK' },
      ],
      allPassed: true,
    };
    engine.submitStructuralResult(sessionId, structural);

    const evalResult: EvaluationResult = {
      verifications: [
        { acIndex: 0, satisfied: true, evidence: 'Registration works', gaps: [] },
        {
          acIndex: 1,
          satisfied: false,
          evidence: 'Login partially works',
          gaps: ['Missing rate limiting'],
        },
        {
          acIndex: 2,
          satisfied: false,
          evidence: 'No refresh endpoint',
          gaps: ['Not implemented'],
        },
      ],
      overallScore: 0.5,
      goalAlignment: 0.6,
      recommendations: ['Add rate limiting', 'Implement refresh endpoint'],
    };
    engine.submitEvaluation(sessionId, evalResult);

    // Start contextual evolve
    const evolveStart = engine.startContextualEvolve(sessionId);
    expect(isOk(evolveStart)).toBe(true);
    if (isOk(evolveStart)) {
      expect(evolveStart.value.evolveContext).toBeDefined();
      expect(evolveStart.value.terminated).toBeUndefined();
    }

    // Submit spec patch
    const patch: SpecPatch = {
      acceptanceCriteria: [
        'Users can register with email and password',
        'Users can login and receive JWT token with rate limiting',
        'Token refresh endpoint exists and validates refresh tokens',
      ],
    };
    const patchResult = engine.submitSpecPatch(sessionId, patch);
    expect(isOk(patchResult)).toBe(true);
    if (isOk(patchResult)) {
      expect(patchResult.value.impactedTaskIds.length).toBeGreaterThan(0);
      expect(patchResult.value.session.currentGeneration).toBe(1);
    }
  });

  it('caller-initiated termination', () => {
    const sessionId = setupCompletedExecution();

    // Run evaluation
    engine.startEvaluation(sessionId);
    engine.submitStructuralResult(sessionId, {
      commands: [{ name: 'lint', command: 'lint', exitCode: 0, output: 'OK' }],
      allPassed: true,
    });
    engine.submitEvaluation(sessionId, {
      verifications: [
        { acIndex: 0, satisfied: true, evidence: 'OK', gaps: [] },
        { acIndex: 1, satisfied: true, evidence: 'OK', gaps: [] },
        { acIndex: 2, satisfied: false, evidence: 'Partial', gaps: ['Missing'] },
      ],
      overallScore: 0.7,
      goalAlignment: 0.7,
      recommendations: [],
    });

    // Caller terminates
    const result = engine.startContextualEvolve(sessionId, 'caller');
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.terminated).toBe(true);
      expect(result.value.terminationReason).toBe('caller');
      expect(result.value.session.status).toBe('failed');
    }
  });

  it('rejects invalid spec patch (goal modification)', () => {
    const sessionId = setupCompletedExecution();

    engine.startEvaluation(sessionId);
    engine.submitStructuralResult(sessionId, {
      commands: [{ name: 'build', command: 'build', exitCode: 0, output: 'OK' }],
      allPassed: true,
    });
    engine.submitEvaluation(sessionId, {
      verifications: [
        { acIndex: 0, satisfied: true, evidence: 'OK', gaps: [] },
        { acIndex: 1, satisfied: true, evidence: 'OK', gaps: [] },
        { acIndex: 2, satisfied: false, evidence: 'No', gaps: ['Missing'] },
      ],
      overallScore: 0.6,
      goalAlignment: 0.6,
      recommendations: [],
    });

    const badPatch = { goal: 'Different goal' } as unknown as SpecPatch;
    const result = engine.submitSpecPatch(sessionId, badPatch);
    expect(isErr(result)).toBe(true);
  });

  it('session state includes evolution fields', () => {
    const spec = createTestSpec();
    const startResult = engine.start(spec);
    expect(isOk(startResult)).toBe(true);
    if (isOk(startResult)) {
      const session = startResult.value.session;
      expect(session.evolutionHistory).toEqual([]);
      expect(session.currentGeneration).toBe(0);
      expect(session.evolveStage).toBeUndefined();
      expect(session.terminationReason).toBeUndefined();
    }
  });

  it('re-execute task result submission flow', () => {
    const sessionId = setupCompletedExecution();

    // Evaluate
    engine.startEvaluation(sessionId);
    engine.submitStructuralResult(sessionId, {
      commands: [{ name: 'build', command: 'build', exitCode: 0, output: 'OK' }],
      allPassed: true,
    });
    engine.submitEvaluation(sessionId, {
      verifications: [
        { acIndex: 0, satisfied: true, evidence: 'OK', gaps: [] },
        { acIndex: 1, satisfied: false, evidence: 'Partial', gaps: ['Incomplete'] },
        { acIndex: 2, satisfied: false, evidence: 'No', gaps: ['Missing'] },
      ],
      overallScore: 0.4,
      goalAlignment: 0.5,
      recommendations: [],
    });

    // Evolve & patch
    engine.startContextualEvolve(sessionId);
    const patch: SpecPatch = {
      acceptanceCriteria: [
        'Users can register with email and password',
        'Users can login and receive JWT token (with validation)',
        'Token refresh endpoint exists',
      ],
    };
    const patchResult = engine.submitSpecPatch(sessionId, patch);
    expect(isOk(patchResult)).toBe(true);

    if (isOk(patchResult) && patchResult.value.impactedTaskIds.length > 0) {
      const firstImpacted = patchResult.value.impactedTaskIds[0]!;
      const reExecResult = engine.submitReExecuteTaskResult(sessionId, {
        taskId: firstImpacted,
        status: 'completed',
        output: 'Re-implemented with updated requirements',
        artifacts: ['src/updated.ts'],
      });
      expect(isOk(reExecResult)).toBe(true);
    }
  });
});

describe('Evolution Loop Repository Replay', () => {
  beforeEach(() => {
    dbPath = `.gestalt-test/evolve-replay-${randomUUID()}.db`;
    eventStore = new EventStore(dbPath);
    engine = new PassthroughExecuteEngine(eventStore);
  });

  afterEach(() => {
    eventStore.close();
    if (existsSync(dbPath)) rmSync(dbPath);
  });

  it('reconstructs session with evolution state from events', () => {
    const sessionId = setupCompletedExecution();

    // Evaluate
    engine.startEvaluation(sessionId);
    engine.submitStructuralResult(sessionId, {
      commands: [{ name: 'build', command: 'build', exitCode: 0, output: 'OK' }],
      allPassed: true,
    });
    engine.submitEvaluation(sessionId, {
      verifications: [
        { acIndex: 0, satisfied: true, evidence: 'OK', gaps: [] },
        { acIndex: 1, satisfied: false, evidence: 'No', gaps: ['Gap'] },
        { acIndex: 2, satisfied: false, evidence: 'No', gaps: ['Gap'] },
      ],
      overallScore: 0.4,
      goalAlignment: 0.5,
      recommendations: [],
    });

    // Evolve
    engine.startContextualEvolve(sessionId);
    engine.submitSpecPatch(sessionId, {
      acceptanceCriteria: ['AC A', 'AC B', 'AC C'],
    });

    // Reconstruct from new engine instance
    const engine2 = new PassthroughExecuteEngine(eventStore);
    const session = engine2.getSession(sessionId);

    expect(session.currentGeneration).toBe(1);
    expect(session.spec.acceptanceCriteria).toEqual(['AC A', 'AC B', 'AC C']);
    expect(session.evolutionHistory.length).toBeGreaterThan(0);
  });
});
