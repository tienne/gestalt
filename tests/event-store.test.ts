import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventStore } from '../src/events/store.js';
import { EventType } from '../src/events/types.js';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

describe('EventStore', () => {
  let store: EventStore;
  const dbDir = `.gestalt/test-${randomUUID()}`;
  const dbPath = `${dbDir}/events.db`;

  beforeEach(() => {
    store = new EventStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('appends and retrieves events', () => {
    const event = store.append('interview', 'session-1', EventType.INTERVIEW_SESSION_STARTED, {
      topic: 'Test topic',
      projectType: 'greenfield',
    });

    expect(event.id).toBeDefined();
    expect(event.aggregateType).toBe('interview');
    expect(event.aggregateId).toBe('session-1');
    expect(event.eventType).toBe(EventType.INTERVIEW_SESSION_STARTED);
  });

  it('getByAggregate returns events in order', () => {
    store.append('interview', 'session-1', EventType.INTERVIEW_SESSION_STARTED, { topic: 'A' });
    store.append('interview', 'session-1', EventType.INTERVIEW_QUESTION_ASKED, { question: 'Q1' });
    store.append('interview', 'session-2', EventType.INTERVIEW_SESSION_STARTED, { topic: 'B' });

    const events = store.getByAggregate('interview', 'session-1');
    expect(events).toHaveLength(2);
    expect(events[0]!.eventType).toBe(EventType.INTERVIEW_SESSION_STARTED);
    expect(events[1]!.eventType).toBe(EventType.INTERVIEW_QUESTION_ASKED);
  });

  it('getByType returns events of specific type', () => {
    store.append('interview', 's1', EventType.INTERVIEW_SESSION_STARTED, { topic: 'A' });
    store.append('interview', 's2', EventType.INTERVIEW_SESSION_STARTED, { topic: 'B' });
    store.append('interview', 's1', EventType.INTERVIEW_QUESTION_ASKED, { q: 'Q1' });

    const starts = store.getByType(EventType.INTERVIEW_SESSION_STARTED);
    expect(starts).toHaveLength(2);
  });

  it('getLatest returns the most recent matching event', () => {
    store.append('interview', 's1', EventType.INTERVIEW_RESOLUTION_SCORED, { overall: 0.8 });
    store.append('interview', 's1', EventType.INTERVIEW_RESOLUTION_SCORED, { overall: 0.4 });

    const latest = store.getLatest('interview', 's1', EventType.INTERVIEW_RESOLUTION_SCORED);
    expect(latest).not.toBeNull();
    expect((latest!.payload as Record<string, number>).overall).toBe(0.4);
  });

  it('getAll returns events with limit', () => {
    for (let i = 0; i < 5; i++) {
      store.append('test', `a${i}`, 'test.event', { i });
    }

    const all = store.getAll(3);
    expect(all).toHaveLength(3);
  });
});
