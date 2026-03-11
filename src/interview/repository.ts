import type { EventStore } from '../events/store.js';
import type { DomainEvent, InterviewSession, InterviewRound, AmbiguityScore, ProjectType, GestaltPrinciple } from '../core/types.js';
import { EventType } from '../events/types.js';

/**
 * InterviewSessionRepository — Event Replay 기반 InterviewSession 재구성.
 * 도메인 전용 Repository: aggregate_type='interview' 이벤트만 처리.
 */
export class InterviewSessionRepository {
  constructor(private eventStore: EventStore) {}

  /**
   * 이벤트를 fold하여 InterviewSession 상태를 완전히 복원한다.
   */
  reconstruct(sessionId: string): InterviewSession | null {
    const events = this.eventStore.replay('interview', sessionId);
    if (events.length === 0) return null;

    return this.foldEvents(sessionId, events);
  }

  /**
   * 모든 Interview 세션 ID 목록을 반환한다.
   */
  list(): string[] {
    return this.eventStore.listAggregates('interview');
  }

  /**
   * 모든 Interview 세션을 재구성하여 반환한다.
   */
  reconstructAll(): InterviewSession[] {
    const ids = this.list();
    const sessions: InterviewSession[] = [];
    for (const id of ids) {
      const session = this.reconstruct(id);
      if (session) sessions.push(session);
    }
    return sessions;
  }

  private foldEvents(sessionId: string, events: DomainEvent[]): InterviewSession {
    // 초기 상태 — SESSION_STARTED 이벤트에서 시작
    const firstEvent = events[0]!;
    const startPayload = firstEvent.payload as { topic: string; projectType: ProjectType };

    const session: InterviewSession = {
      sessionId,
      topic: startPayload.topic ?? '',
      status: 'in_progress',
      projectType: startPayload.projectType ?? 'greenfield',
      rounds: [],
      ambiguityScore: null,
      createdAt: firstEvent.timestamp,
      updatedAt: firstEvent.timestamp,
    };

    // 순차적으로 이벤트를 fold
    for (const event of events) {
      this.applyEvent(session, event);
    }

    return session;
  }

  private applyEvent(session: InterviewSession, event: DomainEvent): void {
    session.updatedAt = event.timestamp;
    const payload = event.payload as Record<string, unknown>;

    switch (event.eventType) {
      case EventType.INTERVIEW_SESSION_STARTED:
        // 이미 초기 상태에서 처리됨
        break;

      case EventType.INTERVIEW_QUESTION_ASKED: {
        const round: InterviewRound = {
          roundNumber: payload.roundNumber as number,
          question: payload.question as string,
          userResponse: null,
          gestaltFocus: payload.gestaltFocus as GestaltPrinciple,
          timestamp: event.timestamp,
        };
        session.rounds.push(round);
        break;
      }

      case EventType.INTERVIEW_RESPONSE_RECORDED: {
        const roundNumber = payload.roundNumber as number;
        const round = session.rounds.find((r) => r.roundNumber === roundNumber);
        if (round) {
          round.userResponse = payload.response as string;
        }
        break;
      }

      case EventType.INTERVIEW_AMBIGUITY_SCORED: {
        session.ambiguityScore = {
          overall: payload.overall as number,
          isReady: payload.isReady as boolean,
          dimensions: (payload.dimensions as AmbiguityScore['dimensions']) ?? [],
        };
        break;
      }

      case EventType.INTERVIEW_SESSION_COMPLETED:
        session.status = 'completed';
        break;

      // BROWNFIELD_DETECTED, GESTALT_PRINCIPLE_APPLIED — 세션 상태에는 직접 영향 없음
      default:
        break;
    }
  }
}
