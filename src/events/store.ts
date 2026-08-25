import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DomainEvent } from '../core/types.js';
import { SQLITE_BUSY_TIMEOUT_MS } from '../core/constants.js';
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
  getAllByAggregateType(aggregateType: string): Map<string, DomainEvent[]>;
  close(): void;
}

export class EventStore implements IEventStore {
  private db: SqliteDatabase | null = null;
  private jsonlPath: string | null = null;
  /**
   * append가 쓰는 INSERT. 한 번만 컴파일한다.
   *
   * 호출마다 `prepare`하면 같은 SQL을 매번 다시 파싱하고 계획을 다시 세운다. 코멘트
   * 수백 개를 한 번에 옮기는 흐름(`commentMany`)이 이 자리를 그대로 밟는다.
   *
   * 트랜잭션으로 묶지는 않는다. `commentMany`는 중간에 던져도 그때까지 쓴 건 남아
   * 있어야 재시도가 이어 붙는다 — 한 트랜잭션이면 그게 통째로 사라진다.
   */
  private appendStmt: SqliteStatement | null = null;

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
        this.db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
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
        this.appendStmt ??= this.db.prepare(`
          INSERT INTO events (id, aggregate_type, aggregate_id, event_type, payload, timestamp)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        this.appendStmt.run(
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

    // rowid로 정렬한다. timestamp로 안 하는 건 그게 밀리초 ISO 문자열이라 같은 ms에
    // 여러 건이 들어가서다 — 코멘트를 연속으로 붙이는 흐름은 그 자리를 통상적으로
    // 밟는다. 그러면 timestamp만으로는 순서가 안 정해진다. tiebreaker로 rowid를
    // 얹으면 정렬 기준이 둘이 된다.
    //
    // rowid 하나로 충분하다. append는 INSERT 한 번이고 sqlite의 rowid는 그때마다
    // 단조 증가한다 — 이건 문서화된 성질이다. 삽입 순서가 곧 재생 순서다. 이 테이블은
    // 붙이기만 하고 지우는 자리가 없어서 최대 rowid가 재사용되는 갈래도 안 열린다.
    //
    // 겸사겸사 이 쿼리에서는 정렬이 사라진다. timestamp를 앞에 두면 이 절을 받쳐 줄
    // 인덱스가 없어 sqlite가 매번 임시 b-tree를 세웠다. rowid만 남기면
    // idx_events_aggregate로 좁힌 뒤 rowid 순서로 훑고 끝난다. 여기 얘기지
    // `getAllByAggregateType` 얘기가 아니다 — 거기는 사정이 다르고 그 자리에 적었다.
    //
    // 재생 순서는 이 도메인이 상태를 만드는 근거라 저장 엔진의 문서화되지 않은
    // 성질에 기대고 싶지 않았다. 그 취지가 rowid 쪽에 더 맞는다
    const stmt = this.db.prepare(`
      SELECT * FROM events
      WHERE aggregate_type = ? AND aggregate_id = ?
      ORDER BY rowid ASC
    `);
    const rows = stmt.all(aggregateType, aggregateId) as RawEventRow[];
    return rows.map(parseRow);
  }

  /**
   * 이 타입의 모든 이벤트를 aggregate별로 묶어 한 번에 돌려준다.
   *
   * aggregate마다 replay를 부르면 PR 수만큼 쿼리가 나간다. sqlite가 없어 JSONL로
   * 떨어진 런타임에서는 파일 전체를 PR 수만큼 다시 읽는다. 목록 화면과 CLI list가
   * 부르는 가장 뜨거운 자리라 그 비용이 그대로 보인다.
   *
   * 정렬은 rowid만 본다. 결과를 aggregate별로 다시 묶으므로 전역 시간 순서는 쓸
   * 데가 없다. 필요한 건 묶음 안의 상대 순서뿐이다. 순서를 rowid로 정하는 근거는
   * `getByAggregate`에 적었다.
   *
   * 다만 임시 b-tree는 여기서 안 없어진다. 플래너가 `aggregate_type = ?` 하나만 보고도
   * idx_events_aggregate를 고르는데, 그 인덱스 순서는 rowid 순서가 아니라 정렬이 또
   * 필요하다. 어느 플랜을 고를지는 통계를 탄다 — `ANALYZE`를 돌려 sqlite_stat1이
   * 있으면 `SCAN events`로 붙어 정렬이 사라진다. 없으면 인덱스를 골라 임시 b-tree가
   * 남는다. 이 스토어는 ANALYZE를 안 돌리므로 실물은 후자다.
   *
   * 그래도 빨라지는 건 정렬 키가 ISO 문자열 비교에서 정수 비교로 바뀌어서다. 이벤트
   * 2만 건에 aggregate 200개로 20회 평균 23.1 → 20.7 ms였다(sqlite 3.53.4, macOS).
   */
  getAllByAggregateType(aggregateType: string): Map<string, DomainEvent[]> {
    const grouped = new Map<string, DomainEvent[]>();

    const events = this.db
      ? (
          this.db
            .prepare(`SELECT * FROM events WHERE aggregate_type = ? ORDER BY rowid ASC`)
            .all(aggregateType) as RawEventRow[]
        ).map(parseRow)
      : this.readJsonlEvents().filter((e) => e.aggregateType === aggregateType);

    for (const event of events) {
      const list = grouped.get(event.aggregateId);
      if (list) list.push(event);
      else grouped.set(event.aggregateId, [event]);
    }

    return grouped;
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

  getEventCountsByType(): Record<string, number> {
    if (!this.db) {
      const counts: Record<string, number> = {};
      for (const event of this.readJsonlEvents()) {
        counts[event.eventType] = (counts[event.eventType] ?? 0) + 1;
      }
      return counts;
    }

    const stmt = this.db.prepare(`
      SELECT event_type, COUNT(*) as count FROM events GROUP BY event_type
    `);
    const rows = stmt.all() as { event_type: string; count: number }[];
    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.event_type] = row.count;
    }
    return counts;
  }

  close(): void {
    // 캐시한 statement는 닫힌 db를 붙잡고 있다. 먼저 놓아야 닫은 뒤에 잘못 쓰는 길이
    // 안 남는다
    this.appendStmt = null;
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
