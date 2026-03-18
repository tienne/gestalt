import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ScreenProps } from '../components/TUIApp.js';
import type { DomainEvent } from '../../core/types.js';

interface InterviewRound {
  roundNumber: number;
  question: string;
  response: string;
  ambiguityScore: number | null;
  gestaltPrinciple: string;
}

interface InterviewData {
  topic: string;
  rounds: InterviewRound[];
  overallAmbiguity: number | null;
  status: string;
}

function parseInterviewEvents(
  events: DomainEvent[],
  sessionId: string | null
): InterviewData {
  const sessionEvents = sessionId
    ? events.filter((e) => e.aggregateId === sessionId)
    : [];

  let topic = '';
  let overallAmbiguity: number | null = null;
  let status = 'unknown';
  const rounds: InterviewRound[] = [];
  const questionMap = new Map<number, Partial<InterviewRound>>();

  for (const ev of sessionEvents) {
    const payload = ev.payload as Record<string, unknown>;

    if (ev.eventType === 'interview.session.started') {
      topic = (payload.topic as string) ?? '';
      status = 'in_progress';
    }

    if (ev.eventType === 'interview.question.asked') {
      const roundNumber = (payload.roundNumber as number) ?? rounds.length + 1;
      const question = (payload.question as string) ?? '';
      const principle = (payload.gestaltFocus as string) ?? (payload.principle as string) ?? '';
      const existing = questionMap.get(roundNumber) ?? { roundNumber };
      existing.question = question;
      existing.gestaltPrinciple = principle;
      questionMap.set(roundNumber, existing);
    }

    if (ev.eventType === 'interview.response.recorded') {
      const roundNumber = (payload.roundNumber as number) ?? rounds.length + 1;
      const response = (payload.response as string) ?? (payload.userResponse as string) ?? '';
      const existing = questionMap.get(roundNumber) ?? { roundNumber };
      existing.response = response;
      questionMap.set(roundNumber, existing);
    }

    if (ev.eventType === 'interview.ambiguity.scored') {
      const overall = payload.overall as number | undefined;
      const roundNumber = payload.roundNumber as number | undefined;
      if (overall !== undefined) {
        overallAmbiguity = overall;
      }
      if (roundNumber !== undefined) {
        const existing = questionMap.get(roundNumber);
        if (existing) {
          existing.ambiguityScore = overall ?? null;
        }
      }
    }

    if (ev.eventType === 'interview.session.completed') {
      status = 'completed';
    }
  }

  // Assemble rounds from map
  for (const [roundNum, data] of questionMap.entries()) {
    rounds.push({
      roundNumber: roundNum,
      question: data.question ?? '',
      response: data.response ?? '',
      ambiguityScore: data.ambiguityScore ?? null,
      gestaltPrinciple: data.gestaltPrinciple ?? '',
    });
  }

  rounds.sort((a, b) => a.roundNumber - b.roundNumber);

  return { topic, rounds, overallAmbiguity, status };
}

const PRINCIPLE_COLORS: Record<string, string> = {
  closure: 'magenta',
  proximity: 'blue',
  similarity: 'yellow',
  figure_ground: 'green',
  continuity: 'cyan',
};

export function InterviewScreen({
  events,
  selectedSessionId,
}: ScreenProps): React.ReactElement {
  const data = useMemo(
    () => parseInterviewEvents(events, selectedSessionId),
    [events, selectedSessionId]
  );

  const [scrollOffset, setScrollOffset] = useState(0);
  const visibleRounds = 5;

  useInput((_input, key) => {
    if (key.upArrow) {
      setScrollOffset((prev) => Math.max(0, prev - 1));
    }
    if (key.downArrow) {
      setScrollOffset((prev) => Math.min(Math.max(0, data.rounds.length - visibleRounds), prev + 1));
    }
  });

  if (!selectedSessionId) {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" minHeight={10}>
        <Text bold color="yellow">No session selected</Text>
        <Text dimColor>Press 1 to go to Sessions and select one.</Text>
      </Box>
    );
  }

  if (data.rounds.length === 0) {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" minHeight={10}>
        <Text bold color="yellow">No interview data</Text>
        <Text dimColor>This session may not be an interview, or no Q&A rounds have been recorded.</Text>
      </Box>
    );
  }

  const displayedRounds = data.rounds.slice(scrollOffset, scrollOffset + visibleRounds);

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box marginBottom={1} gap={1}>
        <Text bold>Interview</Text>
        <Text dimColor>|</Text>
        <Text color="cyan">{truncate(data.topic || selectedSessionId, 40)}</Text>
        <Text dimColor>|</Text>
        <Text color={data.status === 'completed' ? 'green' : 'cyan'}>
          {data.status}
        </Text>
        {data.overallAmbiguity !== null && (
          <React.Fragment>
            <Text dimColor>| ambiguity:</Text>
            <Text color={data.overallAmbiguity <= 0.2 ? 'green' : data.overallAmbiguity <= 0.5 ? 'yellow' : 'red'}>
              {(data.overallAmbiguity * 100).toFixed(0)}%
            </Text>
          </React.Fragment>
        )}
      </Box>

      {/* Scroll indicator */}
      <Box marginBottom={1}>
        <Text dimColor>
          Rounds {scrollOffset + 1}-{Math.min(scrollOffset + visibleRounds, data.rounds.length)} of{' '}
          {data.rounds.length} | Up/Down to scroll
        </Text>
      </Box>

      {/* Q&A Rounds */}
      {displayedRounds.map((round) => (
        <Box key={round.roundNumber} flexDirection="column" marginBottom={1}>
          <Box gap={1}>
            <Text bold color="white">
              R{round.roundNumber}
            </Text>
            {round.gestaltPrinciple && (
              <Text color={PRINCIPLE_COLORS[round.gestaltPrinciple] ?? 'gray'}>
                [{round.gestaltPrinciple}]
              </Text>
            )}
            {round.ambiguityScore !== null && (
              <Text dimColor>
                amb: {renderMiniBar(round.ambiguityScore, 10)}
                {' '}{(round.ambiguityScore * 100).toFixed(0)}%
              </Text>
            )}
          </Box>

          <Box paddingLeft={2} flexDirection="column">
            <Box>
              <Text color="yellow">Q: </Text>
              <Text>{truncate(round.question, 80)}</Text>
            </Box>
            {round.response ? (
              <Box>
                <Text color="green">A: </Text>
                <Text>{truncate(round.response, 80)}</Text>
              </Box>
            ) : (
              <Box>
                <Text color="gray">A: </Text>
                <Text dimColor>(awaiting response)</Text>
              </Box>
            )}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function renderMiniBar(score: number, width: number): string {
  const filled = Math.round(score * width);
  const empty = width - filled;
  return '[' + '#'.repeat(filled) + ' '.repeat(empty) + ']';
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}
