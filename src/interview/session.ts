import { randomUUID } from 'node:crypto';
import type {
  InterviewSession,
  InterviewRound,
  ResolutionScore,
  ProjectType,
  GestaltPrinciple,
  CompressedContext,
} from '../core/types.js';
import { SessionNotFoundError, SessionAlreadyCompletedError } from '../core/errors.js';
import { DEFAULT_SESSION_TTL_MS } from '../core/constants.js';
import { logger } from '../core/logger.js';
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
      resolutionScore: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.sessions.set(session.sessionId, session);

    this.eventStore.append('interview', session.sessionId, EventType.INTERVIEW_SESSION_STARTED, {
      topic,
      projectType,
    });

    logger.info('interview.started', {
      module: 'interview',
      sessionId: session.sessionId,
      projectType,
    });

    return session;
  }

  /**
   * updatedAt(마지막 활동) 기준으로 ttlMs를 초과한 인메모리 세션을 제거한다.
   * SQLite 이벤트 원장은 보존되므로 재시작 시 loadFromStore로 복원 가능.
   * @returns 제거된 세션 수
   */
  cleanup(ttlMs = DEFAULT_SESSION_TTL_MS): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (now - new Date(session.updatedAt).getTime() > ttlMs) {
        this.sessions.delete(id);
        removed++;
      }
    }
    return removed;
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

  addQuestion(sessionId: string, question: string, gestaltFocus: GestaltPrinciple): InterviewRound {
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

  updateResolutionScore(sessionId: string, score: ResolutionScore): void {
    const session = this.get(sessionId);
    session.resolutionScore = score;
    session.updatedAt = new Date().toISOString();

    this.eventStore.append('interview', sessionId, EventType.INTERVIEW_RESOLUTION_SCORED, {
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
      finalResolutionScore: session.resolutionScore?.overall ?? null,
    });

    logger.info('interview.completed', {
      module: 'interview',
      sessionId,
      totalRounds: session.rounds.length,
      finalResolutionScore: session.resolutionScore?.overall ?? null,
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
    return Array.from(this.sessions.values()).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }
}
