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
      const completeEvent = events.find(
        (e) => e.eventType === EventType.INTERVIEW_SESSION_COMPLETED,
      );
      const scoreEvents = events.filter(
        (e) => e.eventType === EventType.INTERVIEW_RESOLUTION_SCORED,
      );
      const questionEvents = events.filter(
        (e) => e.eventType === EventType.INTERVIEW_QUESTION_ASKED,
      );
      const latestScore = scoreEvents.length > 0 ? scoreEvents[scoreEvents.length - 1] : null;
      const payload = (event: DomainEvent | null | undefined) =>
        event?.payload as Record<string, unknown> | undefined;

      console.log(
        JSON.stringify(
          {
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
          },
          null,
          2,
        ),
      );
    } else {
      // List all sessions from events.
      // getByType은 timestamp DESC라 상한에 걸리면 오래된 세션부터 잘린다.
      // 잘렸는지 알려면 한 건 더 요청해 초과분이 있는지 본다.
      const SESSION_LIMIT = 100;
      const fetched = eventStore.getByType(EventType.INTERVIEW_SESSION_STARTED, SESSION_LIMIT + 1);
      const truncated = fetched.length > SESSION_LIMIT;
      const startEvents = truncated ? fetched.slice(0, SESSION_LIMIT) : fetched;

      if (startEvents.length === 0) {
        console.log(
          JSON.stringify(
            { sessions: [], total: 0, message: 'No interview sessions found.' },
            null,
            2,
          ),
        );
        return;
      }

      const sessions = startEvents.map((start) => {
        const sessionEvents = eventStore.getByAggregate('interview', start.aggregateId);
        const completeEvent = sessionEvents.find(
          (e) => e.eventType === EventType.INTERVIEW_SESSION_COMPLETED,
        );
        const questionEvents = sessionEvents.filter(
          (e) => e.eventType === EventType.INTERVIEW_QUESTION_ASKED,
        );
        const scoreEvents = sessionEvents.filter(
          (e) => e.eventType === EventType.INTERVIEW_RESOLUTION_SCORED,
        );
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

      // total을 sessions.length로 쓰면 잘린 값을 전체 개수라고 말하게 된다.
      // 세션이 150개일 때 "total: 100"을 보면 나머지 50개가 지워진 줄 안다.
      console.log(
        JSON.stringify(
          {
            sessions,
            shown: sessions.length,
            truncated,
            ...(truncated && {
              note: `최근 ${SESSION_LIMIT}건만 표시했습니다. 더 오래된 세션이 있습니다.`,
            }),
          },
          null,
          2,
        ),
      );
    }
  } finally {
    eventStore.close();
  }
}
