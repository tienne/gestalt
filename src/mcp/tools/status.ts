import type { InterviewEngine } from '../../interview/engine.js';
import type { StatusInput } from '../schemas.js';
import type { EventStore } from '../../events/store.js';
import type { GestaltConfig } from '../../core/config.js';
import { ExecuteSessionRepository } from '../../execute/repository.js';
import { getVersion, getCachedUpdateResult } from '../../core/version.js';

export function handleStatus(
  engine: InterviewEngine,
  input: StatusInput,
  eventStore?: EventStore,
  config?: GestaltConfig,
): string {
  const updateResult = getCachedUpdateResult();
  const versionInfo = {
    current: getVersion(),
    latest: updateResult?.latestVersion ?? null,
    updateAvailable: updateResult?.updateAvailable ?? false,
  };
  const reasoningModelInfo = {
    reasoningModel: config?.reasoningModel ?? null,
    reasoningModelFallback: config?.reasoningModelFallback ?? null,
  };

  const sessionType = input.sessionType ?? 'all';

  try {
    if (input.sessionId) {
      // Try interview first
      try {
        const session = engine.getSession(input.sessionId);
        const answeredRounds = session.rounds.filter((r) => r.userResponse).length;
        const scoreStr = session.resolutionScore
          ? ` (score ${session.resolutionScore.overall.toFixed(2)})`
          : '';
        const interviewSummary = `세션 ${session.sessionId.slice(0, 8)}: ${session.status} — ${answeredRounds}/${session.rounds.length} 라운드 완료${scoreStr}`;
        return JSON.stringify(
          {
            versionInfo,
            ...reasoningModelInfo,
            type: 'interview',
            summary: interviewSummary,
            session: {
              sessionId: session.sessionId,
              topic: session.topic,
              status: session.status,
              projectType: session.projectType,
              totalRounds: session.rounds.length,
              answeredRounds,
              resolutionScore: session.resolutionScore
                ? {
                    overall: session.resolutionScore.overall.toFixed(2),
                    isReady: session.resolutionScore.isReady,
                  }
                : null,
              createdAt: session.createdAt,
              updatedAt: session.updatedAt,
            },
          },
          null,
          2,
        );
      } catch {
        // Not found in interview — try execute if eventStore available
        if (eventStore) {
          const repo = new ExecuteSessionRepository(eventStore);
          const execSession = repo.reconstruct(input.sessionId);
          if (execSession) {
            const formatted = formatExecuteSessionBasic(execSession);
            return JSON.stringify(
              {
                versionInfo,
                ...reasoningModelInfo,
                type: 'execute',
                summary: formatted.summary,
                session: formatted,
              },
              null,
              2,
            );
          }
        }
        throw new Error(`Session not found: ${input.sessionId}`);
      }
    }

    // List mode
    const interviewSessions =
      sessionType === 'interview' || sessionType === 'all'
        ? engine.listSessions().map((s) => ({
            sessionId: s.sessionId,
            topic: s.topic,
            status: s.status,
            projectType: s.projectType,
            totalRounds: s.rounds.length,
            resolutionScore: s.resolutionScore?.overall.toFixed(2) ?? 'N/A',
            createdAt: s.createdAt,
          }))
        : [];

    let executeSessions: ReturnType<typeof formatExecuteSessionBasic>[] = [];
    if ((sessionType === 'execute' || sessionType === 'all') && eventStore) {
      const repo = new ExecuteSessionRepository(eventStore);
      executeSessions = repo.reconstructAll().map(formatExecuteSessionBasic);
    }

    return JSON.stringify(
      {
        versionInfo,
        ...reasoningModelInfo,
        interviewSessions,
        executeSessions,
        total: { interview: interviewSessions.length, execute: executeSessions.length },
      },
      null,
      2,
    );
  } catch (e) {
    return JSON.stringify(
      {
        ...reasoningModelInfo,
        error: e instanceof Error ? e.message : String(e),
      },
      null,
      2,
    );
  }
}

function formatExecuteSessionBasic(session: import('../../core/types.js').ExecuteSession) {
  const totalTasks = session.executionPlan?.atomicTasks.length ?? 0;
  const completedTasks = session.taskResults.filter((t) => t.status === 'completed').length;

  let summary: string;
  const shortId = session.sessionId.slice(0, 8);
  if (session.status === 'completed') {
    const scoreStr =
      session.evaluationResult?.overallScore != null
        ? ` score ${session.evaluationResult.overallScore.toFixed(2)}`
        : '';
    const alignStr =
      session.evaluationResult?.goalAlignment != null
        ? `, alignment ${session.evaluationResult.goalAlignment.toFixed(2)}`
        : '';
    summary = `세션 ${shortId}: completed —${scoreStr}${alignStr}`;
  } else if (totalTasks > 0) {
    const pct = Math.round((completedTasks / totalTasks) * 100);
    summary = `세션 ${shortId}: ${session.status} 단계, ${completedTasks}/${totalTasks} 태스크 완료 (${pct}%)`;
  } else {
    summary = `세션 ${shortId}: ${session.status} 단계, 0개 태스크 완료`;
  }

  return {
    sessionId: session.sessionId,
    specId: session.specId,
    status: session.status,
    goal: session.spec.goal,
    summary,
    taskProgress: totalTasks > 0 ? `${completedTasks}/${totalTasks}` : null,
    evaluationScore: session.evaluationResult?.overallScore ?? null,
    goalAlignment: session.evaluationResult?.goalAlignment ?? null,
    currentGeneration: session.currentGeneration,
    terminationReason: session.terminationReason ?? null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}
