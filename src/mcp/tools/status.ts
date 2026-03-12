import type { InterviewEngine } from '../../interview/engine.js';
import type { StatusInput } from '../schemas.js';
import { getVersion, getCachedUpdateResult } from '../../core/version.js';

export function handleStatus(
  engine: InterviewEngine,
  input: StatusInput,
): string {
  const updateResult = getCachedUpdateResult();
  const versionInfo = {
    current: getVersion(),
    latest: updateResult?.latestVersion ?? null,
    updateAvailable: updateResult?.updateAvailable ?? false,
  };

  try {
    if (input.sessionId) {
      const session = engine.getSession(input.sessionId);
      return JSON.stringify({
        versionInfo,
        session: {
          sessionId: session.sessionId,
          topic: session.topic,
          status: session.status,
          projectType: session.projectType,
          totalRounds: session.rounds.length,
          answeredRounds: session.rounds.filter((r) => r.userResponse).length,
          ambiguityScore: session.ambiguityScore
            ? {
                overall: session.ambiguityScore.overall.toFixed(2),
                isReady: session.ambiguityScore.isReady,
              }
            : null,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        },
      }, null, 2);
    }

    const sessions = engine.listSessions();
    return JSON.stringify({
      versionInfo,
      sessions: sessions.map((s) => ({
        sessionId: s.sessionId,
        topic: s.topic,
        status: s.status,
        projectType: s.projectType,
        totalRounds: s.rounds.length,
        ambiguityScore: s.ambiguityScore?.overall.toFixed(2) ?? 'N/A',
        createdAt: s.createdAt,
      })),
      total: sessions.length,
    }, null, 2);
  } catch (e) {
    return JSON.stringify({
      error: e instanceof Error ? e.message : String(e),
    }, null, 2);
  }
}
