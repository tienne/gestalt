import { z } from 'zod';
import type { ExecuteSession } from '../core/types.js';
import { executionPlanSchema } from '../execute/plan-schema.js';
import { validateDAG } from '../execute/dag-validator.js';
import { computeParallelGroups } from '../execute/parallel-groups.js';
import { specSchema } from '../spec/schema.js';

const preparedPlanSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().uuid(),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  spec: specSchema,
  plan: executionPlanSchema,
});

export type PreparedPlan = z.infer<typeof preparedPlanSchema>;

export function preparedPlanSourceRef(planId: string): string {
  return `prepared-plan:${planId}`;
}

export function readPreparedPlan(value: unknown): PreparedPlan {
  const prepared = preparedPlanSchema.parse(value);
  return {
    ...prepared,
    plan: validatePlan(prepared.spec, prepared.plan),
  };
}

function validatePlan(
  spec: PreparedPlan['spec'],
  plan: PreparedPlan['plan'],
): PreparedPlan['plan'] {
  if (spec.metadata.specId !== plan.specId) throw new Error('Spec과 실행 계획의 ID가 달라요');
  if (plan.atomicTasks.length === 0) throw new Error('실행 계획에 태스크가 없어요');
  const dag = validateDAG(plan.atomicTasks, plan.taskGroups);
  if (!plan.dagValidation.isValid || !dag.isValid)
    throw new Error('실행 계획의 의존성이 유효하지 않아요');
  return {
    ...plan,
    dagValidation: dag,
    parallelGroups: computeParallelGroups(plan.atomicTasks, dag.topologicalOrder),
  };
}

export function validateFinalizedSession(session: ExecuteSession): PreparedPlan['plan'] {
  if (session.status !== 'plan_complete' || !session.executionPlan)
    throw new Error('구현을 시작하기 전에 공식 실행 계획을 확정해 주세요');
  return validatePlan(
    specSchema.parse(session.spec),
    executionPlanSchema.parse(session.executionPlan),
  );
}

export function prepareOrderPlan(session: ExecuteSession, repo: string): PreparedPlan {
  return preparedPlanSchema.parse({
    version: 1,
    sessionId: session.sessionId,
    repo,
    spec: session.spec,
    plan: validateFinalizedSession(session),
  });
}
