import type {
  ExecuteSession,
  AtomicTask,
  TaskExecutionResult,
  DriftScore,
  RoleMatch,
  RolePerspective,
  RoleConsensus,
  RoleGuidance,
  ArtifactVerification,
  BaselineCapture,
} from '../../core/types.js';
import {
  ExecuteError,
  ExecuteSessionNotFoundError,
  TaskExecutionError,
} from '../../core/errors.js';
import { type Result, ok, err } from '../../core/result.js';
import { EXECUTION_PRINCIPLE_STRATEGY } from '../../core/constants.js';
import { GestaltPrinciple } from '../../core/types.js';
import { EventStore } from '../../events/store.js';
import { EventType } from '../../events/types.js';
import { ExecuteSessionManager } from '../session.js';
import {
  EXECUTE_EXECUTION_SYSTEM_PROMPT,
  buildTaskExecutionPrompt,
  buildDriftRetrospectivePrompt,
} from '../prompts.js';
import { measureDrift } from '../drift-detector.js';
import { captureWorkingTreeBaseline, verifyArtifacts } from '../artifact-verifier.js';
import { log } from '../../core/log.js';
import { DRIFT_THRESHOLD, VERIFICATION_EVENT_FILE_LIMIT } from '../../core/constants.js';
import type { AgentRegistry } from '../../agent/registry.js';
import { mergeSystemPrompt } from '../../agent/prompt-resolver.js';
import { codeGraphEngine } from '../../code-graph/index.js';
import type { RoleAgentRegistry } from '../../agent/role-agent-registry.js';
import { RoleMatchEngine } from '../../agent/role-match-engine.js';
import { RolePromptGenerator } from '../../agent/role-prompt-generator.js';
import { RoleConsensusEngine } from '../../agent/role-consensus-engine.js';
import type {
  TaskExecutionContext,
  DriftRetrospectiveContext,
  PassthroughRoleMatchResult,
  PassthroughRoleConsensusResult,
  PassthroughExecutionStartResult,
  PassthroughTaskSubmitResult,
} from './types.js';

// ─── Helpers ─────────────────────────────────────────────────────

function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    'the',
    'a',
    'an',
    'and',
    'or',
    'but',
    'in',
    'on',
    'at',
    'to',
    'for',
    'of',
    'with',
    'by',
    '—',
    '+',
  ]);
  return text
    .replace(/[^\w\s가-힣]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w.toLowerCase()))
    .slice(0, 5);
}

export class ExecutionOrchestrator {
  constructor(
    private sessionManager: ExecuteSessionManager,
    private eventStore: EventStore,
    private agentRegistry?: AgentRegistry,
    private roleAgentRegistry?: RoleAgentRegistry,
  ) {}

  /**
   * @param capture captureBaseline이 잡은 기준 트리. 없으면 완료 보고를 대조하지 않는다
   */
  startExecution(
    sessionId: string,
    capture?: BaselineCapture,
  ): Result<PassthroughExecutionStartResult, ExecuteError> {
    try {
      const session = this.sessionManager.get(sessionId);

      if (session.status !== 'plan_complete') {
        return err(
          new TaskExecutionError(
            `Cannot start execution: session status is "${session.status}", expected "plan_complete"`,
          ),
        );
      }

      if (!session.executionPlan) {
        return err(new TaskExecutionError('No execution plan found'));
      }

      // 순환이 있는 계획은 착수 가능한 태스크가 하나도 없어 '전부 완료'로 읽힌다.
      // 플래닝 검증 없이 저장된 무효 계획이 그 상태로 평가까지 넘어가지 않게 여기서 막는다.
      const { dagValidation } = session.executionPlan;
      if (!dagValidation.isValid) {
        const issues = [
          ...(dagValidation.cycleDetails ?? []),
          ...(dagValidation.conflictDetails ?? []),
        ].join('; ');
        return err(
          new TaskExecutionError(
            `Cannot start execution: the execution plan has an invalid dependency DAG (${issues || 'no details'}). Start a new execute session with a corrected plan.`,
          ),
        );
      }

      this.sessionManager.startExecution(sessionId, capture);

      const taskContext = this.buildNextTaskContext(this.sessionManager.get(sessionId));

      return ok({
        session: this.sessionManager.get(sessionId),
        taskContext,
        allTasksCompleted: taskContext === null,
      });
    } catch (e) {
      if (e instanceof ExecuteSessionNotFoundError) return err(e);
      return err(
        new TaskExecutionError(
          `Failed to start execution: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  }

  async submitTaskResult(
    sessionId: string,
    taskResult: TaskExecutionResult,
    driftThreshold?: number,
  ): Promise<Result<PassthroughTaskSubmitResult, ExecuteError>> {
    try {
      const session = this.sessionManager.get(sessionId);

      if (session.status !== 'executing') {
        return err(
          new TaskExecutionError(
            `Cannot submit task result: session status is "${session.status}", expected "executing"`,
          ),
        );
      }

      if (!session.executionPlan) {
        return err(new TaskExecutionError('No execution plan found'));
      }

      // Validate taskId exists in plan
      const task = session.executionPlan.atomicTasks.find((t) => t.taskId === taskResult.taskId);
      if (!task) {
        return err(
          new TaskExecutionError(`Task "${taskResult.taskId}" not found in execution plan`),
        );
      }

      const verification = await this.verifyCompletion(session, taskResult);
      if (verification && !verification.verified) {
        this.eventStore.append(
          'execute',
          sessionId,
          EventType.EXECUTE_TASK_VERIFICATION_FAILED,
          verificationEventPayload(taskResult.taskId, verification),
        );
        return ok({
          session,
          taskContext: null,
          allTasksCompleted: false,
          verification,
        });
      }

      this.sessionManager.addTaskResult(sessionId, taskResult);

      // Clear role state from previous role_match/role_consensus cycle
      this.sessionManager.clearRoleState(sessionId);

      // Drift Detection (only for completed tasks)
      let driftScore: DriftScore | undefined;
      let retrospectiveContext: DriftRetrospectiveContext | undefined;

      if (taskResult.status === 'completed') {
        const threshold = driftThreshold ?? DRIFT_THRESHOLD;
        driftScore = await measureDrift(session.spec, task, taskResult, threshold);
        this.sessionManager.addDriftScore(sessionId, driftScore);

        if (driftScore.thresholdExceeded) {
          this.eventStore.append('execute', sessionId, EventType.EXECUTE_DRIFT_RETROSPECTIVE, {
            taskId: taskResult.taskId,
            driftScore,
          });

          retrospectiveContext = {
            systemPrompt: mergeSystemPrompt(
              EXECUTE_EXECUTION_SYSTEM_PROMPT,
              this.agentRegistry,
              'execute',
            ),
            retrospectivePrompt: buildDriftRetrospectivePrompt(
              session.spec,
              task,
              taskResult,
              driftScore,
            ),
            driftScore,
          };
        }
      }

      const updatedSession = this.sessionManager.get(sessionId);
      const taskContext = this.buildNextTaskContext(updatedSession);
      const allTasksCompleted = taskContext === null;

      return ok({
        session: updatedSession,
        taskContext,
        allTasksCompleted,
        driftScore,
        retrospectiveContext,
        verification,
      });
    } catch (e) {
      if (e instanceof ExecuteSessionNotFoundError) return err(e);
      return err(
        new TaskExecutionError(
          `Failed to submit task result: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  }

  // ─── Role Agent System ──────────────────────────────────────

  /**
   * role_match: 2-call passthrough pattern.
   * - Call 1 (no matchResult): Returns matchContext for current task
   * - Call 2 (with matchResult): Stores matches, returns perspectivePrompts
   */
  roleMatch(
    sessionId: string,
    matchResult?: RoleMatch[],
  ): Result<PassthroughRoleMatchResult, ExecuteError> {
    try {
      const session = this.sessionManager.get(sessionId);

      if (session.status !== 'executing') {
        return err(
          new TaskExecutionError(
            `Cannot perform role match: session status is "${session.status}", expected "executing"`,
          ),
        );
      }

      const currentTask = this.getCurrentTask(session);
      if (!currentTask) {
        return err(new TaskExecutionError('No pending task found for role matching'));
      }

      // Call 1: Return match context
      if (!matchResult) {
        if (!this.roleAgentRegistry) {
          return err(new ExecuteError('RoleAgentRegistry not configured'));
        }

        this.eventStore.append('execute', sessionId, EventType.ROLE_MATCH_STARTED, {
          taskId: currentTask.taskId,
        });

        const engine = new RoleMatchEngine();
        const matchContext = engine.generateMatchContext(
          currentTask.taskId,
          currentTask.title,
          currentTask.description,
          this.roleAgentRegistry.getAll(),
        );

        return ok({ session, matchContext });
      }

      // Call 2: Submit match results, return perspective prompts
      this.sessionManager.setRoleMatches(sessionId, currentTask.taskId, matchResult);

      if (matchResult.length === 0) {
        return ok({
          session: this.sessionManager.get(sessionId),
          perspectivePrompts: [],
        });
      }

      if (!this.roleAgentRegistry) {
        return err(new ExecuteError('RoleAgentRegistry not configured'));
      }

      const matchedAgents = matchResult
        .map((m) => this.roleAgentRegistry!.getByName(m.agentName))
        .filter((a): a is NonNullable<typeof a> => a !== undefined);

      const generator = new RolePromptGenerator();
      const perspectivePrompts = generator.generatePerspectivePrompts(
        currentTask.title,
        currentTask.description,
        matchedAgents,
      );

      return ok({
        session: this.sessionManager.get(sessionId),
        perspectivePrompts,
      });
    } catch (e) {
      if (e instanceof ExecuteSessionNotFoundError) return err(e);
      return err(
        new ExecuteError(`Failed role match: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
  }

  /**
   * role_consensus: 2-call passthrough pattern.
   * - Call 1 (perspectives, no consensus): Returns synthesisContext
   * - Call 2 (consensus): Stores consensus, returns roleGuidance
   */
  roleConsensus(
    sessionId: string,
    perspectives?: RolePerspective[],
    consensus?: RoleConsensus,
  ): Result<PassthroughRoleConsensusResult, ExecuteError> {
    try {
      const session = this.sessionManager.get(sessionId);

      if (session.status !== 'executing') {
        return err(
          new TaskExecutionError(
            `Cannot perform role consensus: session status is "${session.status}", expected "executing"`,
          ),
        );
      }

      const currentTask = this.getCurrentTask(session);
      if (!currentTask) {
        return err(new TaskExecutionError('No pending task found for role consensus'));
      }

      // Call 1: Submit perspectives, return synthesis context
      if (perspectives && !consensus) {
        this.eventStore.append('execute', sessionId, EventType.ROLE_CONSENSUS_STARTED, {
          taskId: currentTask.taskId,
          perspectiveCount: perspectives.length,
        });

        const engine = new RoleConsensusEngine();
        const synthesisContext = engine.generateSynthesisContext(
          currentTask.title,
          currentTask.description,
          perspectives,
        );

        return ok({ session, synthesisContext });
      }

      // Call 2: Submit consensus, store in session
      if (consensus) {
        this.sessionManager.setRoleConsensus(sessionId, currentTask.taskId, consensus);

        const roleGuidance: RoleGuidance = {
          agents: consensus.perspectives,
          consensus: consensus.consensus,
          conflictResolutions: consensus.conflictResolutions,
        };

        return ok({
          session: this.sessionManager.get(sessionId),
          roleGuidance,
        });
      }

      return err(new ExecuteError('Either perspectives or consensus must be provided'));
    } catch (e) {
      if (e instanceof ExecuteSessionNotFoundError) return err(e);
      return err(
        new ExecuteError(`Failed role consensus: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
  }

  // ─── Semantic Hydration ───────────────────────────────────────────

  /**
   * suggestedFiles를 searchByHybrid(키워드+의미론)로 업그레이드.
   * buildNextTaskContext()는 동기 유지, 호출측에서 필요 시 이 메서드로 보강한다.
   */
  async hydrateSuggestedFiles(
    context: TaskExecutionContext,
    repoRoot: string,
  ): Promise<TaskExecutionContext> {
    if (!codeGraphEngine.dbExists(repoRoot)) return context;
    try {
      const query = extractKeywords(
        context.currentTask.title + ' ' + context.currentTask.description,
      ).join(' ');
      const files = await codeGraphEngine.searchByHybrid(repoRoot, query, 10);
      return { ...context, suggestedFiles: files };
    } catch {
      // semantic 실패 시 기존 keyword-based suggestedFiles 유지
      return context;
    }
  }

  // ─── Execution context builders ────────────────────────────────

  private getCurrentTask(session: ExecuteSession): AtomicTask | null {
    if (!session.executionPlan) return null;

    const plan = session.executionPlan;
    const completedIds = new Set(
      session.taskResults
        .filter((r) => r.status === 'completed' || r.status === 'skipped')
        .map((r) => r.taskId),
    );
    const failedIds = new Set(
      session.taskResults.filter((r) => r.status === 'failed').map((r) => r.taskId),
    );

    const topoOrder = plan.dagValidation.topologicalOrder;
    for (const taskId of topoOrder) {
      if (completedIds.has(taskId) || failedIds.has(taskId)) continue;

      const task = plan.atomicTasks.find((t) => t.taskId === taskId);
      if (!task) continue;

      const depsResolved = task.dependsOn.every(
        (dep) => completedIds.has(dep) || failedIds.has(dep),
      );
      if (depsResolved) return task;
    }

    return null;
  }

  /**
   * startExecution에 넘길 기준 트리를 잡는다. git을 기다리는 동안 다른 도구 호출을 막지 않으려고
   * startExecution과 따로 둔다.
   * 기준 디렉토리는 cwd, 세션의 codeGraphRepoRoot, 서버 프로세스 cwd 순으로 정한다.
   * 서버는 호스트 프로젝트 디렉토리에서 뜨므로 마지막 자리도 대개 호스트 레포다.
   */
  async captureBaseline(sessionId: string, cwd?: string): Promise<BaselineCapture> {
    let repoRoot = cwd ?? process.cwd();
    try {
      repoRoot = cwd ?? this.sessionManager.get(sessionId).codeGraphRepoRoot ?? process.cwd();
      const baseline = await captureWorkingTreeBaseline(repoRoot);
      if (baseline) return { repoRoot, baseline };
      log(`execute: ${repoRoot} is not a git work tree — completion claims will not be verified`);
      return { repoRoot, skipped: 'no_baseline' };
    } catch (e) {
      log(`execute: failed to capture working tree baseline for ${sessionId}:`, e);
      return {
        repoRoot,
        skipped: 'baseline_failed',
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * completed 보고만 대조한다. 기준 트리가 없으면 확인할 방법이 없어 통과시키되
   * skipped에 이유를 담아 응답에서 드러나게 한다.
   */
  private async verifyCompletion(
    session: ExecuteSession,
    taskResult: TaskExecutionResult,
  ): Promise<ArtifactVerification | undefined> {
    if (taskResult.status !== 'completed') return undefined;

    const baseline = session.workingTreeBaseline;
    if (!baseline) {
      return {
        verified: true,
        skipped: session.workingTreeBaselineSkipped ?? 'no_baseline',
        files: [],
      };
    }

    if (taskResult.artifacts.length === 0) {
      return taskResult.noCodeChange
        ? { verified: true, skipped: 'no_code_change', files: [] }
        : { verified: false, missingArtifacts: true, files: [] };
    }

    try {
      return await verifyArtifacts(baseline, taskResult.artifacts);
    } catch (e) {
      log(`execute: artifact verification failed for ${taskResult.taskId}:`, e);
      return {
        verified: false,
        error: e instanceof Error ? e.message : String(e),
        files: [],
      };
    }
  }

  private buildNextTaskContext(session: ExecuteSession): TaskExecutionContext | null {
    const nextTask = this.getCurrentTask(session);
    if (!nextTask) return null;

    const plan = session.executionPlan!;
    const completedIds = new Set(
      session.taskResults
        .filter((r) => r.status === 'completed' || r.status === 'skipped')
        .map((r) => r.taskId),
    );
    const failedIds = new Set(
      session.taskResults.filter((r) => r.status === 'failed').map((r) => r.taskId),
    );

    // Find similar completed tasks (Similarity principle)
    const similarTasks = this.findSimilarTasks(nextTask, plan.atomicTasks, completedIds);

    const completedResults = session.taskResults.filter((r) => r.status === 'completed');

    const pendingTasks = plan.atomicTasks.filter(
      (t) =>
        !completedIds.has(t.taskId) && !failedIds.has(t.taskId) && t.taskId !== nextTask!.taskId,
    );

    // suggestedFiles 계산 (code-graph searchByKeywords 기반 — 동기 fallback)
    // Semantic/hybrid upgrade는 호출측에서 hydrateSuggestedFiles()로 수행한다
    // (src/mcp/tools/execute/execution.ts). 이 메서드가 동기라 여기선 키워드까지만 한다.
    let suggestedFiles: string[] | undefined;
    if (session.codeGraphRepoRoot && codeGraphEngine.dbExists(session.codeGraphRepoRoot)) {
      try {
        const keywords = extractKeywords(nextTask.title + ' ' + nextTask.description);
        const files = codeGraphEngine.searchByKeywords(session.codeGraphRepoRoot, keywords);
        suggestedFiles = files.slice(0, 10);
      } catch {
        // graceful fallback — suggestedFiles remains undefined
      }
    }

    const taskPrompt = buildTaskExecutionPrompt(
      nextTask,
      session.spec,
      completedResults,
      similarTasks,
      suggestedFiles,
    );

    // Include roleGuidance if available from a previous role_match/role_consensus cycle
    const roleGuidance = session.roleConsensus
      ? {
          agents: session.roleConsensus.perspectives,
          consensus: session.roleConsensus.consensus,
          conflictResolutions: session.roleConsensus.conflictResolutions,
        }
      : undefined;

    return {
      systemPrompt: mergeSystemPrompt(
        EXECUTE_EXECUTION_SYSTEM_PROMPT,
        this.agentRegistry,
        'execute',
      ),
      taskPrompt,
      phase: 'executing',
      currentTask: nextTask,
      similarityStrategy: EXECUTION_PRINCIPLE_STRATEGY[GestaltPrinciple.SIMILARITY]!,
      pendingTasks,
      completedTaskIds: Array.from(completedIds),
      roleGuidance,
      suggestedFiles,
    };
  }

  private findSimilarTasks(
    target: AtomicTask,
    allTasks: AtomicTask[],
    completedIds: Set<string>,
  ): AtomicTask[] {
    return allTasks.filter((t) => {
      if (!completedIds.has(t.taskId)) return false;
      if (t.taskId === target.taskId) return false;

      // Same complexity or overlapping sourceAC = similar
      const sharedAC = t.sourceAC.some((ac) => target.sourceAC.includes(ac));
      const sameComplexity = t.estimatedComplexity === target.estimatedComplexity;
      return sharedAC || sameComplexity;
    });
  }
}

/** 대조 실패 이벤트는 재제출마다 쌓이므로 통과 못 한 파일만 상한까지 남긴다 */
function verificationEventPayload(taskId: string, verification: ArtifactVerification) {
  const failed = verification.files.filter((f) => f.status !== 'changed');
  return {
    taskId,
    failed: failed.slice(0, VERIFICATION_EVENT_FILE_LIMIT),
    failedCount: failed.length,
    totalCount: verification.files.length,
    ...(failed.length > VERIFICATION_EVENT_FILE_LIMIT ? { truncated: true } : {}),
    ...(verification.missingArtifacts ? { missingArtifacts: true } : {}),
    ...(verification.error ? { error: verification.error } : {}),
  };
}
