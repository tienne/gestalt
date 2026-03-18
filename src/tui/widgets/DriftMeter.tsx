import React from 'react';
import { Box, Text } from 'ink';

export interface DriftDimension {
  name: string;
  score: number;
  weight: number;
}

interface DriftMeterProps {
  dimensions: DriftDimension[];
  overall: number;
  threshold: number;
  barWidth?: number;
}

const DIMENSION_COLORS: Record<string, string> = {
  goal: 'blue',
  constraint: 'magenta',
  ontology: 'yellow',
};

export function DriftMeter({
  dimensions,
  overall,
  threshold,
  barWidth = 20,
}: DriftMeterProps): React.ReactElement {
  const overThreshold = overall > threshold;

  return (
    <Box flexDirection="column">
      <Box gap={1} marginBottom={1}>
        <Text bold>Drift</Text>
        <Text color={overThreshold ? 'red' : 'green'} bold>
          {(overall * 100).toFixed(0)}%
        </Text>
        <Text dimColor>threshold: {(threshold * 100).toFixed(0)}%</Text>
      </Box>

      {dimensions.map((dim) => {
        const dimOver = dim.score > threshold;
        const color = DIMENSION_COLORS[dim.name] ?? 'white';
        return (
          <Box key={dim.name} gap={1}>
            <Box width={12}>
              <Text color={color}>{padRight(dim.name, 11)}</Text>
            </Box>
            <Text>
              {renderBar(dim.score, barWidth, dimOver)}
            </Text>
            <Text color={dimOver ? 'red' : 'green'}>
              {(dim.score * 100).toFixed(0)}%
            </Text>
            <Text dimColor>({(dim.weight * 100).toFixed(0)}%w)</Text>
          </Box>
        );
      })}

      {overThreshold && (
        <Box marginTop={1}>
          <Text color="red" bold>
            WARNING: Drift exceeds threshold!
          </Text>
        </Box>
      )}
    </Box>
  );
}

function renderBar(score: number, width: number, over: boolean): string {
  const filled = Math.round(score * width);
  const empty = width - filled;
  const fillChar = over ? '#' : '=';
  return '[' + fillChar.repeat(filled) + ' '.repeat(empty) + ']';
}

function padRight(str: string, len: number): string {
  if (str.length >= len) return str;
  return str + ' '.repeat(len - str.length);
}
