import React from 'react';
import { Box, Text } from 'ink';
import type { ScreenProps } from '../components/TUIApp.js';

export function HUDPanel({
  events,
  sessions,
  stats,
  isConnected,
}: ScreenProps): React.ReactElement {
  const activeSessions = sessions.filter((s) => s.status === 'in_progress').length;
  const latestEventType = events.length > 0 ? events[events.length - 1]?.eventType ?? '-' : '-';

  return (
    <Box borderStyle="single" borderColor="yellow" paddingX={1} gap={2}>
      <Box gap={1}>
        <Text color="yellow" bold>HUD</Text>
      </Box>
      <Box gap={1}>
        <Text dimColor>events:</Text>
        <Text color="white">{stats.totalEvents}</Text>
      </Box>
      <Box gap={1}>
        <Text dimColor>sessions:</Text>
        <Text color="white">{sessions.length}</Text>
        <Text dimColor>({activeSessions} active)</Text>
      </Box>
      <Box gap={1}>
        <Text dimColor>latest:</Text>
        <Text color="cyan">{truncate(latestEventType, 30)}</Text>
      </Box>
      <Box gap={1}>
        <Text color={isConnected ? 'green' : 'red'}>
          {isConnected ? 'OK' : 'ERR'}
        </Text>
      </Box>
    </Box>
  );
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}
