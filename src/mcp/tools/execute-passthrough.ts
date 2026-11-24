import { real } from '../../conductor/parent-worktree.js';
import type { PassthroughExecuteEngine } from '../../execute/passthrough-engine.js';
import type { ExecuteInput } from '../schemas.js';
import { createHostAdapter, type IHostAdapter } from '../host-adapter.js';
import type { ClientType } from '../../execute/rule-writer.js';
import type { ExecuteHandler } from './execute/types.js';
import {
  handleStart,
  handlePlanStep,
  handlePlanComplete,
  handlePrepareConductor,
} from './execute/planning.js';
import { handleExecuteStart, handleExecuteTask } from './execute/execution.js';
import { handleEvaluate } from './execute/evaluate.js';
import {
  handleEvolveFix,
  handleEvolve,
  handleEvolvePatch,
  handleEvolveReExecute,
  handleEvolveLateral,
  handleEvolveLateralResult,
  handleGateResolve,
} from './execute/evolve.js';
import { handleRoleMatch, handleRoleConsensus } from './execute/roles.js';
import {
  handleStatusAction,
  handleResume,
  handleAudit,
  handleSpawn,
  handleEvolutionViz,
} from './execute/utility.js';
import { formatError, resolveExecuteSessionInput } from './execute/utils.js';

const handlers: Record<string, ExecuteHandler> = {
  start: handleStart,
  prepare_conductor: handlePrepareConductor,
  plan_step: handlePlanStep,
  plan_complete: handlePlanComplete,
  execute_start: handleExecuteStart,
  execute_task: handleExecuteTask,
  evaluate: handleEvaluate,
  status: handleStatusAction,
  resume: handleResume,
  audit: handleAudit,
  spawn: handleSpawn,
  evolve_fix: handleEvolveFix,
  evolve: handleEvolve,
  evolve_patch: handleEvolvePatch,
  evolve_re_execute: handleEvolveReExecute,
  role_match: handleRoleMatch,
  role_consensus: handleRoleConsensus,
  evolve_lateral: handleEvolveLateral,
  evolve_lateral_result: handleEvolveLateralResult,
  gate_resolve: handleGateResolve,
  evolution_viz: handleEvolutionViz,
};

export async function handleExecutePassthrough(
  engine: PassthroughExecuteEngine,
  input: ExecuteInput,
  clientOrAdapter: ClientType | IHostAdapter = 'claude-code',
): Promise<string> {
  const handler = handlers[input.action];
  if (!handler) return formatError(`Unknown action: ${input.action}`);
  const resolved = resolveExecuteSessionInput(engine, input);
  if (!resolved.ok) return formatError(resolved.error);
  const params = resolved.input;
  const blocked = blockWhileAwaitingHuman(engine, params);
  if (blocked) return blocked;

  let assignedWorktree: string | undefined;
  if (params.sessionId) {
    try {
      assignedWorktree = engine.getSession(params.sessionId).assignedWorktree;
    } catch {
      // 기존 핸들러가 세션을 찾지 못한 결과를 돌려준다.
    }
  }
  if (assignedWorktree && params.cwd && real(params.cwd) !== real(assignedWorktree))
    return formatError('이 주문의 작업과 검증은 배정된 워크트리에서 진행해 주세요');

  const bound = assignedWorktree ? { ...params, cwd: assignedWorktree } : params;
  const adapter =
    typeof clientOrAdapter === 'string'
      ? createHostAdapter(clientOrAdapter, bound.cwd)
      : clientOrAdapter;
  return handler(engine, bound, adapter);
}

// 사람의 답을 기다리는 동안에는 흐름을 앞으로 미는 action을 막는다. 상태 조회와 해소만 통과시킨다
const ALLOWED_WHILE_AWAITING_HUMAN = new Set(['status', 'resume', 'gate_resolve', 'evolution_viz']);

function blockWhileAwaitingHuman(
  engine: PassthroughExecuteEngine,
  input: ExecuteInput,
): string | null {
  if (!input.sessionId || ALLOWED_WHILE_AWAITING_HUMAN.has(input.action)) return null;
  let status: string;
  try {
    status = engine.getSession(input.sessionId).status;
  } catch {
    return null;
  }
  if (status !== 'awaiting_human') return null;
  return formatError(
    `Session is awaiting a human decision. Resolve the open gate with gate_resolve before "${input.action}".`,
  );
}
