import type { PassthroughEngine } from '../../interview/passthrough-engine.js';
import type { PassthroughSpecGenerator } from '../../spec/passthrough-generator.js';
import { TextBasedSpecGenerator } from '../../spec/text-based-spec-generator.js';
import type { SpecInput } from '../schemas.js';
import type { AgentRegistry } from '../../agent/registry.js';
import { ProjectMemoryStore } from '../../memory/project-memory-store.js';

export function handleSpecPassthrough(
  engine: PassthroughEngine,
  generator: PassthroughSpecGenerator,
  input: SpecInput,
  agentRegistry?: AgentRegistry,
): string {
  try {
    // ─── Text-based path (no sessionId required) ──────────────────
    if (input.text) {
      const memoryStore = new ProjectMemoryStore();
      const memory = memoryStore.read();
      const textGenerator = new TextBasedSpecGenerator(agentRegistry);

      // Call 2: spec provided → validate and store
      if (input.spec) {
        const result = generator.validateAndStoreFromText(input.spec);
        if (!result.ok) {
          return JSON.stringify({ error: result.error.message }, null, 2);
        }

        // Update project memory with this spec
        memoryStore.addSpec({
          specId: result.value.metadata.specId,
          goal: result.value.goal,
          createdAt: result.value.metadata.generatedAt,
          sourceType: 'text',
        });

        return JSON.stringify({
          status: 'generated',
          spec: result.value,
        }, null, 2);
      }

      // Call 1: return prompt for caller LLM to generate spec
      const context = textGenerator.buildSpecContext(input.text, memory);

      return JSON.stringify({
        status: 'prompt',
        specContext: context,
        message: 'Use specContext.specPrompt with specContext.systemPrompt to generate the spec JSON, then call this tool again with both the text and spec parameters.',
      }, null, 2);
    }

    // ─── Interview-based path (sessionId required) ────────────────
    if (!input.sessionId) {
      return JSON.stringify({ error: 'sessionId or text is required' }, null, 2);
    }
    const session = engine.getSession(input.sessionId);

    // Call 2: external spec provided → validate and store
    if (input.spec) {
      const result = generator.validateAndStore(session, input.spec, input.force);
      if (!result.ok) {
        return JSON.stringify({ error: result.error.message }, null, 2);
      }

      // Update project memory with this spec
      try {
        const memoryStore = new ProjectMemoryStore();
        memoryStore.addSpec({
          specId: result.value.metadata.specId,
          goal: result.value.goal,
          createdAt: result.value.metadata.generatedAt,
          interviewSessionId: session.sessionId,
          sourceType: 'interview',
        });
      } catch {
        // Memory update failure should not block spec generation
      }

      return JSON.stringify({
        status: 'generated',
        spec: result.value,
      }, null, 2);
    }

    // Call 1: return prompt for caller LLM to generate spec
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
