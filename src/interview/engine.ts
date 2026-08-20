import type { InterviewSession, ResolutionScore, ProjectType } from '../core/types.js';
import { MAX_INTERVIEW_ROUNDS } from '../core/constants.js';
import { InterviewError } from '../core/errors.js';
import { type Result, ok, err } from '../core/result.js';
import { selectNextPrinciple } from '../gestalt/principles.js';
import { ResolutionScorer } from './resolution.js';
import { QuestionGenerator } from './questions.js';
import { SessionManager } from './session.js';
import { detectProjectType } from './brownfield.js';
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

  /**
   * @param llm 질문 생성에 쓰는 기본 어댑터
   * @param frugalLlm 해상도 점수 산정용 저비용 어댑터. 없으면 `llm`을 그대로 쓴다.
   *   점수 산정은 정해진 기준에 점수를 매기는 작업이라 질문 생성만큼의 모델이 필요 없다.
   */
  constructor(
    llm: LLMAdapter,
    private eventStore: EventStore,
    frugalLlm?: LLMAdapter,
  ) {
    this.sessionManager = new SessionManager(eventStore);
    this.sessionManager.loadFromStore();
    this.questionGenerator = new QuestionGenerator(llm);
    this.resolutionScorer = new ResolutionScorer(frugalLlm ?? llm);
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
            `Maximum interview rounds (${MAX_INTERVIEW_ROUNDS}) reached. Complete the session.`,
          ),
        );
      }

      // Score resolution
      const resolutionScore = await this.resolutionScorer.score(
        session.topic,
        session.rounds,
        session.projectType,
      );
      this.sessionManager.updateResolutionScore(sessionId, resolutionScore);

      // Select next principle based on current state
      const hasContradictions = (resolutionScore.contradictions?.length ?? 0) > 0;

      const nextPrinciple = selectNextPrinciple({
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
      this.sessionManager.updateResolutionScore(sessionId, resolutionScore);
      return ok(resolutionScore);
    } catch (e) {
      return err(
        new InterviewError(`Failed to score: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
  }

  complete(sessionId: string): Result<InterviewSession, InterviewError> {
    try {
      return ok(this.sessionManager.complete(sessionId));
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
