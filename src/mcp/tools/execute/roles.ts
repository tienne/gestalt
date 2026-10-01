import type { PassthroughExecuteEngine } from '../../../execute/passthrough-engine.js';
import type { ExecuteInput } from '../../schemas.js';
import type { NextActionGuide } from '../../../core/types.js';
import type { IHostAdapter } from '../../host-adapter.js';
import { formatError } from './utils.js';

export function handleRoleMatch(
  engine: PassthroughExecuteEngine,
  input: ExecuteInput,
  _adapter: IHostAdapter,
): string {
  if (!input.sessionId) return formatError('sessionId is required for role_match action');

  const rmResult = engine.roleMatch(input.sessionId, input.matchResult);
  if (!rmResult.ok) return formatError(rmResult.error.message);

  const { matchContext, perspectivePrompts } = rmResult.value;

  if (matchContext) {
    const roleMatchCall1Guide: NextActionGuide = {
      nextAction: 'role_match',
      nextActionParams: { sessionId: rmResult.value.session.sessionId },
      hint: 'matchContext를 사용해 관련 Role Agent를 선택하고 matchResult를 제출하세요.',
    };
    return JSON.stringify(
      {
        status: 'role_matching',
        sessionId: rmResult.value.session.sessionId,
        matchContext,
        message:
          'Use matchContext.systemPrompt + matchContext.matchingPrompt to determine which role agents match this task. Submit matchResult with role_match.',
        ...roleMatchCall1Guide,
      },
      null,
      2,
    );
  }

  // 관점이 하나도 없으면 role_consensus는 perspectives 없이 불려 에러로 끝난다
  const hasPerspectives = (perspectivePrompts?.length ?? 0) > 0;
  const roleMatchCall2Guide: NextActionGuide = hasPerspectives
    ? {
        nextAction: 'role_consensus',
        nextActionParams: { sessionId: rmResult.value.session.sessionId },
        hint: '각 에이전트의 관점을 생성하고 perspectives를 제출하세요.',
      }
    : {
        nextAction: 'execute_task',
        nextActionParams: { sessionId: rmResult.value.session.sessionId },
        hint: '매칭된 에이전트가 없습니다. 바로 태스크를 실행하세요.',
      };
  return JSON.stringify(
    {
      status: 'role_matched',
      sessionId: rmResult.value.session.sessionId,
      perspectivePrompts: perspectivePrompts ?? [],
      matchCount: perspectivePrompts?.length ?? 0,
      message: perspectivePrompts?.length
        ? `${perspectivePrompts.length} agents matched. Use each perspectivePrompt for parallel LLM calls, then submit perspectives with role_consensus.`
        : 'No agents matched. Proceed directly to execute_task.',
      ...roleMatchCall2Guide,
    },
    null,
    2,
  );
}

export function handleRoleConsensus(
  engine: PassthroughExecuteEngine,
  input: ExecuteInput,
  _adapter: IHostAdapter,
): string {
  if (!input.sessionId) return formatError('sessionId is required for role_consensus action');

  const rcResult = engine.roleConsensus(input.sessionId, input.perspectives, input.consensus);
  if (!rcResult.ok) return formatError(rcResult.error.message);

  const { synthesisContext, roleGuidance } = rcResult.value;

  if (synthesisContext) {
    const roleConsensusCall1Guide: NextActionGuide = {
      nextAction: 'role_consensus',
      nextActionParams: { sessionId: rcResult.value.session.sessionId },
      hint: 'synthesisContext를 사용해 관점을 통합하고 consensus를 제출하세요.',
    };
    return JSON.stringify(
      {
        status: 'synthesizing',
        sessionId: rcResult.value.session.sessionId,
        synthesisContext,
        message:
          'Use synthesisContext.systemPrompt + synthesisContext.synthesisPrompt to synthesize consensus. Submit consensus with role_consensus.',
        ...roleConsensusCall1Guide,
      },
      null,
      2,
    );
  }

  const roleConsensusCall2Guide: NextActionGuide = {
    nextAction: 'execute_task',
    nextActionParams: { sessionId: rcResult.value.session.sessionId },
    hint: 'roleGuidance를 참조해 태스크를 실행하세요.',
  };
  return JSON.stringify(
    {
      status: 'consensus_complete',
      sessionId: rcResult.value.session.sessionId,
      roleGuidance,
      message:
        'Role consensus stored. Use roleGuidance to inform task implementation, then submit with execute_task.',
      ...roleConsensusCall2Guide,
    },
    null,
    2,
  );
}
