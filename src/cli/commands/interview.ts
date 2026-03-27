import { createInterface } from 'node:readline';
import { unlinkSync } from 'node:fs';
import { loadConfig } from '../../core/config.js';
import { EventStore } from '../../events/store.js';
import { AnthropicAdapter } from '../../llm/adapter.js';
import { InterviewEngine } from '../../interview/engine.js';
import { TerminalRecorder } from '../../recording/terminal-recorder.js';
import { detectResume } from '../../recording/resume-detector.js';
import { SegmentMerger } from '../../recording/segment-merger.js';
import { GifGenerator } from '../../recording/gif-generator.js';
import { FilenameGenerator } from '../../recording/filename-generator.js';
import { getFramesPath } from '../../recording/recording-dir.js';

export interface InterviewCommandOptions {
  record?: boolean;
}

export async function interviewCommand(
  topic: string,
  options: InterviewCommandOptions = {},
): Promise<void> {
  const config = loadConfig();

  if (!config.llm.apiKey) {
    console.error('Error: ANTHROPIC_API_KEY is required for CLI mode. Set it in .env or as environment variable.');
    process.exit(1);
  }

  const eventStore = new EventStore(config.dbPath);
  const llm = new AnthropicAdapter(config.llm.apiKey, config.llm.model);
  const engine = new InterviewEngine(llm, eventStore);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (question: string): Promise<string> =>
    new Promise((resolve) => rl.question(question, resolve));

  let recorder: TerminalRecorder | null = null;

  try {
    console.log(`\n🔍 Starting Gestalt interview for: "${topic}"\n`);

    const startResult = await engine.start(topic);
    if (!startResult.ok) {
      console.error(`Error: ${startResult.error.message}`);
      return;
    }

    const { session, firstQuestion, projectType, detectedFiles } = startResult.value;
    const sessionId = session.sessionId;

    // --record 플래그 또는 기존 .frames 파일이 있으면 녹화 시작 (resume 자동 감지)
    const { isResuming } = detectResume(sessionId);
    const shouldRecord = options.record === true || isResuming;

    if (shouldRecord) {
      recorder = new TerminalRecorder(sessionId);
      recorder.start();
      if (isResuming) {
        console.log('📹 Resuming recording from previous session...\n');
      } else {
        console.log('📹 Recording started...\n');
      }
    }

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
      console.log('Run `gestalt spec ' + sessionId + '` to generate a spec.\n');
    }

    // 녹화 중이었다면 GIF 생성
    if (recorder && recorder.recording) {
      recorder.stop();
      await generateGif(sessionId, topic, llm);
    }
  } finally {
    // 프로세스 종료 시 recorder가 아직 녹화 중이면 pause
    if (recorder?.recording) {
      recorder.pause();
    }
    rl.close();
    eventStore.close();
  }
}

async function generateGif(sessionId: string, topic: string, llm: AnthropicAdapter): Promise<void> {
  const framesPath = getFramesPath(sessionId);

  try {
    console.log('🎬 Generating GIF recording...');

    const merger = new SegmentMerger();
    const frames = await merger.readSingleFile(framesPath);

    if (frames.length === 0) {
      console.log('⚠️  No frames captured, skipping GIF generation.');
      return;
    }

    const filenameGen = new FilenameGenerator(llm);
    const outputPath = await filenameGen.generate(topic, sessionId);

    const gifGen = new GifGenerator({ repeat: 0, quality: 10, frameDelay: 150 });
    const result = await gifGen.generateFromFrames(frames, outputPath);

    // 임시 .frames 파일 정리
    unlinkSync(framesPath);

    console.log(`✅ GIF saved: ${result.filePath} (${(result.sizeBytes / 1024).toFixed(1)} KB, ${result.frameCount} frames)\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`⚠️  GIF generation failed: ${message}`);
  }
}
