import type { PassthroughEngine } from '../../interview/passthrough-engine.js';
import type { PassthroughSeedGenerator } from '../../seed/passthrough-generator.js';
import type { SeedInput } from '../schemas.js';

export function handleSeedPassthrough(
  engine: PassthroughEngine,
  generator: PassthroughSeedGenerator,
  input: SeedInput,
): string {
  try {
    const session = engine.getSession(input.sessionId);

    // If external seed is provided, validate and store it
    if (input.seed) {
      const result = generator.validateAndStore(session, input.seed, input.force);
      if (!result.ok) {
        return JSON.stringify({ error: result.error.message }, null, 2);
      }

      return JSON.stringify({
        status: 'generated',
        seed: result.value,
      }, null, 2);
    }

    // No seed provided — return the prompt for generation
    const context = generator.buildSeedContext(session);

    return JSON.stringify({
      status: 'prompt',
      seedContext: context,
      message: 'Use seedContext.seedPrompt with seedContext.systemPrompt to generate the seed JSON, then call this tool again with the seed parameter.',
    }, null, 2);
  } catch (e) {
    return JSON.stringify({
      error: e instanceof Error ? e.message : String(e),
    }, null, 2);
  }
}
