import type { ExecuteSession, EvaluationResult, StructuralCommand, StructuralResult } from '../../core/types.js';
import { ExecuteError, ExecuteSessionNotFoundError, EvaluationError } from '../../core/errors.js';
import { type Result, ok, err } from '../../core/result.js';
import { EventStore } from '../../events/store.js';
import { ExecuteSessionManager } from '../session.js';
import {
  EXECUTE_EVALUATION_SYSTEM_PROMPT,
  buildContextualEvaluationPrompt,
} from '../prompts.js';
import type { AgentRegistry } from '../../agent/registry.js';
import { mergeSystemPrompt } from '../../agent/prompt-resolver.js';
import { codeGraphEngine } from '../../code-graph/index.js';
import type { RoleAgentRegistry } from '../../agent/role-agent-registry.js';
import type { ContextualEvaluateContext, PassthroughEvaluateResult } from './types.js';

export class EvaluationOrchestrator {
  constructor(
    private sessionManager: ExecuteSessionManager,
    _eventStore: EventStore,
    private agentRegistry?: AgentRegistry,
    _roleAgentRegistry?: RoleAgentRegistry,
  ) {}

  /**
   * Call 1: Start evaluation → returns structural commands to run.
   */
  startEvaluation(sessionId: string): Result<PassthroughEvaluateResult, ExecuteError> {
    try {
      const session = this.sessionManager.get(sessionId);

      if (session.status !== 'executing') {
        return err(
          new EvaluationError(
            `Cannot start evaluation: session status is "${session.status}", expected "executing"`,
          ),
        );
      }

      if (!session.executionPlan) {
        return err(new EvaluationError('No execution plan found'));
      }

      this.sessionManager.startStructuralEvaluation(sessionId);

      let commands: StructuralCommand[] = [
        { name: 'lint', command: 'npm run lint' },
        { name: 'build', command: 'npm run build' },
        { name: 'test', command: 'npm test' },
      ];

      // blast-radius 기반 테스트 필터링: codeGraphRepoRoot가 설정되고 DB가 존재할 때
      if (session.codeGraphRepoRoot && codeGraphEngine.dbExists(session.codeGraphRepoRoot)) {
        try {
          const blastResult = codeGraphEngine.blastRadius(session.codeGraphRepoRoot, {
            base: 'HEAD~1',
          });
          const testFiles = blastResult.impactedFiles.filter(
            (f) => f.includes('.test.') || f.includes('.spec.') || f.includes('__tests__'),
          );
          if (testFiles.length > 0) {
            commands = commands.map((cmd) => {
              if (cmd.name === 'test') {
                return { ...cmd, command: `${cmd.command} -- ${testFiles.join(' ')}` };
              }
              return cmd;
            });
          } else {
            // 변경된 테스트 파일 없음 → 테스트 스킵
            commands = commands.map((cmd) => {
              if (cmd.name === 'test') {
                return { ...cmd, command: 'echo "No affected tests"' };
              }
              return cmd;
            });
          }
        } catch {
          // blast-radius 실패 시 기존 전체 테스트로 fallback (graceful degradation)
        }
      }

      return ok({
        session: this.sessionManager.get(sessionId),
        stage: 'structural',
        structuralContext: {
          phase: 'evaluating',
          stage: 'structural',
          commands,
          message:
            'Run these structural checks and submit results. Adapt commands to your project (e.g., pnpm/yarn). All must pass to proceed to contextual evaluation.',
        },
      });
    } catch (e) {
      if (e instanceof ExecuteSessionNotFoundError) return err(e);
      return err(
        new EvaluationError(
          `Failed to start evaluation: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  }

  /**
   * Call 2: Submit structural results → returns contextual context or short-circuits.
   */
  submitStructuralResult(
    sessionId: string,
    structuralResult: StructuralResult,
  ): Result<PassthroughEvaluateResult, ExecuteError> {
    try {
      const session = this.sessionManager.get(sessionId);

      if (session.status !== 'executing' || session.evaluateStage !== 'structural') {
        return err(
          new EvaluationError(
            `Cannot submit structural result: expected stage "structural", got "${session.evaluateStage ?? 'none'}"`,
          ),
        );
      }

      this.sessionManager.completeStructuralStage(sessionId, structuralResult);

      // Short-circuit if structural checks failed
      if (!structuralResult.allPassed) {
        const failedCommands = structuralResult.commands
          .filter((c) => c.exitCode !== 0)
          .map((c) => `${c.name} (exit ${c.exitCode})`)
          .join(', ');

        this.sessionManager.shortCircuitEvaluation(
          sessionId,
          `Structural checks failed: ${failedCommands}`,
        );

        return ok({
          session: this.sessionManager.get(sessionId),
          stage: 'complete',
          shortCircuited: true,
          evaluationResult: this.sessionManager.get(sessionId).evaluationResult,
        });
      }

      // Structural passed → advance to contextual stage
      this.sessionManager.startContextualEvaluation(sessionId);
      const updatedSession = this.sessionManager.get(sessionId);
      const contextualContext = this.buildContextualEvaluateContext(updatedSession);

      return ok({
        session: updatedSession,
        stage: 'contextual',
        contextualContext,
      });
    } catch (e) {
      if (e instanceof ExecuteSessionNotFoundError) return err(e);
      return err(
        new EvaluationError(
          `Failed to submit structural result: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  }

  /**
   * Call 3: Submit contextual evaluation result → completes session.
   */
  submitEvaluation(
    sessionId: string,
    evaluationResult: EvaluationResult,
  ): Result<PassthroughEvaluateResult, ExecuteError> {
    try {
      const session = this.sessionManager.get(sessionId);

      if (session.status !== 'executing' || session.evaluateStage !== 'contextual') {
        return err(
          new EvaluationError(
            `Cannot submit evaluation: expected stage "contextual", got "${session.evaluateStage ?? 'none'}"`,
          ),
        );
      }

      // Validate evaluation covers all ACs
      const acCount = session.spec.acceptanceCriteria.length;
      const verifiedIndices = new Set(evaluationResult.verifications.map((v) => v.acIndex));
      for (let i = 0; i < acCount; i++) {
        if (!verifiedIndices.has(i)) {
          return err(new EvaluationError(`AC index ${i} is not verified`));
        }
      }

      // Validate score ranges
      if (evaluationResult.overallScore < 0 || evaluationResult.overallScore > 1) {
        return err(
          new EvaluationError(
            `overallScore must be between 0 and 1, got ${evaluationResult.overallScore}`,
          ),
        );
      }
      if (evaluationResult.goalAlignment < 0 || evaluationResult.goalAlignment > 1) {
        return err(
          new EvaluationError(
            `goalAlignment must be between 0 and 1, got ${evaluationResult.goalAlignment}`,
          ),
        );
      }

      this.sessionManager.completeEvaluation(sessionId, evaluationResult);

      return ok({
        session: this.sessionManager.get(sessionId),
        stage: 'complete',
        evaluationResult,
      });
    } catch (e) {
      if (e instanceof ExecuteSessionNotFoundError) return err(e);
      return err(
        new EvaluationError(
          `Failed to submit evaluation: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  }

  private buildContextualEvaluateContext(session: ExecuteSession): ContextualEvaluateContext {
    const plan = session.executionPlan!;
    const evaluatePrompt = buildContextualEvaluationPrompt(
      session.spec,
      plan.classifiedACs,
      session.taskResults,
      session.structuralResult!,
    );

    return {
      systemPrompt: mergeSystemPrompt(
        EXECUTE_EVALUATION_SYSTEM_PROMPT,
        this.agentRegistry,
        'evaluate',
      ),
      evaluatePrompt,
      phase: 'evaluating',
      stage: 'contextual',
      spec: session.spec,
      taskResults: session.taskResults,
      classifiedACs: plan.classifiedACs,
      structuralResult: session.structuralResult!,
    };
  }
}
