import { randomUUID } from 'node:crypto';
import type { InterviewSession, Spec, InterviewRound } from '../core/types.js';
import { ResolutionThresholdError, SpecGenerationError } from '../core/errors.js';
import { RESOLUTION_THRESHOLD } from '../core/constants.js';
import { type Result, ok, err } from '../core/result.js';
import { specSchema } from './schema.js';
import { EventStore } from '../events/store.js';
import { EventType } from '../events/types.js';
import { INTERVIEW_SYSTEM_PROMPT, buildSpecPrompt } from '../llm/prompts.js';
import type { AgentRegistry } from '../agent/registry.js';
import { mergeSystemPrompt, getActiveAgentNames } from '../agent/prompt-resolver.js';

export const TEXT_INPUT_SESSION_ID = 'text-input';

// ─── Types ──────────────────────────────────────────────────────

export interface SpecContext {
  systemPrompt: string;
  specPrompt: string;
  allRounds: { roundNumber: number; question: string; response: string; gestaltFocus: string }[];
  activeAgents?: string[];
}

export interface ExternalSpec {
  goal: string;
  constraints: string[];
  acceptanceCriteria: string[];
  ontologySchema: { entities: unknown[]; relations: unknown[] };
  gestaltAnalysis: unknown[];
}

// ─── Generator ──────────────────────────────────────────────────

export class PassthroughSpecGenerator {
  private agentRegistry?: AgentRegistry;

  constructor(private eventStore: EventStore, agentRegistry?: AgentRegistry) {
    this.agentRegistry = agentRegistry;
  }

  buildSpecContext(session: InterviewSession): SpecContext {
    const answeredRounds = session.rounds
      .filter((r): r is InterviewRound & { userResponse: string } => r.userResponse !== null)
      .map((r) => ({
        question: r.question,
        response: r.userResponse,
      }));

    const specPrompt = buildSpecPrompt(session.topic, answeredRounds, session.projectType);

    const systemPrompt = mergeSystemPrompt(INTERVIEW_SYSTEM_PROMPT, this.agentRegistry, 'spec');
    const activeAgents = getActiveAgentNames(this.agentRegistry, 'spec');

    return {
      systemPrompt,
      specPrompt,
      allRounds: session.rounds
        .filter((r) => r.userResponse !== null)
        .map((r) => ({
          roundNumber: r.roundNumber,
          question: r.question,
          response: r.userResponse!,
          gestaltFocus: r.gestaltFocus,
        })),
      ...(activeAgents.length > 0 && { activeAgents }),
    };
  }

  validateAndStore(
    session: InterviewSession,
    externalSpec: ExternalSpec,
    force = false,
  ): Result<Spec, SpecGenerationError | ResolutionThresholdError> {
    // Validate resolution threshold
    if (!force) {
      const resolution = session.resolutionScore?.overall ?? 0.0;
      if (resolution < RESOLUTION_THRESHOLD) {
        return err(new ResolutionThresholdError(resolution, RESOLUTION_THRESHOLD));
      }
    }

    if (session.status !== 'completed') {
      return err(new SpecGenerationError('Interview session must be completed before generating a spec'));
    }

    try {
      const spec: Spec = {
        version: '1.0.0',
        goal: externalSpec.goal,
        constraints: externalSpec.constraints,
        acceptanceCriteria: externalSpec.acceptanceCriteria,
        ontologySchema: externalSpec.ontologySchema as Spec['ontologySchema'],
        gestaltAnalysis: externalSpec.gestaltAnalysis as Spec['gestaltAnalysis'],
        metadata: {
          specId: randomUUID(),
          interviewSessionId: session.sessionId,
          resolutionScore: session.resolutionScore?.overall ?? 0.0,
          generatedAt: new Date().toISOString(),
        },
      };

      // Validate against schema
      const validation = specSchema.safeParse(spec);
      if (!validation.success) {
        return err(
          new SpecGenerationError(
            `Spec validation failed: ${validation.error.message}`,
          ),
        );
      }

      this.eventStore.append(
        'spec',
        spec.metadata.specId,
        EventType.SPEC_GENERATED,
        {
          sessionId: session.sessionId,
          goal: spec.goal,
          constraintCount: spec.constraints.length,
          criteriaCount: spec.acceptanceCriteria.length,
          source: 'passthrough',
        },
      );

      return ok(spec);
    } catch (e) {
      return err(
        new SpecGenerationError(
          `Failed to validate spec: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  }

  validateAndStoreFromText(externalSpec: ExternalSpec): Result<Spec, SpecGenerationError> {
    try {
      const spec: Spec = {
        version: '1.0.0',
        goal: externalSpec.goal,
        constraints: externalSpec.constraints,
        acceptanceCriteria: externalSpec.acceptanceCriteria,
        ontologySchema: externalSpec.ontologySchema as Spec['ontologySchema'],
        gestaltAnalysis: externalSpec.gestaltAnalysis as Spec['gestaltAnalysis'],
        metadata: {
          specId: randomUUID(),
          interviewSessionId: TEXT_INPUT_SESSION_ID,
          resolutionScore: 1,
          generatedAt: new Date().toISOString(),
        },
      };

      const validation = specSchema.safeParse(spec);
      if (!validation.success) {
        return err(
          new SpecGenerationError(
            `Spec validation failed: ${validation.error.message}`,
          ),
        );
      }

      this.eventStore.append(
        'spec',
        spec.metadata.specId,
        EventType.SPEC_GENERATED,
        {
          sessionId: TEXT_INPUT_SESSION_ID,
          goal: spec.goal,
          constraintCount: spec.constraints.length,
          criteriaCount: spec.acceptanceCriteria.length,
          source: 'text',
        },
      );

      return ok(spec);
    } catch (e) {
      return err(
        new SpecGenerationError(
          `Failed to validate spec: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  }
}
