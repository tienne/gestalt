import { randomUUID } from 'node:crypto';
import type { InterviewSession, Spec } from '../core/types.js';
import { AmbiguityThresholdError, SpecGenerationError } from '../core/errors.js';
import { AMBIGUITY_THRESHOLD, MAX_SPEC_RETRIES } from '../core/constants.js';
import { type Result, ok, err } from '../core/result.js';
import { specSchema } from './schema.js';
import { SpecExtractor } from './extractor.js';
import type { LLMAdapter } from '../llm/types.js';
import { EventStore } from '../events/store.js';
import { EventType } from '../events/types.js';

export class SpecGenerator {
  private extractor: SpecExtractor;

  constructor(
    llm: LLMAdapter,
    private eventStore: EventStore,
  ) {
    this.extractor = new SpecExtractor(llm);
  }

  async generate(
    session: InterviewSession,
    force = false,
  ): Promise<Result<Spec, SpecGenerationError | AmbiguityThresholdError>> {
    // Validate ambiguity threshold
    if (!force) {
      const ambiguity = session.ambiguityScore?.overall ?? 1.0;
      if (ambiguity > AMBIGUITY_THRESHOLD) {
        return err(new AmbiguityThresholdError(ambiguity, AMBIGUITY_THRESHOLD));
      }
    }

    if (session.status !== 'completed') {
      return err(new SpecGenerationError('Interview session must be completed before generating a spec'));
    }

    // Retry up to MAX_SPEC_RETRIES
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < MAX_SPEC_RETRIES; attempt++) {
      try {
        const extracted = await this.extractor.extract(session);

        const spec: Spec = {
          version: '1.0.0',
          goal: extracted.goal,
          constraints: extracted.constraints,
          acceptanceCriteria: extracted.acceptanceCriteria,
          ontologySchema: extracted.ontologySchema,
          gestaltAnalysis: extracted.gestaltAnalysis,
          metadata: {
            specId: randomUUID(),
            interviewSessionId: session.sessionId,
            ambiguityScore: session.ambiguityScore?.overall ?? 1.0,
            generatedAt: new Date().toISOString(),
          },
        };

        // Validate against schema
        const validation = specSchema.safeParse(spec);
        if (!validation.success) {
          lastError = new SpecGenerationError(
            `Spec validation failed: ${validation.error.message}`,
          );
          continue;
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
          },
        );

        return ok(spec);
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
      }
    }

    return err(
      new SpecGenerationError(
        `Failed after ${MAX_SPEC_RETRIES} attempts: ${lastError?.message ?? 'unknown error'}`,
      ),
    );
  }
}
