import { randomUUID } from 'node:crypto';
import type { InterviewSession, Seed } from '../core/types.js';
import { AmbiguityThresholdError, SeedGenerationError } from '../core/errors.js';
import { AMBIGUITY_THRESHOLD, MAX_SEED_RETRIES } from '../core/constants.js';
import { type Result, ok, err } from '../core/result.js';
import { seedSchema } from './schema.js';
import { SeedExtractor } from './extractor.js';
import type { LLMAdapter } from '../llm/types.js';
import { EventStore } from '../events/store.js';
import { EventType } from '../events/types.js';

export class SeedGenerator {
  private extractor: SeedExtractor;

  constructor(
    llm: LLMAdapter,
    private eventStore: EventStore,
  ) {
    this.extractor = new SeedExtractor(llm);
  }

  async generate(
    session: InterviewSession,
    force = false,
  ): Promise<Result<Seed, SeedGenerationError | AmbiguityThresholdError>> {
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

    // Retry up to MAX_SEED_RETRIES
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < MAX_SEED_RETRIES; attempt++) {
      try {
        const extracted = await this.extractor.extract(session);

        const seed: Seed = {
          version: '1.0.0',
          goal: extracted.goal,
          constraints: extracted.constraints,
          acceptanceCriteria: extracted.acceptanceCriteria,
          ontologySchema: extracted.ontologySchema,
          gestaltAnalysis: extracted.gestaltAnalysis,
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
          lastError = new SeedGenerationError(
            `Seed validation failed: ${validation.error.message}`,
          );
          continue;
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
          },
        );

        return ok(seed);
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
      }
    }

    return err(
      new SeedGenerationError(
        `Failed after ${MAX_SEED_RETRIES} attempts: ${lastError?.message ?? 'unknown error'}`,
      ),
    );
  }
}
