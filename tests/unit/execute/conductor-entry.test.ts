import { describe, expect, it } from 'vitest';
import { PassthroughEngine } from '../../../src/interview/passthrough-engine.js';
import { PassthroughSpecGenerator } from '../../../src/spec/passthrough-generator.js';
import { handleSpecPassthrough } from '../../../src/mcp/tools/spec-passthrough.js';
import { executeInputSchema, specInputSchema } from '../../../src/mcp/schemas.js';
import { EventType } from '../../../src/events/types.js';
import {
  createExecuteFixture,
  makeSpec,
  makeTask,
  planningSteps,
  RecordingAdapter,
} from '../../helpers/execute-fixture.js';

describe('인터뷰, 스펙, 실행의 컨덕터 준비 진입점', () => {
  it('완료한 인터뷰의 Spec과 계획을 생성하고 세 출발점에서 같은 계획을 찾는다', async () => {
    const fx = createExecuteFixture('conductor-entry');
    try {
      const interviews = new PassthroughEngine(fx.store);
      const specs = new PassthroughSpecGenerator(fx.store);
      const started = interviews.start('예약 취소 안내');
      if (!started.ok) throw started.error;
      const sessionId = started.value.session.sessionId;
      const specCall = (input: Record<string, unknown>) =>
        JSON.parse(
          handleSpecPassthrough(
            interviews,
            specs,
            specInputSchema.parse(input),
            undefined,
            fx.store,
          ),
        );
      expect(specCall({ sessionId, reuse: true }).error).toContain('완료된 인터뷰');
      expect(fx.engine.listSessions()).toHaveLength(0);
      expect(fx.store.listAggregates('spec')).toHaveLength(0);

      // 사람이 기준 미달 완료를 승인한 경우의 실제 기록을 사용한다.
      const done = interviews.complete(sessionId, true);
      if (!done.ok) throw done.error;
      expect(fx.store.listAggregates('spec')).toHaveLength(0);
      const draft = makeSpec();
      expect(specCall({ sessionId, reuse: true, force: true }).status).toBe('prompt');
      expect(
        specCall({ sessionId, reuse: true, force: true, spec: { ...draft, goal: '' } }).error,
      ).toContain('Spec validation failed');
      expect(fx.engine.listSessions()).toHaveLength(0);

      const { spec } = specCall({ sessionId, reuse: true, force: true, spec: draft });
      expect(spec.metadata.interviewSessionId).toBe(sessionId);
      expect(fx.engine.listSessions()).toHaveLength(0);
      const specId = spec.metadata.specId;
      const fromInterview = specCall({ sessionId, reuse: true }).spec;
      const fromSpec = specCall({ specId }).spec;
      expect(fromInterview).toEqual(fromSpec);
      expect(fx.store.listAggregates('spec')).toHaveLength(1);

      const execute = (input: Record<string, unknown>) => fx.call(executeInputSchema.parse(input));
      const start = await execute({ action: 'prepare_conductor', spec: fromInterview });
      const execId = start['sessionId'] as string;
      const [first, ...rest] = planningSteps(spec);
      await execute({ action: 'plan_step', sessionId: execId, stepResult: first });
      const resumed = await execute({ action: 'prepare_conductor', spec: fromSpec });
      expect(resumed).toMatchObject({
        sessionId: execId,
        stepsCompleted: 1,
        nextAction: 'plan_step',
      });
      for (const stepResult of rest)
        await execute({ action: 'plan_step', sessionId: execId, stepResult });
      const result = await execute({ action: 'plan_complete', sessionId: execId, conductor: true });
      expect(result).toMatchObject({ status: 'ready_for_conductor', sessionId: execId, specId });
      expect(result['nextAction']).toBeUndefined();
      const byPlan = await execute({ action: 'prepare_conductor', planId: result['planId'] });
      const bySession = await execute({ action: 'prepare_conductor', sessionId: execId });
      const bySpec = await execute({ action: 'prepare_conductor', spec });
      expect([byPlan, bySession, bySpec]).toEqual([result, result, result]);
      expect(fx.engine.listSessions()).toHaveLength(1);
      expect(
        fx.store
          .getByAggregate('execute', execId)
          .some((event) => event.eventType === EventType.EXECUTE_EXECUTION_STARTED),
      ).toBe(false);
    } finally {
      fx.close();
    }
  });

  it('기본 스펙 호출은 Spec 생성으로 끝난다', () => {
    const fx = createExecuteFixture('conductor-default-spec');
    try {
      const interviews = new PassthroughEngine(fx.store);
      const specs = new PassthroughSpecGenerator(fx.store);
      const started = interviews.start('정산 내역 조회');
      if (!started.ok) throw started.error;
      const sessionId = started.value.session.sessionId;
      const completed = interviews.complete(sessionId, true);
      if (!completed.ok) throw completed.error;
      const response = handleSpecPassthrough(
        interviews,
        specs,
        specInputSchema.parse({
          sessionId,
          force: true,
          spec: makeSpec(),
        }),
        undefined,
        fx.store,
      );
      expect(JSON.parse(response)).toMatchObject({ status: 'generated' });
      expect(fx.engine.listSessions()).toHaveLength(0);
    } finally {
      fx.close();
    }
  });

  it('실행의 기본 종료 지점과 옵션 경로의 실행 차단을 확인한다', async () => {
    const fx = createExecuteFixture('conductor-default-execute');
    try {
      const { sessionId } = fx.plannedSession();
      const ready = await fx.call({ action: 'plan_complete', sessionId });
      expect(ready).toMatchObject({ status: 'plan_complete', nextAction: 'execute_start' });
      const adapter = new RecordingAdapter();
      await expect(
        fx.call({ action: 'execute_start', sessionId, conductor: true }, adapter),
      ).resolves.toHaveProperty('error');
      expect(adapter.written).toHaveLength(0);
      await expect(fx.call({ action: 'execute_start', sessionId }, adapter)).resolves.toMatchObject(
        { status: 'executing' },
      );
      const rejected = await fx.call({ action: 'prepare_conductor', sessionId });
      expect(rejected['error']).toContain('구현을 시작하기 전');
    } finally {
      fx.close();
    }
  });

  it('서버가 의존성 순환을 되감은 계획은 접수 준비로 보지 않는다', async () => {
    const fx = createExecuteFixture('conductor-invalid-dag');
    try {
      const { sessionId, spec } = fx.startedSession(makeSpec(['AC0', 'AC1']));
      const steps = planningSteps(spec, [makeTask('a', ['b'], 0), makeTask('b', ['a'], 1)]);
      for (const stepResult of steps) await fx.call({ action: 'plan_step', sessionId, stepResult });
      const result = await fx.call({ action: 'plan_complete', sessionId, conductor: true });
      expect(result).toHaveProperty('error');
      expect(fx.engine.getSession(sessionId).executionPlan).toBeUndefined();
    } finally {
      fx.close();
    }
  });
});
