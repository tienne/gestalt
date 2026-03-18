import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ScreenProps } from '../components/TUIApp.js';

const STATUS_ICONS: Record<string, string> = {
  completed: 'v',
  in_progress: '>',
  failed: 'x',
  escalated: '!',
};

const STATUS_COLORS: Record<string, string> = {
  completed: 'green',
  in_progress: 'cyan',
  failed: 'red',
  escalated: 'yellow',
};

const TYPE_LABELS: Record<string, string> = {
  interview: 'INT',
  execute: 'EXE',
  spec: 'SPC',
};

export function SessionListScreen({
  sessions,
  selectedSessionId,
  onSelectSession,
}: ScreenProps): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    }
    if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(sessions.length - 1, prev + 1));
    }
    if (key.return) {
      const session = sessions[selectedIndex];
      if (session) {
        onSelectSession(session.sessionId);
      }
    }
  });

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" minHeight={10}>
        <Text bold color="yellow">No sessions found</Text>
        <Text dimColor>Start an interview or execute session to see them here.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1} gap={1}>
        <Text bold>Sessions</Text>
        <Text dimColor>({sessions.length} total)</Text>
        <Text dimColor>| Up/Down: navigate | Enter: select</Text>
      </Box>

      {/* Header row */}
      <Box paddingLeft={2}>
        <Box width={5}>
          <Text bold dimColor>ST</Text>
        </Box>
        <Box width={6}>
          <Text bold dimColor>TYPE</Text>
        </Box>
        <Box width={40}>
          <Text bold dimColor>TOPIC</Text>
        </Box>
        <Box width={8}>
          <Text bold dimColor>EVENTS</Text>
        </Box>
        <Box width={22}>
          <Text bold dimColor>CREATED</Text>
        </Box>
      </Box>

      {sessions.map((session, index) => {
        const isSelected = index === selectedIndex;
        const isActive = session.sessionId === selectedSessionId;
        const status = session.status;
        const icon = STATUS_ICONS[status] ?? '?';
        const color = STATUS_COLORS[status] ?? 'white';
        const typeLabel = TYPE_LABELS[session.type] ?? session.type.slice(0, 3).toUpperCase();

        return (
          <Box key={session.sessionId} paddingLeft={isSelected ? 0 : 2}>
            {isSelected && <Text color="cyan">{'\u25B6 '}</Text>}
            <Box width={5}>
              <Text color={color}>{icon}</Text>
            </Box>
            <Box width={6}>
              <Text color={isActive ? 'cyan' : 'white'} bold={isActive}>
                {typeLabel}
              </Text>
            </Box>
            <Box width={40}>
              <Text
                color={isSelected ? 'cyan' : isActive ? 'white' : 'gray'}
                bold={isSelected}
              >
                {truncate(session.topic || '(no topic)', 38)}
              </Text>
            </Box>
            <Box width={8}>
              <Text dimColor>{session.eventCount}</Text>
            </Box>
            <Box width={22}>
              <Text dimColor>{formatTimestamp(session.createdAt)}</Text>
            </Box>
          </Box>
        );
      })}

      {selectedSessionId && (
        <Box marginTop={1}>
          <Text dimColor>Active: </Text>
          <Text color="cyan">{truncate(selectedSessionId, 36)}</Text>
        </Box>
      )}
    </Box>
  );
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
