import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PassthroughEngine } from '../../../src/interview/passthrough-engine.js';
import { EventStore } from '../../../src/events/store.js';
import { isOk, isErr } from '../../../src/core/result.js';
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

describe('PassthroughEngine', () => {
  let store: EventStore;
  let engine: PassthroughEngine;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/passthrough-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    engine = new PassthroughEngine(store);
  });

  afterEach(() => {
    store.close();
    try {
      if (existsSync(dbPath)) rmSync(dbPath);
      if (existsSync(dbPath + '-wal')) rmSync(dbPath + '-wal');
      if (existsSync(dbPath + '-shm')) rmSync(dbPath + '-shm');
    } catch { /* ignore */ }
  });

  it('starts an interview and returns GestaltContext', () => {
    const result = engine.start('Payment system');
    expect(isOk(result)).toBe(true);

    if (result.ok) {
      const { session, gestaltContext } = result.value;
      expect(session.topic).toBe('Payment system');
      expect(session.status).toBe('in_progress');
      expect(session.rounds).toHaveLength(0);
      expect(gestaltContext.systemPrompt).toContain('Gestalt');
      expect(gestaltContext.questionPrompt).toContain('Payment system');
      expect(gestaltContext.currentPrinciple).toBeDefined();
      expect(gestaltContext.phase).toBe('early (goal definition)');
      expect(gestaltContext.roundNumber).toBe(1);
    }
  });

  it('responds with generatedQuestion and saves Q&A', () => {
    const startResult = engine.start('Chat app');
    expect(isOk(startResult)).toBe(true);
    if (!startResult.ok) return;

    const { sessionId } = startResult.value.session;
    const result = engine.respond(
      sessionId,
      'We need real-time messaging',
      'What is the main goal of this chat app?',
    );
    expect(isOk(result)).toBe(true);

    if (result.ok) {
      const { session, gestaltContext } = result.value;
      expect(session.rounds).toHaveLength(1);
      expect(session.rounds[0]!.question).toBe('What is the main goal of this chat app?');
      expect(session.rounds[0]!.userResponse).toBe('We need real-time messaging');
      expect(gestaltContext.questionPrompt).toContain('Chat app');
      expect(gestaltContext.roundNumber).toBe(2);
    }
  });

  it('responds with resolutionScore and computes score', () => {
    const startResult = engine.start('Dashboard');
    expect(isOk(startResult)).toBe(true);
    if (!startResult.ok) return;

    const { sessionId } = startResult.value.session;
    const result = engine.respond(
      sessionId,
      'Analytics dashboard for marketing',
      'What is the goal?',
      {
        goalClarity: 0.8,
        constraintClarity: 0.6,
        successCriteria: 0.5,
        priorityClarity: 0.4,
      },
    );
    expect(isOk(result)).toBe(true);

    if (result.ok) {
      expect(result.value.resolutionScore).not.toBeNull();
      expect(result.value.resolutionScore!.overall).toBeGreaterThan(0);
      expect(result.value.resolutionScore!.dimensions.length).toBeGreaterThanOrEqual(4);
      expect(result.value.gestaltContext.scoringPrompt).toBeDefined();
    }
  });

  it('score action returns scoringPrompt when no external score', () => {
    const startResult = engine.start('API');
    expect(isOk(startResult)).toBe(true);
    if (!startResult.ok) return;

    const { sessionId } = startResult.value.session;

    // Add a round manually via respond
    engine.respond(sessionId, 'REST API for users', 'What type of API?');

    const result = engine.score(sessionId);
    expect(isOk(result)).toBe(true);

    if (result.ok) {
      expect(result.value.scoringPrompt).toBeDefined();
      expect(result.value.scoringPrompt).toContain('API');
    }
  });

  it('score action saves external score', () => {
    const startResult = engine.start('Mobile app');
    expect(isOk(startResult)).toBe(true);
    if (!startResult.ok) return;

    const { sessionId } = startResult.value.session;
    engine.respond(sessionId, 'iOS fitness app', 'What platform?');

    const result = engine.score(sessionId, {
      goalClarity: 0.9,
      constraintClarity: 0.8,
      successCriteria: 0.7,
      priorityClarity: 0.6,
    });
    expect(isOk(result)).toBe(true);

    if (result.ok) {
      expect(result.value.resolutionScore).not.toBeNull();
      expect(result.value.scoringPrompt).toBeUndefined();
    }
  });

  it('completes a session', () => {
    const startResult = engine.start('test project');
    expect(isOk(startResult)).toBe(true);
    if (!startResult.ok) return;

    const { sessionId } = startResult.value.session;
    const result = engine.complete(sessionId);
    expect(isOk(result)).toBe(true);

    if (result.ok) {
      expect(result.value.status).toBe('completed');
    }
  });

  it('returns error for nonexistent session', () => {
    const result = engine.respond('nonexistent', 'hello', 'question');
    expect(isErr(result)).toBe(true);
  });

  it('lists and gets sessions', () => {
    engine.start('Project A');
    engine.start('Project B');

    const sessions = engine.listSessions();
    expect(sessions).toHaveLength(2);

    const latest = engine.getLatestSession();
    expect(latest).not.toBeNull();
    expect(latest!.topic).toBe('Project B');
  });
});
