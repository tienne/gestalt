import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function repoForPlanning(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'gestalt-conductor-entry-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/acme/${name}.git`], {
    cwd: root,
  });
  return root;
}

describe('인터뷰, 스펙, 실행의 컨덕터 준비 진입점', () => {
  it('완료한 인터뷰의 Spec과 계획을 생성하고 세 출발점에서 같은 계획을 찾는다', async () => {
    const fx = createExecuteFixture('conductor-entry');
    const root = repoForPlanning('entry');
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

      const execute = (input: Record<string, unknown>) =>
        fx.call(executeInputSchema.parse({ codeGraphRepoRoot: root, ...input }));
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
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('현재 레포의 계획만 자동 선택하고 다른 레포의 명시적 계획은 거절한다', async () => {
    const fx = createExecuteFixture('conductor-plan-repo');
    const first = mkdtempSync(join(tmpdir(), 'gestalt-conductor-a-'));
    const second = mkdtempSync(join(tmpdir(), 'gestalt-conductor-b-'));
    const spec = makeSpec();
    try {
      execFileSync('git', ['init', '-q', first]);
      execFileSync('git', ['init', '-q', second]);
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/first.git'], {
        cwd: first,
      });
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/second.git'], {
        cwd: second,
      });
      const a = await fx.call({ action: 'prepare_conductor', spec, codeGraphRepoRoot: first });
      const aSessionId = a['sessionId'] as string;
      for (const stepResult of planningSteps(spec))
        await fx.call({ action: 'plan_step', sessionId: aSessionId, stepResult });
      const aPlan = await fx.call({
        action: 'plan_complete',
        sessionId: aSessionId,
        conductor: true,
      });
      const rejected = await fx.call({
        action: 'prepare_conductor',
        planId: aPlan['planId'] as string,
        codeGraphRepoRoot: second,
      });
      expect(rejected['error']).toContain('대상 레포');
      const b = await fx.call({ action: 'prepare_conductor', spec, codeGraphRepoRoot: second });
      expect(b).toMatchObject({ status: 'started', nextAction: 'plan_step' });
      expect(b['sessionId']).not.toBe(aSessionId);
      const reused = await fx.call({ action: 'prepare_conductor', spec, codeGraphRepoRoot: first });
      expect(reused).toEqual(aPlan);
      execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/acme/second.git'], {
        cwd: first,
      });
      const rediscovered = await fx.call({
        action: 'prepare_conductor',
        spec,
        codeGraphRepoRoot: first,
      });
      expect(rediscovered['sessionId']).toBe(b['sessionId']);
    } finally {
      fx.close();
      for (const directory of [first, second]) rmSync(directory, { recursive: true, force: true });
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

  it('플래그 없는 실행은 계획을 만든 뒤 origin을 지워도 이어진다', async () => {
    const fx = createExecuteFixture('conductor-unbound-local');
    const root = repoForPlanning('ordinary');
    try {
      const { sessionId } = fx.plannedSession(undefined, undefined, root);
      expect(fx.engine.getSession(sessionId).targetRepository?.name).toBe('acme/ordinary');
      execFileSync('git', ['remote', 'remove', 'origin'], { cwd: root });
      await expect(
        fx.call({ action: 'execute_start', sessionId, cwd: root }),
      ).resolves.toMatchObject({ status: 'executing' });
    } finally {
      fx.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('레포를 확인하지 못한 계획은 접수 준비 완료 대신 사유와 다음 조치를 준다', async () => {
    const fx = createExecuteFixture('conductor-no-repo');
    try {
      const { sessionId } = fx.plannedSession();
      const result = await fx.call({ action: 'plan_complete', sessionId, conductor: true });
      expect(result).toMatchObject({
        sessionId,
        error: expect.stringContaining('기준 레포가 기록되지 않았어요'),
        nextStep: expect.stringContaining('Spec으로 계획'),
      });
      expect(result).not.toHaveProperty('status', 'ready_for_conductor');
      expect(fx.engine.getSession(sessionId).planBoundaryError).toContain('기준 레포');
    } finally {
      fx.close();
    }
  });

  it.each(['changed', 'missing'])(
    '플래그로 준비한 뒤 origin이 %s이면 원인과 맞는 다음 조치를 준다',
    async (change) => {
      const fx = createExecuteFixture('conductor-origin-error');
      const root = repoForPlanning('before');
      const other = repoForPlanning('before');
      const spec = makeSpec();
      try {
        const started = await fx.call({
          action: 'prepare_conductor',
          spec,
          codeGraphRepoRoot: root,
        });
        const sessionId = started['sessionId'] as string;
        for (const stepResult of planningSteps(spec)) {
          await fx.call({ action: 'plan_step', sessionId, stepResult });
        }
        const args =
          change === 'changed'
            ? ['set-url', 'origin', 'https://github.com/acme/after.git']
            : ['remove', 'origin'];
        execFileSync('git', ['remote', ...args], { cwd: root });
        const stopped = await fx.call({
          action: 'plan_complete',
          sessionId,
          conductor: true,
          cwd: other,
        });
        expect(stopped).toMatchObject({
          error: expect.stringContaining(change === 'changed' ? 'acme/after' : '확인할 수 없어요'),
          nextStep: expect.stringContaining(
            change === 'changed' ? 'Spec으로 계획' : 'origin이 acme/before',
          ),
        });
        expect(stopped).not.toHaveProperty('status', 'ready_for_conductor');
        expect(stopped['nextStep']).toContain(root);
        expect(stopped['nextStep']).not.toContain(other);
        const restore = change === 'changed' ? 'set-url' : 'add';
        expect(stopped['nextStep']).toContain(`git remote ${restore} origin`);
        execFileSync('git', ['remote', restore, 'origin', 'https://github.com/acme/before.git'], {
          cwd: root,
        });
        await expect(
          fx.call({ action: 'plan_complete', sessionId, conductor: true, cwd: other }),
        ).resolves.toMatchObject({ status: 'ready_for_conductor', sessionId });
      } finally {
        fx.close();
        rmSync(root, { recursive: true, force: true });
        rmSync(other, { recursive: true, force: true });
      }
    },
  );

  it('origin이 없는 레포에서 처음 준비하면 계획을 만들지 않고 다음 조치를 준다', async () => {
    const fx = createExecuteFixture('conductor-missing-initial-origin');
    const root = repoForPlanning('initial');
    try {
      execFileSync('git', ['remote', 'remove', 'origin'], { cwd: root });
      const stopped = await fx.call({
        action: 'prepare_conductor',
        spec: makeSpec(),
        codeGraphRepoRoot: root,
      });
      expect(stopped).toMatchObject({
        error: expect.stringContaining('확인할 수 없어요'),
        nextStep: expect.stringContaining('origin'),
      });
      expect(fx.engine.listSessions()).toHaveLength(0);
    } finally {
      fx.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('서버가 의존성 순환을 되감은 계획은 접수 준비로 보지 않는다', async () => {
    const fx = createExecuteFixture('conductor-invalid-dag');
    const root = repoForPlanning('dag');
    try {
      const { sessionId, spec } = fx.startedSession(makeSpec(['AC0', 'AC1']), root);
      const steps = planningSteps(spec, [makeTask('a', ['b'], 0), makeTask('b', ['a'], 1)]);
      for (const stepResult of steps) await fx.call({ action: 'plan_step', sessionId, stepResult });
      const result = await fx.call({ action: 'plan_complete', sessionId, conductor: true });
      expect(result).toHaveProperty('error');
      expect(fx.engine.getSession(sessionId).executionPlan).toBeUndefined();
    } finally {
      fx.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
