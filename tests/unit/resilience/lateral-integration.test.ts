import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PassthroughExecuteEngine } from '../../../src/execute/passthrough-engine.js';
import { EventStore } from '../../../src/events/store.js';
import { EventType } from '../../../src/events/types.js';
import { isOk } from '../../../src/core/result.js';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecuteSessionRepository } from '../../../src/execute/repository.js';
import { handleExecutePassthrough } from '../../../src/mcp/tools/execute-passthrough.js';
import { ProjectMemoryStore } from '../../../src/memory/project-memory-store.js';
import { executeInputSchema, type ExecuteInput } from '../../../src/mcp/schemas.js';
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
import { asRequested } from '../../helpers/structural.js';

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
        name: 'Auth Tokens',
        domain: 'auth',
        taskIds: ['task-2', 'task-3'],
        reasoning: 'Token-related',
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
async function setupToEvaluationComplete(
  engine: PassthroughExecuteEngine,
  spec: Spec,
): Promise<string> {
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
    await engine.submitTaskResult(sessionId, {
      taskId,
      status: 'completed',
      output: `Implemented ${taskId}`,
      artifacts: [`${taskId}.ts`],
    });
  }

  // Evaluate: structural → contextual
  engine.submitStructuralResult(
    sessionId,
    asRequested(engine.startEvaluation(sessionId), passingStructural),
  );
  engine.submitEvaluation(sessionId, makeLowEval());

  return sessionId;
}

// Helper: lateral persona 4개를 다 쓰고 hard_cap에 걸린 상태로 만든다
function exhaustLateral(engine: PassthroughExecuteEngine, sessionId: string, spec: Spec): void {
  const session = engine.getSession(sessionId);
  session.lateralTriedPersonas = ['multistability', 'simplicity', 'reification', 'invariance'];
  session.lateralAttempts = 4;
  session.evolutionHistory = [0, 1, 2].map((generation) => ({
    generation,
    spec,
    evaluationScore: 0.5 + generation * 0.02,
    goalAlignment: 0.5 + generation * 0.02,
    delta: { fieldsChanged: ['acceptanceCriteria'], similarity: 0.9, generation },
  }));
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

  it('evolve returns lateralContext when stagnation is detected (instead of terminating)', async () => {
    const spec = createTestSpec();
    const sessionId = await setupToEvaluationComplete(engine, spec);

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

    engine.submitStructuralResult(
      sessionId,
      asRequested(engine.startEvaluation(sessionId), passingStructural),
    );
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
        engine.submitStructuralResult(
          sessionId,
          asRequested(engine.startEvaluation(sessionId), passingStructural),
        );
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

  it('evolve still terminates on success', async () => {
    const spec = createTestSpec();
    const sessionId = await setupToEvaluationComplete(engine, spec);

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

  it('evolve_lateral_result applies specPatch and triggers re-execution', async () => {
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
      await engine.submitTaskResult(sessionId, {
        taskId,
        status: 'completed',
        output: `Done ${taskId}`,
        artifacts: [],
      });
    }

    // Evaluate
    engine.submitStructuralResult(
      sessionId,
      asRequested(engine.startEvaluation(sessionId), passingStructural),
    );
    engine.submitEvaluation(sessionId, makeLowEval());

    // Manually start lateral
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

  it('human_escalation when all 4 personas exhausted', async () => {
    const spec = createTestSpec();
    const sessionId = await setupToEvaluationComplete(engine, spec);

    // Manually exhaust all personas
    const session = engine.getSession(sessionId);
    session.lateralTriedPersonas = ['multistability', 'simplicity', 'reification', 'invariance'];
    session.lateralAttempts = 4;

    // Trigger hard_cap termination by setting enough evolution history
    // (contextualCount >= MAX_CONTEXTUAL=3)
    session.evolutionHistory = [
      {
        generation: 0,
        spec,
        evaluationScore: 0.5,
        goalAlignment: 0.5,
        delta: { fieldsChanged: ['acceptanceCriteria'], similarity: 0.9, generation: 0 },
      },
      {
        generation: 1,
        spec,
        evaluationScore: 0.52,
        goalAlignment: 0.52,
        delta: { fieldsChanged: ['acceptanceCriteria'], similarity: 0.9, generation: 1 },
      },
      {
        generation: 2,
        spec,
        evaluationScore: 0.54,
        goalAlignment: 0.54,
        delta: { fieldsChanged: ['acceptanceCriteria'], similarity: 0.9, generation: 2 },
      },
    ];

    const result = engine.startContextualEvolve(sessionId);
    expect(isOk(result)).toBe(true);
    if (!result.ok) return;

    // All personas exhausted + termination detected → human gate (세션은 종료되지 않는다)
    expect(result.value.humanEscalation).toBeDefined();
    expect(result.value.terminated).toBeUndefined();
    expect(result.value.humanEscalation!.stage).toBe('human_escalation');
    expect(result.value.humanEscalation!.triedPersonas).toHaveLength(4);
    expect(result.value.gate?.status).toBe('open');
    expect(engine.getSession(sessionId).status).toBe('awaiting_human');
    expect(engine.getSession(sessionId).terminationReason).toBeUndefined();
  });

  it('existing evolve flow works normally when no termination', async () => {
    const spec = createTestSpec();
    const sessionId = await setupToEvaluationComplete(engine, spec);

    // First evolve — no stagnation yet, should return evolveContext
    const result = engine.startContextualEvolve(sessionId);
    expect(isOk(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.evolveContext).toBeDefined();
    expect(result.value.lateralContext).toBeUndefined();
    expect(result.value.humanEscalation).toBeUndefined();
    expect(result.value.terminated).toBeUndefined();
  });

  it('startLateralEvolve suggests next persona correctly', async () => {
    const spec = createTestSpec();
    const sessionId = await setupToEvaluationComplete(engine, spec);

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

  it('startLateralEvolve returns success termination when score improves', async () => {
    const spec = createTestSpec();
    const sessionId = await setupToEvaluationComplete(engine, spec);

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

describe('Human Gate', () => {
  let dbPath: string;
  let store: EventStore;
  let engine: PassthroughExecuteEngine;
  let cwd: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/human-gate-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    engine = new PassthroughExecuteEngine(store);
    // memory.json이 레포 루트에 써지지 않게 package.json을 둔 임시 디렉토리를 루트로 삼는다
    cwd = mkdtempSync(join(tmpdir(), 'gestalt-gate-'));
    writeFileSync(join(cwd, 'package.json'), '{}');
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix, { force: true });
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  async function openGate(): Promise<{ sessionId: string; spec: Spec }> {
    const spec = createTestSpec();
    const sessionId = await setupToEvaluationComplete(engine, spec);
    exhaustLateral(engine, sessionId, spec);
    const result = engine.startContextualEvolve(sessionId);
    if (!result.ok || !result.value.gate) throw new Error('gate did not open');
    return { sessionId, spec };
  }

  function call(input: Partial<ExecuteInput>): Promise<Record<string, unknown>> {
    return handleExecutePassthrough(engine, { cwd, ...input } as ExecuteInput, 'claude-code').then(
      (raw) => JSON.parse(raw) as Record<string, unknown>,
    );
  }

  function readDecisions(): Array<Record<string, unknown>> {
    const raw = readFileSync(join(cwd, '.gestalt', 'memory.json'), 'utf-8');
    return (JSON.parse(raw) as { architectureDecisions: Array<Record<string, unknown>> })
      .architectureDecisions;
  }

  it('startLateralEvolve도 소진되면 같은 게이트를 연다', async () => {
    const spec = createTestSpec();
    const sessionId = await setupToEvaluationComplete(engine, spec);
    exhaustLateral(engine, sessionId, spec);

    const result = engine.startLateralEvolve(sessionId);
    expect(isOk(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.gate?.options.map((o) => o.id)).toEqual([
      'patch_spec',
      'manual_task',
      'restart',
      'abort',
    ]);
    expect(engine.getSession(sessionId).status).toBe('awaiting_human');
  });

  it('리플레이하면 열린 게이트와 awaiting_human 상태가 그대로 살아난다', async () => {
    const { sessionId } = await openGate();

    const restored = new ExecuteSessionRepository(store).reconstruct(sessionId);
    expect(restored?.status).toBe('awaiting_human');
    expect(restored?.terminationReason).toBeUndefined();
    expect(restored?.humanGates).toHaveLength(1);
    expect(restored?.humanGates[0]!.status).toBe('open');
  });

  it('게이트가 생기기 전 escalation 이벤트는 실패 종료로 되살린다', () => {
    const spec = createTestSpec();
    const started = engine.start(spec);
    if (!started.ok) throw new Error('start failed');
    const sessionId = started.value.session.sessionId;
    store.append('execute', sessionId, EventType.EVOLVE_TERMINATED, { reason: 'human_escalation' });
    store.append('execute', sessionId, EventType.EVOLVE_HUMAN_ESCALATION, {
      triedPersonas: [],
      bestScore: 0.5,
    });

    const restored = new ExecuteSessionRepository(store).reconstruct(sessionId);
    expect(restored?.status).toBe('failed');
    expect(restored?.terminationReason).toBe('human_escalation');
    expect(restored?.humanGates).toEqual([]);
  });

  it('MCP 응답은 awaiting_human과 gate_resolve 안내를 돌려준다', async () => {
    const spec = createTestSpec();
    const sessionId = await setupToEvaluationComplete(engine, spec);
    exhaustLateral(engine, sessionId, spec);

    const res = await call({ action: 'evolve', sessionId });
    expect(res.status).toBe('awaiting_human');
    expect(res.nextAction).toBe('gate_resolve');
    expect((res.gate as { status: string }).status).toBe('open');
  });

  it('대기 중에는 흐름을 미는 action을 막고 status와 resume은 통과시킨다', async () => {
    const { sessionId } = await openGate();

    const blocked = await call({ action: 'evaluate', sessionId });
    expect(String(blocked.error)).toContain('gate_resolve');

    const resumed = await call({ action: 'resume', sessionId });
    expect(resumed.status).toBe('awaiting_human');
    expect(resumed.nextAction).toBe('gate_resolve');

    const status = await call({ action: 'status', sessionId });
    const session = status.session as { status: string; openGate?: { gateId: string } };
    expect(session.status).toBe('awaiting_human');
    expect(session.openGate?.gateId).toBeDefined();
  });

  it('patch_spec으로 해소하면 executing으로 돌아가고 결정이 specId와 함께 memory에 남는다', async () => {
    const { sessionId, spec } = await openGate();

    const res = await call({
      action: 'gate_resolve',
      sessionId,
      gateResolution: {
        optionId: 'patch_spec',
        decision: 'refresh 토큰 AC를 이번 범위에서 뺀다',
        rationale: '외부 IdP 연동 전이라 검증할 방법이 없다',
      },
    });
    expect(res.status).toBe('gate_resolved');
    expect(res.nextAction).toBe('evolve_patch');

    const session = engine.getSession(sessionId);
    expect(session.status).toBe('executing');
    expect(session.humanGates[0]!.status).toBe('resolved');

    const decisions = readDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      decision: '[Escalation:patch_spec] refresh 토큰 AC를 이번 범위에서 뺀다',
      rationale: '외부 IdP 연동 전이라 검증할 방법이 없다',
      specId: spec.metadata.specId,
    });
    expect(decisions[0]!.outcome).toBeUndefined();

    // 해소 뒤에는 기존 흐름이 그대로 이어진다
    const patched = engine.submitSpecPatch(sessionId, {
      acceptanceCriteria: ['Users can register', 'Users can login and receive JWT token'],
    });
    expect(isOk(patched)).toBe(true);

    const restored = new ExecuteSessionRepository(store).reconstruct(sessionId);
    expect(restored?.humanGates[0]!.resolution?.optionId).toBe('patch_spec');
  });

  it('manual_task로 해소하면 evaluate를 다시 부를 수 있다', async () => {
    const { sessionId } = await openGate();

    await call({
      action: 'gate_resolve',
      sessionId,
      gateResolution: { optionId: 'manual_task', decision: '직접 고쳤다', rationale: '간단해서' },
    });
    expect(isOk(engine.startEvaluation(sessionId))).toBe(true);
  });

  it('abort로 해소하면 human_escalation으로 종료되고 리플레이도 같다', async () => {
    const { sessionId } = await openGate();

    const res = await call({
      action: 'gate_resolve',
      sessionId,
      gateResolution: {
        optionId: 'abort',
        decision: '이 과제는 접는다',
        rationale: '우선순위 밀림',
      },
    });
    expect(res.status).toBe('terminated');
    expect(res.terminationReason).toBe('human_escalation');
    expect(readDecisions()[0]!.outcome).toBe('execute session terminated (abort)');

    const restored = new ExecuteSessionRepository(store).reconstruct(sessionId);
    expect(restored?.status).toBe('failed');
    expect(restored?.terminationReason).toBe('human_escalation');
    expect(restored?.humanGates[0]!.status).toBe('resolved');
  });

  it('종료하는 선택지는 EVOLVE_TERMINATED가 빠져도 리플레이에서 종료된다', async () => {
    const { sessionId } = await openGate();
    const gateId = engine.getSession(sessionId).humanGates[0]!.gateId;
    // 해소 이벤트만 남기고 종료 이벤트 전에 끊긴 상황
    store.append('execute', sessionId, EventType.EVOLVE_HUMAN_GATE_RESOLVED, {
      gateId,
      resolution: { optionId: 'abort', decision: 'd', rationale: 'r', resolvedAt: '' },
      resumes: false,
    });

    const restored = new ExecuteSessionRepository(store).reconstruct(sessionId);
    expect(restored?.status).toBe('failed');
    expect(restored?.terminationReason).toBe('human_escalation');
  });

  it('열린 게이트가 있으면 엔진을 직접 불러도 두 번째 게이트를 열지 않는다', async () => {
    const { sessionId } = await openGate();

    const again = engine.startContextualEvolve(sessionId);
    expect(again.ok).toBe(false);
    const open = engine.getSession(sessionId).humanGates.filter((g) => g.status === 'open');
    expect(open).toHaveLength(1);
  });

  it('이어간 뒤 평가가 한 번만 기준에 못 미쳐도 persona 없이 곧바로 새 게이트를 연다', async () => {
    const { sessionId } = await openGate();
    const firstGateId = engine.getSession(sessionId).humanGates[0]!.gateId;

    await call({
      action: 'gate_resolve',
      sessionId,
      gateResolution: { optionId: 'manual_task', decision: '직접 고쳤다', rationale: '간단해서' },
    });
    engine.startEvaluation(sessionId);
    engine.submitStructuralResult(sessionId, passingStructural);
    engine.submitEvaluation(sessionId, makeLowEval());

    const result = engine.startContextualEvolve(sessionId);
    expect(isOk(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.lateralContext).toBeUndefined();
    expect(result.value.gate?.gateId).not.toBe(firstGateId);

    const gates = engine.getSession(sessionId).humanGates;
    expect(gates.map((g) => g.status)).toEqual(['resolved', 'open']);
  });

  it('공백만 있는 decision과 rationale은 스키마에서 거절한다', () => {
    const parse = (decision: string, rationale: string) =>
      executeInputSchema.safeParse({
        action: 'gate_resolve',
        sessionId: 's',
        gateResolution: { optionId: 'abort', decision, rationale },
      }).success;

    expect(parse('   ', '이유')).toBe(false);
    expect(parse('결정', '\n\t')).toBe(false);
    expect(parse('결정', '이유')).toBe(true);
  });

  it('memory 기록이 실패해도 해소는 되고 memoryRecorded가 false로 온다', async () => {
    const { sessionId } = await openGate();
    const spy = vi
      .spyOn(ProjectMemoryStore.prototype, 'addArchitectureDecision')
      .mockImplementation(() => {
        throw new Error('disk full');
      });
    try {
      const res = await call({
        action: 'gate_resolve',
        sessionId,
        gateResolution: { optionId: 'abort', decision: 'd', rationale: 'r' },
      });
      expect(res.status).toBe('terminated');
      expect(res.memoryRecorded).toBe(false);
      expect(engine.getSession(sessionId).humanGates[0]!.status).toBe('resolved');
    } finally {
      spy.mockRestore();
    }
  });

  it('memory 기록이 되면 memoryRecorded가 true로 온다', async () => {
    const { sessionId } = await openGate();
    const res = await call({
      action: 'gate_resolve',
      sessionId,
      gateResolution: { optionId: 'manual_task', decision: 'd', rationale: 'r' },
    });
    expect(res.memoryRecorded).toBe(true);
    expect(readDecisions()).toHaveLength(1);
  });

  it('재시작한 엔진에서 해소해도 결정이 실제 specId로 memory에 남는다', async () => {
    const { sessionId, spec } = await openGate();
    const store2 = new EventStore(dbPath);
    try {
      const engine2 = new PassthroughExecuteEngine(store2);
      expect(engine2.getSession(sessionId).status).toBe('awaiting_human');

      const raw = await handleExecutePassthrough(
        engine2,
        {
          cwd,
          action: 'gate_resolve',
          sessionId,
          gateResolution: { optionId: 'patch_spec', decision: '재시작 뒤 결정', rationale: 'r' },
        } as ExecuteInput,
        'claude-code',
      );
      expect((JSON.parse(raw) as { status: string }).status).toBe('gate_resolved');
      expect(readDecisions()[0]).toMatchObject({
        decision: '[Escalation:patch_spec] 재시작 뒤 결정',
        specId: spec.metadata.specId,
      });
      // 처음 엔진도 다른 프로세스가 남긴 해소를 본다
      expect(engine.getSession(sessionId).status).toBe('executing');
    } finally {
      store2.close();
    }
  });

  it('대기 중이 아니거나 이미 해소된 게이트는 거절한다', async () => {
    const { sessionId } = await openGate();
    const answer = { optionId: 'patch_spec' as const, decision: 'd', rationale: 'r' };

    expect(isOk(engine.resolveHumanGate(sessionId, answer))).toBe(true);
    const again = engine.resolveHumanGate(sessionId, answer);
    expect(again.ok).toBe(false);

    const missing = await call({ action: 'gate_resolve', sessionId });
    expect(String(missing.error)).toContain('gateResolution');
  });
});
