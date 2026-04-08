import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

// Mock better-sqlite3 to avoid Node.js version mismatch
vi.mock('better-sqlite3', () => {
  const mockStmt = {
    run: vi.fn(),
    get: vi.fn(),
    all: vi.fn().mockReturnValue([]),
  };
  const MockDatabase = vi.fn().mockImplementation(() => ({
    pragma: vi.fn(),
    exec: vi.fn(),
    prepare: vi.fn().mockReturnValue(mockStmt),
    close: vi.fn(),
  }));
  return { default: MockDatabase };
});

import { PassthroughExecuteEngine } from '../../../src/execute/passthrough-engine.js';
import { EventStore } from '../../../src/events/store.js';
import { AgentRegistry } from '../../../src/agent/registry.js';
import { RoleAgentRegistry } from '../../../src/agent/role-agent-registry.js';
import type { Spec, RoleMatch, RolePerspective, RoleConsensus } from '../../../src/core/types.js';

// ─── Test Helpers ────────────────────────────────────────────

function createTestSpec(): Spec {
  return {
    version: '1.0',
    goal: 'Role Agent 시스템 통합 테스트',
    constraints: ['TypeScript', 'Passthrough mode'],
    acceptanceCriteria: [
      'role_match → role_consensus → execute_task 전체 플로우 동작',
      '0매칭 시 roleGuidance 없이 정상 동작',
    ],
    ontologySchema: {
      entities: [{ name: 'Component', description: 'UI component', attributes: ['name'] }],
      relations: [{ from: 'Component', to: 'Component', type: 'depends_on' }],
    },
    gestaltAnalysis: [{ principle: 'closure', finding: 'test', confidence: 0.9 }],
    metadata: {
      specId: `spec-${randomUUID()}`,
      interviewSessionId: `int-${randomUUID()}`,
      resolutionScore: 0.85,
      generatedAt: new Date().toISOString(),
    },
  };
}

function setupEngine(withRoleRegistry = true): PassthroughExecuteEngine {
  const eventStore = new EventStore('fake.db');
  const agentRegistry = new AgentRegistry(resolve('agents'));
  agentRegistry.loadAll();

  if (withRoleRegistry) {
    const roleAgentRegistry = new RoleAgentRegistry(resolve('role-agents'));
    roleAgentRegistry.loadAll();
    return new PassthroughExecuteEngine(eventStore, agentRegistry, roleAgentRegistry);
  }

  return new PassthroughExecuteEngine(eventStore, agentRegistry);
}

function planAndStartExecution(engine: PassthroughExecuteEngine, spec: Spec): string {
  const startResult = engine.start(spec);
  if (!startResult.ok) throw new Error(`Start failed: ${startResult.error.message}`);
  const sessionId = startResult.value.session.sessionId;

  const principles = ['figure_ground', 'closure', 'proximity', 'continuity'] as const;
  for (const principle of principles) {
    const stepResult: Record<string, unknown> = { principle };
    if (principle === 'figure_ground') {
      stepResult.classifiedACs = spec.acceptanceCriteria.map((ac, i) => ({
        acIndex: i, acText: ac, classification: 'figure', priority: 'critical', reasoning: 'test',
      }));
    } else if (principle === 'closure') {
      stepResult.atomicTasks = [
        { taskId: 'task-a', title: 'React 컴포넌트 구현', description: 'UserProfile React 컴포넌트를 구현한다', sourceAC: [0], isImplicit: false, estimatedComplexity: 'medium', dependsOn: [] },
        { taskId: 'task-b', title: 'API 연동', description: 'Backend API와 연동하여 데이터를 가져온다', sourceAC: [1], isImplicit: false, estimatedComplexity: 'medium', dependsOn: ['task-a'] },
      ];
    } else if (principle === 'proximity') {
      stepResult.taskGroups = [
        { groupId: 'g1', name: 'UI', domain: 'frontend', taskIds: ['task-a'], reasoning: 'UI task' },
        { groupId: 'g2', name: 'Backend', domain: 'backend', taskIds: ['task-b'], reasoning: 'API task' },
      ];
    } else if (principle === 'continuity') {
      stepResult.dagValidation = {
        isValid: true, hasCycles: false, hasConflicts: false,
        topologicalOrder: ['task-a', 'task-b'], criticalPath: ['task-a', 'task-b'],
      };
    }
    const planResult = engine.planStep(sessionId, stepResult as any);
    if (!planResult.ok) throw new Error(`Plan step ${principle} failed: ${planResult.error.message}`);
  }

  const completeResult = engine.planComplete(sessionId);
  if (!completeResult.ok) throw new Error(`Complete plan failed: ${completeResult.error.message}`);

  const execResult = engine.startExecution(sessionId);
  if (!execResult.ok) throw new Error(`Start execution failed: ${execResult.error.message}`);

  return sessionId;
}

// ─── Integration Tests ───────────────────────────────────────

describe('Role Agent Integration: Full MCP Flow', () => {
  let engine: PassthroughExecuteEngine;
  let sessionId: string;

  beforeEach(() => {
    engine = setupEngine();
    sessionId = planAndStartExecution(engine, createTestSpec());
  });

  it('role_match call 1 returns matchContext with available agents', () => {
    const result = engine.roleMatch(sessionId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.matchContext).toBeDefined();
    expect(result.value.matchContext!.availableAgents.length).toBe(9);
    expect(result.value.matchContext!.systemPrompt).toContain('role-agent matcher');
    expect(result.value.matchContext!.matchingPrompt).toContain('task-a');
  });

  it('role_match call 2 returns perspectivePrompts for matched agents', () => {
    engine.roleMatch(sessionId);

    const matches: RoleMatch[] = [
      { agentName: 'frontend-developer', domain: ['ui', 'react'], relevanceScore: 0.95, reasoning: 'React component task' },
      { agentName: 'designer', domain: ['ui', 'ux'], relevanceScore: 0.7, reasoning: 'UI design guidance' },
    ];

    const result = engine.roleMatch(sessionId, matches);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.perspectivePrompts).toBeDefined();
    expect(result.value.perspectivePrompts!.length).toBe(2);
    expect(result.value.perspectivePrompts![0].agentName).toBe('frontend-developer');
    expect(result.value.perspectivePrompts![1].agentName).toBe('designer');
    expect(result.value.perspectivePrompts![0].systemPrompt).toBeTruthy();
  });

  it('role_consensus call 1 returns synthesisContext', () => {
    engine.roleMatch(sessionId);
    engine.roleMatch(sessionId, [
      { agentName: 'frontend-developer', domain: ['ui'], relevanceScore: 0.9, reasoning: 'match' },
      { agentName: 'designer', domain: ['ui'], relevanceScore: 0.8, reasoning: 'match' },
    ]);

    const perspectives: RolePerspective[] = [
      { agentName: 'frontend-developer', perspective: 'Use React hooks with TypeScript', confidence: 0.9 },
      { agentName: 'designer', perspective: 'Follow Material Design guidelines', confidence: 0.85 },
    ];

    const result = engine.roleConsensus(sessionId, perspectives);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.synthesisContext).toBeDefined();
    expect(result.value.synthesisContext!.systemPrompt).toContain('consensus synthesizer');
    expect(result.value.synthesisContext!.synthesisPrompt).toContain('frontend-developer');
    expect(result.value.synthesisContext!.synthesisPrompt).toContain('designer');
  });

  it('role_consensus call 2 returns roleGuidance', () => {
    engine.roleMatch(sessionId);
    engine.roleMatch(sessionId, [
      { agentName: 'frontend-developer', domain: ['ui'], relevanceScore: 0.9, reasoning: 'match' },
    ]);
    engine.roleConsensus(sessionId, [
      { agentName: 'frontend-developer', perspective: 'Use hooks', confidence: 0.9 },
    ]);

    const consensus: RoleConsensus = {
      consensus: 'Use React hooks for state management',
      conflictResolutions: [],
      perspectives: [
        { agentName: 'frontend-developer', perspective: 'Use hooks', confidence: 0.9 },
      ],
    };

    const result = engine.roleConsensus(sessionId, undefined, consensus);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.roleGuidance).toBeDefined();
    expect(result.value.roleGuidance!.consensus).toBe('Use React hooks for state management');
    expect(result.value.roleGuidance!.agents.length).toBe(1);
    expect(result.value.roleGuidance!.conflictResolutions).toEqual([]);
  });

  it('full flow: role_match → role_consensus → execute_task with roleGuidance', () => {
    // 1. role_match
    engine.roleMatch(sessionId);
    engine.roleMatch(sessionId, [
      { agentName: 'frontend-developer', domain: ['ui', 'react'], relevanceScore: 0.95, reasoning: 'React task' },
      { agentName: 'architect', domain: ['architecture'], relevanceScore: 0.75, reasoning: 'Design review' },
    ]);

    // 2. role_consensus
    engine.roleConsensus(sessionId, [
      { agentName: 'frontend-developer', perspective: 'Use React hooks pattern', confidence: 0.9 },
      { agentName: 'architect', perspective: 'Ensure clean architecture separation', confidence: 0.85 },
    ]);

    const consensus: RoleConsensus = {
      consensus: 'Use React hooks with clean architecture boundaries',
      conflictResolutions: ['Architecture concerns addressed by component isolation'],
      perspectives: [
        { agentName: 'frontend-developer', perspective: 'React hooks pattern', confidence: 0.9 },
        { agentName: 'architect', perspective: 'Clean architecture', confidence: 0.85 },
      ],
    };
    const guidanceResult = engine.roleConsensus(sessionId, undefined, consensus);
    expect(guidanceResult.ok).toBe(true);
    expect(guidanceResult.ok && guidanceResult.value.roleGuidance).toBeDefined();

    // 3. execute_task — submit task-a
    const taskSubmit = engine.submitTaskResult(sessionId, {
      taskId: 'task-a',
      status: 'completed',
      output: 'React component implemented with hooks',
      artifacts: ['src/components/UserProfile.tsx'],
    });
    expect(taskSubmit.ok).toBe(true);

    // After submit, roleState cleared → next task context has no roleGuidance
    if (taskSubmit.ok) {
      expect(taskSubmit.value.taskContext).toBeDefined();
      expect(taskSubmit.value.taskContext!.roleGuidance).toBeUndefined();
    }
  });

  it('zero matches: perspectivePrompts is empty, execute_task works without roleGuidance', () => {
    engine.roleMatch(sessionId);
    const result = engine.roleMatch(sessionId, []);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.perspectivePrompts).toEqual([]);
    }

    const taskSubmit = engine.submitTaskResult(sessionId, {
      taskId: 'task-a',
      status: 'completed',
      output: 'Task completed without role guidance',
      artifacts: [],
    });
    expect(taskSubmit.ok).toBe(true);
    if (taskSubmit.ok) {
      expect(taskSubmit.value.taskContext?.roleGuidance).toBeUndefined();
    }
  });

  it('multiple agents: 3 perspectives merge into consensus', () => {
    engine.roleMatch(sessionId);
    engine.roleMatch(sessionId, [
      { agentName: 'frontend-developer', domain: ['ui'], relevanceScore: 0.95, reasoning: 'UI' },
      { agentName: 'designer', domain: ['ux'], relevanceScore: 0.85, reasoning: 'UX' },
      { agentName: 'qa-engineer', domain: ['testing'], relevanceScore: 0.7, reasoning: 'Test' },
    ]);

    const perspectives: RolePerspective[] = [
      { agentName: 'frontend-developer', perspective: 'Component-first approach', confidence: 0.9 },
      { agentName: 'designer', perspective: 'Accessibility-first design', confidence: 0.85 },
      { agentName: 'qa-engineer', perspective: 'Test coverage above 90%', confidence: 0.8 },
    ];
    const synthResult = engine.roleConsensus(sessionId, perspectives);
    expect(synthResult.ok).toBe(true);
    if (synthResult.ok) {
      expect(synthResult.value.synthesisContext!.synthesisPrompt).toContain('3 role agents');
    }

    const consensus: RoleConsensus = {
      consensus: 'Component-first approach with accessibility and high test coverage',
      conflictResolutions: ['Balanced UX polish with testing requirements'],
      perspectives,
    };
    const guidanceResult = engine.roleConsensus(sessionId, undefined, consensus);
    expect(guidanceResult.ok).toBe(true);
    if (guidanceResult.ok) {
      expect(guidanceResult.value.roleGuidance!.agents.length).toBe(3);
      expect(guidanceResult.value.roleGuidance!.conflictResolutions.length).toBe(1);
    }
  });

  it('roleState is cleared after each execute_task submission', () => {
    engine.roleMatch(sessionId);
    engine.roleMatch(sessionId, [
      { agentName: 'frontend-developer', domain: ['ui'], relevanceScore: 0.9, reasoning: 'match' },
    ]);
    engine.roleConsensus(sessionId, [
      { agentName: 'frontend-developer', perspective: 'Use hooks', confidence: 0.9 },
    ]);
    engine.roleConsensus(sessionId, undefined, {
      consensus: 'Use hooks',
      conflictResolutions: [],
      perspectives: [{ agentName: 'frontend-developer', perspective: 'Use hooks', confidence: 0.9 }],
    });

    // Submit task-a → clears role state
    engine.submitTaskResult(sessionId, {
      taskId: 'task-a',
      status: 'completed',
      output: 'Done',
      artifacts: [],
    });

    // New role_match for task-b starts fresh
    const matchResult = engine.roleMatch(sessionId);
    expect(matchResult.ok).toBe(true);
    if (matchResult.ok) {
      expect(matchResult.value.matchContext).toBeDefined();
      expect(matchResult.value.matchContext!.matchingPrompt).toContain('task-b');
    }
  });

  it('engine without roleAgentRegistry returns error on role_match', () => {
    const engineNoRole = setupEngine(false);
    const sid = planAndStartExecution(engineNoRole, createTestSpec());

    const result = engineNoRole.roleMatch(sid);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('RoleAgentRegistry not configured');
    }
  });

  it('role_match on non-executing session returns error', () => {
    const spec = createTestSpec();
    const startResult = engine.start(spec);
    if (!startResult.ok) throw new Error('Failed to start');
    const newSessionId = startResult.value.session.sessionId;

    const result = engine.roleMatch(newSessionId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('expected "executing"');
    }
  });

  it('role_consensus without perspectives or consensus returns error', () => {
    const result = engine.roleConsensus(sessionId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('perspectives or consensus must be provided');
    }
  });
});
