import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readActiveSession, writeActiveSession } from '../../../src/execute/rule-writer.js';
import type { EvaluationResult } from '../../../src/core/types.js';
import {
  createExecuteFixture,
  RecordingAdapter,
  type ExecuteFixture,
} from '../../helpers/execute-fixture.js';

/**
 * evolve_lateral, evolve_lateral_result 핸들러.
 * 평가 단계는 다른 작업이 동작을 바꾸고 있어 엔진의 evaluate 경로를 타지 않고
 * 세션에 evaluationResult를 직접 심어 lateral 진입 조건만 만든다.
 */

interface LateralResponse {
  error?: string;
  status?: string;
  terminationReason?: string;
  escalationContext?: { stage: string; triedPersonas: string[] };
  lateralContext?: { persona: string; attemptNumber: number; stage: string };
  message?: string;
}

interface LateralResultResponse {
  error?: string;
  status?: string;
  impactedTaskIds?: string[];
  reExecuteContext?: { currentTask?: { taskId: string } };
}

function evaluation(score: number, alignment = score): EvaluationResult {
  return {
    verifications: [{ acIndex: 0, satisfied: score >= 0.85, evidence: 'e', gaps: [] }],
    overallScore: score,
    goalAlignment: alignment,
    recommendations: [],
  };
}

const ALL_PERSONAS = ['multistability', 'simplicity', 'reification', 'invariance'];

describe('ges_execute evolve_lateral 핸들러', () => {
  let fx: ExecuteFixture;
  let cwd: string;

  beforeEach(() => {
    fx = createExecuteFixture('handlers-lateral');
    cwd = mkdtempSync(join(tmpdir(), 'gestalt-lateral-'));
  });
  afterEach(() => {
    fx.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  function evaluatedSession(score: number): string {
    const { sessionId } = fx.executingSession();
    fx.engine.getSession(sessionId).evaluationResult = evaluation(score);
    return sessionId;
  }

  it('sessionId가 없으면 에러를 돌려준다', async () => {
    const res = await fx.call<LateralResponse>({ action: 'evolve_lateral' });
    expect(res.error).toContain('sessionId is required');
  });

  it('평가 결과가 없으면 evaluate부터 하라고 막는다', async () => {
    const { sessionId } = fx.executingSession();
    const res = await fx.call<LateralResponse>({ action: 'evolve_lateral', sessionId });
    expect(res.error).toContain('Run evaluate first');
  });

  it('점수가 낮으면 첫 페르소나의 lateralContext를 돌려주고 세션을 lateral 단계로 둔다', async () => {
    const sessionId = evaluatedSession(0.4);
    const res = await fx.call<LateralResponse>({ action: 'evolve_lateral', sessionId });

    expect(res.status).toBe('lateral_thinking');
    expect(ALL_PERSONAS).toContain(res.lateralContext?.persona);
    expect(res.lateralContext?.attemptNumber).toBe(1);
    expect(res.message).toContain('attempt 1/4');

    const session = fx.engine.getSession(sessionId);
    expect(session.evolveStage).toBe('lateral');
    expect(session.lateralCurrentPersona).toBe(res.lateralContext?.persona);
  });

  it('이미 쓴 페르소나는 다시 고르지 않는다', async () => {
    const sessionId = evaluatedSession(0.4);
    const first = await fx.call<LateralResponse>({ action: 'evolve_lateral', sessionId });
    fx.engine.getSession(sessionId).lateralTriedPersonas.push(first.lateralContext!.persona);

    const second = await fx.call<LateralResponse>({ action: 'evolve_lateral', sessionId });
    expect(second.lateralContext?.persona).not.toBe(first.lateralContext?.persona);
  });

  it('그사이 성공 점수가 나왔으면 terminated로 끝내고 활성 컨텍스트를 치운다', async () => {
    const sessionId = evaluatedSession(0.95);
    writeActiveSession(cwd, sessionId, 'spec');
    const adapter = new RecordingAdapter();

    const res = await fx.call<LateralResponse>(
      { action: 'evolve_lateral', sessionId, cwd },
      adapter,
    );

    expect(res.status).toBe('terminated');
    expect(res.terminationReason).toBe('success');
    expect(res).not.toHaveProperty('escalationContext');
    expect(adapter.cleared).toBe(1);
    expect(readActiveSession(cwd)).toBeNull();
    expect(fx.engine.getSession(sessionId).status).toBe('completed');
  });

  it('페르소나 4개를 다 썼으면 human_escalation과 escalationContext를 돌려준다', async () => {
    const sessionId = evaluatedSession(0.4);
    fx.engine.getSession(sessionId).lateralTriedPersonas = [...ALL_PERSONAS];
    const adapter = new RecordingAdapter();

    const res = await fx.call<LateralResponse>(
      { action: 'evolve_lateral', sessionId, cwd },
      adapter,
    );

    expect(res.status).toBe('human_escalation');
    expect(res.escalationContext?.stage).toBe('human_escalation');
    expect(res.escalationContext?.triedPersonas).toEqual(ALL_PERSONAS);
    expect(res.message).toContain('Human intervention required');
    expect(adapter.cleared).toBe(1);
    expect(fx.engine.getSession(sessionId).terminationReason).toBe('human_escalation');
  });

  it('cwd가 없으면 종료돼도 활성 컨텍스트를 건드리지 않는다', async () => {
    const sessionId = evaluatedSession(0.95);
    const adapter = new RecordingAdapter();

    await fx.call({ action: 'evolve_lateral', sessionId }, adapter);
    expect(adapter.cleared).toBe(0);
  });
});

describe('ges_execute evolve_lateral_result 핸들러', () => {
  let fx: ExecuteFixture;

  beforeEach(() => {
    fx = createExecuteFixture('handlers-lateral-result');
  });
  afterEach(() => fx.close());

  async function lateralSession(): Promise<{ sessionId: string; persona: string }> {
    const { sessionId } = fx.executingSession();
    fx.engine.getSession(sessionId).evaluationResult = evaluation(0.4);
    const res = await fx.call<LateralResponse>({ action: 'evolve_lateral', sessionId });
    return { sessionId, persona: res.lateralContext!.persona };
  }

  it('sessionId가 없으면 에러를 돌려준다', async () => {
    const res = await fx.call<LateralResultResponse>({ action: 'evolve_lateral_result' });
    expect(res.error).toContain('sessionId is required');
  });

  it('lateralResult가 없으면 에러를 돌려준다', async () => {
    const { sessionId } = await lateralSession();
    const res = await fx.call<LateralResultResponse>({
      action: 'evolve_lateral_result',
      sessionId,
    });
    expect(res.error).toContain('lateralResult is required');
  });

  it('AC를 바꾸는 패치면 AC에 걸린 태스크를 다시 돌리라고 re_executing을 돌려준다', async () => {
    const { sessionId, persona } = await lateralSession();
    const res = await fx.call<LateralResultResponse>({
      action: 'evolve_lateral_result',
      sessionId,
      lateralResult: {
        persona: persona as 'multistability',
        specPatch: { acceptanceCriteria: ['AC0 reframed', 'AC1 reframed', 'AC2 reframed'] },
        description: 'reframe',
      },
    });

    expect(res.status).toBe('re_executing');
    expect([...res.impactedTaskIds!].sort()).toEqual(['task-0', 'task-1', 'task-2']);
    expect(res.reExecuteContext).toBeDefined();

    const session = fx.engine.getSession(sessionId);
    expect(session.lateralTriedPersonas).toEqual([persona]);
    expect(session.lateralAttempts).toBe(1);
    expect(session.lateralCurrentPersona).toBeUndefined();
    expect(session.spec.acceptanceCriteria[0]).toBe('AC0 reframed');
  });

  it('재실행할 태스크가 없는 패치면 lateral_patch_applied로 끝낸다', async () => {
    const { sessionId, persona } = await lateralSession();
    const res = await fx.call<LateralResultResponse>({
      action: 'evolve_lateral_result',
      sessionId,
      lateralResult: {
        persona: persona as 'multistability',
        specPatch: { constraints: ['TypeScript', 'No new deps'] },
        description: 'tighten constraints',
      },
    });

    expect(res.status).toBe('lateral_patch_applied');
    expect(res.impactedTaskIds).toEqual([]);
    expect(fx.engine.getSession(sessionId).spec.constraints).toContain('No new deps');
  });

  it('검증에 걸리는 패치면 에러를 돌려주고 스펙은 그대로다', async () => {
    const { sessionId, persona } = await lateralSession();
    const before = [...fx.engine.getSession(sessionId).spec.acceptanceCriteria];

    const res = await fx.call<LateralResultResponse>({
      action: 'evolve_lateral_result',
      sessionId,
      lateralResult: {
        persona: persona as 'multistability',
        specPatch: { acceptanceCriteria: [] },
        description: 'empty',
      },
    });

    expect(res.error).toContain('Invalid spec patch');
    expect(fx.engine.getSession(sessionId).spec.acceptanceCriteria).toEqual(before);
  });

  it('없는 세션이면 에러를 돌려준다', async () => {
    const res = await fx.call<LateralResultResponse>({
      action: 'evolve_lateral_result',
      sessionId: '00000000-0000-0000-0000-000000000000',
      lateralResult: {
        persona: 'simplicity',
        specPatch: { constraints: ['x'] },
        description: 'd',
      },
    });
    expect(res.error).toEqual(expect.any(String));
  });
});
