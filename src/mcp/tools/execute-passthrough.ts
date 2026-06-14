import type { PassthroughExecuteEngine } from '../../execute/passthrough-engine.js';
import type { ExecuteInput } from '../schemas.js';
import { createHostAdapter, type IHostAdapter } from '../host-adapter.js';
import type { ClientType } from '../../execute/rule-writer.js';
import type { ExecuteHandler } from './execute/types.js';
import { handleStart, handlePlanStep, handlePlanComplete } from './execute/planning.js';
import { handleExecuteStart, handleExecuteTask } from './execute/execution.js';
import { handleEvaluate } from './execute/evaluate.js';
import {
  handleEvolveFix,
  handleEvolve,
  handleEvolvePatch,
  handleEvolveReExecute,
  handleEvolveLateral,
  handleEvolveLateralResult,
} from './execute/evolve.js';
import { handleRoleMatch, handleRoleConsensus } from './execute/roles.js';
import {
  handleStatusAction,
  handleResume,
  handleAudit,
  handleSpawn,
  handleEvolutionViz,
} from './execute/utility.js';
import { formatError } from './execute/utils.js';

const handlers: Record<string, ExecuteHandler> = {
  start: handleStart,
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
  evolution_viz: handleEvolutionViz,
};

export async function handleExecutePassthrough(
  engine: PassthroughExecuteEngine,
  input: ExecuteInput,
  clientOrAdapter: ClientType | IHostAdapter = 'claude-code',
): Promise<string> {
  const handler = handlers[input.action];
  if (!handler) return formatError(`Unknown action: ${input.action}`);
  const adapter =
    typeof clientOrAdapter === 'string'
      ? createHostAdapter(clientOrAdapter, input.cwd)
      : clientOrAdapter;
  return handler(engine, input, adapter);
}
