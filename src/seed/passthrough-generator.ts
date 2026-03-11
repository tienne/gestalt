import { randomUUID } from 'node:crypto';
import type { InterviewSession, Seed, InterviewRound } from '../core/types.js';
import { AmbiguityThresholdError, SeedGenerationError } from '../core/errors.js';
import { AMBIGUITY_THRESHOLD } from '../core/constants.js';
import { type Result, ok, err } from '../core/result.js';
import { seedSchema } from './schema.js';
import { EventStore } from '../events/store.js';
import { EventType } from '../events/types.js';
import { INTERVIEW_SYSTEM_PROMPT, buildSeedPrompt } from '../llm/prompts.js';

// ─── Types ──────────────────────────────────────────────────────

export interface SeedContext {
  systemPrompt: string;
  seedPrompt: string;
  allRounds: { roundNumber: number; question: string; response: string; gestaltFocus: string }[];
}

export interface ExternalSeed {
  goal: string;
  constraints: string[];
  acceptanceCriteria: string[];
  ontologySchema: { entities: unknown[]; relations: unknown[] };
  gestaltAnalysis: unknown[];
}

// ─── Generator ──────────────────────────────────────────────────

export class PassthroughSeedGenerator {
  constructor(private eventStore: EventStore) {}

  buildSeedContext(session: InterviewSession): SeedContext {
    const answeredRounds = session.rounds
      .filter((r): r is InterviewRound & { userResponse: string } => r.userResponse !== null)
      .map((r) => ({
        question: r.question,
        response: r.userResponse,
      }));

    const seedPrompt = buildSeedPrompt(session.topic, answeredRounds, session.projectType);

    return {
      systemPrompt: INTERVIEW_SYSTEM_PROMPT,
      seedPrompt,
      allRounds: session.rounds
        .filter((r) => r.userResponse !== null)
        .map((r) => ({
          roundNumber: r.roundNumber,
          question: r.question,
          response: r.userResponse!,
          gestaltFocus: r.gestaltFocus,
        })),
    };
  }

  validateAndStore(
    session: InterviewSession,
    externalSeed: ExternalSeed,
    force = false,
  ): Result<Seed, SeedGenerationError | AmbiguityThresholdError> {
    // Validate ambiguity threshold
    if (!force) {
      const ambiguity = session.ambiguityScore?.overall ?? 1.0;
      if (ambiguity > AMBIGUITY_THRESHOLD) {
        return err(new AmbiguityThresholdError(ambiguity, AMBIGUITY_THRESHOLD));
      }
    }

    if (session.status !== 'completed') {
      return err(new SeedGenerationError('Interview session must be completed before generating a seed'));
    }

    try {
      const seed: Seed = {
        version: '1.0.0',
        goal: externalSeed.goal,
        constraints: externalSeed.constraints,
        acceptanceCriteria: externalSeed.acceptanceCriteria,
        ontologySchema: externalSeed.ontologySchema as Seed['ontologySchema'],
        gestaltAnalysis: externalSeed.gestaltAnalysis as Seed['gestaltAnalysis'],
        metadata: {
          seedId: randomUUID(),
          interviewSessionId: session.sessionId,
          ambiguityScore: session.ambiguityScore?.overall ?? 1.0,
          generatedAt: new Date().toISOString(),
        },
      };

      // Validate against schema
      const validation = seedSchema.safeParse(seed);
      if (!validation.success) {
        return err(
          new SeedGenerationError(
            `Seed validation failed: ${validation.error.message}`,
          ),
        );
      }

      this.eventStore.append(
        'seed',
        seed.metadata.seedId,
        EventType.SEED_SPEC_GENERATED,
        {
          sessionId: session.sessionId,
          goal: seed.goal,
          constraintCount: seed.constraints.length,
          criteriaCount: seed.acceptanceCriteria.length,
          source: 'passthrough',
        },
      );

      return ok(seed);
    } catch (e) {
      return err(
        new SeedGenerationError(
          `Failed to validate seed: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  }
}
