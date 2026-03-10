import type { InterviewEngine } from '../../interview/engine.js';
import type { SeedGenerator } from '../../seed/generator.js';
import type { SeedInput } from '../schemas.js';

export async function handleSeed(
  engine: InterviewEngine,
  generator: SeedGenerator,
  input: SeedInput,
): Promise<string> {
  try {
    const session = engine.getSession(input.sessionId);
    const result = await generator.generate(session, input.force);

    if (!result.ok) {
      return JSON.stringify({ error: result.error.message }, null, 2);
    }

    return JSON.stringify({
      status: 'generated',
      seed: result.value,
    }, null, 2);
  } catch (e) {
    return JSON.stringify({
      error: e instanceof Error ? e.message : String(e),
    }, null, 2);
  }
}
