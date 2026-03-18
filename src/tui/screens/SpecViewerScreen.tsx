import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { ScreenProps } from '../components/TUIApp.js';
import type { DomainEvent } from '../../core/types.js';

interface SpecData {
  goal: string;
  constraints: string[];
  acceptanceCriteria: string[];
  entities: Array<{ name: string; description: string; attributes: string[] }>;
  relations: Array<{ from: string; to: string; type: string }>;
  gestaltAnalysis: Array<{ principle: string; finding: string; confidence: number }>;
  generatedAt: string;
}

function parseSpecEvents(
  events: DomainEvent[],
  sessionId: string | null
): SpecData | null {
  if (!sessionId) return null;

  // Spec events may be tied to the interview session or an execute session
  // Look for SPEC_GENERATED events across all events matching the session
  const specEvents = events.filter(
    (e) =>
      e.eventType === 'spec.generated' &&
      (e.aggregateId === sessionId || hasMatchingSessionId(e, sessionId))
  );

  if (specEvents.length === 0) return null;

  // Use the latest spec event
  const latestSpec = specEvents[specEvents.length - 1];
  if (!latestSpec) return null;

  const payload = latestSpec.payload as Record<string, unknown>;

  // The spec may be nested under "spec" or at the top level
  const spec = (payload.spec as Record<string, unknown>) ?? payload;

  const ontology = (spec.ontologySchema as Record<string, unknown>) ?? {};

  return {
    goal: (spec.goal as string) ?? '',
    constraints: (spec.constraints as string[]) ?? [],
    acceptanceCriteria: (spec.acceptanceCriteria as string[]) ?? [],
    entities: (ontology.entities as Array<{ name: string; description: string; attributes: string[] }>) ?? [],
    relations: (ontology.relations as Array<{ from: string; to: string; type: string }>) ?? [],
    gestaltAnalysis: (spec.gestaltAnalysis as Array<{ principle: string; finding: string; confidence: number }>) ?? [],
    generatedAt: latestSpec.timestamp,
  };
}

function hasMatchingSessionId(event: DomainEvent, sessionId: string): boolean {
  const payload = event.payload as Record<string, unknown>;
  return (
    payload.interviewSessionId === sessionId ||
    payload.sessionId === sessionId
  );
}

const PRINCIPLE_COLORS: Record<string, string> = {
  closure: 'magenta',
  proximity: 'blue',
  similarity: 'yellow',
  figure_ground: 'green',
  continuity: 'cyan',
};

export function SpecViewerScreen({
  events,
  selectedSessionId,
}: ScreenProps): React.ReactElement {
  const spec = useMemo(
    () => parseSpecEvents(events, selectedSessionId),
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

  if (!spec) {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" minHeight={10}>
        <Text bold color="yellow">No spec found</Text>
        <Text dimColor>No SPEC_GENERATED event found for this session.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box marginBottom={1} gap={1}>
        <Text bold>Spec Viewer</Text>
        <Text dimColor>| generated: {formatTimestamp(spec.generatedAt)}</Text>
      </Box>

      {/* Goal */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="cyan">Goal</Text>
        <Box paddingLeft={2}>
          <Text>{spec.goal}</Text>
        </Box>
      </Box>

      {/* Constraints */}
      <Box flexDirection="column" marginBottom={1}>
        <Box gap={1}>
          <Text bold color="yellow">Constraints</Text>
          <Text dimColor>({spec.constraints.length})</Text>
        </Box>
        {spec.constraints.map((c, i) => (
          <Box key={i} paddingLeft={2}>
            <Text color="yellow">- </Text>
            <Text>{truncate(c, 80)}</Text>
          </Box>
        ))}
      </Box>

      {/* Acceptance Criteria */}
      <Box flexDirection="column" marginBottom={1}>
        <Box gap={1}>
          <Text bold color="green">Acceptance Criteria</Text>
          <Text dimColor>({spec.acceptanceCriteria.length})</Text>
        </Box>
        {spec.acceptanceCriteria.map((ac, i) => (
          <Box key={i} paddingLeft={2}>
            <Text color="green">{i + 1}. </Text>
            <Text>{truncate(ac, 78)}</Text>
          </Box>
        ))}
      </Box>

      {/* Ontology */}
      <Box flexDirection="column" marginBottom={1}>
        <Box gap={1}>
          <Text bold color="magenta">Ontology</Text>
          <Text dimColor>
            ({spec.entities.length} entities, {spec.relations.length} relations)
          </Text>
        </Box>

        {spec.entities.length > 0 && (
          <Box flexDirection="column" paddingLeft={2}>
            <Text bold dimColor>Entities:</Text>
            {spec.entities.map((entity) => (
              <Box key={entity.name} paddingLeft={2} flexDirection="column">
                <Box gap={1}>
                  <Text color="magenta">{entity.name}</Text>
                  <Text dimColor>- {truncate(entity.description, 50)}</Text>
                </Box>
                {entity.attributes.length > 0 && (
                  <Box paddingLeft={2}>
                    <Text dimColor>attrs: {entity.attributes.join(', ')}</Text>
                  </Box>
                )}
              </Box>
            ))}
          </Box>
        )}

        {spec.relations.length > 0 && (
          <Box flexDirection="column" paddingLeft={2} marginTop={1}>
            <Text bold dimColor>Relations:</Text>
            {spec.relations.map((rel, i) => (
              <Box key={i} paddingLeft={2} gap={1}>
                <Text color="magenta">{rel.from}</Text>
                <Text dimColor>--[{rel.type}]--{'>'}</Text>
                <Text color="magenta">{rel.to}</Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>

      {/* Gestalt Analysis */}
      {spec.gestaltAnalysis.length > 0 && (
        <Box flexDirection="column">
          <Box gap={1}>
            <Text bold color="blue">Gestalt Analysis</Text>
            <Text dimColor>({spec.gestaltAnalysis.length})</Text>
          </Box>
          {spec.gestaltAnalysis.map((ga, i) => (
            <Box key={i} paddingLeft={2} gap={1}>
              <Text color={PRINCIPLE_COLORS[ga.principle] ?? 'gray'}>
                [{ga.principle}]
              </Text>
              <Text>{truncate(ga.finding, 60)}</Text>
              <Text dimColor>({(ga.confidence * 100).toFixed(0)}%)</Text>
            </Box>
          ))}
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
      hour12: false,
    });
  } catch {
    return ts.slice(0, 19);
  }
}
