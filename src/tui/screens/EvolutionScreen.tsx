import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { ScreenProps } from '../components/TUIApp.js';
import type { DomainEvent } from '../../core/types.js';

interface GenerationRecord {
  generation: number;
  overallScore: number;
  goalAlignment: number;
  patchFields: string[];
  timestamp: string;
}

interface LateralRecord {
  persona: string;
  pattern: string;
  status: 'started' | 'completed';
  timestamp: string;
}

interface EvolutionData {
  generations: GenerationRecord[];
  laterals: LateralRecord[];
  terminationReason: string | null;
  fixAttempts: number;
  isEscalated: boolean;
  currentStage: string;
}

function parseEvolutionEvents(
  events: DomainEvent[],
  sessionId: string | null
): EvolutionData {
  const sessionEvents = sessionId
    ? events.filter((e) => e.aggregateId === sessionId)
    : [];

  const generations: GenerationRecord[] = [];
  const laterals: LateralRecord[] = [];
  let terminationReason: string | null = null;
  let fixAttempts = 0;
  let isEscalated = false;
  let currentStage = 'none';

  for (const ev of sessionEvents) {
    const payload = ev.payload as Record<string, unknown>;

    // Evaluation results → score tracking per generation
    if (ev.eventType === 'evaluate.contextual.completed' || ev.eventType === 'execute.evaluation.completed') {
      const overallScore = (payload.overallScore as number) ?? 0;
      const goalAlignment = (payload.goalAlignment as number) ?? 0;
      generations.push({
        generation: generations.length + 1,
        overallScore,
        goalAlignment,
        patchFields: [],
        timestamp: ev.timestamp,
      });
    }

    // Spec patches
    if (ev.eventType === 'evolve.spec.patched') {
      const fieldsChanged = (payload.fieldsChanged as string[]) ?? [];
      const lastGen = generations[generations.length - 1];
      if (lastGen) {
        lastGen.patchFields = fieldsChanged;
      }
      currentStage = 'patch';
    }

    // Structural fixes
    if (ev.eventType === 'evolve.structural.fix.started') {
      fixAttempts++;
      currentStage = 'fix';
    }

    if (ev.eventType === 'evolve.structural.fix.completed') {
      currentStage = 'fix_done';
    }

    // Lateral thinking
    if (ev.eventType === 'evolve.lateral.started') {
      const persona = (payload.persona as string) ?? '';
      const pattern = (payload.pattern as string) ?? '';
      laterals.push({ persona, pattern, status: 'started', timestamp: ev.timestamp });
      currentStage = 'lateral';
    }

    if (ev.eventType === 'evolve.lateral.completed') {
      const persona = (payload.persona as string) ?? '';
      const matching = laterals.find((l) => l.persona === persona && l.status === 'started');
      if (matching) {
        matching.status = 'completed';
      }
      currentStage = 'lateral_done';
    }

    // Termination
    if (ev.eventType === 'evolve.terminated') {
      terminationReason = (payload.reason as string) ?? 'unknown';
    }

    // Human escalation
    if (ev.eventType === 'evolve.human.escalation') {
      isEscalated = true;
      terminationReason = 'human_escalation';
    }

    // Re-execution
    if (ev.eventType === 'evolve.re.execution.started') {
      currentStage = 're_executing';
    }
  }

  return {
    generations,
    laterals,
    terminationReason,
    fixAttempts,
    isEscalated,
    currentStage,
  };
}

const PERSONA_ICONS: Record<string, string> = {
  multistability: '~',
  simplicity: '-',
  reification: '+',
  invariance: '=',
};

const PERSONA_COLORS: Record<string, string> = {
  multistability: 'magenta',
  simplicity: 'green',
  reification: 'yellow',
  invariance: 'cyan',
};

export function EvolutionScreen({
  events,
  selectedSessionId,
}: ScreenProps): React.ReactElement {
  const data = useMemo(
    () => parseEvolutionEvents(events, selectedSessionId),
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

  if (data.generations.length === 0 && data.laterals.length === 0) {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" minHeight={10}>
        <Text bold color="yellow">No evolution data</Text>
        <Text dimColor>No evolution events found for this session.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box marginBottom={1} gap={1}>
        <Text bold>Evolution</Text>
        <Text dimColor>|</Text>
        <Text color="cyan">{truncate(selectedSessionId, 24)}</Text>
        <Text dimColor>|</Text>
        <Text dimColor>gens: {data.generations.length}</Text>
        <Text dimColor>fixes: {data.fixAttempts}</Text>
        <Text dimColor>stage: {data.currentStage}</Text>
        {data.terminationReason && (
          <Text color={data.terminationReason === 'success' ? 'green' : 'red'}>
            [{data.terminationReason}]
          </Text>
        )}
      </Box>

      {/* Score Progression Sparkline */}
      {data.generations.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Score Progression</Text>
          <Box paddingLeft={2} flexDirection="column">
            <Box gap={1}>
              <Box width={12}>
                <Text dimColor>overall:</Text>
              </Box>
              <Text>
                {renderSparkline(data.generations.map((g) => g.overallScore))}
              </Text>
            </Box>
            <Box gap={1}>
              <Box width={12}>
                <Text dimColor>goalAlign:</Text>
              </Box>
              <Text>
                {renderSparkline(data.generations.map((g) => g.goalAlignment))}
              </Text>
            </Box>
          </Box>
        </Box>
      )}

      {/* Generation Details */}
      <Box flexDirection="column" marginBottom={1}>
        <Box gap={1}>
          <Text bold>Generations</Text>
          <Text dimColor>({data.generations.length})</Text>
        </Box>
        {data.generations.map((gen) => {
          const scoreColor = gen.overallScore >= 0.85 ? 'green' : gen.overallScore >= 0.5 ? 'yellow' : 'red';
          const goalColor = gen.goalAlignment >= 0.80 ? 'green' : gen.goalAlignment >= 0.5 ? 'yellow' : 'red';
          return (
            <Box key={gen.generation} paddingLeft={2} gap={1}>
              <Text bold>G{gen.generation}</Text>
              <Text color={scoreColor}>
                score:{(gen.overallScore * 100).toFixed(0)}%
              </Text>
              <Text color={goalColor}>
                goal:{(gen.goalAlignment * 100).toFixed(0)}%
              </Text>
              {renderScoreBar(gen.overallScore, 15)}
              {gen.patchFields.length > 0 && (
                <Text dimColor>patch:[{gen.patchFields.join(',')}]</Text>
              )}
            </Box>
          );
        })}
      </Box>

      {/* Lateral Thinking Personas */}
      {data.laterals.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Box gap={1}>
            <Text bold>Lateral Thinking</Text>
            <Text dimColor>({data.laterals.length} attempts)</Text>
          </Box>
          {data.laterals.map((lat, i) => {
            const icon = PERSONA_ICONS[lat.persona] ?? '?';
            const color = PERSONA_COLORS[lat.persona] ?? 'gray';
            return (
              <Box key={i} paddingLeft={2} gap={1}>
                <Text color={color}>{icon}</Text>
                <Text color={color} bold>
                  {lat.persona}
                </Text>
                <Text dimColor>({lat.pattern})</Text>
                <Text color={lat.status === 'completed' ? 'green' : 'cyan'}>
                  {lat.status === 'completed' ? 'done' : 'active'}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {/* Human Escalation */}
      {data.isEscalated && (
        <Box marginTop={1} paddingX={1} borderStyle="single" borderColor="red">
          <Text color="red" bold>
            HUMAN ESCALATION — All lateral personas exhausted. Manual intervention required.
          </Text>
        </Box>
      )}
    </Box>
  );
}

function renderSparkline(values: number[]): string {
  if (values.length === 0) return '';
  const blocks = [' ', '\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'];
  return values
    .map((v) => {
      const clamped = Math.max(0, Math.min(1, v));
      const idx = Math.round(clamped * (blocks.length - 1));
      return blocks[idx] ?? ' ';
    })
    .join('');
}

function renderScoreBar(score: number, width: number): React.ReactElement {
  const filled = Math.round(score * width);
  const empty = width - filled;
  const color = score >= 0.85 ? 'green' : score >= 0.5 ? 'yellow' : 'red';
  return (
    <Text color={color}>
      {'[' + '='.repeat(filled) + ' '.repeat(empty) + ']'}
    </Text>
  );
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}
