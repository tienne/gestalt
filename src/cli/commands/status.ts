import { loadConfig } from '../../core/config.js';
import { EventStore } from '../../events/store.js';
import { AnthropicAdapter } from '../../llm/adapter.js';
import { InterviewEngine } from '../../interview/engine.js';
import { handleStatus } from '../../mcp/tools/status.js';

export function statusCommand(sessionId?: string): void {
  const config = loadConfig();
  const eventStore = new EventStore(config.dbPath);
  const llm = new AnthropicAdapter(config.anthropicApiKey, config.model);
  const engine = new InterviewEngine(llm, eventStore);

  try {
    const result = handleStatus(engine, { sessionId });
    console.log(result);
  } finally {
    eventStore.close();
  }
}
