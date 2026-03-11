import type { InterviewEngine } from '../../interview/engine.js';
import type { SpecGenerator } from '../../spec/generator.js';
import type { SpecInput } from '../schemas.js';

export async function handleSpec(
  engine: InterviewEngine,
  generator: SpecGenerator,
  input: SpecInput,
): Promise<string> {
  try {
    const session = engine.getSession(input.sessionId);
    const result = await generator.generate(session, input.force);

    if (!result.ok) {
      return JSON.stringify({ error: result.error.message }, null, 2);
    }

    return JSON.stringify({
      status: 'generated',
      spec: result.value,
    }, null, 2);
  } catch (e) {
    return JSON.stringify({
      error: e instanceof Error ? e.message : String(e),
    }, null, 2);
  }
}
