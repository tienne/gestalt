import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventStore } from '../../../src/events/store.js';
import { EventType } from '../../../src/events/types.js';
import { SQLITE_BUSY_TIMEOUT_MS } from '../../../src/core/constants.js';
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

function testDb() {
  return `.gestalt-test/events-${randomUUID()}.db`;
}

// pragma는 연결 속성이라 별도 연결로는 확인할 수 없어 스토어의 내부 연결을 직접 들여다본다
function pragma(store: EventStore, source: string, key: string): unknown {
  const db = (store as unknown as { db: { pragma(s: string): unknown } | null }).db;
  if (!db) return undefined;
  const raw = db.pragma(source);
  if (Array.isArray(raw)) {
    return (raw[0] as Record<string, unknown> | undefined)?.[key];
  }
  return raw;
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
      if (existsSync(dbPath + '.jsonl')) rmSync(dbPath + '.jsonl');
    } catch {
      /* ignore cleanup errors */
    }
  });

  it('creates database and tables', () => {
    expect(existsSync(dbPath) || existsSync(dbPath + '.jsonl')).toBe(true);
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

  it('timestamp가 같아도 붙인 순서대로 재생한다', () => {
    // 재생 순서가 이 도메인의 상태를 만든다. timestamp는 밀리초 ISO 문자열이라
    // 코멘트를 연속으로 붙이면 같은 값이 여럿 나온다. 시계를 세워 그 동점을 강제로
    // 만든다. 그래도 순서가 삽입 순서 그대로인지 본다 — rowid 정렬이 지키는 약속이다
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      for (let i = 0; i < 50; i++) {
        store.append('local-pr', 'pr1', 'pr.comment.added', { i });
      }
      store.append('local-pr', 'pr2', 'pr.comment.added', { i: -1 });

      const byAggregate = store.getByAggregate('local-pr', 'pr1');
      expect(new Set(byAggregate.map((e) => e.timestamp)).size).toBe(1);
      expect(byAggregate.map((e) => (e.payload as { i: number }).i)).toEqual(
        Array.from({ length: 50 }, (_, i) => i),
      );

      const grouped = store.getAllByAggregateType('local-pr');
      expect(grouped.get('pr1')!.map((e) => (e.payload as { i: number }).i)).toEqual(
        Array.from({ length: 50 }, (_, i) => i),
      );
      // 묶음 안의 상대 순서만 보장한다. 묶음은 aggregate별로 갈라 담는다
      expect([...grouped.keys()].sort()).toEqual(['pr1', 'pr2']);
    } finally {
      vi.useRealTimers();
    }
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

  describe('emit (non-throwing wrapper)', () => {
    it('returns a DomainEvent on success', () => {
      const event = store.emit('interview', 'session-1', EventType.INTERVIEW_SESSION_STARTED, {
        topic: 'emit topic',
      });

      expect(event).not.toBeNull();
      expect(event!.id).toBeDefined();
      expect(event!.aggregateType).toBe('interview');
      expect(event!.aggregateId).toBe('session-1');
      expect(event!.payload).toEqual({ topic: 'emit topic' });

      // emitted event is actually persisted
      const stored = store.getByAggregate('interview', 'session-1');
      expect(stored).toHaveLength(1);
    });

    it('returns null without throwing when the DB is closed', () => {
      const usesSqlite = existsSync(dbPath);
      store.close();

      let result: ReturnType<typeof store.emit> | undefined;
      expect(() => {
        result = store.emit('interview', 'session-1', EventType.INTERVIEW_SESSION_STARTED, {});
      }).not.toThrow();
      if (usesSqlite) {
        expect(result).toBeNull();
      } else {
        expect(result).not.toBeNull();
      }
    });
  });

  describe('sqlite 연결 pragma', () => {
    it('busy_timeout을 설정값으로 적용한다', () => {
      expect(pragma(store, 'busy_timeout', 'timeout')).toBe(SQLITE_BUSY_TIMEOUT_MS);
    });

    it('busy_timeout 설정 후에도 journal_mode는 wal로 유지된다', () => {
      expect(pragma(store, 'journal_mode', 'journal_mode')).toBe('wal');
    });

    it('같은 DB를 연 두 스토어가 서로 막지 않고 각각 기록한다', () => {
      const sharedPath = testDb();
      const first = new EventStore(sharedPath);
      const second = new EventStore(sharedPath);

      try {
        expect(() => {
          first.append('interview', 'shared', EventType.INTERVIEW_SESSION_STARTED, { from: 'a' });
          second.append('interview', 'shared', EventType.INTERVIEW_QUESTION_ASKED, { from: 'b' });
        }).not.toThrow();

        for (const store of [first, second]) {
          const events = store.getByAggregate('interview', 'shared');
          expect(events).toHaveLength(2);
          expect(events.map((e) => e.eventType)).toEqual([
            EventType.INTERVIEW_SESSION_STARTED,
            EventType.INTERVIEW_QUESTION_ASKED,
          ]);
        }
      } finally {
        first.close();
        second.close();
        for (const suffix of ['', '-wal', '-shm', '.jsonl']) {
          rmSync(sharedPath + suffix, { force: true });
        }
      }
    });
  });

  describe('JSONL fallback backend', () => {
    it('persists and replays events without sqlite bindings', () => {
      const fallbackDbPath = testDb();
      const fallbackStore = new EventStore(fallbackDbPath, { forceJsonl: true });

      fallbackStore.append('interview', 'jsonl-session', EventType.INTERVIEW_SESSION_STARTED, {
        topic: 'fallback topic',
      });
      fallbackStore.append('interview', 'jsonl-session', EventType.INTERVIEW_QUESTION_ASKED, {
        q: 'What?',
      });
      fallbackStore.close();

      const reloaded = new EventStore(fallbackDbPath, { forceJsonl: true });
      const events = reloaded.replay('interview', 'jsonl-session');
      expect(events).toHaveLength(2);
      expect(events[0]!.eventType).toBe(EventType.INTERVIEW_SESSION_STARTED);
      expect(events[1]!.eventType).toBe(EventType.INTERVIEW_QUESTION_ASKED);
      expect(reloaded.listAggregates('interview')).toEqual(['jsonl-session']);
      reloaded.close();

      rmSync(fallbackDbPath + '.jsonl', { force: true });
    });
  });
});
