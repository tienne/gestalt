import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { InterviewSession } from '../core/types.js';

// ANSI color codes
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';

type CastEvent = [number, 'o', string];

export function slugify(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'interview';
}

export function getDateString(date = new Date()): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

export class CastGenerator {
  generate(session: InterviewSession, outputPath: string): void {
    const startTs = Math.floor(Date.parse(session.createdAt) / 1000);

    const header = {
      version: 2,
      width: 100,
      height: 40,
      timestamp: startTs,
      title: `Gestalt Interview: ${session.topic}`,
    };

    const events: CastEvent[] = [];
    let t = 0;

    // Banner
    events.push([t, 'o', `\r\n${BOLD}${CYAN}╔══════════════════════════════════════════════╗${RESET}\r\n`]);
    t += 0.05;
    events.push([t, 'o', `${BOLD}${CYAN}║  🎯 Gestalt Interview                        ║${RESET}\r\n`]);
    t += 0.05;
    events.push([t, 'o', `${BOLD}${CYAN}║  ${DIM}${session.topic.slice(0, 44).padEnd(44)}${RESET}${BOLD}${CYAN}  ║${RESET}\r\n`]);
    t += 0.05;
    events.push([t, 'o', `${BOLD}${CYAN}╚══════════════════════════════════════════════╝${RESET}\r\n\r\n`]);
    t += 0.5;

    // Q&A rounds
    for (const round of session.rounds) {
      if (!round.userResponse) continue;

      // Question
      events.push([t, 'o', `${BOLD}${YELLOW}Q${round.roundNumber} [${round.gestaltFocus}]${RESET}\r\n`]);
      t += 0.1;
      events.push([t, 'o', `${round.question}\r\n\r\n`]);
      t += 1.2;

      // Answer
      events.push([t, 'o', `${BOLD}${GREEN}❯${RESET} `]);
      t += 0.1;
      events.push([t, 'o', `${round.userResponse}\r\n\r\n`]);
      t += 0.8;
    }

    // Footer
    events.push([t, 'o', `${BOLD}${CYAN}✅ Interview completed — ${session.rounds.length} rounds${RESET}\r\n`]);
    t += 0.3;
    if (session.ambiguityScore) {
      events.push([t, 'o', `${DIM}Ambiguity score: ${session.ambiguityScore.overall.toFixed(2)}${RESET}\r\n`]);
    }
    events.push([t + 0.2, 'o', '\r\n']);

    // Write file
    mkdirSync(dirname(outputPath), { recursive: true });
    const lines = [
      JSON.stringify(header),
      ...events.map((e) => JSON.stringify(e)),
    ];
    writeFileSync(outputPath, lines.join('\n') + '\n', 'utf8');
  }
}
