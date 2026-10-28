import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionManager } from '../../../src/interview/session.js';
import { EventStore } from '../../../src/events/store.js';
import { GestaltPrinciple } from '../../../src/core/types.js';
import { EventType } from '../../../src/events/types.js';
import {
  SessionNotFoundError,
  SessionAlreadyCompletedError,
  InterviewNotReadyError,
} from '../../../src/core/errors.js';
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
    } catch {
      /* ignore */
    }
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

  function completedEvent(sessionId: string) {
    return store
      .getByAggregate('interview', sessionId)
      .find((e) => e.eventType === EventType.INTERVIEW_SESSION_COMPLETED);
  }

  it('completes a ready session', () => {
    const session = manager.create('test', 'greenfield');
    manager.updateResolutionScore(session.sessionId, {
      overall: 0.85,
      isReady: true,
      dimensions: [],
    });
    const completed = manager.complete(session.sessionId);
    expect(completed.status).toBe('completed');
    expect(completed.forcedComplete).toBeUndefined();
    expect(completedEvent(session.sessionId)?.payload).toMatchObject({ forced: false });
  });

  it('rejects completing a session below the threshold', () => {
    const session = manager.create('test', 'greenfield');
    manager.updateResolutionScore(session.sessionId, {
      overall: 0.5,
      isReady: false,
      dimensions: [],
    });
    expect(() => manager.complete(session.sessionId)).toThrow(InterviewNotReadyError);
    expect(manager.get(session.sessionId).status).toBe('in_progress');
    expect(completedEvent(session.sessionId)).toBeUndefined();
  });

  function rejection(sessionId: string): Error {
    try {
      manager.complete(sessionId);
    } catch (e) {
      return e as Error;
    }
    throw new Error('complete가 거절되지 않았다');
  }

  it('points a session above the threshold that has no rescore yet to the rescore instead of force', () => {
    const session = manager.create('test', 'greenfield');
    manager.updateResolutionScore(session.sessionId, {
      overall: 0.85,
      isReady: false,
      dimensions: [],
    });
    const error = rejection(session.sessionId);
    expect(error).toBeInstanceOf(InterviewNotReadyError);
    expect(error.message).toMatch(/다시 채점을 아직 받지 않아/);
    expect(error.message).not.toMatch(/force=true/);
    expect(manager.get(session.sessionId).status).toBe('in_progress');
    expect(manager.get(session.sessionId).forcedComplete).toBeUndefined();
  });

  it('treats a score exactly at the threshold as above it', () => {
    const session = manager.create('test', 'greenfield');
    manager.updateResolutionScore(session.sessionId, {
      overall: 0.8,
      isReady: false,
      dimensions: [],
    });
    expect(rejection(session.sessionId).message).toMatch(/다시 채점을 아직 받지 않아/);
  });

  it('points a session held by the rescore to continue the interview', () => {
    const session = manager.create('test', 'greenfield');
    manager.updateResolutionScore(session.sessionId, {
      overall: 0.85,
      isReady: false,
      dimensions: [],
    });
    manager.recordRescore(
      session.sessionId,
      { mode: 'isolated', overall: 0.6, maxDimensionSpread: 0.3, droppedDimensions: [] },
      false,
    );
    const error = rejection(session.sessionId);
    expect(error.message).toMatch(/완료가 보류됐습니다/);
    expect(error.message).not.toMatch(/force=true/);
    expect(manager.get(session.sessionId).status).toBe('in_progress');
    expect(manager.get(session.sessionId).forcedComplete).toBeUndefined();
  });

  it('completes without force once the rescore passes', () => {
    const session = manager.create('test', 'greenfield');
    manager.updateResolutionScore(session.sessionId, {
      overall: 0.85,
      isReady: false,
      dimensions: [],
    });
    manager.recordRescore(
      session.sessionId,
      { mode: 'isolated', overall: 0.84, maxDimensionSpread: 0.05, droppedDimensions: [] },
      true,
    );
    const completed = manager.complete(session.sessionId);
    expect(completed.status).toBe('completed');
    expect(completed.forcedComplete).toBeUndefined();
    expect(completedEvent(session.sessionId)?.payload).toMatchObject({ forced: false });
  });

  it('keeps the force message for a stored score without a threshold', () => {
    const lowered = new SessionManager(store, { resolutionThreshold: 0.7 });
    const session = lowered.create('test', 'greenfield');
    store.append('interview', session.sessionId, EventType.INTERVIEW_RESOLUTION_SCORED, {
      overall: 0.75,
      isReady: false,
      dimensions: [],
    });
    let message = '';
    try {
      lowered.complete(session.sessionId);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/임계값\(0\.8\)에 못 미쳐/);
    expect(message).toMatch(/force=true/);
  });

  it('rejects completing an unscored session', () => {
    const session = manager.create('test', 'greenfield');
    expect(() => manager.complete(session.sessionId)).toThrow(InterviewNotReadyError);
  });

  it('completes a session below the threshold with force and records it', () => {
    const session = manager.create('test', 'greenfield');
    manager.updateResolutionScore(session.sessionId, {
      overall: 0.5,
      isReady: false,
      dimensions: [],
    });
    const completed = manager.complete(session.sessionId, { force: true });
    expect(completed.status).toBe('completed');
    expect(completed.forcedComplete).toBe(true);
    expect(completedEvent(session.sessionId)?.payload).toMatchObject({
      forced: true,
      finalResolutionScore: 0.5,
    });
  });

  it('does not mark a ready session as forced even when force is passed', () => {
    const session = manager.create('test', 'greenfield');
    manager.updateResolutionScore(session.sessionId, {
      overall: 0.9,
      isReady: true,
      dimensions: [],
    });
    const completed = manager.complete(session.sessionId, { force: true });
    expect(completed.forcedComplete).toBeUndefined();
  });

  it('rejects completing an already completed session without another event', () => {
    const session = manager.create('test', 'greenfield');
    manager.complete(session.sessionId, { force: true });
    expect(() => manager.complete(session.sessionId)).toThrow(SessionAlreadyCompletedError);
    expect(() => manager.complete(session.sessionId, { force: true })).toThrow(
      SessionAlreadyCompletedError,
    );
    const completedEvents = store
      .getByAggregate('interview', session.sessionId)
      .filter((e) => e.eventType === EventType.INTERVIEW_SESSION_COMPLETED);
    expect(completedEvents).toHaveLength(1);
  });

  it('prevents questions on completed session', () => {
    const session = manager.create('test', 'greenfield');
    manager.complete(session.sessionId, { force: true });
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

  it('updates resolution score', () => {
    const session = manager.create('test', 'greenfield');
    const mockScore = {
      overall: 0.5,
      dimensions: [],
      isReady: false,
    };
    manager.updateResolutionScore(session.sessionId, mockScore);
    expect(session.resolutionScore).toEqual(mockScore);
  });

  describe('cleanup (TTL)', () => {
    it('removes sessions whose updatedAt is older than the TTL (25h ago)', () => {
      const session = manager.create('stale', 'greenfield');
      // Force updatedAt to 25 hours ago — beyond the 24h default TTL
      session.updatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

      manager.cleanup();

      expect(manager.list().map((s) => s.sessionId)).not.toContain(session.sessionId);
    });

    it('preserves sessions whose updatedAt is within the TTL (1h ago)', () => {
      const session = manager.create('active', 'greenfield');
      session.updatedAt = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();

      manager.cleanup();

      expect(manager.get(session.sessionId).sessionId).toBe(session.sessionId);
    });

    it('returns the number of sessions removed', () => {
      const stale1 = manager.create('stale1', 'greenfield');
      const stale2 = manager.create('stale2', 'greenfield');
      const fresh = manager.create('fresh', 'greenfield');

      const past = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      stale1.updatedAt = past;
      stale2.updatedAt = past;
      // fresh keeps its recent updatedAt

      const removed = manager.cleanup();

      expect(removed).toBe(2);
      expect(manager.get(fresh.sessionId).sessionId).toBe(fresh.sessionId);
    });
  });
});
