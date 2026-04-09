import { createInterface } from 'node:readline';
import { loadConfig } from '../../core/config.js';
import { EventStore } from '../../events/store.js';
import { createAdapter } from '../../llm/factory.js';
import { InterviewEngine } from '../../interview/engine.js';
import { RecordingOrchestrator } from '../../recording/recording-orchestrator.js';

export interface InterviewCommandOptions {
  record?: boolean;
  mp4?: boolean;
}

export async function interviewCommand(
  topic: string,
  options: InterviewCommandOptions = {},
): Promise<void> {
  const config = loadConfig();

  if (!config.llm.apiKey) {
    console.error(
      'Error: ANTHROPIC_API_KEY is required for CLI mode. Set it in .env or as environment variable.',
    );
    process.exit(1);
  }

  const llm = createAdapter(config.llm);
  const orchestrator = new RecordingOrchestrator(llm);

  // --record 플래그가 있고 아직 asciinema로 감싸지지 않았으면 respawn.
  // respawn 시 process.exit()이 호출되므로 이후 코드는 실행되지 않음.
  await orchestrator.startIfNeeded(options);

  const eventStore = new EventStore(config.dbPath);
  const engine = new InterviewEngine(llm, eventStore);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (question: string): Promise<string> =>
    new Promise((resolve) => rl.question(question, resolve));

  try {
    console.log(`\n🔍 Starting Gestalt interview for: "${topic}"\n`);

    if (orchestrator.isRecording()) {
      console.log('📹 Recording in progress (asciinema)...\n');
    }

    const startResult = await engine.start(topic);
    if (!startResult.ok) {
      console.error(`Error: ${startResult.error.message}`);
      return;
    }

    const { session, firstQuestion, projectType, detectedFiles } = startResult.value;
    const sessionId = session.sessionId;

    console.log(`Project type: ${projectType}`);
    if (detectedFiles.length > 0) {
      console.log(`Detected: ${detectedFiles.join(', ')}`);
    }
    console.log('');

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

      const { nextQuestion, resolutionScore } = respondResult.value;
      console.log(`\n📊 Resolution: ${(resolutionScore.overall * 100).toFixed(0)}%`);

      if (resolutionScore.isReady) {
        console.log('✅ Requirements are clear enough! Type "done" to finish or continue.\n');
      } else {
        console.log('');
      }

      currentQuestion = nextQuestion;
    }

    const completeResult = engine.complete(sessionId);
    if (completeResult.ok) {
      console.log(`\n✅ Interview completed. Session ID: ${sessionId}`);
      console.log('Run `gestalt spec ' + sessionId + '` to generate a spec.\n');
    }

    // asciinema 녹화 중이었다면 백그라운드 GIF 변환 트리거
    if (orchestrator.isRecording()) {
      await orchestrator.stopAndConvert(topic, sessionId, options);
    }
  } finally {
    rl.close();
    eventStore.close();
  }
}
