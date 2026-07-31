import type { InterviewEngine } from '../../interview/engine.js';
import type { SpecGenerator } from '../../spec/generator.js';
import type { SpecInput } from '../schemas.js';
import { resolveInterviewSessionId } from '../session-selector.js';

export async function handleSpec(
  engine: InterviewEngine,
  generator: SpecGenerator,
  rawInput: SpecInput,
): Promise<string> {
  const resolved = resolveInterviewSessionId(engine, rawInput.sessionId);
  if (!resolved.ok) return JSON.stringify({ error: resolved.error }, null, 2);
  const input: SpecInput = { ...rawInput, sessionId: resolved.sessionId };

  try {
    if (!input.sessionId) return JSON.stringify({ error: 'sessionId is required' }, null, 2);
    const session = engine.getSession(input.sessionId);
    const result = await generator.generate(session, input.force);

    if (!result.ok) {
      return JSON.stringify({ error: result.error.message }, null, 2);
    }

    return JSON.stringify(
      {
        status: 'generated',
        spec: result.value,
      },
      null,
      2,
    );
  } catch (e) {
    return JSON.stringify(
      {
        error: e instanceof Error ? e.message : String(e),
      },
      null,
      2,
    );
  }
}
