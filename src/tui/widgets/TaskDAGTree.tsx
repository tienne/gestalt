import React from 'react';
import { Box, Text } from 'ink';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

export interface TaskNode {
  id: string;
  title: string;
  status: TaskStatus;
  dependsOn: string[];
}

const STATUS_ICONS: Record<TaskStatus, string> = {
  pending: 'o',
  in_progress: '>',
  completed: 'v',
  failed: 'x',
  skipped: '-',
};

const STATUS_COLORS: Record<TaskStatus, string> = {
  pending: 'gray',
  in_progress: 'cyan',
  completed: 'green',
  failed: 'red',
  skipped: 'yellow',
};

interface TaskDAGTreeProps {
  tasks: TaskNode[];
  maxHeight?: number;
}

export function TaskDAGTree({ tasks, maxHeight }: TaskDAGTreeProps): React.ReactElement {
  const completedCount = tasks.filter((t) => t.status === 'completed').length;
  const failedCount = tasks.filter((t) => t.status === 'failed').length;
  const totalCount = tasks.length;

  const layers = buildLayers(tasks);

  return (
    <Box flexDirection="column">
      <Box gap={1} marginBottom={1}>
        <Text bold>Task DAG</Text>
        <Text color="green">{completedCount}v</Text>
        {failedCount > 0 && <Text color="red">{failedCount}x</Text>}
        <Text dimColor>
          {completedCount}/{totalCount}
        </Text>
      </Box>
      <Box flexDirection="column" height={maxHeight}>
        {layers.map((layer, layerIdx) => (
          <Box key={layerIdx} flexDirection="column">
            {layerIdx > 0 && (
              <Text dimColor>  |</Text>
            )}
            {layer.map((task) => (
              <Box key={task.id} paddingLeft={1}>
                <Text color={STATUS_COLORS[task.status]}>
                  {STATUS_ICONS[task.status]}
                </Text>
                <Text color={STATUS_COLORS[task.status]} bold={task.status === 'in_progress'}>
                  {' '}
                  {task.id}
                </Text>
                <Text dimColor> {truncate(task.title, 40)}</Text>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function buildLayers(tasks: TaskNode[]): TaskNode[][] {
  if (tasks.length === 0) return [];

  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const layers: TaskNode[][] = [];
  const placed = new Set<string>();

  // Kahn's algorithm for layer assignment
  while (placed.size < tasks.length) {
    const layer: TaskNode[] = [];
    for (const task of tasks) {
      if (placed.has(task.id)) continue;
      const depsPlaced = task.dependsOn.every(
        (dep) => placed.has(dep) || !taskMap.has(dep)
      );
      if (depsPlaced) {
        layer.push(task);
      }
    }
    if (layer.length === 0) break; // cycle guard
    for (const t of layer) placed.add(t.id);
    layers.push(layer);
  }

  return layers;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}
