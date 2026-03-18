import React, { useState, useMemo } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import type { DomainEvent } from '../../core/types.js';
import { useEventStorePoller } from '../hooks/useEventStorePoller.js';
import type { SessionSummary, EventStats } from '../hooks/event-store-reader.js';
import { SessionListScreen } from '../screens/SessionListScreen.js';
import { DashboardScreen } from '../screens/DashboardScreen.js';
import { InterviewScreen } from '../screens/InterviewScreen.js';
import { SpecViewerScreen } from '../screens/SpecViewerScreen.js';
import { EvolutionScreen } from '../screens/EvolutionScreen.js';
import { LogScreen } from '../screens/LogScreen.js';
import { DebugScreen } from '../screens/DebugScreen.js';
import { HUDPanel } from '../screens/HUDPanel.js';

export type ScreenName =
  | 'sessions'
  | 'dashboard'
  | 'interview'
  | 'spec'
  | 'evolution'
  | 'log'
  | 'debug';

export interface ScreenProps {
  events: DomainEvent[];
  sessions: SessionSummary[];
  stats: EventStats;
  isConnected: boolean;
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
}

const SCREEN_KEYS: Record<string, ScreenName> = {
  '1': 'sessions',
  '2': 'dashboard',
  '3': 'interview',
  '4': 'spec',
  '5': 'evolution',
  l: 'log',
  d: 'debug',
};

const SCREEN_LABELS: Record<ScreenName, string> = {
  sessions: '1:Sessions',
  dashboard: '2:Dashboard',
  interview: '3:Interview',
  spec: '4:Spec',
  evolution: '5:Evolution',
  log: 'L:Log',
  debug: 'D:Debug',
};

const SCREEN_COMPONENTS: Record<ScreenName, React.ComponentType<ScreenProps>> = {
  sessions: SessionListScreen,
  dashboard: DashboardScreen,
  interview: InterviewScreen,
  spec: SpecViewerScreen,
  evolution: EvolutionScreen,
  log: LogScreen,
  debug: DebugScreen,
};

interface TUIAppProps {
  dbPath: string;
  initialSessionId?: string;
  pollInterval?: number;
}

export function TUIApp({ dbPath, initialSessionId, pollInterval }: TUIAppProps): React.ReactElement {
  const { exit } = useApp();
  const [activeScreen, setActiveScreen] = useState<ScreenName>(
    initialSessionId ? 'dashboard' : 'sessions'
  );
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    initialSessionId ?? null
  );
  const [hudVisible, setHudVisible] = useState(false);

  const poller = useEventStorePoller(dbPath, pollInterval);

  useInput((input, key) => {
    if (input === 'q') {
      exit();
      return;
    }

    if (input === 'h') {
      setHudVisible((prev) => !prev);
      return;
    }

    const screen = SCREEN_KEYS[input];
    if (screen) {
      setActiveScreen(screen);
    }

    if (key.escape) {
      setActiveScreen('sessions');
    }
  });

  const screenProps: ScreenProps = useMemo(
    () => ({
      events: poller.events,
      sessions: poller.sessions,
      stats: poller.stats,
      isConnected: poller.isConnected,
      selectedSessionId,
      onSelectSession: (id: string) => {
        setSelectedSessionId(id);
        setActiveScreen('dashboard');
      },
    }),
    [poller.events, poller.sessions, poller.stats, poller.isConnected, selectedSessionId]
  );

  const ScreenComponent = SCREEN_COMPONENTS[activeScreen];

  return (
    <Box flexDirection="column" width="100%">
      <StatusBar
        activeScreen={activeScreen}
        isConnected={poller.isConnected}
        hudVisible={hudVisible}
        error={poller.error}
      />

      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <ScreenComponent {...screenProps} />
      </Box>

      {hudVisible && <HUDPanel {...screenProps} />}

      <NavBar activeScreen={activeScreen} />
    </Box>
  );
}

function StatusBar({
  activeScreen,
  isConnected,
  hudVisible,
  error,
}: {
  activeScreen: ScreenName;
  isConnected: boolean;
  hudVisible: boolean;
  error: string | null;
}): React.ReactElement {
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text bold color="cyan">
        Gestalt Monitor
      </Text>
      <Box gap={2}>
        <Text color={isConnected ? 'green' : 'red'}>
          {isConnected ? 'Connected' : 'Disconnected'}
        </Text>
        {hudVisible && <Text color="yellow">[HUD]</Text>}
        {error && <Text color="red">{error}</Text>}
        <Text dimColor>{activeScreen}</Text>
      </Box>
    </Box>
  );
}

function NavBar({ activeScreen }: { activeScreen: ScreenName }): React.ReactElement {
  const screens = Object.entries(SCREEN_LABELS) as [ScreenName, string][];
  return (
    <Box paddingX={1} gap={1} borderStyle="single" borderColor="gray">
      {screens.map(([name, label]) => (
        <Text key={name} color={name === activeScreen ? 'cyan' : 'gray'} bold={name === activeScreen}>
          {label}
        </Text>
      ))}
      <Text color="gray">H:HUD</Text>
      <Text color="gray">Q:Quit</Text>
    </Box>
  );
}
