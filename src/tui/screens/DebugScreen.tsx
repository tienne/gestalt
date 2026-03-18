import React from 'react';
import { Box, Text } from 'ink';
import type { ScreenProps } from '../components/TUIApp.js';

export function DebugScreen({
  events,
  stats,
  isConnected,
}: ScreenProps): React.ReactElement {
  const latestEvent = events.length > 0 ? events[events.length - 1] : null;

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold>Debug Info</Text>
      </Box>

      {/* Connection Status */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="cyan">Connection</Text>
        <Box paddingLeft={2} gap={1}>
          <Text>Status:</Text>
          <Text color={isConnected ? 'green' : 'red'} bold>
            {isConnected ? 'Connected' : 'Disconnected'}
          </Text>
        </Box>
      </Box>

      {/* Event Stats */}
      <Box flexDirection="column" marginBottom={1}>
        <Box gap={1}>
          <Text bold color="cyan">Event Stats</Text>
          <Text dimColor>(total: {stats.totalEvents})</Text>
        </Box>

        {stats.oldestEvent && (
          <Box paddingLeft={2} gap={1}>
            <Text dimColor>oldest:</Text>
            <Text>{formatTimestamp(stats.oldestEvent)}</Text>
          </Box>
        )}
        {stats.newestEvent && (
          <Box paddingLeft={2} gap={1}>
            <Text dimColor>newest:</Text>
            <Text>{formatTimestamp(stats.newestEvent)}</Text>
          </Box>
        )}
      </Box>

      {/* By Type Breakdown */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="yellow">By Event Type</Text>
        {Object.keys(stats.byType).length === 0 ? (
          <Box paddingLeft={2}>
            <Text dimColor>(no events)</Text>
          </Box>
        ) : (
          Object.entries(stats.byType)
            .sort(([, a], [, b]) => b - a)
            .map(([type, count]) => (
              <Box key={type} paddingLeft={2} gap={1}>
                <Box width={40}>
                  <Text>{type}</Text>
                </Box>
                <Text color="yellow">{count}</Text>
                <Text dimColor>{renderMiniBar(count, stats.totalEvents, 15)}</Text>
              </Box>
            ))
        )}
      </Box>

      {/* By Aggregate Breakdown */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="magenta">By Aggregate Type</Text>
        {Object.keys(stats.byAggregate).length === 0 ? (
          <Box paddingLeft={2}>
            <Text dimColor>(no events)</Text>
          </Box>
        ) : (
          Object.entries(stats.byAggregate)
            .sort(([, a], [, b]) => b - a)
            .map(([agg, count]) => (
              <Box key={agg} paddingLeft={2} gap={1}>
                <Box width={20}>
                  <Text>{agg}</Text>
                </Box>
                <Text color="magenta">{count}</Text>
                <Text dimColor>{renderMiniBar(count, stats.totalEvents, 15)}</Text>
              </Box>
            ))
        )}
      </Box>

      {/* Latest Event Raw JSON */}
      <Box flexDirection="column">
        <Text bold color="green">Latest Event (raw)</Text>
        {latestEvent ? (
          <Box paddingLeft={2} flexDirection="column">
            <Box gap={1}>
              <Text dimColor>id:</Text>
              <Text>{latestEvent.id}</Text>
            </Box>
            <Box gap={1}>
              <Text dimColor>type:</Text>
              <Text>{latestEvent.eventType}</Text>
            </Box>
            <Box gap={1}>
              <Text dimColor>aggregate:</Text>
              <Text>
                {latestEvent.aggregateType}/{truncate(latestEvent.aggregateId, 24)}
              </Text>
            </Box>
            <Box gap={1}>
              <Text dimColor>time:</Text>
              <Text>{latestEvent.timestamp}</Text>
            </Box>
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>payload:</Text>
              <Box paddingLeft={2}>
                <Text color="green">
                  {truncate(JSON.stringify(latestEvent.payload, null, 2), 200)}
                </Text>
              </Box>
            </Box>
          </Box>
        ) : (
          <Box paddingLeft={2}>
            <Text dimColor>(no events)</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

function renderMiniBar(count: number, total: number, width: number): string {
  if (total === 0) return '[' + ' '.repeat(width) + ']';
  const ratio = count / total;
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return '[' + '='.repeat(filled) + ' '.repeat(empty) + ']';
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleString('en-US', {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return ts.slice(0, 19);
  }
}
