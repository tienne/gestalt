import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { EventStore } from '../../../src/events/store.js';
import { AgentRegistry } from '../../../src/agent/registry.js';
import { PassthroughEngine } from '../../../src/interview/passthrough-engine.js';
import { PassthroughSpecGenerator } from '../../../src/spec/passthrough-generator.js';
import { handleInterviewPassthrough } from '../../../src/mcp/tools/interview-passthrough.js';
import { handleSpecPassthrough } from '../../../src/mcp/tools/spec-passthrough.js';
import { BANNED_SURFACE_TERMS, DEEP_PROMPT_KEYS } from '../../../src/gestalt/surface-labels.js';

/**
 * LeakTest — 사용자 표면으로 나가는 MCP 응답 문자열에 게슈탈트 원리 용어가
 * 하나도 새지 않는지 검사하는 회귀 테스트.
 *
 * 검사 대상: 시스템이 생성하는 표면 라벨·문구 (currentStage, dimensions.label, message, stage 등).
 * 검사 제외:
 *   - 심층 LLM 지시 프롬프트 필드(systemPrompt/questionPrompt 등) — 게슈탈트 어휘를 담은 채 유지.
 *   - 에코된 사용자/이력 데이터(priorContext 메모리, detectedFiles) — 사용자가 만든 스펙 목표에는
 *     제품명 "Gestalt"가 들어갈 수 있고, 이는 시스템이 주입한 원리 라벨 누수가 아니다.
 */
const ECHOED_DATA_KEYS = ['priorContext', 'detectedFiles'];
describe('surface leak regression', () => {
  let store: EventStore;
  let registry: AgentRegistry;
  let engine: PassthroughEngine;
  let generator: PassthroughSpecGenerator;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/surface-leak-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    registry = new AgentRegistry('agents');
    registry.loadAll();
    engine = new PassthroughEngine(store, registry);
    generator = new PassthroughSpecGenerator(store, registry);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
      } catch {
        /* ignore */
      }
    }
  });

  it('활성 에이전트가 실제로 로드된다 (테스트 전제 확인)', () => {
    // 이 전제가 깨지면 activeAgents 정화를 실제로 검증하지 못한다.
    expect(registry.getByPipeline('interview').length).toBeGreaterThan(0);
  });

  it('인터뷰 start 응답에 원리 용어가 새지 않는다', () => {
    const res = JSON.parse(
      handleInterviewPassthrough(engine, {
        action: 'start',
        topic: 'A payment checkout flow',
        cwd: process.cwd(),
      }),
    );
    // 표면에는 currentPrinciple 대신 currentStage가 온다
    expect(res.gestaltContext.currentPrinciple).toBeUndefined();
    expect(typeof res.gestaltContext.currentStage).toBe('string');
    assertNoLeak(res);
  });

  it('인터뷰 respond 응답의 점수 라벨과 컨텍스트에 원리 용어가 없다', () => {
    const started = JSON.parse(
      handleInterviewPassthrough(engine, { action: 'start', topic: 'A search feature' }),
    );
    const sessionId = started.sessionId as string;

    const res = JSON.parse(
      handleInterviewPassthrough(engine, {
        action: 'respond',
        sessionId,
        response: 'It must return results within 200ms and support typo tolerance.',
        generatedQuestion: 'What are the latency and accuracy targets?',
        resolutionScore: {
          goalClarity: 0.9,
          constraintClarity: 0.85,
          successCriteria: 0.85,
          priorityClarity: 0.86,
          contextClarity: 0.8,
        },
      }),
    );

    // 점수 차원은 raw 원리명이 아니라 사람이 읽는 label로 노출된다
    const dims = res.resolutionScore.dimensions as Array<Record<string, unknown>>;
    expect(dims.length).toBeGreaterThan(0);
    for (const d of dims) {
      expect(d.principle).toBeUndefined();
      expect(typeof d.label).toBe('string');
    }
    assertNoLeak(res);
  });

  it('인터뷰 score 응답에 원리 용어가 없다', () => {
    const started = JSON.parse(
      handleInterviewPassthrough(engine, { action: 'start', topic: 'A notification system' }),
    );
    const sessionId = started.sessionId as string;

    const res = JSON.parse(
      handleInterviewPassthrough(engine, {
        action: 'score',
        sessionId,
        resolutionScore: {
          goalClarity: 0.9,
          constraintClarity: 0.85,
          successCriteria: 0.85,
          priorityClarity: 0.86,
          contextClarity: 0.8,
        },
      }),
    );
    for (const d of res.resolutionScore.dimensions as Array<Record<string, unknown>>) {
      expect(d.principle).toBeUndefined();
    }
    assertNoLeak(res);
  });

  it('스펙 컨텍스트 응답(specContext)에 원리 용어가 없다', () => {
    const started = JSON.parse(
      handleInterviewPassthrough(engine, { action: 'start', topic: 'An analytics dashboard' }),
    );
    const sessionId = started.sessionId as string;

    handleInterviewPassthrough(engine, {
      action: 'respond',
      sessionId,
      response: 'Show daily active users and revenue with a date range filter.',
      generatedQuestion: 'Which metrics and filters are required?',
    });

    const res = JSON.parse(handleSpecPassthrough(engine, generator, { sessionId }, registry));
    expect(res.status).toBe('prompt');
    // allRounds에는 gestaltFocus 대신 평범한 stage가 온다
    for (const round of res.specContext.allRounds as Array<Record<string, unknown>>) {
      expect(round.gestaltFocus).toBeUndefined();
      expect(typeof round.stage).toBe('string');
    }
    assertNoLeak(res);
  });
});

// ─── helpers ────────────────────────────────────────────────────

/**
 * 응답 객체에서 심층 프롬프트 필드를 제외한 모든 문자열 값을 모아
 * 게슈탈트 금지어가 하나도 없는지 단언한다.
 */
function assertNoLeak(response: unknown): void {
  const values = collectSurfaceValues(response);
  const blob = values.join('\n').toLowerCase();
  for (const term of BANNED_SURFACE_TERMS) {
    expect(blob, `banned term "${term}" leaked into a surface value`).not.toContain(term);
  }
}

function collectSurfaceValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((v) => collectSurfaceValues(v));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, v]) =>
      DEEP_PROMPT_KEYS.includes(key) || ECHOED_DATA_KEYS.includes(key)
        ? []
        : collectSurfaceValues(v),
    );
  }
  return [];
}
