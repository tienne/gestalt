import { randomUUID } from 'node:crypto';
import type {
  InterviewSession,
  InterviewRound,
  ResolutionScore,
  ProjectType,
  GestaltPrinciple,
  CompressedContext,
} from '../core/types.js';
import {
  SessionNotFoundError,
  SessionAlreadyCompletedError,
  InterviewNotReadyError,
} from '../core/errors.js';
import { DEFAULT_SESSION_TTL_MS, RESOLUTION_THRESHOLD } from '../core/constants.js';
import { logger } from '../core/logger.js';
import type { IEventStore } from '../events/store.js';
import { EventType } from '../events/types.js';
import { InterviewSessionRepository } from './repository.js';

/**
 * 인터뷰 세션의 인메모리 캐시. 기준은 이벤트 스토어다.
 *
 * 같은 DB를 여러 MCP 프로세스(dispatch 워커 등)가 함께 쓴다. 그래서 캐시가 담은
 * 세션마다 그때까지 반영한 이벤트 수를 들고 있다가, get()에서 스토어의 수와 다르면
 * 다시 재구성한다. 모든 변경 메서드가 get()부터 부르므로 쓰기도 최신 상태 위에서 한다.
 */
export class SessionManager {
  private sessions = new Map<string, InterviewSession>();
  private eventCounts = new Map<string, number>();
  private repo: InterviewSessionRepository;

  constructor(private eventStore: IEventStore) {
    this.repo = new InterviewSessionRepository(eventStore);
  }

  /**
   * EventStore에서 기존 세션을 복원하여 메모리 Map에 로드한다.
   * 서버 시작 시 한 번 호출.
   */
  loadFromStore(): void {
    for (const id of this.repo.list()) this.reload(id);
  }

  private reload(sessionId: string): InterviewSession | null {
    const loaded = this.repo.load(sessionId);
    if (!loaded) return null;
    this.sessions.set(sessionId, loaded.session);
    this.eventCounts.set(sessionId, loaded.eventCount);
    return loaded.session;
  }

  private record(sessionId: string, eventType: EventType, payload: Record<string, unknown>): void {
    this.eventStore.append('interview', sessionId, eventType, payload);
    this.eventCounts.set(sessionId, (this.eventCounts.get(sessionId) ?? 0) + 1);
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

    this.record(session.sessionId, EventType.INTERVIEW_SESSION_STARTED, {
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
   * SQLite 이벤트 원장은 보존되므로 지운 세션도 get()이 다시 재구성한다.
   * @returns 제거된 세션 수
   */
  cleanup(ttlMs = DEFAULT_SESSION_TTL_MS): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (now - new Date(session.updatedAt).getTime() > ttlMs) {
        this.sessions.delete(id);
        this.eventCounts.delete(id);
        removed++;
      }
    }
    return removed;
  }

  get(sessionId: string): InterviewSession {
    const cached = this.sessions.get(sessionId);
    if (
      cached &&
      this.eventCounts.get(sessionId) === this.eventStore.countByAggregate('interview', sessionId)
    ) {
      return cached;
    }
    const session = this.reload(sessionId);
    if (!session) throw new SessionNotFoundError(sessionId);
    return session;
  }

  getLatest(): InterviewSession | null {
    let latest: InterviewSession | null = null;
    for (const session of this.sessions.values()) {
      if (!latest || session.updatedAt >= latest.updatedAt) latest = session;
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

    this.record(sessionId, EventType.INTERVIEW_QUESTION_ASKED, {
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

    this.record(sessionId, EventType.INTERVIEW_RESPONSE_RECORDED, {
      roundNumber: currentRound.roundNumber,
      response,
    });

    return currentRound;
  }

  updateResolutionScore(sessionId: string, score: ResolutionScore): void {
    const session = this.get(sessionId);
    session.resolutionScore = score;
    session.updatedAt = new Date().toISOString();

    // 채점 시점의 마지막 라운드(방금 답변된 라운드)에 감지된 모순을 기록한다.
    const currentRound = session.rounds[session.rounds.length - 1];
    if (currentRound && score.contradictions && score.contradictions.length > 0) {
      currentRound.contradictions = score.contradictions;
    }

    this.record(sessionId, EventType.INTERVIEW_RESOLUTION_SCORED, {
      overall: score.overall,
      isReady: score.isReady,
      dimensions: score.dimensions,
      contradictions: score.contradictions ?? [],
      roundNumber: currentRound?.roundNumber ?? null,
    });
  }

  setCompressedContext(sessionId: string, compressedContext: CompressedContext): void {
    const session = this.get(sessionId);
    session.compressedContext = compressedContext;
    session.updatedAt = new Date().toISOString();

    this.record(sessionId, EventType.INTERVIEW_CONTEXT_COMPRESSED, { compressedContext });
  }

  complete(sessionId: string, options: { force?: boolean } = {}): InterviewSession {
    const session = this.get(sessionId);
    if (session.status !== 'in_progress') {
      throw new SessionAlreadyCompletedError(sessionId);
    }
    const ready = session.resolutionScore?.isReady === true;
    if (!ready && !options.force) {
      throw new InterviewNotReadyError(
        session.resolutionScore?.overall ?? null,
        RESOLUTION_THRESHOLD,
      );
    }
    const forced = !ready;

    session.status = 'completed';
    session.updatedAt = new Date().toISOString();
    if (forced) session.forcedComplete = true;

    this.record(sessionId, EventType.INTERVIEW_SESSION_COMPLETED, {
      totalRounds: session.rounds.length,
      finalResolutionScore: session.resolutionScore?.overall ?? null,
      forced,
    });

    logger.info('interview.completed', {
      module: 'interview',
      sessionId,
      totalRounds: session.rounds.length,
      finalResolutionScore: session.resolutionScore?.overall ?? null,
      forced,
    });

    return session;
  }

  abort(sessionId: string): InterviewSession {
    const session = this.get(sessionId);
    session.status = 'aborted';
    session.updatedAt = new Date().toISOString();

    this.record(sessionId, EventType.INTERVIEW_SESSION_ABORTED, {});

    return session;
  }

  list(): InterviewSession[] {
    return Array.from(this.sessions.values()).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }
}
