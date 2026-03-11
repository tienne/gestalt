import type { PassthroughEngine } from '../../interview/passthrough-engine.js';
import type { InterviewInput } from '../schemas.js';

export function handleInterviewPassthrough(
  engine: PassthroughEngine,
  input: InterviewInput,
): string {
  switch (input.action) {
    case 'start': {
      const topic = input.topic ?? 'Untitled project';
      const result = engine.start(topic, input.cwd);
      if (!result.ok) return formatError(result.error.message);

      const { session, projectType, detectedFiles, gestaltContext } = result.value;
      return JSON.stringify({
        status: 'started',
        sessionId: session.sessionId,
        projectType,
        detectedFiles,
        gestaltContext,
        roundNumber: 1,
        message: `Interview started for "${topic}" (${projectType}). Use the gestaltContext.questionPrompt with gestaltContext.systemPrompt to generate the first question.`,
      }, null, 2);
    }

    case 'respond': {
      if (!input.sessionId) return formatError('sessionId is required for respond action');
      if (!input.response) return formatError('response is required for respond action');
      if (!input.generatedQuestion) return formatError('generatedQuestion is required for respond action in passthrough mode');

      const result = engine.respond(
        input.sessionId,
        input.response,
        input.generatedQuestion,
        input.ambiguityScore,
      );
      if (!result.ok) return formatError(result.error.message);

      const { session, ambiguityScore, gestaltContext } = result.value;
      return JSON.stringify({
        status: 'in_progress',
        sessionId: session.sessionId,
        roundNumber: session.rounds.length,
        gestaltContext,
        ambiguityScore: ambiguityScore
          ? {
              overall: ambiguityScore.overall.toFixed(2),
              isReady: ambiguityScore.isReady,
              dimensions: ambiguityScore.dimensions.map((d) => ({
                name: d.name,
                clarity: d.clarity.toFixed(2),
                principle: d.gestaltPrinciple,
              })),
            }
          : null,
        message: ambiguityScore?.isReady
          ? 'Ambiguity threshold met! You can complete the interview and generate a spec.'
          : 'Use gestaltContext.questionPrompt to generate the next question. Use gestaltContext.scoringPrompt to compute ambiguity scores.',
      }, null, 2);
    }

    case 'score': {
      if (!input.sessionId) return formatError('sessionId is required for score action');

      const result = engine.score(input.sessionId, input.ambiguityScore);
      if (!result.ok) return formatError(result.error.message);

      const { ambiguityScore, scoringPrompt } = result.value;
      return JSON.stringify({
        status: 'scored',
        ambiguityScore: ambiguityScore
          ? {
              overall: ambiguityScore.overall.toFixed(2),
              isReady: ambiguityScore.isReady,
              dimensions: ambiguityScore.dimensions.map((d) => ({
                name: d.name,
                clarity: d.clarity.toFixed(2),
                principle: d.gestaltPrinciple,
              })),
            }
          : null,
        scoringPrompt: scoringPrompt ?? null,
        message: scoringPrompt
          ? 'Use the scoringPrompt to compute ambiguity scores, then call score again with the ambiguityScore parameter.'
          : undefined,
      }, null, 2);
    }

    case 'complete': {
      if (!input.sessionId) return formatError('sessionId is required for complete action');

      const result = engine.complete(input.sessionId);
      if (!result.ok) return formatError(result.error.message);

      return JSON.stringify({
        status: 'completed',
        sessionId: result.value.sessionId,
        totalRounds: result.value.rounds.length,
        finalAmbiguityScore: result.value.ambiguityScore?.overall.toFixed(2) ?? 'N/A',
        message: 'Interview completed. Use ges_generate_spec to generate a spec.',
      }, null, 2);
    }
  }
}

function formatError(message: string): string {
  return JSON.stringify({ error: message }, null, 2);
}
