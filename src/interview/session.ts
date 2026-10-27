import { randomUUID } from 'node:crypto';
import type {
  InterviewSession,
  InterviewRound,
  ResolutionScore,
  ProjectType,
  GestaltPrinciple,
  CompressedContext,
  RescoreResult,
} from '../core/types.js';
import {
  SessionNotFoundError,
  SessionAlreadyCompletedError,
  InterviewNotReadyError,
} from '../core/errors.js';
import {
  DEFAULT_SESSION_TTL_MS,
  READINESS_RULE_VERSION,
  RESOLUTION_THRESHOLD,
} from '../core/constants.js';
import { logger } from '../core/logger.js';
import type { IEventStore } from '../events/store.js';
import { EventType } from '../events/types.js';
import { InterviewSessionRepository } from './repository.js';
import { computeSignals } from '../gestalt/signals.js';
import type { InterviewConfig } from '../core/config.js';
import type { RescoreState } from './rescore.js';

export type InterviewOptions = Partial<InterviewConfig>;

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
  private resolutionThreshold: number;

  constructor(
    private eventStore: IEventStore,
    options: InterviewOptions = {},
  ) {
    this.resolutionThreshold = options.resolutionThreshold ?? RESOLUTION_THRESHOLD;
    this.repo = new InterviewSessionRepository(eventStore, this.resolutionThreshold);
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

  private record(
    sessionId: string,
    eventType: EventType,
    payload: Record<string, unknown>,
  ): string {
    const event = this.eventStore.append('interview', sessionId, eventType, payload);
    this.eventCounts.set(sessionId, (this.eventCounts.get(sessionId) ?? 0) + 1);
    return event.timestamp;
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

    const roundNumber = session.rounds.length + 1;
    // replay는 라운드 시각을 이벤트 timestamp로 복원한다. 여기서 시각을 따로 찍으면
    // 밀리초 경계에 걸릴 때 라이브 세션과 replay 결과가 어긋난다
    const timestamp = this.record(sessionId, EventType.INTERVIEW_QUESTION_ASKED, {
      roundNumber,
      question,
      gestaltFocus,
    });

    const round: InterviewRound = {
      roundNumber,
      question,
      userResponse: null,
      gestaltFocus,
      timestamp,
    };

    session.rounds.push(round);
    session.updatedAt = timestamp;

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
    score.signals = computeSignals(session, score, session.resolutionScore);
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
      threshold: score.threshold ?? this.resolutionThreshold,
      readinessRuleVersion: READINESS_RULE_VERSION,
      signals: score.signals,
    });
  }

  /** 다시 채점하기가 어디까지 왔는지. 지금 들어온 채점을 기록하기 전에 부른다 */
  rescoreState(sessionId: string): RescoreState {
    const session = this.get(sessionId);
    if (session.resolutionScore?.signals?.rescore) return 'done';
    const crossed = this.eventStore.replay('interview', sessionId).some((e) => {
      if (e.eventType !== EventType.INTERVIEW_RESOLUTION_SCORED) return false;
      const payload = e.payload as { overall?: unknown; threshold?: unknown };
      const threshold =
        typeof payload.threshold === 'number' ? payload.threshold : this.resolutionThreshold;
      return typeof payload.overall === 'number' && payload.overall >= threshold;
    });
    return crossed ? 'pending' : 'none';
  }

  /** 다시 채점한 결과를 지금 점수에 붙이고 판정을 갱신한다 */
  recordRescore(sessionId: string, rescore: RescoreResult, isReady: boolean): ResolutionScore {
    const session = this.get(sessionId);
    const score = session.resolutionScore;
    if (!score) throw new Error(`다시 채점할 점수가 없습니다: ${sessionId}`);
    score.isReady = isReady;
    score.signals = { ...(score.signals ?? computeSignals(session, score, null)), rescore };
    session.updatedAt = new Date().toISOString();

    this.record(sessionId, EventType.INTERVIEW_RESOLUTION_RESCORED, {
      rescore,
      isReady,
      readinessRuleVersion: READINESS_RULE_VERSION,
      signals: score.signals,
    });
    return score;
  }

  /** 다시 채점 호출이 실패한 사실만 남긴다. 판정과 상태는 그대로라 gate면 다음에 기준값을 넘을 때 다시 요청하고 record면 다시 요청하지 않는다 */
  recordRescoreFailure(sessionId: string, error: string): void {
    this.record(sessionId, EventType.INTERVIEW_RESOLUTION_RESCORE_FAILED, { error });
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
    const score = session.resolutionScore;
    const ready = score?.isReady === true;
    if (!ready && !options.force) {
      const threshold = score?.threshold ?? this.resolutionThreshold;
      // 기준값을 넘었는데 준비가 안 된 건 gate가 다시 채점을 기다리거나 결과로 보류한 경우뿐이다
      const hold =
        score && score.overall >= threshold
          ? score.signals?.rescore
            ? 'held'
            : 'pending'
          : undefined;
      throw new InterviewNotReadyError(score?.overall ?? null, threshold, hold);
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
