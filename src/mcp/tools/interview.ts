import { join } from 'node:path';
import type { InterviewEngine } from '../../interview/engine.js';
import type { InterviewSession } from '../../core/types.js';
import { CastGenerator, slugify, getDateString } from '../../recording/cast-generator.js';
import { AggConverter } from '../../recording/agg-converter.js';
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

      const recordingPath = input.record ? triggerRecording(result.value) : undefined;

      return JSON.stringify({
        status: 'completed',
        sessionId: result.value.sessionId,
        totalRounds: result.value.rounds.length,
        finalAmbiguityScore: result.value.ambiguityScore?.overall.toFixed(2) ?? 'N/A',
        ...(recordingPath && { recordingPath }),
        message: recordingPath
          ? `Interview completed. GIF recording is being generated: ${recordingPath}`
          : 'Interview completed. You can now generate a spec with ges_generate_spec.',
      }, null, 2);
    }

    case 'compress': {
      // compress action is passthrough-only; normal mode does not support it
      return formatError('compress action is only available in passthrough mode');
    }

    default: {
      const _exhaustive: never = input.action;
      return formatError(`Unknown action: ${_exhaustive}`);
    }
  }
}

function formatError(message: string): string {
  return JSON.stringify({ error: message }, null, 2);
}

function triggerRecording(session: InterviewSession): string {
  const slug = slugify(session.topic);
  const date = getDateString();
  const gifPath = join('.gestalt', 'recordings', `${slug}-${date}.gif`);
  const castPath = join('.gestalt', 'recordings', `tmp-${session.sessionId}.cast`);

  try {
    new CastGenerator().generate(session, castPath);
    void new AggConverter().convertAsync(castPath, gifPath, {
      deleteCastAfter: true,
      onComplete: (p) => process.stderr.write(`[gestalt] Recording saved: ${p}\n`),
      onError: (e) => process.stderr.write(`[gestalt] Recording failed: ${e.message}\n`),
    }).catch(() => {});
  } catch {
    // cast generation failure should not break complete action
  }

  return gifPath;
}
