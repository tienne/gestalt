import type {
  InterviewSession,
  ResolutionScore,
  ProjectType,
  GestaltPrinciple,
} from '../core/types.js';
import { MAX_INTERVIEW_ROUNDS, RESOLUTION_THRESHOLD } from '../core/constants.js';
import { logger } from '../core/logger.js';
import { InterviewError } from '../core/errors.js';
import { type Result, ok, err } from '../core/result.js';
import { selectNextPrinciple } from '../gestalt/principles.js';
import { ResolutionScorer } from './resolution.js';
import { QuestionGenerator } from './questions.js';
import { SessionManager, type InterviewOptions } from './session.js';
import { detectProjectType } from './brownfield.js';
import {
  type RescoreSetting,
  shouldRequestRescore,
  compareRescore,
  readinessAfterRescore,
  principleAfterRescore,
} from './rescore.js';
import type { LLMAdapter } from '../llm/types.js';
import { EventStore } from '../events/store.js';
import { EventType } from '../events/types.js';

export interface StartResult {
  session: InterviewSession;
  firstQuestion: string;
  projectType: ProjectType;
  detectedFiles: string[];
}

export interface RespondResult {
  session: InterviewSession;
  nextQuestion: string;
  resolutionScore: ResolutionScore;
}

export class InterviewEngine {
  private sessionManager: SessionManager;
  private questionGenerator: QuestionGenerator;
  private resolutionScorer: ResolutionScorer;
  private resolutionThreshold: number;
  private rescoreSetting: RescoreSetting;

  /**
   * @param llm 질문 생성에 쓰는 기본 어댑터
   * @param frugalLlm 해상도 점수 산정용 저비용 어댑터. 없으면 `llm`을 그대로 쓴다.
   *   점수 산정은 정해진 기준에 점수를 매기는 작업이라 질문 생성만큼의 모델이 필요 없다.
   */
  constructor(
    llm: LLMAdapter,
    private eventStore: EventStore,
    frugalLlm?: LLMAdapter,
    options: InterviewOptions = {},
  ) {
    this.sessionManager = new SessionManager(eventStore, options);
    this.sessionManager.loadFromStore();
    this.questionGenerator = new QuestionGenerator(llm);
    this.resolutionScorer = new ResolutionScorer(frugalLlm ?? llm, options.resolutionThreshold);
    this.resolutionThreshold = options.resolutionThreshold ?? RESOLUTION_THRESHOLD;
    this.rescoreSetting = options.rescore ?? 'record';
  }

  async start(topic: string, cwd?: string): Promise<Result<StartResult, InterviewError>> {
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

      const { question } = await this.questionGenerator.generate(topic, principle, [], projectType);

      this.sessionManager.addQuestion(session.sessionId, question, principle);

      return ok({
        session,
        firstQuestion: question,
        projectType,
        detectedFiles,
      });
    } catch (e) {
      return err(
        new InterviewError(
          `Failed to start interview: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  }

  async respond(
    sessionId: string,
    response: string,
  ): Promise<Result<RespondResult, InterviewError>> {
    try {
      this.sessionManager.recordResponse(sessionId, response);

      const session = this.sessionManager.get(sessionId);

      if (session.rounds.length >= MAX_INTERVIEW_ROUNDS) {
        return err(
          new InterviewError(
            `Maximum interview rounds (${MAX_INTERVIEW_ROUNDS}) reached. Complete the session (pass force=true if resolution is still below the threshold).`,
          ),
        );
      }

      // Score resolution
      const resolutionScore = await this.resolutionScorer.score(
        session.topic,
        session.rounds,
        session.projectType,
      );
      const afterRescore = await this.recordScore(sessionId, resolutionScore);

      // Select next principle based on current state
      const hasContradictions = (resolutionScore.contradictions?.length ?? 0) > 0;

      const nextPrinciple =
        afterRescore ??
        selectNextPrinciple({
          roundNumber: session.rounds.length + 1,
          dimensions: resolutionScore.dimensions,
          hasContradictions,
        });

      this.eventStore.append('interview', sessionId, EventType.GESTALT_PRINCIPLE_APPLIED, {
        principle: nextPrinciple,
        roundNumber: session.rounds.length + 1,
      });

      // Generate next question
      const { question } = await this.questionGenerator.generate(
        session.topic,
        nextPrinciple,
        session.rounds,
        session.projectType,
      );

      this.sessionManager.addQuestion(sessionId, question, nextPrinciple);

      return ok({
        session: this.sessionManager.get(sessionId),
        nextQuestion: question,
        resolutionScore,
      });
    } catch (e) {
      return err(
        new InterviewError(
          `Failed to process response: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  }

  async score(sessionId: string): Promise<Result<ResolutionScore, InterviewError>> {
    try {
      const session = this.sessionManager.get(sessionId);
      const resolutionScore = await this.resolutionScorer.score(
        session.topic,
        session.rounds,
        session.projectType,
      );
      await this.recordScore(sessionId, resolutionScore);
      return ok(resolutionScore);
    } catch (e) {
      return err(
        new InterviewError(`Failed to score: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
  }

  /**
   * 채점을 기록하고 다시 채점할 차례면 같은 모델로 한 번 더 부른다.
   * gate가 판정을 미뤘으면 다음 질문에 쓸 원칙을 돌려준다.
   */
  private async recordScore(
    sessionId: string,
    score: ResolutionScore,
  ): Promise<GestaltPrinciple | null> {
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
    if (!request) return null;

    const session = this.sessionManager.get(sessionId);
    let second: ResolutionScore;
    try {
      second = await this.resolutionScorer.rescore(
        session.topic,
        session.rounds,
        session.projectType,
      );
    } catch (e) {
      // 다시 채점이 실패해도 인터뷰는 이어간다. gate면 다음에 넘을 때 다시 부른다
      const error = e instanceof Error ? e.message : String(e);
      logger.warn('interview.rescore.failed', { sessionId, error });
      this.sessionManager.recordRescoreFailure(sessionId, error);
      return null;
    }
    const rescore = compareRescore(score, second, 'isolated', this.resolutionThreshold);
    const isReady = readinessAfterRescore(
      this.rescoreSetting,
      score,
      rescore,
      this.resolutionThreshold,
    );
    const principle =
      !isReady && this.rescoreSetting === 'gate'
        ? principleAfterRescore(score, second, rescore, session.rounds.length + 1)
        : null;
    this.sessionManager.recordRescore(sessionId, rescore, isReady);
    return principle;
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

  getLatestSession(): InterviewSession | null {
    return this.sessionManager.getLatest();
  }

  listSessions(): InterviewSession[] {
    return this.sessionManager.list();
  }
}
