import React from 'react';
import { Box, Text } from 'ink';

export type PrinciplePhase = 'figure_ground' | 'closure' | 'proximity' | 'continuity';

type PhaseStatus = 'completed' | 'active' | 'pending';

interface PhaseInfo {
  key: PrinciplePhase;
  label: string;
}

const PHASES: PhaseInfo[] = [
  { key: 'figure_ground', label: 'Figure-Ground' },
  { key: 'closure', label: 'Closure' },
  { key: 'proximity', label: 'Proximity' },
  { key: 'continuity', label: 'Continuity' },
];

const STATUS_COLORS: Record<PhaseStatus, string> = {
  completed: 'green',
  active: 'cyan',
  pending: 'gray',
};

const STATUS_ICONS: Record<PhaseStatus, string> = {
  completed: '[x]',
  active: '[>]',
  pending: '[ ]',
};

interface GestaltPrincipleBarProps {
  currentPhase: PrinciplePhase | null;
  completedPhases: PrinciplePhase[];
}

export function GestaltPrincipleBar({
  currentPhase,
  completedPhases,
}: GestaltPrincipleBarProps): React.ReactElement {
  function getStatus(phase: PrinciplePhase): PhaseStatus {
    if (completedPhases.includes(phase)) return 'completed';
    if (phase === currentPhase) return 'active';
    return 'pending';
  }

  const completedCount = completedPhases.length;
  const totalCount = PHASES.length;

  return (
    <Box flexDirection="column">
      <Box gap={1} marginBottom={1}>
        <Text bold>Gestalt Phases</Text>
        <Text dimColor>
          ({completedCount}/{totalCount})
        </Text>
      </Box>
      <Box gap={1}>
        {PHASES.map((phase, index) => {
          const status = getStatus(phase.key);
          return (
            <React.Fragment key={phase.key}>
              <Box>
                <Text color={STATUS_COLORS[status]} bold={status === 'active'}>
                  {STATUS_ICONS[status]} {phase.label}
                </Text>
              </Box>
              {index < PHASES.length - 1 && (
                <Text color={completedPhases.includes(phase.key) ? 'green' : 'gray'}>
                  {' -> '}
                </Text>
              )}
            </React.Fragment>
          );
        })}
      </Box>
    </Box>
  );
}
