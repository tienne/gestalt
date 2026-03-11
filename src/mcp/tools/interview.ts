import type { InterviewEngine } from '../../interview/engine.js';
import type { InterviewInput } from '../schemas.js';

export async function handleInterview(
  engine: InterviewEngine,
  input: InterviewInput,
): Promise<string> {
  switch (input.action) {
    case 'start': {
      const topic = input.topic ?? 'Untitled project';
      const result = await engine.start(topic, input.cwd);
      if (!result.ok) return formatError(result.error.message);

      const { session, firstQuestion, projectType, detectedFiles } = result.value;
      return JSON.stringify({
        status: 'started',
        sessionId: session.sessionId,
        projectType,
        detectedFiles,
        question: firstQuestion,
        roundNumber: 1,
        message: `Interview started for "${topic}" (${projectType}). Please answer the question below.`,
      }, null, 2);
    }

    case 'respond': {
      if (!input.sessionId) return formatError('sessionId is required for respond action');
      if (!input.response) return formatError('response is required for respond action');

      const result = await engine.respond(input.sessionId, input.response);
      if (!result.ok) return formatError(result.error.message);

      const { session, nextQuestion, ambiguityScore } = result.value;
      return JSON.stringify({
        status: 'in_progress',
        sessionId: session.sessionId,
        roundNumber: session.rounds.length,
        question: nextQuestion,
        ambiguityScore: {
          overall: ambiguityScore.overall.toFixed(2),
          isReady: ambiguityScore.isReady,
          dimensions: ambiguityScore.dimensions.map((d) => ({
            name: d.name,
            clarity: d.clarity.toFixed(2),
            principle: d.gestaltPrinciple,
          })),
        },
        message: ambiguityScore.isReady
          ? 'Ambiguity threshold met! You can now complete the interview and generate a spec.'
          : `Ambiguity: ${(ambiguityScore.overall * 100).toFixed(0)}% — continue answering to reduce ambiguity.`,
      }, null, 2);
    }

    case 'score': {
      if (!input.sessionId) return formatError('sessionId is required for score action');

      const result = await engine.score(input.sessionId);
      if (!result.ok) return formatError(result.error.message);

      return JSON.stringify({
        status: 'scored',
        ambiguityScore: {
          overall: result.value.overall.toFixed(2),
          isReady: result.value.isReady,
          dimensions: result.value.dimensions.map((d) => ({
            name: d.name,
            clarity: d.clarity.toFixed(2),
            principle: d.gestaltPrinciple,
          })),
        },
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
        message: 'Interview completed. You can now generate a spec with ges_generate_spec.',
      }, null, 2);
    }
  }
}

function formatError(message: string): string {
  return JSON.stringify({ error: message }, null, 2);
}
