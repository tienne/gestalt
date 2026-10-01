import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { RoleAgentRegistry } from '../../../src/agent/role-agent-registry.js';
import { createExecuteFixture, type ExecuteFixture } from '../../helpers/execute-fixture.js';

interface RoleMatchResponse {
  error?: string;
  status?: string;
  matchContext?: { taskId: string; systemPrompt: string; matchingPrompt: string };
  perspectivePrompts?: Array<{ agentName: string }>;
  matchCount?: number;
  message?: string;
  nextAction?: string;
}

interface RoleConsensusResponse {
  error?: string;
  status?: string;
  synthesisContext?: { systemPrompt: string; synthesisPrompt: string };
  roleGuidance?: { agents: unknown[]; consensus: string; conflictResolutions: string[] };
  nextAction?: string;
}

const perspective = {
  agentName: 'frontend-developer',
  perspective: 'Keep the component tree shallow.',
  confidence: 0.8,
};

const consensus = {
  consensus: 'Ship a shallow component tree.',
  conflictResolutions: ['none'],
  perspectives: [perspective],
};

describe('ges_execute role_match / role_consensus 핸들러', () => {
  let registry: RoleAgentRegistry;
  let fx: ExecuteFixture;

  beforeAll(() => {
    registry = new RoleAgentRegistry(resolve('plugin/role-agents'));
    registry.loadAll();
  });

  beforeEach(() => {
    fx = createExecuteFixture('handlers-roles', registry);
  });
  afterEach(() => fx.close());

  describe('role_match', () => {
    it('sessionId가 없으면 에러를 돌려준다', async () => {
      const res = await fx.call<RoleMatchResponse>({ action: 'role_match' });
      expect(res.error).toContain('sessionId is required');
    });

    it('실행 중이 아닌 세션이면 엔진 에러를 그대로 돌려준다', async () => {
      const { sessionId } = fx.plannedSession();
      const res = await fx.call<RoleMatchResponse>({ action: 'role_match', sessionId });
      expect(res.error).toContain('expected "executing"');
    });

    it('1차 호출은 현재 태스크 기준 matchContext를 주고 role_match를 다시 부르게 한다', async () => {
      const { sessionId } = fx.executingSession();
      const res = await fx.call<RoleMatchResponse>({ action: 'role_match', sessionId });

      expect(res.status).toBe('role_matching');
      expect(res.matchContext?.matchingPrompt).toContain('Task task-0');
      expect(res.nextAction).toBe('role_match');
    });

    it('2차 호출은 매칭된 에이전트마다 관점 프롬프트를 주고 role_consensus로 안내한다', async () => {
      const { sessionId } = fx.executingSession();
      const res = await fx.call<RoleMatchResponse>({
        action: 'role_match',
        sessionId,
        matchResult: [
          {
            agentName: 'frontend-developer',
            domain: ['ui'],
            relevanceScore: 0.9,
            reasoning: 'UI work',
          },
        ],
      });

      expect(res.status).toBe('role_matched');
      expect(res.matchCount).toBe(1);
      expect(res.perspectivePrompts?.[0]?.agentName).toBe('frontend-developer');
      expect(res.nextAction).toBe('role_consensus');
      expect(fx.engine.getSession(sessionId).roleMatches).toHaveLength(1);
    });

    it('레지스트리에 없는 에이전트 이름은 관점 프롬프트에서 빠진다', async () => {
      const { sessionId } = fx.executingSession();
      const res = await fx.call<RoleMatchResponse>({
        action: 'role_match',
        sessionId,
        matchResult: [
          { agentName: 'ghost-agent', domain: ['x'], relevanceScore: 0.9, reasoning: 'none' },
          {
            agentName: 'frontend-developer',
            domain: ['ui'],
            relevanceScore: 0.9,
            reasoning: 'UI',
          },
        ],
      });

      expect(res.matchCount).toBe(1);
      expect(res.perspectivePrompts?.map((p) => p.agentName)).toEqual(['frontend-developer']);
    });

    it('레지스트리 없이 1차 호출하면 설정 에러를 돌려준다', async () => {
      const bare = createExecuteFixture('handlers-roles-bare');
      try {
        const { sessionId } = bare.executingSession();
        const res = await bare.call<RoleMatchResponse>({ action: 'role_match', sessionId });
        expect(res.error).toContain('RoleAgentRegistry not configured');
      } finally {
        bare.close();
      }
    });
  });

  describe('role_consensus', () => {
    it('sessionId가 없으면 에러를 돌려준다', async () => {
      const res = await fx.call<RoleConsensusResponse>({ action: 'role_consensus' });
      expect(res.error).toContain('sessionId is required');
    });

    it('perspectives도 consensus도 없으면 엔진 에러를 돌려준다', async () => {
      const { sessionId } = fx.executingSession();
      const res = await fx.call<RoleConsensusResponse>({ action: 'role_consensus', sessionId });
      expect(res.error).toContain('Either perspectives or consensus');
    });

    it('1차 호출은 관점을 모은 synthesisContext를 주고 role_consensus를 다시 부르게 한다', async () => {
      const { sessionId } = fx.executingSession();
      const res = await fx.call<RoleConsensusResponse>({
        action: 'role_consensus',
        sessionId,
        perspectives: [perspective],
      });

      expect(res.status).toBe('synthesizing');
      expect(res.synthesisContext?.synthesisPrompt).toContain(perspective.perspective);
      expect(res.nextAction).toBe('role_consensus');
    });

    it('2차 호출은 roleGuidance를 돌려주고 세션에 합의를 저장한다', async () => {
      const { sessionId } = fx.executingSession();
      const res = await fx.call<RoleConsensusResponse>({
        action: 'role_consensus',
        sessionId,
        consensus,
      });

      expect(res.status).toBe('consensus_complete');
      expect(res.roleGuidance).toEqual({
        agents: consensus.perspectives,
        consensus: consensus.consensus,
        conflictResolutions: consensus.conflictResolutions,
      });
      expect(res.nextAction).toBe('execute_task');
      expect(fx.engine.getSession(sessionId).roleConsensus?.consensus).toBe(consensus.consensus);
    });

    it('perspectives와 consensus를 같이 주면 저장 쪽으로 간다', async () => {
      const { sessionId } = fx.executingSession();
      const res = await fx.call<RoleConsensusResponse>({
        action: 'role_consensus',
        sessionId,
        perspectives: [perspective],
        consensus,
      });

      expect(res.status).toBe('consensus_complete');
    });
  });
});
