import { join } from 'node:path';
import type { PassthroughEngine } from '../../interview/passthrough-engine.js';
import type { InterviewSession } from '../../core/types.js';
import { CastGenerator, slugify, getDateString } from '../../recording/cast-generator.js';
import { AggConverter } from '../../recording/agg-converter.js';
import type { InterviewInput } from '../schemas.js';
import { ContextCompressor } from '../../interview/context-compressor.js';
import { ProjectMemoryStore } from '../../memory/project-memory-store.js';
import { gestaltNotify } from '../../utils/notifier.js';

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
        input.resolutionScore,
      );
      if (!result.ok) return formatError(result.error.message);

      const { session, resolutionScore, gestaltContext, compressionContext, needsCompression } = result.value;
      return JSON.stringify({
        status: 'in_progress',
        sessionId: session.sessionId,
        roundNumber: session.rounds.length,
        gestaltContext,
        ...(needsCompression ? { compressionContext, needsCompression } : {}),
        resolutionScore: resolutionScore
          ? {
              overall: resolutionScore.overall.toFixed(2),
              isReady: resolutionScore.isReady,
              dimensions: resolutionScore.dimensions.map((d) => ({
                name: d.name,
                clarity: d.clarity.toFixed(2),
                principle: d.gestaltPrinciple,
              })),
            }
          : null,
        message: resolutionScore?.isReady
          ? 'Resolution threshold met! You can complete the interview and generate a spec.'
          : needsCompression
            ? 'Use compressionContext to compress previous rounds, then continue with gestaltContext.questionPrompt.'
            : 'Use gestaltContext.questionPrompt to generate the next question. Use gestaltContext.scoringPrompt to compute resolution scores.',
      }, null, 2);
    }

    case 'score': {
      if (!input.sessionId) return formatError('sessionId is required for score action');

      const result = engine.score(input.sessionId, input.resolutionScore);
      if (!result.ok) return formatError(result.error.message);

      const { resolutionScore, scoringPrompt } = result.value;
      return JSON.stringify({
        status: 'scored',
        resolutionScore: resolutionScore
          ? {
              overall: resolutionScore.overall.toFixed(2),
              isReady: resolutionScore.isReady,
              dimensions: resolutionScore.dimensions.map((d) => ({
                name: d.name,
                clarity: d.clarity.toFixed(2),
                principle: d.gestaltPrinciple,
              })),
            }
          : null,
        scoringPrompt: scoringPrompt ?? null,
        message: scoringPrompt
          ? 'Use the scoringPrompt to compute resolution scores, then call score again with the resolutionScore parameter.'
          : undefined,
      }, null, 2);
    }

    case 'compress': {
      if (!input.sessionId) return formatError('sessionId is required for compress action');

      try {
        const session = engine.getSession(input.sessionId);
        const compressor = new ContextCompressor();

        // Call 2: submit compressed summary
        if (input.compressedSummary) {
          const completedRounds = session.rounds.filter((r) => r.userResponse !== null);
          const roundsToCompress = Math.max(0, completedRounds.length - 3);
          const compressedContext = compressor.buildCompressedContext(input.compressedSummary, roundsToCompress);
          engine.getSessionManager().setCompressedContext(input.sessionId, compressedContext);

          // Persist to project memory
          try {
            const memoryStore = new ProjectMemoryStore();
            memoryStore.addCompressedContext(input.sessionId, input.compressedSummary);
          } catch { /* non-blocking */ }

          return JSON.stringify({
            status: 'compressed',
            sessionId: input.sessionId,
            roundsCompressed: roundsToCompress,
            message: `Context compressed (${roundsToCompress} rounds summarized). Continue with respond action.`,
          }, null, 2);
        }

        // Call 1: return compression context
        const compressionCtx = compressor.buildCompressionContext(
          session.topic,
          session.rounds,
          session.compressedContext?.summary,
        );

        return JSON.stringify({
          status: 'compressing',
          sessionId: input.sessionId,
          compressionContext: compressionCtx,
          message: 'Use compressionContext.systemPrompt + compressionContext.compressionPrompt to generate a summary, then submit with compressedSummary.',
        }, null, 2);
      } catch (e) {
        return formatError(e instanceof Error ? e.message : String(e));
      }
    }

    case 'complete': {
      if (!input.sessionId) return formatError('sessionId is required for complete action');

      const result = engine.complete(input.sessionId);
      if (!result.ok) return formatError(result.error.message);

      const recordingPath = input.record ? triggerRecording(result.value) : undefined;

      gestaltNotify({
        event: 'interview_complete',
        message: `인터뷰 완료 — ${result.value.rounds.length}라운드, 해상도: ${result.value.resolutionScore?.overall.toFixed(2) ?? 'N/A'}`,
      });

      return JSON.stringify({
        status: 'completed',
        sessionId: result.value.sessionId,
        totalRounds: result.value.rounds.length,
        finalResolutionScore: result.value.resolutionScore?.overall.toFixed(2) ?? 'N/A',
        ...(recordingPath && { recordingPath }),
        message: recordingPath
          ? `Interview completed. GIF recording is being generated: ${recordingPath}`
          : 'Interview completed. Use ges_generate_spec to generate a spec.',
      }, null, 2);
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
