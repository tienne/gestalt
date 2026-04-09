import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventStore } from '../../../src/events/store.js';
import { EventType } from '../../../src/events/types.js';
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

function testDb() {
  return `.gestalt-test/events-${randomUUID()}.db`;
}

describe('EventStore', () => {
  let store: EventStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = testDb();
    store = new EventStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try {
      if (existsSync(dbPath)) rmSync(dbPath);
      if (existsSync(dbPath + '-wal')) rmSync(dbPath + '-wal');
      if (existsSync(dbPath + '-shm')) rmSync(dbPath + '-shm');
    } catch {
      /* ignore cleanup errors */
    }
  });

  it('creates database and tables', () => {
    expect(existsSync(dbPath)).toBe(true);
  });

  it('appends and retrieves events', () => {
    const event = store.append('interview', 'session-1', EventType.INTERVIEW_SESSION_STARTED, {
      topic: 'test topic',
    });

    expect(event.id).toBeDefined();
    expect(event.aggregateType).toBe('interview');
    expect(event.aggregateId).toBe('session-1');
    expect(event.eventType).toBe(EventType.INTERVIEW_SESSION_STARTED);
    expect(event.payload).toEqual({ topic: 'test topic' });
  });

  it('retrieves events by aggregate', () => {
    store.append('interview', 'session-1', EventType.INTERVIEW_SESSION_STARTED, {});
    store.append('interview', 'session-1', EventType.INTERVIEW_QUESTION_ASKED, { q: 'What?' });
    store.append('interview', 'session-2', EventType.INTERVIEW_SESSION_STARTED, {});

    const events = store.getByAggregate('interview', 'session-1');
    expect(events).toHaveLength(2);
    expect(events[0]!.eventType).toBe(EventType.INTERVIEW_SESSION_STARTED);
    expect(events[1]!.eventType).toBe(EventType.INTERVIEW_QUESTION_ASKED);
  });

  it('retrieves events by type', () => {
    store.append('interview', 's1', EventType.INTERVIEW_SESSION_STARTED, {});
    store.append('interview', 's2', EventType.INTERVIEW_SESSION_STARTED, {});
    store.append('interview', 's1', EventType.INTERVIEW_QUESTION_ASKED, {});

    const events = store.getByType(EventType.INTERVIEW_SESSION_STARTED);
    expect(events).toHaveLength(2);
  });

  it('retrieves latest event', () => {
    store.append('interview', 's1', EventType.INTERVIEW_RESOLUTION_SCORED, { score: 0.8 });
    store.append('interview', 's1', EventType.INTERVIEW_RESOLUTION_SCORED, { score: 0.5 });

    const latest = store.getLatest('interview', 's1', EventType.INTERVIEW_RESOLUTION_SCORED);
    expect(latest).not.toBeNull();
    expect((latest!.payload as { score: number }).score).toBe(0.5);
  });

  it('returns null for non-existent latest', () => {
    const latest = store.getLatest('interview', 'nope', EventType.INTERVIEW_SESSION_STARTED);
    expect(latest).toBeNull();
  });

  it('retrieves all events with limit', () => {
    for (let i = 0; i < 5; i++) {
      store.append('interview', `s${i}`, EventType.INTERVIEW_SESSION_STARTED, { i });
    }
    const events = store.getAll(3);
    expect(events).toHaveLength(3);
  });
});
