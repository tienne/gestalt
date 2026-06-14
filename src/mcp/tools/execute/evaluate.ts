import type { PassthroughExecuteEngine } from '../../../execute/passthrough-engine.js';
import type { ExecuteInput } from '../../schemas.js';
import type { NextActionGuide } from '../../../core/types.js';
import { ProjectMemoryStore } from '../../../memory/project-memory-store.js';
import { gestaltNotify } from '../../../utils/notifier.js';
import {
  deleteGestaltRule,
  deleteActiveSession,
  type ClientType,
} from '../../../execute/rule-writer.js';
import { formatError, stripContextPrompts } from './utils.js';

export function handleEvaluate(
  engine: PassthroughExecuteEngine,
  input: ExecuteInput,
  client: ClientType,
): string {
  const verbose = input.verbose !== false;

  if (!input.sessionId) return formatError('sessionId is required for evaluate action');

  // Call 3: Submit contextual evaluation result
  if (input.evaluationResult) {
    const result = engine.submitEvaluation(input.sessionId, input.evaluationResult);
    if (!result.ok) return formatError(result.error.message);

    const { evaluationResult } = result.value;
    const completedSession = result.value.session;

    // Update project memory on execution completion
    try {
      const memoryStore = new ProjectMemoryStore();
      const completedTasks = completedSession.taskResults
        .filter((t) => t.status === 'completed')
        .map((t) => t.taskId);
      const failedTasks = completedSession.taskResults
        .filter((t) => t.status === 'failed')
        .map((t) => t.taskId);
      const score = evaluationResult?.overallScore ?? 0;
      const goalAlign = evaluationResult?.goalAlignment ?? 0;
      memoryStore.addExecution({
        executeSessionId: completedSession.sessionId,
        specId: completedSession.specId,
        completedTasks,
        failedTasks,
        resultSummary: `Score: ${score.toFixed(2)}, goalAlignment: ${goalAlign.toFixed(2)}`,
        completedAt: new Date().toISOString(),
      });
    } catch {
      // Memory update failure should not block the response
    }

    if (input.cwd) {
      try {
        deleteGestaltRule(input.cwd, client);
        deleteActiveSession(input.cwd);
      } catch {
        // Cleanup failure should not block the response
      }
    }

    const score = evaluationResult!.overallScore;
    const alignment = evaluationResult!.goalAlignment;
    const success = score >= 0.85 && alignment >= 0.8;
    gestaltNotify({
      event: success ? 'evaluation_success' : 'evaluation_failed',
      message: success
        ? `평가 성공 ✓ score: ${score.toFixed(2)}, alignment: ${alignment.toFixed(2)}`
        : `평가 미달 score: ${score.toFixed(2)}, alignment: ${alignment.toFixed(2)} — Evolve 진입`,
    });
    const evalCompleteExtra = success
      ? { hint: '구현 완료! score ≥ 0.85, alignment ≥ 0.80 달성.' }
      : {
          nextAction: 'evolve',
          nextActionParams: { sessionId: completedSession.sessionId },
          hint: '점수 미달. evolve를 호출해 개선하세요.',
        };
    return JSON.stringify(
      {
        status: 'completed',
        sessionId: completedSession.sessionId,
        stage: 'complete',
        evaluationResult,
        message: `Evaluation complete. Overall score: ${score.toFixed(2)}, goal alignment: ${alignment.toFixed(2)}. Session is now completed.`,
        ...evalCompleteExtra,
      },
      null,
      2,
    );
  }

  // Call 2: Submit structural results
  if (input.structuralResult) {
    const result = engine.submitStructuralResult(input.sessionId, input.structuralResult);
    if (!result.ok) return formatError(result.error.message);

    const { stage, shortCircuited, contextualContext, evaluationResult } = result.value;

    if (shortCircuited) {
      gestaltNotify({
        event: 'structural_failed',
        message: 'Structural 검사 실패 — lint/build/test를 확인하세요',
      });
      const evalShortCircuitGuide: NextActionGuide = {
        nextAction: 'evolve',
        nextActionParams: { sessionId: result.value.session.sessionId },
        hint: '점수 미달. evolve를 호출해 개선하세요.',
      };
      return JSON.stringify(
        {
          status: 'completed',
          sessionId: result.value.session.sessionId,
          stage: 'complete',
          shortCircuited: true,
          evaluationResult,
          message:
            'Structural checks failed. Evaluation short-circuited. Fix structural issues and retry.',
          ...evalShortCircuitGuide,
        },
        null,
        2,
      );
    }

    const evalContextualGuide: NextActionGuide = {
      nextAction: 'evaluate',
      nextActionParams: { sessionId: result.value.session.sessionId },
      hint: 'evaluationContext에 따라 각 AC를 검증하고 결과를 제출하세요.',
    };
    return JSON.stringify(
      {
        status: 'evaluating',
        sessionId: result.value.session.sessionId,
        stage,
        contextualContext: verbose
          ? contextualContext
          : stripContextPrompts(contextualContext as unknown as Record<string, unknown>),
        message:
          'Structural checks passed. Use contextualContext.evaluatePrompt with contextualContext.systemPrompt to generate the contextual evaluation.',
        ...evalContextualGuide,
      },
      null,
      2,
    );
  }

  // Call 1: Start evaluation → return structural commands
  const result = engine.startEvaluation(input.sessionId);
  if (!result.ok) return formatError(result.error.message);

  const evalStructuralGuide: NextActionGuide = {
    nextAction: 'evaluate',
    nextActionParams: { sessionId: result.value.session.sessionId },
    hint: 'structuralContext에 따라 lint/build/test를 실행하고 결과를 제출하세요.',
  };
  return JSON.stringify(
    {
      status: 'evaluating',
      sessionId: result.value.session.sessionId,
      stage: 'structural',
      structuralContext: result.value.structuralContext,
      message:
        'Run structural checks (lint, build, test) and submit results with structuralResult.',
      ...evalStructuralGuide,
    },
    null,
    2,
  );
}
