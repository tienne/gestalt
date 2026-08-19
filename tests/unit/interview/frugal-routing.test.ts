import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { InterviewEngine } from '../../../src/interview/engine.js';
import { EventStore } from '../../../src/events/store.js';
import type { LLMAdapter, LLMRequest, LLMResponse } from '../../../src/llm/types.js';

/** 어느 어댑터가 무슨 프롬프트를 받았는지 기록하는 목 */
class RecordingLLM implements LLMAdapter {
  calls: string[] = [];

  constructor(private reply: string) {}

  async chat(request: LLMRequest): Promise<LLMResponse> {
    this.calls.push(request.messages.map((m) => m.content).join('\n'));
    return { content: this.reply, usage: { inputTokens: 10, outputTokens: 5 } };
  }
}

const QUESTION_REPLY = '{"question": "무엇을 만들려고 하나요?", "reasoning": "closure"}';
const SCORE_REPLY = JSON.stringify({
  goalClarity: 0.7,
  constraintClarity: 0.6,
  successCriteria: 0.5,
  priorityClarity: 0.6,
  contradictions: [],
});

describe('InterviewEngine frugal tier 라우팅', () => {
  let store: EventStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/frugal-routing-${randomUUID()}.db`;
    store = new EventStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try {
      if (existsSync(dbPath)) rmSync(dbPath);
      if (existsSync(dbPath + '-wal')) rmSync(dbPath + '-wal');
      if (existsSync(dbPath + '-shm')) rmSync(dbPath + '-shm');
    } catch {
      /* ignore */
    }
  });

  it('frugal 어댑터를 주면 점수 산정만 그쪽으로 가고 질문 생성은 기본 어댑터가 맡는다', async () => {
    const standard = new RecordingLLM(QUESTION_REPLY);
    const frugal = new RecordingLLM(SCORE_REPLY);
    const engine = new InterviewEngine(standard, store, frugal);

    const start = await engine.start('대시보드 기능');
    if (!start.ok) throw new Error('start failed');

    // start는 질문 생성만 한다
    expect(standard.calls).toHaveLength(1);
    expect(frugal.calls).toHaveLength(0);

    const respond = await engine.respond(start.value.session.sessionId, '주간 지표를 본다');
    if (!respond.ok) throw new Error('respond failed');

    // respond는 점수 1회 + 질문 1회
    expect(frugal.calls).toHaveLength(1);
    expect(standard.calls).toHaveLength(2);
    expect(respond.value.resolutionScore.overall).toBeGreaterThan(0);
  });

  it('frugal 어댑터가 없으면 점수 산정도 기본 어댑터가 맡는다', async () => {
    const standard = new RecordingLLM(SCORE_REPLY);
    const engine = new InterviewEngine(standard, store);

    const start = await engine.start('대시보드 기능');
    if (!start.ok) throw new Error('start failed');

    await engine.respond(start.value.session.sessionId, '주간 지표를 본다');

    // 질문 2회 + 점수 1회가 모두 한 어댑터로 간다
    expect(standard.calls).toHaveLength(3);
  });
});
