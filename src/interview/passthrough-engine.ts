import type {
  InterviewSession,
  AmbiguityScore,
  ProjectType,
  GestaltPrinciple,
} from '../core/types.js';
import { MAX_INTERVIEW_ROUNDS, PRINCIPLE_QUESTION_STRATEGIES } from '../core/constants.js';
import { InterviewError } from '../core/errors.js';
import { type Result, ok, err } from '../core/result.js';
import { selectNextPrinciple, getPrinciplePhaseLabel } from '../gestalt/principles.js';
import { computeAmbiguityScore } from '../gestalt/analyzer.js';
import { SessionManager } from './session.js';
import { detectProjectType } from './brownfield.js';
import { EventStore } from '../events/store.js';
import { EventType } from '../events/types.js';
import { INTERVIEW_SYSTEM_PROMPT, buildQuestionPrompt, buildAmbiguityPrompt } from '../llm/prompts.js';
import type { AgentRegistry } from '../agent/registry.js';
import { mergeSystemPrompt, getActiveAgentNames } from '../agent/prompt-resolver.js';

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
  ambiguityScore: AmbiguityScore | null;
  gestaltContext: GestaltContext;
}

// ─── External ambiguity score shape (from caller LLM) ───────────

export interface ExternalAmbiguityScore {
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

  constructor(private eventStore: EventStore, agentRegistry?: AgentRegistry) {
    this.sessionManager = new SessionManager(eventStore);
    this.sessionManager.loadFromStore();
    this.agentRegistry = agentRegistry;
  }

  start(topic: string, cwd?: string): Result<PassthroughStartResult, InterviewError> {
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

      const gestaltContext = this.buildGestaltContext(
        topic,
        principle,
        1,
        [],
        projectType,
      );

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
    externalScore?: ExternalAmbiguityScore,
  ): Result<PassthroughRespondResult, InterviewError> {
    try {
      const session = this.sessionManager.get(sessionId);

      // Save the externally generated question
      const principle = session.rounds.length > 0
        ? session.rounds[session.rounds.length - 1]!.gestaltFocus
        : selectNextPrinciple({ roundNumber: 1, dimensions: [], hasContradictions: false });

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
            `Maximum interview rounds (${MAX_INTERVIEW_ROUNDS}) reached. Complete the session.`,
          ),
        );
      }

      // Compute ambiguity score if provided externally
      let ambiguityScore: AmbiguityScore | null = null;
      if (externalScore) {
        ambiguityScore = computeAmbiguityScore(
          {
            goalClarity: externalScore.goalClarity,
            constraintClarity: externalScore.constraintClarity,
            successCriteria: externalScore.successCriteria,
            priorityClarity: externalScore.priorityClarity,
            contextClarity: externalScore.contextClarity,
            contradictions: externalScore.contradictions ?? [],
          },
          session.projectType,
        );
        this.sessionManager.updateAmbiguityScore(sessionId, ambiguityScore);
      }

      // Select next principle
      const hasContradictions = ambiguityScore?.dimensions.some(
        (d) => d.clarity < 0.3 && d.name === 'continuity',
      ) ?? false;

      const nextPrinciple = selectNextPrinciple({
        roundNumber: session.rounds.length + 1,
        dimensions: ambiguityScore?.dimensions ?? [],
        hasContradictions,
      });

      this.eventStore.append(
        'interview',
        sessionId,
        EventType.GESTALT_PRINCIPLE_APPLIED,
        { principle: nextPrinciple, roundNumber: session.rounds.length + 1 },
      );

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

      return ok({
        session: this.sessionManager.get(sessionId),
        ambiguityScore,
        gestaltContext,
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
    externalScore?: ExternalAmbiguityScore,
  ): Result<{ ambiguityScore: AmbiguityScore | null; scoringPrompt?: string }, InterviewError> {
    try {
      const session = this.sessionManager.get(sessionId);

      if (externalScore) {
        const ambiguityScore = computeAmbiguityScore(
          {
            goalClarity: externalScore.goalClarity,
            constraintClarity: externalScore.constraintClarity,
            successCriteria: externalScore.successCriteria,
            priorityClarity: externalScore.priorityClarity,
            contextClarity: externalScore.contextClarity,
            contradictions: externalScore.contradictions ?? [],
          },
          session.projectType,
        );
        this.sessionManager.updateAmbiguityScore(sessionId, ambiguityScore);
        return ok({ ambiguityScore });
      }

      // No external score — return scoring prompt for the caller
      const rounds = session.rounds
        .filter((r) => r.userResponse)
        .map((r) => ({ question: r.question, response: r.userResponse }));

      const scoringPrompt = buildAmbiguityPrompt(session.topic, rounds, session.projectType);
      return ok({ ambiguityScore: session.ambiguityScore, scoringPrompt });
    } catch (e) {
      return err(
        new InterviewError(
          `Failed to score: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  }

  complete(sessionId: string): Result<InterviewSession, InterviewError> {
    try {
      return ok(this.sessionManager.complete(sessionId));
    } catch (e) {
      return err(
        new InterviewError(
          `Failed to complete: ${e instanceof Error ? e.message : String(e)}`,
        ),
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

  // ─── Private helpers ────────────────────────────────────────────

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

    const systemPrompt = mergeSystemPrompt(INTERVIEW_SYSTEM_PROMPT, this.agentRegistry, 'interview');
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
      context.scoringPrompt = buildAmbiguityPrompt(topic, answeredRounds, projectType);
    }

    return context;
  }
}
