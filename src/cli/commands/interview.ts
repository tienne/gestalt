import { createInterface } from 'node:readline';
import { loadConfig } from '../../core/config.js';
import { EventStore } from '../../events/store.js';
import { AnthropicAdapter } from '../../llm/adapter.js';
import { InterviewEngine } from '../../interview/engine.js';

export async function interviewCommand(topic: string): Promise<void> {
  const config = loadConfig();

  if (!config.anthropicApiKey) {
    console.error('Error: ANTHROPIC_API_KEY is required for CLI mode. Set it in .env or as environment variable.');
    process.exit(1);
  }

  const eventStore = new EventStore(config.dbPath);
  const llm = new AnthropicAdapter(config.anthropicApiKey, config.model);
  const engine = new InterviewEngine(llm, eventStore);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (question: string): Promise<string> =>
    new Promise((resolve) => rl.question(question, resolve));

  try {
    console.log(`\n🔍 Starting Gestalt interview for: "${topic}"\n`);

    const startResult = await engine.start(topic);
    if (!startResult.ok) {
      console.error(`Error: ${startResult.error.message}`);
      return;
    }

    const { session, firstQuestion, projectType, detectedFiles } = startResult.value;
    console.log(`Project type: ${projectType}`);
    if (detectedFiles.length > 0) {
      console.log(`Detected: ${detectedFiles.join(', ')}`);
    }
    console.log('');

    let sessionId = session.sessionId;
    let currentQuestion = firstQuestion;

    while (true) {
      console.log(`📋 Q${session.rounds.length}: ${currentQuestion}\n`);
      const response = await prompt('> ');

      if (response.trim().toLowerCase() === 'done') {
        break;
      }

      const respondResult = await engine.respond(sessionId, response);
      if (!respondResult.ok) {
        console.error(`Error: ${respondResult.error.message}`);
        break;
      }

      const { nextQuestion, ambiguityScore } = respondResult.value;
      console.log(`\n📊 Ambiguity: ${(ambiguityScore.overall * 100).toFixed(0)}%`);

      if (ambiguityScore.isReady) {
        console.log('✅ Requirements are clear enough! Type "done" to finish or continue.\n');
      } else {
        console.log('');
      }

      currentQuestion = nextQuestion;
    }

    const completeResult = engine.complete(sessionId);
    if (completeResult.ok) {
      console.log(`\n✅ Interview completed. Session ID: ${sessionId}`);
      console.log('Run `gestalt seed ' + sessionId + '` to generate a seed.\n');
    }
  } finally {
    rl.close();
    eventStore.close();
  }
}
