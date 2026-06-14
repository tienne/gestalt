import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DomainEvent } from '../core/types.js';
import { EventStoreError } from '../core/errors.js';
import { logger } from '../core/logger.js';

const require = createRequire(import.meta.url);

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  pragma(source: string): unknown;
  exec(source: string): unknown;
  prepare(source: string): SqliteStatement;
  close(): void;
}

type SqliteConstructor = new (path: string) => SqliteDatabase;

export interface EventStoreOptions {
  forceJsonl?: boolean;
}

/**
 * EventStore 추상 인터페이스 — SessionManager/Repository가 구체 클래스 대신
 * 이 인터페이스에 의존하도록 하여 단일 장애점을 완화한다.
 */
export interface IEventStore {
  append<T>(
    aggregateType: string,
    aggregateId: string,
    eventType: string,
    payload: T,
  ): DomainEvent<T>;
  emit<T>(
    aggregateType: string,
    aggregateId: string,
    eventType: string,
    payload: T,
  ): DomainEvent<T> | null;
  getByAggregate(aggregateType: string, aggregateId: string): DomainEvent<unknown>[];
  replay(aggregateType: string, aggregateId: string): DomainEvent<unknown>[];
  listAggregates(aggregateType: string): string[];
  close(): void;
}

export class EventStore implements IEventStore {
  private db: SqliteDatabase | null = null;
  private jsonlPath: string | null = null;

  constructor(dbPath: string, options: EventStoreOptions = {}) {
    if (!options.forceJsonl) {
      try {
        const dir = dirname(dbPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        const Database = loadSqliteDatabase();
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this.initialize(this.db);
        return;
      } catch (e) {
        logger.warn('event_store.sqlite_unavailable_using_jsonl', {
          module: 'events/store',
          dbPath,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    this.configureJsonlFallback(dbPath);
  }

  private initialize(db: SqliteDatabase): void {
    db.exec(`
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
      if (this.db) {
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
      } else {
        this.appendJsonl(event);
      }
    } catch (e) {
      throw new EventStoreError(
        `Failed to append event: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    return event;
  }

  /**
   * Non-throwing variant of append(). Logs a warning and returns null on failure
   * so event emission never interrupts the main flow.
   */
  emit<T>(
    aggregateType: string,
    aggregateId: string,
    eventType: string,
    payload: T,
  ): DomainEvent<T> | null {
    try {
      return this.append(aggregateType, aggregateId, eventType, payload);
    } catch (e) {
      logger.warn('event_store.emit_failed', {
        module: 'events/store',
        aggregateType,
        aggregateId,
        eventType,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  getByAggregate(aggregateType: string, aggregateId: string): DomainEvent[] {
    if (!this.db) {
      return this.readJsonlEvents().filter(
        (event) => event.aggregateType === aggregateType && event.aggregateId === aggregateId,
      );
    }

    const stmt = this.db.prepare(`
      SELECT * FROM events
      WHERE aggregate_type = ? AND aggregate_id = ?
      ORDER BY timestamp ASC
    `);
    const rows = stmt.all(aggregateType, aggregateId) as RawEventRow[];
    return rows.map(parseRow);
  }

  getByType(eventType: string, limit = 100): DomainEvent[] {
    if (!this.db) {
      return this.readJsonlEvents()
        .filter((event) => event.eventType === eventType)
        .sort(descByTimestamp)
        .slice(0, limit);
    }

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
    if (!this.db) {
      const matches = this.readJsonlEvents().filter(
        (event) =>
          event.aggregateType === aggregateType &&
          event.aggregateId === aggregateId &&
          event.eventType === eventType,
      );
      return matches[matches.length - 1] ?? null;
    }

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
    if (!this.db) {
      const earliestByAggregate = new Map<string, string>();
      for (const event of this.readJsonlEvents()) {
        if (event.aggregateType !== aggregateType) continue;
        if (!earliestByAggregate.has(event.aggregateId)) {
          earliestByAggregate.set(event.aggregateId, event.timestamp);
        }
      }
      return [...earliestByAggregate.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([aggregateId]) => aggregateId);
    }

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
    if (!this.db) {
      return this.readJsonlEvents().sort(descByTimestamp).slice(0, limit);
    }

    const stmt = this.db.prepare(`
      SELECT * FROM events ORDER BY timestamp DESC LIMIT ?
    `);
    const rows = stmt.all(limit) as RawEventRow[];
    return rows.map(parseRow);
  }

  close(): void {
    this.db?.close();
  }

  private appendJsonl<T>(event: DomainEvent<T>): void {
    if (!this.jsonlPath) {
      throw new EventStoreError('JSONL event store path is not configured');
    }
    appendFileSync(this.jsonlPath, JSON.stringify(event) + '\n', 'utf-8');
  }

  private configureJsonlFallback(dbPath: string): void {
    const candidates = [
      dbPath,
      join(process.cwd(), '.gestalt', 'events.db'),
      join(tmpdir(), 'gestalt', 'events.db'),
    ];

    const failures: string[] = [];
    for (const candidate of candidates) {
      const jsonlPath = `${candidate}.jsonl`;
      try {
        const dir = dirname(jsonlPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        appendFileSync(jsonlPath, '', { encoding: 'utf-8', flag: 'a' });
        this.jsonlPath = jsonlPath;
        if (candidate !== dbPath) {
          logger.warn('event_store.jsonl_path_fallback', {
            module: 'events/store',
            requestedPath: dbPath,
            jsonlPath,
          });
        }
        return;
      } catch (e) {
        failures.push(`${jsonlPath}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    throw new EventStoreError(
      `Failed to initialize JSONL event store fallback:\n${failures.join('\n')}`,
    );
  }

  private readJsonlEvents(): DomainEvent[] {
    if (!this.jsonlPath || !existsSync(this.jsonlPath)) return [];

    const raw = readFileSync(this.jsonlPath, 'utf-8');
    const events: DomainEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as DomainEvent);
      } catch {
        logger.warn('event_store.invalid_jsonl_event_ignored', {
          module: 'events/store',
          jsonlPath: this.jsonlPath,
        });
      }
    }
    return events;
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

function loadSqliteDatabase(): SqliteConstructor {
  const imported = require('better-sqlite3') as SqliteConstructor | { default?: SqliteConstructor };
  if (typeof imported === 'function') return imported;
  if (typeof imported.default === 'function') return imported.default;
  throw new EventStoreError('better-sqlite3 did not export a Database constructor');
}

function descByTimestamp(a: DomainEvent, b: DomainEvent): number {
  return b.timestamp.localeCompare(a.timestamp);
}
