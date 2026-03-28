import { randomUUID } from 'node:crypto';
import type {
  InterviewSession,
  InterviewRound,
  AmbiguityScore,
  ProjectType,
  GestaltPrinciple,
  CompressedContext,
} from '../core/types.js';
import { SessionNotFoundError, SessionAlreadyCompletedError } from '../core/errors.js';
import { EventStore } from '../events/store.js';
import { EventType } from '../events/types.js';
import { InterviewSessionRepository } from './repository.js';

export class SessionManager {
  private sessions = new Map<string, InterviewSession>();

  constructor(private eventStore: EventStore) {}

  /**
   * EventStore에서 기존 세션을 복원하여 메모리 Map에 로드한다.
   * 서버 시작 시 한 번 호출.
   */
  loadFromStore(): void {
    const repo = new InterviewSessionRepository(this.eventStore);
    const restored = repo.reconstructAll();
    for (const session of restored) {
      this.sessions.set(session.sessionId, session);
    }
  }

  create(topic: string, projectType: ProjectType): InterviewSession {
    const session: InterviewSession = {
      sessionId: randomUUID(),
      topic,
      status: 'in_progress',
      projectType,
      rounds: [],
      ambiguityScore: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.sessions.set(session.sessionId, session);

    this.eventStore.append('interview', session.sessionId, EventType.INTERVIEW_SESSION_STARTED, {
      topic,
      projectType,
    });

    return session;
  }

  get(sessionId: string): InterviewSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new SessionNotFoundError(sessionId);
    return session;
  }

  getLatest(): InterviewSession | null {
    let latest: InterviewSession | null = null;
    for (const session of this.sessions.values()) {
      latest = session;
    }
    return latest;
  }

  addQuestion(
    sessionId: string,
    question: string,
    gestaltFocus: GestaltPrinciple,
  ): InterviewRound {
    const session = this.get(sessionId);
    if (session.status !== 'in_progress') {
      throw new SessionAlreadyCompletedError(sessionId);
    }

    const round: InterviewRound = {
      roundNumber: session.rounds.length + 1,
      question,
      userResponse: null,
      gestaltFocus,
      timestamp: new Date().toISOString(),
    };

    session.rounds.push(round);
    session.updatedAt = new Date().toISOString();

    this.eventStore.append('interview', sessionId, EventType.INTERVIEW_QUESTION_ASKED, {
      roundNumber: round.roundNumber,
      question,
      gestaltFocus,
    });

    return round;
  }

  recordResponse(sessionId: string, response: string): InterviewRound {
    const session = this.get(sessionId);
    if (session.status !== 'in_progress') {
      throw new SessionAlreadyCompletedError(sessionId);
    }

    const currentRound = session.rounds[session.rounds.length - 1];
    if (!currentRound) throw new SessionNotFoundError(sessionId);

    currentRound.userResponse = response;
    session.updatedAt = new Date().toISOString();

    this.eventStore.append('interview', sessionId, EventType.INTERVIEW_RESPONSE_RECORDED, {
      roundNumber: currentRound.roundNumber,
      response,
    });

    return currentRound;
  }

  updateAmbiguityScore(sessionId: string, score: AmbiguityScore): void {
    const session = this.get(sessionId);
    session.ambiguityScore = score;
    session.updatedAt = new Date().toISOString();

    this.eventStore.append('interview', sessionId, EventType.INTERVIEW_AMBIGUITY_SCORED, {
      overall: score.overall,
      isReady: score.isReady,
      dimensions: score.dimensions,
    });
  }

  setCompressedContext(sessionId: string, compressedContext: CompressedContext): void {
    const session = this.get(sessionId);
    session.compressedContext = compressedContext;
    session.updatedAt = new Date().toISOString();
  }

  complete(sessionId: string): InterviewSession {
    const session = this.get(sessionId);
    session.status = 'completed';
    session.updatedAt = new Date().toISOString();

    this.eventStore.append('interview', sessionId, EventType.INTERVIEW_SESSION_COMPLETED, {
      totalRounds: session.rounds.length,
      finalAmbiguityScore: session.ambiguityScore?.overall ?? null,
    });

    return session;
  }

  abort(sessionId: string): InterviewSession {
    const session = this.get(sessionId);
    session.status = 'aborted';
    session.updatedAt = new Date().toISOString();
    return session;
  }

  list(): InterviewSession[] {
    return Array.from(this.sessions.values()).sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt),
    );
  }
}
