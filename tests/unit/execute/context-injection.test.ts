import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type {
  Spec,
  FigureGroundResult,
  ClosureResult,
  ProximityResult,
  ContinuityResult,
} from '../../../src/core/types.js';

// codeGraphEngine 싱글톤 mock — passthrough-engine.ts가 import하는 경로와 동일해야 함
vi.mock('../../../src/code-graph/index.js', () => ({
  codeGraphEngine: {
    dbExists: vi.fn(),
    searchByKeywords: vi.fn(),
    blastRadius: vi.fn().mockReturnValue({ impactedFiles: [] }),
    build: vi.fn(),
    close: vi.fn(),
  },
  // 나머지 re-export는 테스트에서 불필요하므로 생략
}));

// mock 설치 이후에 import — ESM에서는 vi.mock 호이스팅이 적용되므로 dynamic import 불필요
import { PassthroughExecuteEngine } from '../../../src/execute/passthrough-engine.js';
import { EventStore } from '../../../src/events/store.js';
import { isOk } from '../../../src/core/result.js';
import { codeGraphEngine } from '../../../src/code-graph/index.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

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
        reasoning: 'Important',
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

/**
 * 세션을 plan_complete 상태까지 진행한 뒤 sessionId를 반환한다.
 */
function completePlanningPhase(
  engine: PassthroughExecuteEngine,
  spec: Spec,
  repoRoot?: string,
): string {
  const startResult = engine.start(spec, { codeGraphRepoRoot: repoRoot });
  if (!startResult.ok) throw new Error('start failed');
  const { sessionId } = startResult.value.session;
  engine.planStep(sessionId, createFigureGroundResult());
  engine.planStep(sessionId, createClosureResult());
  engine.planStep(sessionId, createProximityResult());
  engine.planStep(sessionId, createContinuityResult());
  engine.planComplete(sessionId);
  return sessionId;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('buildNextTaskContext — suggestedFiles 주입', () => {
  let store: EventStore;
  let engine: PassthroughExecuteEngine;
  let dbPath: string;

  const mockedEngine = codeGraphEngine as {
    dbExists: ReturnType<typeof vi.fn>;
    searchByKeywords: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    dbPath = `.gestalt-test/context-injection-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    engine = new PassthroughExecuteEngine(store);
    vi.clearAllMocks();
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

  describe('db가 존재할 때', () => {
    it('searchByKeywords가 파일 목록을 반환하면 suggestedFiles가 채워진다', () => {
      const repoRoot = '/fake/repo';
      const mockFiles = [
        '/fake/repo/src/auth/user.ts',
        '/fake/repo/src/auth/token.ts',
        '/fake/repo/src/middleware/auth.ts',
      ];

      mockedEngine.dbExists.mockReturnValue(true);
      mockedEngine.searchByKeywords.mockReturnValue(mockFiles);

      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec, repoRoot);

      const result = engine.startExecution(sessionId);
      expect(isOk(result)).toBe(true);

      if (result.ok) {
        const { taskContext } = result.value;
        expect(taskContext).not.toBeNull();
        expect(taskContext!.suggestedFiles).toEqual(mockFiles);
      }
    });

    it('searchByKeywords 호출 시 repoRoot와 키워드가 전달된다', () => {
      const repoRoot = '/fake/repo';
      mockedEngine.dbExists.mockReturnValue(true);
      mockedEngine.searchByKeywords.mockReturnValue(['/fake/repo/src/user.ts']);

      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec, repoRoot);
      engine.startExecution(sessionId);

      expect(mockedEngine.dbExists).toHaveBeenCalledWith(repoRoot);
      expect(mockedEngine.searchByKeywords).toHaveBeenCalledWith(repoRoot, expect.any(Array));
    });
  });

  describe('db가 없을 때', () => {
    it('dbExists()가 false를 반환하면 suggestedFiles는 undefined 또는 빈 배열이다', () => {
      const repoRoot = '/fake/repo';
      mockedEngine.dbExists.mockReturnValue(false);

      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec, repoRoot);

      const result = engine.startExecution(sessionId);
      expect(isOk(result)).toBe(true);

      if (result.ok) {
        const { taskContext } = result.value;
        expect(taskContext).not.toBeNull();
        // db 없음 → suggestedFiles는 undefined이거나 빈 배열이어야 함
        const suggested = taskContext!.suggestedFiles;
        expect(
          suggested === undefined || (Array.isArray(suggested) && suggested.length === 0),
        ).toBe(true);
        // searchByKeywords는 호출되지 않아야 함
        expect(mockedEngine.searchByKeywords).not.toHaveBeenCalled();
      }
    });

    it('codeGraphRepoRoot가 없으면 dbExists 호출 자체를 건너뛴다', () => {
      const spec = createTestSpec();
      // repoRoot 없이 세션 시작
      const sessionId = completePlanningPhase(engine, spec, undefined);

      const result = engine.startExecution(sessionId);
      expect(isOk(result)).toBe(true);

      if (result.ok) {
        const { taskContext } = result.value;
        expect(taskContext).not.toBeNull();
        expect(taskContext!.suggestedFiles).toBeUndefined();
        expect(mockedEngine.dbExists).not.toHaveBeenCalled();
        expect(mockedEngine.searchByKeywords).not.toHaveBeenCalled();
      }
    });
  });

  describe('10개 제한', () => {
    it('searchByKeywords가 15개를 반환해도 suggestedFiles는 최대 10개로 잘린다', () => {
      const repoRoot = '/fake/repo';
      const fifteenFiles = Array.from({ length: 15 }, (_, i) => `/fake/repo/src/file-${i}.ts`);

      mockedEngine.dbExists.mockReturnValue(true);
      mockedEngine.searchByKeywords.mockReturnValue(fifteenFiles);

      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec, repoRoot);

      const result = engine.startExecution(sessionId);
      expect(isOk(result)).toBe(true);

      if (result.ok) {
        const { taskContext } = result.value;
        expect(taskContext).not.toBeNull();
        expect(taskContext!.suggestedFiles).toHaveLength(10);
        // 앞에서부터 10개여야 함
        expect(taskContext!.suggestedFiles).toEqual(fifteenFiles.slice(0, 10));
      }
    });

    it('searchByKeywords가 5개를 반환하면 suggestedFiles도 5개다', () => {
      const repoRoot = '/fake/repo';
      const fiveFiles = Array.from({ length: 5 }, (_, i) => `/fake/repo/src/file-${i}.ts`);

      mockedEngine.dbExists.mockReturnValue(true);
      mockedEngine.searchByKeywords.mockReturnValue(fiveFiles);

      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec, repoRoot);

      const result = engine.startExecution(sessionId);
      expect(isOk(result)).toBe(true);

      if (result.ok) {
        const { taskContext } = result.value;
        expect(taskContext).not.toBeNull();
        expect(taskContext!.suggestedFiles).toHaveLength(5);
        expect(taskContext!.suggestedFiles).toEqual(fiveFiles);
      }
    });
  });

  describe('예외 처리 (graceful fallback)', () => {
    it('searchByKeywords가 예외를 던지면 suggestedFiles는 undefined로 유지된다', () => {
      const repoRoot = '/fake/repo';
      mockedEngine.dbExists.mockReturnValue(true);
      mockedEngine.searchByKeywords.mockImplementation(() => {
        throw new Error('DB read error');
      });

      const spec = createTestSpec();
      const sessionId = completePlanningPhase(engine, spec, repoRoot);

      const result = engine.startExecution(sessionId);
      expect(isOk(result)).toBe(true);

      if (result.ok) {
        const { taskContext } = result.value;
        expect(taskContext).not.toBeNull();
        // 에러 발생 시 graceful fallback → undefined
        expect(taskContext!.suggestedFiles).toBeUndefined();
      }
    });
  });
});
