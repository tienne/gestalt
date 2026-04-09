import type { InterviewEngine } from '../../interview/engine.js';
import type { StatusInput } from '../schemas.js';
import type { EventStore } from '../../events/store.js';
import { ExecuteSessionRepository } from '../../execute/repository.js';
import { getVersion, getCachedUpdateResult } from '../../core/version.js';

export function handleStatus(
  engine: InterviewEngine,
  input: StatusInput,
  eventStore?: EventStore,
): string {
  const updateResult = getCachedUpdateResult();
  const versionInfo = {
    current: getVersion(),
    latest: updateResult?.latestVersion ?? null,
    updateAvailable: updateResult?.updateAvailable ?? false,
  };

  const sessionType = input.sessionType ?? 'all';

  try {
    if (input.sessionId) {
      // Try interview first
      try {
        const session = engine.getSession(input.sessionId);
        return JSON.stringify(
          {
            versionInfo,
            type: 'interview',
            session: {
              sessionId: session.sessionId,
              topic: session.topic,
              status: session.status,
              projectType: session.projectType,
              totalRounds: session.rounds.length,
              answeredRounds: session.rounds.filter((r) => r.userResponse).length,
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
            return JSON.stringify(
              {
                versionInfo,
                type: 'execute',
                session: formatExecuteSessionBasic(execSession),
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
  return {
    sessionId: session.sessionId,
    specId: session.specId,
    status: session.status,
    goal: session.spec.goal,
    taskProgress: totalTasks > 0 ? `${completedTasks}/${totalTasks}` : null,
    evaluationScore: session.evaluationResult?.overallScore ?? null,
    goalAlignment: session.evaluationResult?.goalAlignment ?? null,
    currentGeneration: session.currentGeneration,
    terminationReason: session.terminationReason ?? null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}
