import type { PassthroughExecuteEngine } from '../../../execute/passthrough-engine.js';
import type { ExecuteInput } from '../../schemas.js';
import type { NextActionGuide } from '../../../core/types.js';
import { gestaltNotify } from '../../../utils/notifier.js';
import {
  deleteGestaltRule,
  deleteActiveSession,
  updateGestaltRule,
  type ClientType,
} from '../../../execute/rule-writer.js';
import { formatError } from './utils.js';

export function handleEvolveFix(
  engine: PassthroughExecuteEngine,
  input: ExecuteInput,
  _client: ClientType,
): string {
  if (!input.sessionId) return formatError('sessionId is required for evolve_fix action');

  const fixResult = engine.startStructuralFix(input.sessionId, input.fixTasks);
  if (!fixResult.ok) return formatError(fixResult.error.message);

  const { fixContext } = fixResult.value;

  if (fixContext) {
    const evolveFixGuide: NextActionGuide = {
      nextAction: 'evolve_fix',
      nextActionParams: { sessionId: fixResult.value.session.sessionId },
      hint: 'fixContext에 따라 lint/build/test 오류를 수정하세요.',
    };
    return JSON.stringify(
      {
        status: 'evolving',
        sessionId: fixResult.value.session.sessionId,
        stage: 'fix',
        fixContext,
        message:
          'Structural failures detected. Use fixContext to generate fix tasks, then re-submit with fixTasks.',
        ...evolveFixGuide,
      },
      null,
      2,
    );
  }

  const evolveFixAppliedGuide: NextActionGuide = {
    nextAction: 'evaluate',
    nextActionParams: { sessionId: fixResult.value.session.sessionId },
    hint: 'fixContext에 따라 lint/build/test 오류를 수정하세요.',
  };
  return JSON.stringify(
    {
      status: 'fix_applied',
      sessionId: fixResult.value.session.sessionId,
      message: 'Fix tasks recorded. Call evaluate to re-run structural checks.',
      ...evolveFixAppliedGuide,
    },
    null,
    2,
  );
}

export function handleEvolve(
  engine: PassthroughExecuteEngine,
  input: ExecuteInput,
  client: ClientType,
): string {
  if (!input.sessionId) return formatError('sessionId is required for evolve action');

  const evolveResult = engine.startContextualEvolve(input.sessionId, input.terminateReason);
  if (!evolveResult.ok) return formatError(evolveResult.error.message);

  if (evolveResult.value.lateralContext) {
    const evolveLateralGuide: NextActionGuide = {
      nextAction: 'evolve_lateral_result',
      nextActionParams: { sessionId: evolveResult.value.session.sessionId },
      hint: 'lateralContext.lateralPrompt를 사용해 관점 전환 결과를 제출하세요.',
    };
    return JSON.stringify(
      {
        status: 'lateral_thinking',
        sessionId: evolveResult.value.session.sessionId,
        lateralContext: evolveResult.value.lateralContext,
        message: `Stagnation detected. Lateral thinking activated: ${evolveResult.value.lateralContext.persona} persona (attempt ${evolveResult.value.lateralContext.attemptNumber}/4). Use lateralContext to generate a lateral SpecPatch, then submit with evolve_lateral_result.`,
        ...evolveLateralGuide,
      },
      null,
      2,
    );
  }

  if (evolveResult.value.humanEscalation) {
    if (input.cwd) {
      try {
        deleteGestaltRule(input.cwd, client);
        deleteActiveSession(input.cwd);
      } catch {
        /* ignore */
      }
    }
    gestaltNotify({
      event: 'human_escalation',
      message: '⚠️ Human Escalation — 모든 Lateral Thinking 소진, 수동 개입이 필요해요',
    });
    return JSON.stringify(
      {
        status: 'human_escalation',
        sessionId: evolveResult.value.session.sessionId,
        terminationReason: 'human_escalation',
        escalationContext: evolveResult.value.humanEscalation,
        evolutionHistory: evolveResult.value.session.evolutionHistory.map((g) => ({
          generation: g.generation,
          score: g.evaluationScore,
          goalAlignment: g.goalAlignment,
          fieldsChanged: g.delta.fieldsChanged,
        })),
        message: 'All lateral thinking personas exhausted. Human intervention required.',
      },
      null,
      2,
    );
  }

  if (evolveResult.value.terminated) {
    if (input.cwd) {
      try {
        deleteGestaltRule(input.cwd, client);
        deleteActiveSession(input.cwd);
      } catch {
        /* ignore */
      }
    }
    gestaltNotify({
      event: 'terminated',
      message: `세션 종료: ${evolveResult.value.terminationReason ?? 'unknown'}`,
    });
    return JSON.stringify(
      {
        status: 'terminated',
        sessionId: evolveResult.value.session.sessionId,
        terminationReason: evolveResult.value.terminationReason,
        evolutionHistory: evolveResult.value.session.evolutionHistory.map((g) => ({
          generation: g.generation,
          score: g.evaluationScore,
          goalAlignment: g.goalAlignment,
          fieldsChanged: g.delta.fieldsChanged,
        })),
        message: `Evolution terminated: ${evolveResult.value.terminationReason}.`,
      },
      null,
      2,
    );
  }

  const evolveGuide: NextActionGuide = {
    nextAction: 'evolve_patch',
    nextActionParams: { sessionId: evolveResult.value.session.sessionId },
    hint: 'evolveContext에 따라 specPatch를 작성하세요.',
  };
  return JSON.stringify(
    {
      status: 'evolving',
      sessionId: evolveResult.value.session.sessionId,
      stage: 'evolve',
      evolveContext: evolveResult.value.evolveContext,
      message: 'Use evolveContext to generate a Spec patch, then submit with evolve_patch.',
      ...evolveGuide,
    },
    null,
    2,
  );
}

export function handleEvolvePatch(
  engine: PassthroughExecuteEngine,
  input: ExecuteInput,
  client: ClientType,
): string {
  if (!input.sessionId) return formatError('sessionId is required for evolve_patch action');
  if (!input.specPatch) return formatError('specPatch is required for evolve_patch action');

  const patchResult = engine.submitSpecPatch(input.sessionId, input.specPatch);
  if (!patchResult.ok) return formatError(patchResult.error.message);

  const { impactedTaskIds, reExecuteContext } = patchResult.value;

  if (input.cwd) {
    try {
      const patchedSession = patchResult.value.session;
      updateGestaltRule(
        input.cwd,
        { goal: patchedSession.spec.goal, constraints: patchedSession.spec.constraints },
        null,
        client,
      );
    } catch {
      // Rule file update failure should not block execution
    }
  }

  if (impactedTaskIds.length === 0) {
    const evolvePatchNoTasksGuide: NextActionGuide = {
      nextAction: 'evaluate',
      nextActionParams: { sessionId: patchResult.value.session.sessionId },
      hint: 'impactedTaskIds의 태스크를 재실행하세요.',
    };
    return JSON.stringify(
      {
        status: 'patch_applied',
        sessionId: patchResult.value.session.sessionId,
        impactedTaskIds: [],
        message: 'Spec patched. No tasks need re-execution. Call evaluate to re-assess.',
        ...evolvePatchNoTasksGuide,
      },
      null,
      2,
    );
  }

  const evolvePatchGuide: NextActionGuide = {
    nextAction: 'evolve_re_execute',
    nextActionParams: { sessionId: patchResult.value.session.sessionId },
    hint: 'impactedTaskIds의 태스크를 재실행하세요.',
  };
  return JSON.stringify(
    {
      status: 're_executing',
      sessionId: patchResult.value.session.sessionId,
      impactedTaskIds,
      reExecuteContext,
      message: `Spec patched. ${impactedTaskIds.length} tasks need re-execution. Use reExecuteContext to implement the task.`,
      ...evolvePatchGuide,
    },
    null,
    2,
  );
}

export function handleEvolveReExecute(
  engine: PassthroughExecuteEngine,
  input: ExecuteInput,
  _client: ClientType,
): string {
  if (!input.sessionId) return formatError('sessionId is required for evolve_re_execute action');
  if (!input.reExecuteTaskResult)
    return formatError('reExecuteTaskResult is required for evolve_re_execute action');

  const reExecResult = engine.submitReExecuteTaskResult(input.sessionId, input.reExecuteTaskResult);
  if (!reExecResult.ok) return formatError(reExecResult.error.message);

  const { reExecuteContext: nextContext, allTasksCompleted } = reExecResult.value;

  if (allTasksCompleted) {
    const reExecDoneGuide: NextActionGuide = {
      nextAction: 'evaluate',
      nextActionParams: { sessionId: reExecResult.value.session.sessionId },
      hint: '재실행 완료. evaluate를 다시 호출하세요.',
    };
    return JSON.stringify(
      {
        status: 're_execute_complete',
        sessionId: reExecResult.value.session.sessionId,
        message: 'All impacted tasks re-executed. Call evaluate to re-assess.',
        ...reExecDoneGuide,
      },
      null,
      2,
    );
  }

  const reExecGuide: NextActionGuide = {
    nextAction: 'evolve_re_execute',
    nextActionParams: { sessionId: reExecResult.value.session.sessionId },
    hint: '재실행 계속. 남은 태스크를 완료하세요.',
  };
  return JSON.stringify(
    {
      status: 're_executing',
      sessionId: reExecResult.value.session.sessionId,
      reExecuteContext: nextContext,
      message: 'Task recorded. Use reExecuteContext to implement the next re-execution task.',
      ...reExecGuide,
    },
    null,
    2,
  );
}

export function handleEvolveLateral(
  engine: PassthroughExecuteEngine,
  input: ExecuteInput,
  client: ClientType,
): string {
  if (!input.sessionId) return formatError('sessionId is required for evolve_lateral action');

  const lateralResult = engine.startLateralEvolve(input.sessionId);
  if (!lateralResult.ok) return formatError(lateralResult.error.message);

  if (lateralResult.value.terminated) {
    if (input.cwd) {
      try {
        deleteGestaltRule(input.cwd, client);
        deleteActiveSession(input.cwd);
      } catch {
        /* ignore */
      }
    }
    return JSON.stringify(
      {
        status:
          lateralResult.value.terminationReason === 'human_escalation'
            ? 'human_escalation'
            : 'terminated',
        sessionId: lateralResult.value.session.sessionId,
        terminationReason: lateralResult.value.terminationReason,
        ...(lateralResult.value.humanEscalation
          ? { escalationContext: lateralResult.value.humanEscalation }
          : {}),
        message:
          lateralResult.value.terminationReason === 'human_escalation'
            ? 'All lateral thinking personas exhausted. Human intervention required.'
            : `Evolution terminated: ${lateralResult.value.terminationReason}.`,
      },
      null,
      2,
    );
  }

  if (lateralResult.value.lateralContext) {
    return JSON.stringify(
      {
        status: 'lateral_thinking',
        sessionId: lateralResult.value.session.sessionId,
        lateralContext: lateralResult.value.lateralContext,
        message: `Lateral thinking: ${lateralResult.value.lateralContext.persona} persona (attempt ${lateralResult.value.lateralContext.attemptNumber}/4). Use lateralContext to generate a lateral SpecPatch, then submit with evolve_lateral_result.`,
      },
      null,
      2,
    );
  }

  return formatError('Unexpected state in evolve_lateral');
}

export function handleEvolveLateralResult(
  engine: PassthroughExecuteEngine,
  input: ExecuteInput,
  _client: ClientType,
): string {
  if (!input.sessionId)
    return formatError('sessionId is required for evolve_lateral_result action');
  if (!input.lateralResult)
    return formatError('lateralResult is required for evolve_lateral_result action');

  const lrResult = engine.submitLateralResult(input.sessionId, input.lateralResult);
  if (!lrResult.ok) return formatError(lrResult.error.message);

  const { impactedTaskIds, reExecuteContext: lrReExecCtx } = lrResult.value;

  if (impactedTaskIds.length === 0) {
    return JSON.stringify(
      {
        status: 'lateral_patch_applied',
        sessionId: lrResult.value.session.sessionId,
        impactedTaskIds: [],
        message:
          'Lateral spec patch applied. No tasks need re-execution. Call evaluate to re-assess.',
      },
      null,
      2,
    );
  }

  return JSON.stringify(
    {
      status: 're_executing',
      sessionId: lrResult.value.session.sessionId,
      impactedTaskIds,
      reExecuteContext: lrReExecCtx,
      message: `Lateral spec patch applied. ${impactedTaskIds.length} tasks need re-execution. Use reExecuteContext to implement the task.`,
    },
    null,
    2,
  );
}
