import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionManager } from '../../../src/interview/session.js';
import { EventStore } from '../../../src/events/store.js';
import { GestaltPrinciple } from '../../../src/core/types.js';
import { SessionNotFoundError, SessionAlreadyCompletedError } from '../../../src/core/errors.js';
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

describe('SessionManager', () => {
  let store: EventStore;
  let manager: SessionManager;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/session-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    manager = new SessionManager(store);
  });

  afterEach(() => {
    store.close();
    try {
      if (existsSync(dbPath)) rmSync(dbPath);
      if (existsSync(dbPath + '-wal')) rmSync(dbPath + '-wal');
      if (existsSync(dbPath + '-shm')) rmSync(dbPath + '-shm');
    } catch { /* ignore */ }
  });

  it('creates a session', () => {
    const session = manager.create('test topic', 'greenfield');
    expect(session.sessionId).toBeDefined();
    expect(session.topic).toBe('test topic');
    expect(session.status).toBe('in_progress');
    expect(session.projectType).toBe('greenfield');
    expect(session.rounds).toHaveLength(0);
  });

  it('retrieves a session', () => {
    const created = manager.create('test', 'greenfield');
    const retrieved = manager.get(created.sessionId);
    expect(retrieved.sessionId).toBe(created.sessionId);
  });

  it('throws on unknown session', () => {
    expect(() => manager.get('nonexistent')).toThrow(SessionNotFoundError);
  });

  it('adds questions and records responses', () => {
    const session = manager.create('test', 'greenfield');
    manager.addQuestion(session.sessionId, 'What is the goal?', GestaltPrinciple.CLOSURE);

    expect(session.rounds).toHaveLength(1);
    expect(session.rounds[0]!.question).toBe('What is the goal?');
    expect(session.rounds[0]!.userResponse).toBeNull();

    manager.recordResponse(session.sessionId, 'Build a dashboard');
    expect(session.rounds[0]!.userResponse).toBe('Build a dashboard');
  });

  it('completes a session', () => {
    const session = manager.create('test', 'greenfield');
    const completed = manager.complete(session.sessionId);
    expect(completed.status).toBe('completed');
  });

  it('prevents questions on completed session', () => {
    const session = manager.create('test', 'greenfield');
    manager.complete(session.sessionId);
    expect(() =>
      manager.addQuestion(session.sessionId, 'Another?', GestaltPrinciple.CLOSURE),
    ).toThrow(SessionAlreadyCompletedError);
  });

  it('gets latest session', () => {
    manager.create('first', 'greenfield');
    // second session is created after first, so it has a later createdAt
    const second = manager.create('second', 'brownfield');
    const latest = manager.getLatest();
    // Both may have same ISO timestamp; just ensure one of them is returned
    expect(latest).not.toBeNull();
    // If timestamps are identical, map iteration order isn't guaranteed
    // Verify the session exists
    expect(latest!.sessionId).toBe(second.sessionId);
  });

  it('lists sessions', () => {
    manager.create('first', 'greenfield');
    manager.create('second', 'brownfield');
    const list = manager.list();
    expect(list).toHaveLength(2);
  });

  it('updates ambiguity score', () => {
    const session = manager.create('test', 'greenfield');
    const mockScore = {
      overall: 0.5,
      dimensions: [],
      isReady: false,
    };
    manager.updateResolutionScore(session.sessionId, mockScore);
    expect(session.resolutionScore).toEqual(mockScore);
  });
});
