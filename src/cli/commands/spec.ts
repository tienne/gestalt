import { loadConfig } from '../../core/config.js';
import { EventStore } from '../../events/store.js';
import { AnthropicAdapter } from '../../llm/adapter.js';
import { InterviewEngine } from '../../interview/engine.js';
import { SpecGenerator } from '../../spec/generator.js';

export async function specCommand(sessionId: string, options: { force?: boolean }): Promise<void> {
  const config = loadConfig();

  if (!config.anthropicApiKey) {
    console.error('Error: ANTHROPIC_API_KEY is required for CLI mode. Set it in .env or as environment variable.');
    process.exit(1);
  }

  const eventStore = new EventStore(config.dbPath);
  const llm = new AnthropicAdapter(config.anthropicApiKey, config.model);
  const engine = new InterviewEngine(llm, eventStore);
  const generator = new SpecGenerator(llm, eventStore);

  try {
    const session = engine.getSession(sessionId);
    console.log(`\n📋 Generating spec for session: ${session.topic}\n`);

    const result = await generator.generate(session, options.force ?? false);

    if (!result.ok) {
      console.error(`Error: ${result.error.message}`);
      return;
    }

    console.log(JSON.stringify(result.value, null, 2));
    console.log('\n✅ Spec generated successfully.\n');
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    eventStore.close();
  }
}
