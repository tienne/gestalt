import { randomUUID } from 'node:crypto';
import type { InterviewSession, Spec } from '../core/types.js';
import { ResolutionThresholdError, SpecGenerationError } from '../core/errors.js';
import { RESOLUTION_THRESHOLD, MAX_SPEC_RETRIES } from '../core/constants.js';
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
  ): Promise<Result<Spec, SpecGenerationError | ResolutionThresholdError>> {
    // Validate resolution threshold
    const resolution = session.resolutionScore?.overall ?? 0.0;
    const thresholdExceeded = resolution < RESOLUTION_THRESHOLD;

    if (!force && thresholdExceeded) {
      return err(new ResolutionThresholdError(resolution, RESOLUTION_THRESHOLD));
    }

    if (session.status !== 'completed') {
      return err(
        new SpecGenerationError('Interview session must be completed before generating a spec'),
      );
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
            resolutionScore: resolution,
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

        // Record audit event if force override was used with subthreshold resolution
        if (force && thresholdExceeded) {
          this.eventStore.append('spec', spec.metadata.specId, EventType.SPEC_FORCE_OVERRIDE, {
            sessionId: session.sessionId,
            specId: spec.metadata.specId,
            resolutionScore: resolution,
            threshold: RESOLUTION_THRESHOLD,
            timestamp: new Date().toISOString(),
          });
        }

        this.eventStore.append('spec', spec.metadata.specId, EventType.SPEC_GENERATED, {
          sessionId: session.sessionId,
          goal: spec.goal,
          constraintCount: spec.constraints.length,
          criteriaCount: spec.acceptanceCriteria.length,
        });

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
