import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildClosurePrompt } from '../../../src/execute/prompts.js';
import { buildLateralPrompt } from '../../../src/resilience/prompts.js';
import { measureDrift } from '../../../src/execute/drift-detector.js';
import type {
  AtomicTask,
  ClassifiedAC,
  EvaluationResult,
  Spec,
  TaskExecutionResult,
} from '../../../src/core/types.js';

// MCP 입력 스키마는 엔티티의 description과 attributes를 optional로 받는다.
// 그렇게 저장된 스펙으로도 프롬프트와 drift 계산이 돌아야 한다.
function createSpecWithSparseEntities(): Spec {
  return {
    version: '1.0.0',
    goal: 'Build a user authentication system',
    constraints: ['Must use JWT'],
    acceptanceCriteria: ['Users can login'],
    ontologySchema: {
      entities: [
        { name: 'User', description: 'System user', attributes: ['email'] },
        { name: 'Session', description: 'Login session' },
        { name: 'Token', attributes: ['accessToken'] },
        { name: 'Audit' },
      ],
      relations: [{ from: 'User', to: 'Session', type: 'has_many' }],
    },
    gestaltAnalysis: [],
    metadata: {
      specId: randomUUID(),
      interviewSessionId: randomUUID(),
      resolutionScore: 0.9,
      generatedAt: new Date().toISOString(),
    },
  };
}

describe('온톨로지 엔티티의 optional 필드', () => {
  it('attributes가 없는 엔티티로 closure 프롬프트를 만든다', () => {
    const classified: ClassifiedAC[] = [
      {
        acIndex: 0,
        acText: 'Users can login',
        classification: 'behavioral',
        priority: 'primary',
        reasoning: 'core flow',
      } as ClassifiedAC,
    ];

    const prompt = buildClosurePrompt(createSpecWithSparseEntities(), classified);

    expect(prompt).toContain('User (email)');
    expect(prompt).toContain('Session ()');
    expect(prompt).toContain('Token (accessToken)');
    expect(prompt).toContain('Audit ()');
  });

  it('attributes가 없는 엔티티로 evolve 프롬프트를 만든다', () => {
    const evaluation = {
      overallScore: 0.5,
      goalAlignment: 0.5,
      verifications: [],
      recommendations: [],
    } as unknown as EvaluationResult;

    const prompt = buildLateralPrompt(
      'simplicity',
      'spinning',
      createSpecWithSparseEntities(),
      evaluation,
      [],
      1,
    );

    expect(prompt).toContain('User (email)');
    expect(prompt).toContain('Session ()');
  });

  it('attributes가 없는 엔티티로 ontology drift를 계산한다', async () => {
    const task = { taskId: 't1' } as AtomicTask;
    const result: TaskExecutionResult = {
      taskId: 't1',
      status: 'completed',
      output: 'User login with email and accessToken',
      artifacts: [],
    };

    const drift = await measureDrift(createSpecWithSparseEntities(), task, result, 0.6);

    const ontology = drift.dimensions.find((d) => d.name === 'ontology');
    expect(ontology).toBeDefined();
    expect(Number.isFinite(ontology!.score)).toBe(true);
  });
});
