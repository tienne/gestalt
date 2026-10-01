import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PassthroughExecuteEngine } from '../../src/execute/passthrough-engine.js';
import { EventStore } from '../../src/events/store.js';
import { validateDAG } from '../../src/execute/dag-validator.js';
import { handleExecutePassthrough } from '../../src/mcp/tools/execute-passthrough.js';
import type { ExecuteInput } from '../../src/mcp/schemas.js';
import type { IHostAdapter } from '../../src/mcp/host-adapter.js';
import type { RoleAgentRegistry } from '../../src/agent/role-agent-registry.js';
import type {
  Spec,
  AtomicTask,
  TaskGroup,
  FigureGroundResult,
  ClosureResult,
  ProximityResult,
  ContinuityResult,
} from '../../src/core/types.js';

export function makeSpec(acceptanceCriteria = ['AC0', 'AC1', 'AC2']): Spec {
  return {
    version: '1.0',
    goal: 'Handler test goal',
    constraints: ['TypeScript'],
    acceptanceCriteria,
    ontologySchema: {
      entities: [{ name: 'Task', description: 'A task', attributes: ['taskId'] }],
      relations: [{ from: 'Task', to: 'Task', type: 'depends_on' }],
    },
    gestaltAnalysis: [{ principle: 'closure', finding: 'fixture', confidence: 0.9 }],
    metadata: {
      specId: `spec-${randomUUID()}`,
      interviewSessionId: `interview-${randomUUID()}`,
      resolutionScore: 0.85,
      generatedAt: new Date().toISOString(),
    },
  };
}

export function makeTask(taskId: string, dependsOn: string[], acIndex: number): AtomicTask {
  return {
    taskId,
    title: `Task ${taskId}`,
    description: `Implement ${taskId}`,
    sourceAC: [acIndex],
    isImplicit: false,
    estimatedComplexity: 'low',
    dependsOn,
  };
}

/** task-0 → task-1 → task-2, AC 하나에 태스크 하나 */
export const linearTasks: AtomicTask[] = [
  makeTask('task-0', [], 0),
  makeTask('task-1', ['task-0'], 1),
  makeTask('task-2', ['task-1'], 2),
];

export function singleGroup(tasks: AtomicTask[]): TaskGroup[] {
  return [
    {
      groupId: 'group-0',
      name: 'All',
      domain: 'core',
      taskIds: tasks.map((t) => t.taskId),
      reasoning: 'single group',
    },
  ];
}

export function figureGround(spec: Spec): FigureGroundResult {
  return {
    principle: 'figure_ground',
    classifiedACs: spec.acceptanceCriteria.map((acText, acIndex) => ({
      acIndex,
      acText,
      classification: 'figure' as const,
      priority: 'high' as const,
      reasoning: 'Core',
    })),
  };
}

export function planningSteps(spec: Spec, tasks: AtomicTask[] = linearTasks) {
  const groups = singleGroup(tasks);
  const closure: ClosureResult = { principle: 'closure', atomicTasks: tasks };
  const proximity: ProximityResult = { principle: 'proximity', taskGroups: groups };
  const continuity: ContinuityResult = {
    principle: 'continuity',
    dagValidation: validateDAG(tasks, groups),
  };
  return [figureGround(spec), closure, proximity, continuity] as const;
}

/** 파일에 아무것도 안 쓰고 호출 횟수만 센다 */
export class RecordingAdapter implements IHostAdapter {
  written: string[] = [];
  cleared = 0;
  async writeActiveContext(content: string): Promise<void> {
    this.written.push(content);
  }
  async clearActiveContext(): Promise<void> {
    this.cleared += 1;
  }
}

export interface ExecuteFixture {
  store: EventStore;
  engine: PassthroughExecuteEngine;
  dbPath: string;
  /** 핸들러를 거쳐 호출하고 JSON 응답을 파싱해 돌려준다 */
  call<T = Record<string, unknown>>(
    input: Partial<ExecuteInput> & { action: ExecuteInput['action'] },
    adapter?: IHostAdapter,
  ): Promise<T>;
  /** 같은 DB로 엔진을 새로 띄운다. 이벤트 재생으로 복원되는 범위를 볼 때 쓴다 */
  reopen(): PassthroughExecuteEngine;
  /** 엔진 메서드로 start만 마친 세션 */
  startedSession(spec?: Spec): { sessionId: string; spec: Spec };
  /** 플래닝 4단계와 plan_complete까지 마친 세션 */
  plannedSession(tasks?: AtomicTask[], spec?: Spec): { sessionId: string; spec: Spec };
  /** 실행까지 시작한 세션 */
  executingSession(tasks?: AtomicTask[], spec?: Spec): { sessionId: string; spec: Spec };
  close(): void;
}

export function createExecuteFixture(
  name: string,
  roleAgentRegistry?: RoleAgentRegistry,
): ExecuteFixture {
  const dbPath = `.gestalt-test/${name}-${randomUUID()}.db`;
  const store = new EventStore(dbPath);
  const engine = new PassthroughExecuteEngine(store, undefined, roleAgentRegistry);
  const extraStores: EventStore[] = [];

  const fixture: ExecuteFixture = {
    store,
    engine,
    dbPath,
    async call(input, adapter) {
      const raw = await handleExecutePassthrough(
        engine,
        input as ExecuteInput,
        adapter ?? new RecordingAdapter(),
      );
      return JSON.parse(raw);
    },
    reopen() {
      const s = new EventStore(dbPath);
      extraStores.push(s);
      return new PassthroughExecuteEngine(s, undefined, roleAgentRegistry);
    },
    startedSession(spec = makeSpec()) {
      const r = engine.start(spec);
      if (!r.ok) throw r.error;
      return { sessionId: r.value.session.sessionId, spec };
    },
    plannedSession(tasks = linearTasks, spec = makeSpec()) {
      const { sessionId } = fixture.startedSession(spec);
      for (const step of planningSteps(spec, tasks)) {
        const r = engine.planStep(sessionId, step);
        if (!r.ok) throw r.error;
      }
      const done = engine.planComplete(sessionId);
      if (!done.ok) throw done.error;
      return { sessionId, spec };
    },
    executingSession(tasks = linearTasks, spec = makeSpec()) {
      const planned = fixture.plannedSession(tasks, spec);
      const r = engine.startExecution(planned.sessionId);
      if (!r.ok) throw r.error;
      return planned;
    },
    close() {
      for (const s of extraStores) s.close();
      store.close();
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
      }
    },
  };
  return fixture;
}
