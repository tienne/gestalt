import { loadConfig } from '../../core/config.js';
import { EventStore } from '../../events/store.js';
import { EventType } from '../../events/types.js';
import type { DomainEvent } from '../../core/types.js';

export function statusCommand(sessionId?: string): void {
  const config = loadConfig();
  const eventStore = new EventStore(config.dbPath);

  try {
    if (sessionId) {
      const events = eventStore.getByAggregate('interview', sessionId);
      if (events.length === 0) {
        console.log(JSON.stringify({ error: `Session not found: ${sessionId}` }, null, 2));
        return;
      }

      const startEvent = events.find((e) => e.eventType === EventType.INTERVIEW_SESSION_STARTED);
      const completeEvent = events.find((e) => e.eventType === EventType.INTERVIEW_SESSION_COMPLETED);
      const scoreEvents = events.filter((e) => e.eventType === EventType.INTERVIEW_RESOLUTION_SCORED);
      const questionEvents = events.filter((e) => e.eventType === EventType.INTERVIEW_QUESTION_ASKED);
      const latestScore = scoreEvents.length > 0 ? scoreEvents[scoreEvents.length - 1] : null;
      const payload = (event: DomainEvent | null | undefined) => event?.payload as Record<string, unknown> | undefined;

      console.log(JSON.stringify({
        session: {
          sessionId,
          topic: payload(startEvent)?.topic ?? 'Unknown',
          status: completeEvent ? 'completed' : 'in_progress',
          projectType: payload(startEvent)?.projectType ?? 'unknown',
          totalRounds: questionEvents.length,
          resolutionScore: latestScore
            ? { overall: payload(latestScore)?.overall, isReady: payload(latestScore)?.isReady }
            : null,
          createdAt: startEvent?.timestamp,
        },
      }, null, 2));
    } else {
      // List all sessions from events
      const startEvents = eventStore.getByType(EventType.INTERVIEW_SESSION_STARTED, 100);

      if (startEvents.length === 0) {
        console.log(JSON.stringify({ sessions: [], total: 0, message: 'No interview sessions found.' }, null, 2));
        return;
      }

      const sessions = startEvents.map((start) => {
        const sessionEvents = eventStore.getByAggregate('interview', start.aggregateId);
        const completeEvent = sessionEvents.find((e) => e.eventType === EventType.INTERVIEW_SESSION_COMPLETED);
        const questionEvents = sessionEvents.filter((e) => e.eventType === EventType.INTERVIEW_QUESTION_ASKED);
        const scoreEvents = sessionEvents.filter((e) => e.eventType === EventType.INTERVIEW_RESOLUTION_SCORED);
        const latestScore = scoreEvents.length > 0 ? scoreEvents[scoreEvents.length - 1] : null;

        return {
          sessionId: start.aggregateId,
          topic: (start.payload as Record<string, unknown>)?.topic ?? 'Unknown',
          status: completeEvent ? 'completed' : 'in_progress',
          projectType: (start.payload as Record<string, unknown>)?.projectType ?? 'unknown',
          totalRounds: questionEvents.length,
          resolutionScore: latestScore
            ? (latestScore.payload as Record<string, unknown>)?.overall
            : 'N/A',
          createdAt: start.timestamp,
        };
      });

      console.log(JSON.stringify({ sessions, total: sessions.length }, null, 2));
    }
  } finally {
    eventStore.close();
  }
}
