import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DomainEvent } from '../core/types.js';
import { EventStoreError } from '../core/errors.js';

export class EventStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        timestamp TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_events_aggregate
        ON events(aggregate_type, aggregate_id);
      CREATE INDEX IF NOT EXISTS idx_events_type
        ON events(event_type);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp
        ON events(timestamp);
    `);
  }

  append<T>(
    aggregateType: string,
    aggregateId: string,
    eventType: string,
    payload: T,
  ): DomainEvent<T> {
    const event: DomainEvent<T> = {
      id: randomUUID(),
      aggregateType,
      aggregateId,
      eventType,
      payload,
      timestamp: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };

    try {
      const stmt = this.db.prepare(`
        INSERT INTO events (id, aggregate_type, aggregate_id, event_type, payload, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        event.id,
        event.aggregateType,
        event.aggregateId,
        event.eventType,
        JSON.stringify(event.payload),
        event.timestamp,
      );
    } catch (e) {
      throw new EventStoreError(
        `Failed to append event: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    return event;
  }

  getByAggregate(aggregateType: string, aggregateId: string): DomainEvent[] {
    const stmt = this.db.prepare(`
      SELECT * FROM events
      WHERE aggregate_type = ? AND aggregate_id = ?
      ORDER BY timestamp ASC
    `);
    const rows = stmt.all(aggregateType, aggregateId) as RawEventRow[];
    return rows.map(parseRow);
  }

  getByType(eventType: string, limit = 100): DomainEvent[] {
    const stmt = this.db.prepare(`
      SELECT * FROM events
      WHERE event_type = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    const rows = stmt.all(eventType, limit) as RawEventRow[];
    return rows.map(parseRow);
  }

  getLatest(aggregateType: string, aggregateId: string, eventType: string): DomainEvent | null {
    const stmt = this.db.prepare(`
      SELECT * FROM events
      WHERE aggregate_type = ? AND aggregate_id = ? AND event_type = ?
      ORDER BY rowid DESC
      LIMIT 1
    `);
    const row = stmt.get(aggregateType, aggregateId, eventType) as RawEventRow | undefined;
    return row ? parseRow(row) : null;
  }

  /**
   * Replay all events for a specific aggregate in chronological order.
   * Semantic alias for getByAggregate — used by Repository pattern for session reconstruction.
   */
  replay(aggregateType: string, aggregateId: string): DomainEvent[] {
    return this.getByAggregate(aggregateType, aggregateId);
  }

  /**
   * List distinct aggregate IDs for a given type, ordered by earliest event timestamp.
   */
  listAggregates(aggregateType: string): string[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT aggregate_id
      FROM events
      WHERE aggregate_type = ?
      ORDER BY MIN(timestamp) OVER (PARTITION BY aggregate_id)
    `);
    const rows = stmt.all(aggregateType) as { aggregate_id: string }[];
    return rows.map((r) => r.aggregate_id);
  }

  getAll(limit = 100): DomainEvent[] {
    const stmt = this.db.prepare(`
      SELECT * FROM events ORDER BY timestamp DESC LIMIT ?
    `);
    const rows = stmt.all(limit) as RawEventRow[];
    return rows.map(parseRow);
  }

  close(): void {
    this.db.close();
  }
}

interface RawEventRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: string;
  timestamp: string;
  created_at: string;
}

function parseRow(row: RawEventRow): DomainEvent {
  return {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: JSON.parse(row.payload),
    timestamp: row.timestamp,
    createdAt: row.created_at,
  };
}
