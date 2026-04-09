import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CastGenerator, slugify, getDateString } from '../../../src/recording/cast-generator.js';
import * as fs from 'node:fs';
import type { InterviewSession } from '../../../src/core/types.js';

vi.mock('node:fs');

const mockedMkdirSync = vi.mocked(fs.mkdirSync);
const mockedWriteFileSync = vi.mocked(fs.writeFileSync);

function makeSession(overrides: Partial<InterviewSession> = {}): InterviewSession {
  return {
    sessionId: 'test-session-id',
    topic: 'User Authentication System',
    status: 'completed',
    projectType: 'greenfield',
    rounds: [
      {
        roundNumber: 1,
        question: 'What is the primary goal of this project?',
        userResponse: 'Build a secure login system with OAuth support.',
        gestaltFocus: 'closure',
        timestamp: '2026-03-28T00:00:00.000Z',
      },
      {
        roundNumber: 2,
        question: 'Who are the target users?',
        userResponse: 'Enterprise customers with SSO requirements.',
        gestaltFocus: 'proximity',
        timestamp: '2026-03-28T00:01:00.000Z',
      },
    ],
    resolutionScore: { overall: 0.82, isReady: true, dimensions: [] },
    createdAt: '2026-03-28T00:00:00.000Z',
    updatedAt: '2026-03-28T00:02:00.000Z',
    ...overrides,
  };
}

describe('CastGenerator', () => {
  let generator: CastGenerator;

  beforeEach(() => {
    generator = new CastGenerator();
    vi.clearAllMocks();
    mockedMkdirSync.mockReturnValue(undefined);
    mockedWriteFileSync.mockReturnValue(undefined);
  });

  it('creates output directory and writes file', () => {
    generator.generate(makeSession(), '.gestalt/recordings/test.cast');

    expect(mockedMkdirSync).toHaveBeenCalledWith('.gestalt/recordings', { recursive: true });
    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      '.gestalt/recordings/test.cast',
      expect.any(String),
      'utf8',
    );
  });

  it('generates valid asciinema v2 header on first line', () => {
    generator.generate(makeSession(), '/tmp/test.cast');

    const written = mockedWriteFileSync.mock.calls[0]![1] as string;
    const firstLine = written.split('\n')[0]!;
    const header = JSON.parse(firstLine);

    expect(header.version).toBe(2);
    expect(header.width).toBe(100);
    expect(header.height).toBe(40);
    expect(header.title).toContain('User Authentication System');
  });

  it('includes Q&A content from rounds', () => {
    generator.generate(makeSession(), '/tmp/test.cast');

    const written = mockedWriteFileSync.mock.calls[0]![1] as string;
    expect(written).toContain('What is the primary goal');
    expect(written).toContain('Build a secure login system');
    expect(written).toContain('Who are the target users');
    expect(written).toContain('Enterprise customers with SSO');
  });

  it('skips rounds with null userResponse', () => {
    const session = makeSession({
      rounds: [
        {
          roundNumber: 1,
          question: 'A question with no answer yet',
          userResponse: null,
          gestaltFocus: 'closure',
          timestamp: '2026-03-28T00:00:00.000Z',
        },
      ],
    });

    generator.generate(session, '/tmp/test.cast');

    const written = mockedWriteFileSync.mock.calls[0]![1] as string;
    expect(written).not.toContain('A question with no answer yet');
  });

  it('events have monotonically increasing timestamps', () => {
    generator.generate(makeSession(), '/tmp/test.cast');

    const written = mockedWriteFileSync.mock.calls[0]![1] as string;
    const lines = written.trim().split('\n').slice(1); // skip header
    const timestamps = lines.map((l) => JSON.parse(l) as [number, string, string]).map(([t]) => t);

    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]!);
    }
  });
});

describe('slugify', () => {
  it('converts topic to kebab-case', () => {
    expect(slugify('User Authentication System')).toBe('user-authentication-system');
  });

  it('handles special characters', () => {
    expect(slugify('API Gateway & Rate Limiting!')).toBe('api-gateway-rate-limiting');
  });

  it('truncates long topics', () => {
    const long = 'a'.repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(50);
  });

  it('returns "interview" for empty string', () => {
    expect(slugify('')).toBe('interview');
  });
});

describe('getDateString', () => {
  it('returns YYYYMMDD format', () => {
    const date = new Date('2026-03-28T12:00:00Z');
    expect(getDateString(date)).toBe('20260328');
  });
});
