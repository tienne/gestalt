import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ScreenProps } from '../components/TUIApp.js';
import type { DomainEvent } from '../../core/types.js';

const EVENT_TYPE_COLORS: Record<string, string> = {
  interview: 'cyan',
  spec: 'magenta',
  execute: 'green',
  evaluate: 'yellow',
  evolve: 'red',
  gestalt: 'blue',
  brownfield: 'gray',
};

function getEventColor(eventType: string): string {
  const prefix = eventType.split('.')[0] ?? '';
  return EVENT_TYPE_COLORS[prefix] ?? 'white';
}

interface LogFilter {
  label: string;
  prefix: string;
}

const FILTERS: LogFilter[] = [
  { label: 'ALL', prefix: '' },
  { label: 'INT', prefix: 'interview' },
  { label: 'SPC', prefix: 'spec' },
  { label: 'EXE', prefix: 'execute' },
  { label: 'EVL', prefix: 'evaluate' },
  { label: 'EVO', prefix: 'evolve' },
];

export function LogScreen({
  events,
}: ScreenProps): React.ReactElement {
  const [maxLines, _setMaxLines] = useState(50);
  const [filterIndex, setFilterIndex] = useState(0);

  useInput((input, _key) => {
    if (input === '\t' || input === 'f') {
      setFilterIndex((prev) => (prev + 1) % FILTERS.length);
    }
  });

  const currentFilter = FILTERS[filterIndex] ?? FILTERS[0]!;

  const filteredEvents = useMemo(() => {
    let result: DomainEvent[];
    if (currentFilter.prefix) {
      result = events.filter((e) => e.eventType.startsWith(currentFilter.prefix));
    } else {
      result = events;
    }
    // Show newest at bottom, take last N
    return result.slice(-maxLines);
  }, [events, maxLines, currentFilter.prefix]);

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box marginBottom={1} gap={1}>
        <Text bold>Event Log</Text>
        <Text dimColor>|</Text>
        <Text dimColor>{filteredEvents.length} events</Text>
        <Text dimColor>| F/Tab: filter</Text>
        <Text dimColor>|</Text>
        {FILTERS.map((f, i) => (
          <Text key={f.label} color={i === filterIndex ? 'cyan' : 'gray'} bold={i === filterIndex}>
            {f.label}
          </Text>
        ))}
      </Box>

      {/* Event list */}
      {filteredEvents.length === 0 ? (
        <Box flexDirection="column" alignItems="center" justifyContent="center" minHeight={5}>
          <Text dimColor>No events matching filter "{currentFilter.label}"</Text>
        </Box>
      ) : (
        filteredEvents.map((ev) => (
          <Box key={ev.id} gap={1}>
            <Box width={12}>
              <Text dimColor>{formatTime(ev.timestamp)}</Text>
            </Box>
            <Box width={35}>
              <Text color={getEventColor(ev.eventType)}>
                {truncate(ev.eventType, 33)}
              </Text>
            </Box>
            <Box width={20}>
              <Text dimColor>{truncate(ev.aggregateId, 18)}</Text>
            </Box>
            <Box>
              <Text dimColor>{extractSummary(ev)}</Text>
            </Box>
          </Box>
        ))
      )}
    </Box>
  );
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return ts.slice(11, 19);
  }
}

function extractSummary(ev: DomainEvent): string {
  const payload = ev.payload as Record<string, unknown>;

  // Try to extract a short summary from common payload fields
  if (payload.topic) return truncate(String(payload.topic), 30);
  if (payload.taskId) return `task:${String(payload.taskId)}`;
  if (payload.principle) return `${String(payload.principle)}`;
  if (payload.reason) return `reason:${String(payload.reason)}`;
  if (payload.overall !== undefined) return `score:${String(payload.overall)}`;
  if (payload.status) return `${String(payload.status)}`;

  return '';
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}
