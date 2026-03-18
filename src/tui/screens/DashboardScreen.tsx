import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { ScreenProps } from '../components/TUIApp.js';
import { GestaltPrincipleBar } from '../widgets/GestaltPrincipleBar.js';
import type { PrinciplePhase } from '../widgets/GestaltPrincipleBar.js';
import { TaskDAGTree } from '../widgets/TaskDAGTree.js';
import type { TaskNode } from '../widgets/TaskDAGTree.js';
import { DriftMeter } from '../widgets/DriftMeter.js';
import type { DriftDimension as WidgetDriftDimension } from '../widgets/DriftMeter.js';
import type { DomainEvent } from '../../core/types.js';

const PLANNING_PRINCIPLES: PrinciplePhase[] = [
  'figure_ground',
  'closure',
  'proximity',
  'continuity',
];

interface ParsedDashboard {
  currentPhase: PrinciplePhase | null;
  completedPhases: PrinciplePhase[];
  tasks: TaskNode[];
  driftDimensions: WidgetDriftDimension[];
  driftOverall: number;
  driftThreshold: number;
  activeTasks: Array<{ taskId: string; title: string; status: string }>;
  sessionType: string;
}

function parseDashboardEvents(
  events: DomainEvent[],
  sessionId: string | null
): ParsedDashboard {
  const sessionEvents = sessionId
    ? events.filter((e) => e.aggregateId === sessionId)
    : [];

  const completedPhases: PrinciplePhase[] = [];
  let currentPhase: PrinciplePhase | null = null;
  const tasks: TaskNode[] = [];
  const taskStatusMap = new Map<string, string>();
  let driftOverall = 0;
  const driftDimensions: WidgetDriftDimension[] = [];
  let sessionType = '';

  for (const ev of sessionEvents) {
    const payload = ev.payload as Record<string, unknown>;

    if (ev.eventType.includes('session.started')) {
      sessionType = ev.aggregateType;
    }

    // Planning phase tracking
    if (ev.eventType === 'execute.planning.step.completed') {
      const principle = payload.principle as string | undefined;
      if (principle) {
        const phase = principle as PrinciplePhase;
        if (!completedPhases.includes(phase)) {
          completedPhases.push(phase);
        }
      }
    }

    // Determine current planning phase
    if (ev.eventType === 'execute.session.started') {
      currentPhase = 'figure_ground';
    }

    // Task extraction from plan completion
    if (ev.eventType === 'execute.plan.completed') {
      const atomicTasks = payload.atomicTasks as
        | Array<{ taskId: string; title: string; dependsOn: string[] }>
        | undefined;
      if (atomicTasks) {
        for (const t of atomicTasks) {
          tasks.push({
            id: t.taskId,
            title: t.title,
            status: 'pending',
            dependsOn: t.dependsOn ?? [],
          });
        }
      }
    }

    // Task status updates
    if (
      ev.eventType === 'execute.task.completed' ||
      ev.eventType === 'evolve.task.completed'
    ) {
      const taskId = payload.taskId as string | undefined;
      const status = payload.status as string | undefined;
      if (taskId && status) {
        taskStatusMap.set(taskId, status);
      }
    }

    // Drift measurements
    if (ev.eventType === 'execute.drift.measured') {
      const overall = payload.overall as number | undefined;
      const dimensions = payload.dimensions as
        | Array<{ name: string; score: number; weight?: number }>
        | undefined;
      if (overall !== undefined) {
        driftOverall = overall;
      }
      if (dimensions) {
        driftDimensions.length = 0;
        for (const dim of dimensions) {
          driftDimensions.push({
            name: dim.name,
            score: dim.score,
            weight: dim.weight ?? 0.33,
          });
        }
      }
    }
  }

  // Apply task status updates
  for (const task of tasks) {
    const status = taskStatusMap.get(task.id);
    if (status === 'completed') task.status = 'completed';
    else if (status === 'failed') task.status = 'failed';
    else if (status === 'in_progress') task.status = 'in_progress';
    else if (status === 'skipped') task.status = 'skipped';
  }

  // Determine current phase based on completed phases
  if (completedPhases.length > 0 && completedPhases.length < PLANNING_PRINCIPLES.length) {
    currentPhase = PLANNING_PRINCIPLES[completedPhases.length] ?? null;
  } else if (completedPhases.length >= PLANNING_PRINCIPLES.length) {
    currentPhase = null;
  }

  // Build active tasks list
  const activeTasks = tasks
    .filter((t) => t.status === 'in_progress' || t.status === 'pending')
    .slice(0, 10)
    .map((t) => ({ taskId: t.id, title: t.title, status: t.status }));

  return {
    currentPhase,
    completedPhases,
    tasks,
    driftDimensions,
    driftOverall,
    driftThreshold: 0.3,
    activeTasks,
    sessionType,
  };
}

export function DashboardScreen({
  events,
  selectedSessionId,
}: ScreenProps): React.ReactElement {
  const data = useMemo(
    () => parseDashboardEvents(events, selectedSessionId),
    [events, selectedSessionId]
  );

  if (!selectedSessionId) {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" minHeight={10}>
        <Text bold color="yellow">No session selected</Text>
        <Text dimColor>Press 1 to go to Sessions and select one.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {/* Session header */}
      <Box marginBottom={1} gap={1}>
        <Text bold>Dashboard</Text>
        <Text dimColor>|</Text>
        <Text color="cyan">{truncate(selectedSessionId, 24)}</Text>
        {data.sessionType && (
          <Text dimColor>({data.sessionType})</Text>
        )}
      </Box>

      {/* Top: Gestalt Principle Bar */}
      <Box marginBottom={1}>
        <GestaltPrincipleBar
          currentPhase={data.currentPhase}
          completedPhases={data.completedPhases}
        />
      </Box>

      {/* Middle: TaskDAGTree + DriftMeter side by side */}
      <Box gap={2} marginBottom={1}>
        <Box flexDirection="column" flexGrow={1} flexBasis={0}>
          {data.tasks.length > 0 ? (
            <TaskDAGTree tasks={data.tasks} maxHeight={15} />
          ) : (
            <Box flexDirection="column">
              <Text bold>Task DAG</Text>
              <Text dimColor>No tasks yet (planning not complete)</Text>
            </Box>
          )}
        </Box>

        <Box flexDirection="column" flexGrow={1} flexBasis={0}>
          {data.driftDimensions.length > 0 ? (
            <DriftMeter
              dimensions={data.driftDimensions}
              overall={data.driftOverall}
              threshold={data.driftThreshold}
            />
          ) : (
            <Box flexDirection="column">
              <Text bold>Drift</Text>
              <Text dimColor>No drift data yet</Text>
            </Box>
          )}
        </Box>
      </Box>

      {/* Bottom: Active tasks list */}
      <Box flexDirection="column">
        <Box gap={1} marginBottom={1}>
          <Text bold>Active Tasks</Text>
          <Text dimColor>({data.activeTasks.length})</Text>
        </Box>
        {data.activeTasks.length === 0 ? (
          <Text dimColor>  No active tasks</Text>
        ) : (
          data.activeTasks.map((task) => (
            <Box key={task.taskId} paddingLeft={1} gap={1}>
              <Text color={task.status === 'in_progress' ? 'cyan' : 'gray'}>
                {task.status === 'in_progress' ? '>' : 'o'}
              </Text>
              <Text color={task.status === 'in_progress' ? 'cyan' : 'gray'} bold={task.status === 'in_progress'}>
                {task.taskId}
              </Text>
              <Text dimColor>{truncate(task.title, 50)}</Text>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}
