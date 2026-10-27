import type {
  InterviewSession,
  ResolutionScore,
  ProjectType,
  GestaltPrinciple,
  RescoreMode,
  RescoreResult,
} from '../core/types.js';
import {
  MAX_INTERVIEW_ROUNDS,
  PRINCIPLE_QUESTION_STRATEGIES,
  RESOLUTION_THRESHOLD,
} from '../core/constants.js';
import { InterviewError } from '../core/errors.js';
import { type Result, ok, err } from '../core/result.js';
import { selectNextPrinciple, getPrinciplePhaseLabel } from '../gestalt/principles.js';
import { computeResolutionScore } from '../gestalt/analyzer.js';
import { SessionManager, type InterviewOptions } from './session.js';
import { detectProjectType } from './brownfield.js';
import {
  type RescoreSetting,
  shouldRequestRescore,
  compareRescore,
  readinessAfterRescore,
  principleAfterRescore,
} from './rescore.js';
import { EventStore } from '../events/store.js';
import { EventType } from '../events/types.js';
import {
  INTERVIEW_SYSTEM_PROMPT,
  buildQuestionPrompt,
  buildResolutionPrompt,
  buildRescorePrompt,
} from '../llm/prompts.js';
import type { AgentRegistry } from '../agent/registry.js';
import { mergeSystemPrompt, getActiveAgentNames } from '../agent/prompt-resolver.js';
import { ContextCompressor } from './context-compressor.js';

// ─── Types ──────────────────────────────────────────────────────

export interface GestaltContext {
  systemPrompt: string;
  currentPrinciple: GestaltPrinciple;
  principleStrategy: string;
  phase: string;
  questionPrompt: string;
  scoringPrompt?: string;
  roundNumber: number;
  activeAgents?: string[];
}

export interface PassthroughStartResult {
  session: InterviewSession;
  projectType: ProjectType;
  detectedFiles: string[];
  gestaltContext: GestaltContext;
}

export interface PassthroughRespondResult {
  session: InterviewSession;
  resolutionScore: ResolutionScore | null;
  gestaltContext: GestaltContext;
  compressionContext?: { systemPrompt: string; compressionPrompt: string };
  needsCompression?: boolean;
  /** 처음 기준값을 넘은 채점이면 다시 채점할 프롬프트. 이때 nextAction은 rescore다 */
  rescorePrompt?: string;
  nextAction?: 'rescore';
}

export interface PassthroughScoreResult {
  resolutionScore: ResolutionScore | null;
  scoringPrompt?: string;
  rescorePrompt?: string;
  nextAction?: 'rescore';
  /** rescore: true로 받은 채점의 비교 결과 */
  rescore?: RescoreResult;
  /** gate가 판정을 미뤘을 때 다음 질문을 만들 컨텍스트 */
  gestaltContext?: GestaltContext;
}

export interface RescoreOptions {
  rescore?: boolean;
  rescoreMode?: RescoreMode;
}

// ─── External resolution score shape (from caller LLM) ───────────

export interface ExternalResolutionScore {
  goalClarity: number;
  constraintClarity: number;
  successCriteria: number;
  priorityClarity: number;
  contextClarity?: number;
  contradictions?: string[];
}

// ─── Engine ─────────────────────────────────────────────────────

export class PassthroughEngine {
  private sessionManager: SessionManager;
  private agentRegistry?: AgentRegistry;
  private resolutionThreshold: number;
  private rescoreSetting: RescoreSetting;

  constructor(
    private eventStore: EventStore,
    agentRegistry?: AgentRegistry,
    options: InterviewOptions = {},
  ) {
    this.resolutionThreshold = options.resolutionThreshold ?? RESOLUTION_THRESHOLD;
    this.rescoreSetting = options.rescore ?? 'record';
    this.sessionManager = new SessionManager(eventStore, options);
    this.sessionManager.loadFromStore();
    this.agentRegistry = agentRegistry;
  }

  start(
    topic: string,
    cwd?: string,
    memoryContextStr?: string,
  ): Result<PassthroughStartResult, InterviewError> {
    try {
      const { projectType, detectedFiles } = detectProjectType(cwd);

      if (detectedFiles.length > 0) {
        this.eventStore.append('interview', 'system', EventType.BROWNFIELD_DETECTED, {
          detectedFiles,
          projectType,
        });
      }

      const session = this.sessionManager.create(topic, projectType);
      const principle = selectNextPrinciple({
        roundNumber: 1,
        dimensions: [],
        hasContradictions: false,
      });

      const gestaltContext = this.buildGestaltContext(topic, principle, 1, [], projectType);

      if (memoryContextStr) {
        gestaltContext.systemPrompt = `${gestaltContext.systemPrompt}\n\n${memoryContextStr}`;
      }

      return ok({
        session,
        projectType,
        detectedFiles,
        gestaltContext,
      });
    } catch (e) {
      return err(
        new InterviewError(
          `Failed to start interview: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  }

  respond(
    sessionId: string,
    response: string,
    generatedQuestion: string,
    externalScore?: ExternalResolutionScore,
  ): Result<PassthroughRespondResult, InterviewError> {
    try {
      const session = this.sessionManager.get(sessionId);

      // 호스트는 직전 응답의 gestaltContext.currentPrinciple로 질문을 만들었다.
      // 그 원칙을 라운드에 남겨야 어느 차원을 물었는지가 기록과 맞는다
      const principle =
        this.appliedPrinciple(sessionId, session.rounds.length + 1) ??
        (session.rounds.length > 0
          ? session.rounds[session.rounds.length - 1]!.gestaltFocus
          : selectNextPrinciple({ roundNumber: 1, dimensions: [], hasContradictions: false }));

      // If there's no pending round (no unanswered question), add one
      const lastRound = session.rounds[session.rounds.length - 1];
      if (!lastRound || lastRound.userResponse !== null) {
        this.sessionManager.addQuestion(sessionId, generatedQuestion, principle);
      } else {
        // Update the question text if the round exists but has no response yet
        lastRound.question = generatedQuestion;
      }

      // Record the user's response
      this.sessionManager.recordResponse(sessionId, response);

      if (session.rounds.length >= MAX_INTERVIEW_ROUNDS) {
        return err(
          new InterviewError(
            `Maximum interview rounds (${MAX_INTERVIEW_ROUNDS}) reached. Complete the session (pass force=true if resolution is still below the threshold).`,
          ),
        );
      }

      // Compute resolution score if provided externally
      let resolutionScore: ResolutionScore | null = null;
      let rescorePrompt: string | undefined;
      if (externalScore) {
        resolutionScore = computeResolutionScore(
          rawScore(externalScore),
          session.projectType,
          this.resolutionThreshold,
        );
        const rejected = rejectUnbackedReadyScore(session, resolutionScore);
        if (rejected) return err(rejected);
        rescorePrompt = this.recordScore(sessionId, resolutionScore);
      }

      // Select next principle
      const hasContradictions = (externalScore?.contradictions?.length ?? 0) > 0;

      const nextPrinciple = selectNextPrinciple({
        roundNumber: session.rounds.length + 1,
        dimensions: resolutionScore?.dimensions ?? [],
        hasContradictions,
      });

      this.eventStore.append('interview', sessionId, EventType.GESTALT_PRINCIPLE_APPLIED, {
        principle: nextPrinciple,
        roundNumber: session.rounds.length + 1,
      });

      // Build context for next question generation (with scoring prompt for current round)
      const previousRounds = session.rounds.map((r) => ({
        question: r.question,
        response: r.userResponse,
      }));

      const gestaltContext = this.buildGestaltContext(
        session.topic,
        nextPrinciple,
        session.rounds.length + 1,
        previousRounds,
        session.projectType,
        true, // include scoring prompt
      );

      // Check if compression is needed
      const compressor = new ContextCompressor();
      const updatedSession = this.sessionManager.get(sessionId);
      let compressionContext: { systemPrompt: string; compressionPrompt: string } | undefined;
      let needsCompression = false;
      if (compressor.needsCompression(updatedSession.rounds)) {
        needsCompression = true;
        compressionContext = compressor.buildCompressionContext(
          updatedSession.topic,
          updatedSession.rounds,
          updatedSession.compressedContext?.summary,
        );
      }

      return ok({
        session: updatedSession,
        resolutionScore,
        gestaltContext,
        ...(needsCompression ? { compressionContext, needsCompression } : {}),
        ...(rescorePrompt && { rescorePrompt, nextAction: 'rescore' as const }),
      });
    } catch (e) {
      return err(
        new InterviewError(
          `Failed to process response: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  }

  score(
    sessionId: string,
    externalScore?: ExternalResolutionScore,
    options: RescoreOptions = {},
  ): Result<PassthroughScoreResult, InterviewError> {
    try {
      const session = this.sessionManager.get(sessionId);

      if (options.rescore) {
        if (!externalScore) {
          return err(new InterviewError('rescore: true에는 resolutionScore가 필요합니다.'));
        }
        return this.rescore(sessionId, externalScore, options.rescoreMode ?? 'same-context');
      }

      if (externalScore) {
        const resolutionScore = computeResolutionScore(
          rawScore(externalScore),
          session.projectType,
          this.resolutionThreshold,
        );
        const rejected = rejectUnbackedReadyScore(session, resolutionScore);
        if (rejected) return err(rejected);
        const rescorePrompt = this.recordScore(sessionId, resolutionScore);
        return ok({
          resolutionScore,
          ...(rescorePrompt && { rescorePrompt, nextAction: 'rescore' as const }),
        });
      }

      // No external score — return scoring prompt for the caller
      const rounds = session.rounds
        .filter((r) => r.userResponse)
        .map((r) => ({ question: r.question, response: r.userResponse }));

      const scoringPrompt = buildResolutionPrompt(session.topic, rounds, session.projectType);
      return ok({ resolutionScore: session.resolutionScore, scoringPrompt });
    } catch (e) {
      return err(
        new InterviewError(`Failed to score: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
  }

  complete(sessionId: string, force = false): Result<InterviewSession, InterviewError> {
    try {
      return ok(this.sessionManager.complete(sessionId, { force }));
    } catch (e) {
      return err(
        new InterviewError(`Failed to complete: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
  }

  getSession(sessionId: string): InterviewSession {
    return this.sessionManager.get(sessionId);
  }

  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  getLatestSession(): InterviewSession | null {
    return this.sessionManager.getLatest();
  }

  listSessions(): InterviewSession[] {
    return this.sessionManager.list();
  }

  // ─── Private helpers ────────────────────────────────────────────

  /** 채점을 세션에 넣는다. 다시 채점하기를 요청할 차례면 그 프롬프트를 돌려준다 */
  private recordScore(sessionId: string, score: ResolutionScore): string | undefined {
    const state = this.sessionManager.rescoreState(sessionId);
    const request = shouldRequestRescore(
      this.rescoreSetting,
      state,
      score,
      this.resolutionThreshold,
    );
    // gate는 다시 채점을 받기 전까지 기준값을 넘었다고 보지 않는다
    if (request && this.rescoreSetting === 'gate') score.isReady = false;
    this.sessionManager.updateResolutionScore(sessionId, score);
    if (!request) return undefined;

    const session = this.sessionManager.get(sessionId);
    return buildRescorePrompt(
      session.topic,
      session.rounds.map((r) => ({ question: r.question, response: r.userResponse })),
      session.projectType,
    );
  }

  private rescore(
    sessionId: string,
    externalScore: ExternalResolutionScore,
    mode: RescoreMode,
  ): Result<PassthroughScoreResult, InterviewError> {
    if (this.rescoreSetting === 'off') {
      return err(new InterviewError('interview.rescore가 off라 다시 채점을 받지 않습니다.'));
    }
    const state = this.sessionManager.rescoreState(sessionId);
    if (state === 'done') {
      return err(
        new InterviewError(
          '이미 다시 채점한 인터뷰입니다. 다시 채점하기는 인터뷰마다 한 번만 받습니다.',
        ),
      );
    }
    const session = this.sessionManager.get(sessionId);
    const first = session.resolutionScore;
    if (state === 'none' || !first) {
      return err(
        new InterviewError(
          `아직 기준값(${this.resolutionThreshold})을 넘은 채점이 없습니다. 다시 채점하기는 처음 넘은 채점 뒤에 받습니다.`,
        ),
      );
    }

    const second = computeResolutionScore(
      rawScore(externalScore),
      session.projectType,
      this.resolutionThreshold,
    );
    const rescore = compareRescore(first, second, mode, this.resolutionThreshold);
    const isReady = readinessAfterRescore(
      this.rescoreSetting,
      first,
      rescore,
      this.resolutionThreshold,
    );
    const roundNumber = session.rounds.length + 1;
    const principle =
      !isReady && this.rescoreSetting === 'gate'
        ? principleAfterRescore(first, second, rescore, roundNumber)
        : null;
    const resolutionScore = this.sessionManager.recordRescore(sessionId, rescore, isReady);
    if (!principle) return ok({ resolutionScore, rescore });

    // gate가 판정을 미뤘으면 다음 질문은 흔들린 차원부터 묻는다
    this.eventStore.append('interview', sessionId, EventType.GESTALT_PRINCIPLE_APPLIED, {
      principle,
      roundNumber,
    });
    const gestaltContext = this.buildGestaltContext(
      session.topic,
      principle,
      roundNumber,
      session.rounds.map((r) => ({ question: r.question, response: r.userResponse })),
      session.projectType,
    );
    return ok({ resolutionScore, rescore, gestaltContext });
  }

  /** 직전 respond가 이 라운드용으로 고른 원칙. 첫 라운드나 기록이 없으면 null */
  private appliedPrinciple(sessionId: string, roundNumber: number): GestaltPrinciple | null {
    const applied = this.eventStore
      .replay('interview', sessionId)
      .filter(
        (e) =>
          e.eventType === EventType.GESTALT_PRINCIPLE_APPLIED &&
          (e.payload as { roundNumber?: unknown }).roundNumber === roundNumber,
      );
    const last = applied[applied.length - 1];
    return last ? (last.payload as { principle: GestaltPrinciple }).principle : null;
  }

  private buildGestaltContext(
    topic: string,
    principle: GestaltPrinciple,
    roundNumber: number,
    previousRounds: { question: string; response: string | null }[],
    projectType: ProjectType,
    includeScoringPrompt = false,
  ): GestaltContext {
    const questionPrompt = buildQuestionPrompt(topic, principle, previousRounds, projectType);
    const phase = getPrinciplePhaseLabel(roundNumber);

    const systemPrompt = mergeSystemPrompt(
      INTERVIEW_SYSTEM_PROMPT,
      this.agentRegistry,
      'interview',
    );
    const activeAgents = getActiveAgentNames(this.agentRegistry, 'interview');

    const context: GestaltContext = {
      systemPrompt,
      currentPrinciple: principle,
      principleStrategy: PRINCIPLE_QUESTION_STRATEGIES[principle],
      phase,
      questionPrompt,
      roundNumber,
      ...(activeAgents.length > 0 && { activeAgents }),
    };

    if (includeScoringPrompt) {
      const answeredRounds = previousRounds
        .filter((r) => r.response)
        .map((r) => ({ question: r.question, response: r.response }));
      context.scoringPrompt = buildResolutionPrompt(topic, answeredRounds, projectType);
    }

    return context;
  }
}

function rawScore(external: ExternalResolutionScore) {
  return {
    goalClarity: external.goalClarity,
    constraintClarity: external.constraintClarity,
    successCriteria: external.successCriteria,
    priorityClarity: external.priorityClarity,
    contextClarity: external.contextClarity,
    contradictions: external.contradictions ?? [],
  };
}

// 답을 하나도 안 받은 세션은 근거가 없으니 임계값 이상 점수를 받지 않는다.
// 공백만 보낸 답은 답으로 치지 않는다.
// 임계값 미만은 막지 않는다 — 시작 직전 상태를 낮게 기록하는 건 정상 흐름이다.
function rejectUnbackedReadyScore(
  session: InterviewSession,
  resolutionScore: ResolutionScore,
): InterviewError | null {
  if (!resolutionScore.isReady) return null;
  const answered = session.rounds.some((r) => (r.userResponse ?? '').trim() !== '');
  if (answered) return null;
  return new InterviewError(
    `답변한 라운드가 없는 세션에 임계값 이상 해상도(${resolutionScore.overall.toFixed(2)})를 기록할 수 없습니다. 먼저 respond로 사용자 답변을 받으세요.`,
  );
}
