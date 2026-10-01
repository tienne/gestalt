import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ExecuteSession, EvaluationResult, StructuralResult } from '../../core/types.js';
import { ExecuteError, ExecuteSessionNotFoundError, EvaluationError } from '../../core/errors.js';
import { type Result, ok, err } from '../../core/result.js';
import { EventStore } from '../../events/store.js';
import { ExecuteSessionManager } from '../session.js';
import { EXECUTE_EVALUATION_SYSTEM_PROMPT, buildContextualEvaluationPrompt } from '../prompts.js';
import type { AgentRegistry } from '../../agent/registry.js';
import { mergeSystemPrompt } from '../../agent/prompt-resolver.js';
import { codeGraphEngine } from '../../code-graph/index.js';
import type { RoleAgentRegistry } from '../../agent/role-agent-registry.js';
import { log } from '../../core/log.js';
import {
  buildStructuralCommands,
  collectChangedFiles,
  findCommandMismatches,
} from '../structural-commands.js';
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
  startEvaluation(
    sessionId: string,
    cwd?: string,
  ): Result<PassthroughEvaluateResult, ExecuteError> {
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

      const projectRoot = session.codeGraphRepoRoot ?? cwd ?? process.cwd();
      const commands = buildStructuralCommands(projectRoot, this.findAffectedTests(session));
      this.sessionManager.startStructuralEvaluation(sessionId, commands);

      return ok({
        session: this.sessionManager.get(sessionId),
        stage: 'structural',
        structuralContext: {
          phase: 'evaluating',
          stage: 'structural',
          commands,
          message:
            'Run these structural checks exactly as given and submit each command string unchanged. Submissions with different commands are rejected. All must pass to proceed to contextual evaluation.',
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

      if (structuralResult.commands.length === 0) {
        return err(new EvaluationError('No structural commands were submitted'));
      }
      // 요청 명령을 이벤트에 싣기 전에 시작된 세션이다. 여기서 다시 만들면 cwd를 몰라 다른 프로젝트 기준이 될 수 있다
      if (!session.structuralCommands || session.structuralCommands.length === 0) {
        return err(
          new EvaluationError(
            'No requested structural commands for this session; call evaluate (Call 1) again to get them',
          ),
        );
      }
      const mismatches = findCommandMismatches(session.structuralCommands, structuralResult);
      if (mismatches.length > 0) {
        return err(
          new EvaluationError(
            `Submitted commands do not match the requested ones: ${mismatches.join('; ')}`,
          ),
        );
      }

      // 호스트가 보고한 allPassed보다 종료 코드를 우선한다
      const allPassed =
        structuralResult.allPassed && structuralResult.commands.every((c) => c.exitCode === 0);
      const verifiedResult: StructuralResult = { ...structuralResult, allPassed };

      this.sessionManager.completeStructuralStage(sessionId, verifiedResult);

      if (!allPassed) {
        const failedCommands = verifiedResult.commands
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

  /**
   * 변경에 걸린 테스트 파일을 찾는다. 빈 배열이면 호출부가 전체 테스트를 돌린다.
   */
  private findAffectedTests(session: ExecuteSession): string[] {
    const repoRoot = session.codeGraphRepoRoot;
    if (!repoRoot || !codeGraphEngine.dbExists(repoRoot)) return [];
    try {
      const changedFiles = collectChangedFiles(repoRoot);
      if (changedFiles.length === 0) return [];
      // rankedFiles에는 co-change로만 걸린 md, json이 섞여 있어 테스트 러너 인자로 못 쓴다
      const { impactedFiles } = codeGraphEngine.blastRadius(repoRoot, { changedFiles });
      // 삭제된 테스트 파일도 변경으로 잡혀 넘어온다. 없는 파일을 러너에 넘기면 러너가 실패한다
      return impactedFiles.filter(
        (f) =>
          (f.includes('.test.') || f.includes('.spec.') || f.includes('__tests__')) &&
          existsSync(resolve(repoRoot, f)),
      );
    } catch (e) {
      log(
        `[evaluate] blast-radius failed, running full test suite: ${e instanceof Error ? e.message : String(e)}`,
      );
      return [];
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
