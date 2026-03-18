import Database from 'better-sqlite3';
import type { DomainEvent } from '../../core/types.js';

interface EventRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: string;
  timestamp: string;
  created_at: string;
}

function rowToEvent(row: EventRow): DomainEvent {
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

export interface SessionSummary {
  sessionId: string;
  type: string;
  status: string;
  topic: string;
  createdAt: string;
  eventCount: number;
}

export interface EventStats {
  totalEvents: number;
  byType: Record<string, number>;
  byAggregate: Record<string, number>;
  oldestEvent: string | null;
  newestEvent: string | null;
}

export class EventStoreReader {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { readonly: true });
    this.db.pragma('journal_mode = WAL');
  }

  getEventsSince(lastEventId: string | null, limit = 500): DomainEvent[] {
    if (!lastEventId) {
      const rows = this.db
        .prepare('SELECT * FROM events ORDER BY created_at ASC LIMIT ?')
        .all(limit) as EventRow[];
      return rows.map(rowToEvent);
    }

    const anchor = this.db
      .prepare('SELECT created_at, id FROM events WHERE id = ?')
      .get(lastEventId) as { created_at: string; id: string } | undefined;

    if (!anchor) {
      const rows = this.db
        .prepare('SELECT * FROM events ORDER BY created_at ASC LIMIT ?')
        .all(limit) as EventRow[];
      return rows.map(rowToEvent);
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE (created_at > ?) OR (created_at = ? AND id > ?)
         ORDER BY created_at ASC LIMIT ?`
      )
      .all(anchor.created_at, anchor.created_at, anchor.id, limit) as EventRow[];
    return rows.map(rowToEvent);
  }

  getSessions(): SessionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT
          aggregate_id,
          aggregate_type,
          MIN(timestamp) as first_event,
          COUNT(*) as event_count
        FROM events
        WHERE aggregate_id != 'system'
        GROUP BY aggregate_type, aggregate_id
        ORDER BY first_event DESC`
      )
      .all() as Array<{
      aggregate_id: string;
      aggregate_type: string;
      first_event: string;
      event_count: number;
    }>;

    return rows.map((row) => {
      const startEvent = this.db
        .prepare(
          `SELECT payload FROM events
           WHERE aggregate_id = ? AND event_type LIKE '%_STARTED%'
           ORDER BY timestamp ASC LIMIT 1`
        )
        .get(row.aggregate_id) as { payload: string } | undefined;

      const lastEvent = this.db
        .prepare(
          `SELECT event_type FROM events
           WHERE aggregate_id = ?
           ORDER BY timestamp DESC LIMIT 1`
        )
        .get(row.aggregate_id) as { event_type: string } | undefined;

      let topic = '';
      if (startEvent) {
        try {
          const parsed = JSON.parse(startEvent.payload);
          topic = parsed.topic ?? parsed.goal ?? '';
        } catch {
          // ignore
        }
      }

      const status = this.inferStatus(lastEvent?.event_type ?? '');

      return {
        sessionId: row.aggregate_id,
        type: row.aggregate_type,
        status,
        topic,
        createdAt: row.first_event,
        eventCount: row.event_count,
      };
    });
  }

  getSessionEvents(sessionId: string): DomainEvent[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM events WHERE aggregate_id = ? ORDER BY created_at ASC'
      )
      .all(sessionId) as EventRow[];
    return rows.map(rowToEvent);
  }

  getStats(): EventStats {
    const total = this.db
      .prepare('SELECT COUNT(*) as count FROM events')
      .get() as { count: number };

    const byTypeRows = this.db
      .prepare(
        'SELECT event_type, COUNT(*) as count FROM events GROUP BY event_type'
      )
      .all() as Array<{ event_type: string; count: number }>;

    const byAggRows = this.db
      .prepare(
        'SELECT aggregate_type, COUNT(*) as count FROM events GROUP BY aggregate_type'
      )
      .all() as Array<{ aggregate_type: string; count: number }>;

    const oldest = this.db
      .prepare('SELECT timestamp FROM events ORDER BY timestamp ASC LIMIT 1')
      .get() as { timestamp: string } | undefined;

    const newest = this.db
      .prepare('SELECT timestamp FROM events ORDER BY timestamp DESC LIMIT 1')
      .get() as { timestamp: string } | undefined;

    const byType: Record<string, number> = {};
    for (const row of byTypeRows) {
      byType[row.event_type] = row.count;
    }

    const byAggregate: Record<string, number> = {};
    for (const row of byAggRows) {
      byAggregate[row.aggregate_type] = row.count;
    }

    return {
      totalEvents: total.count,
      byType,
      byAggregate,
      oldestEvent: oldest?.timestamp ?? null,
      newestEvent: newest?.timestamp ?? null,
    };
  }

  getLatestEvents(limit = 50): DomainEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events ORDER BY created_at DESC LIMIT ?')
      .all(limit) as EventRow[];
    return rows.map(rowToEvent);
  }

  close(): void {
    this.db.close();
  }

  private inferStatus(lastEventType: string): string {
    if (lastEventType.includes('COMPLETED')) return 'completed';
    if (lastEventType.includes('FAILED')) return 'failed';
    if (lastEventType.includes('ESCALATION')) return 'escalated';
    return 'in_progress';
  }
}
