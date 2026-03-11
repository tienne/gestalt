import type { PassthroughEngine } from '../../interview/passthrough-engine.js';
import type { PassthroughSpecGenerator } from '../../spec/passthrough-generator.js';
import type { SpecInput } from '../schemas.js';

export function handleSpecPassthrough(
  engine: PassthroughEngine,
  generator: PassthroughSpecGenerator,
  input: SpecInput,
): string {
  try {
    const session = engine.getSession(input.sessionId);

    // If external spec is provided, validate and store it
    if (input.spec) {
      const result = generator.validateAndStore(session, input.spec, input.force);
      if (!result.ok) {
        return JSON.stringify({ error: result.error.message }, null, 2);
      }

      return JSON.stringify({
        status: 'generated',
        spec: result.value,
      }, null, 2);
    }

    // No spec provided — return the prompt for generation
    const context = generator.buildSpecContext(session);

    return JSON.stringify({
      status: 'prompt',
      specContext: context,
      message: 'Use specContext.specPrompt with specContext.systemPrompt to generate the spec JSON, then call this tool again with the spec parameter.',
    }, null, 2);
  } catch (e) {
    return JSON.stringify({
      error: e instanceof Error ? e.message : String(e),
    }, null, 2);
  }
}
