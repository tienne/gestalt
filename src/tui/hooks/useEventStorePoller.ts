import { useState, useEffect, useRef, useCallback } from 'react';
import type { DomainEvent } from '../../core/types.js';
import { EventStoreReader, type SessionSummary, type EventStats } from './event-store-reader.js';

export interface PollerState {
  events: DomainEvent[];
  sessions: SessionSummary[];
  stats: EventStats;
  isConnected: boolean;
  lastEventId: string | null;
  error: string | null;
}

const EMPTY_STATS: EventStats = {
  totalEvents: 0,
  byType: {},
  byAggregate: {},
  oldestEvent: null,
  newestEvent: null,
};

export function useEventStorePoller(dbPath: string, pollInterval = 1000): PollerState {
  const [state, setState] = useState<PollerState>({
    events: [],
    sessions: [],
    stats: EMPTY_STATS,
    isConnected: false,
    lastEventId: null,
    error: null,
  });

  const readerRef = useRef<EventStoreReader | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastEventIdRef = useRef<string | null>(null);

  const poll = useCallback(() => {
    const reader = readerRef.current;
    if (!reader) return;

    try {
      const newEvents = reader.getEventsSince(lastEventIdRef.current);
      const sessions = reader.getSessions();
      const stats = reader.getStats();

      if (newEvents.length > 0) {
        const lastEvent = newEvents[newEvents.length - 1];
        if (lastEvent) {
          lastEventIdRef.current = lastEvent.id;
        }
      }

      setState((prev) => {
        const allEvents = newEvents.length > 0 ? [...prev.events, ...newEvents] : prev.events;

        return {
          events: allEvents,
          sessions,
          stats,
          isConnected: true,
          lastEventId: lastEventIdRef.current,
          error: null,
        };
      });
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isConnected: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, []);

  useEffect(() => {
    try {
      readerRef.current = new EventStoreReader(dbPath);
      setState((prev) => ({ ...prev, isConnected: true, error: null }));
      poll();
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isConnected: false,
        error: err instanceof Error ? err.message : String(err),
      }));
      return;
    }

    timerRef.current = setInterval(poll, pollInterval);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      if (readerRef.current) {
        readerRef.current.close();
        readerRef.current = null;
      }
    };
  }, [dbPath, pollInterval, poll]);

  return state;
}
