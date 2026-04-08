import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PassthroughSpecGenerator } from '../../../src/spec/passthrough-generator.js';
import { EventStore } from '../../../src/events/store.js';
import { isOk, isErr } from '../../../src/core/result.js';
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { InterviewSession } from '../../../src/core/types.js';
import { GestaltPrinciple } from '../../../src/core/types.js';

function makeSession(overrides: Partial<InterviewSession> = {}): InterviewSession {
  return {
    sessionId: randomUUID(),
    topic: 'Test project',
    status: 'completed',
    projectType: 'greenfield',
    rounds: [
      {
        roundNumber: 1,
        question: 'What is the goal?',
        userResponse: 'Build a payment system',
        gestaltFocus: GestaltPrinciple.CLOSURE,
        timestamp: new Date().toISOString(),
      },
      {
        roundNumber: 2,
        question: 'What constraints exist?',
        userResponse: 'Must support credit cards and PayPal',
        gestaltFocus: GestaltPrinciple.PROXIMITY,
        timestamp: new Date().toISOString(),
      },
    ],
    resolutionScore: {
      overall: 0.85,
      dimensions: [],
      isReady: true,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const validExternalSpec = {
  goal: 'Build a payment processing system',
  constraints: ['Must support credit cards', 'PCI-DSS compliant'],
  acceptanceCriteria: ['Process payments within 3 seconds'],
  ontologySchema: {
    entities: [{ name: 'Payment', description: 'A payment transaction', attributes: ['amount', 'currency'] }],
    relations: [{ from: 'Payment', to: 'User', type: 'belongs_to' }],
  },
  gestaltAnalysis: [
    { principle: 'closure', finding: 'Missing refund flow', confidence: 0.8 },
  ],
};

describe('PassthroughSpecGenerator', () => {
  let store: EventStore;
  let generator: PassthroughSpecGenerator;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/pt-spec-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    generator = new PassthroughSpecGenerator(store);
  });

  afterEach(() => {
    store.close();
    try {
      if (existsSync(dbPath)) rmSync(dbPath);
      if (existsSync(dbPath + '-wal')) rmSync(dbPath + '-wal');
      if (existsSync(dbPath + '-shm')) rmSync(dbPath + '-shm');
    } catch { /* ignore */ }
  });

  it('buildSpecContext returns prompt and round data', () => {
    const session = makeSession();
    const context = generator.buildSpecContext(session);

    expect(context.systemPrompt).toContain('Gestalt');
    expect(context.specPrompt).toContain('Test project');
    expect(context.allRounds).toHaveLength(2);
    expect(context.allRounds[0]!.question).toBe('What is the goal?');
    expect(context.allRounds[0]!.response).toBe('Build a payment system');
  });

  it('validateAndStore with valid spec passes Zod and stores event', () => {
    const session = makeSession();
    const result = generator.validateAndStore(session, validExternalSpec);

    expect(isOk(result)).toBe(true);
    if (result.ok) {
      expect(result.value.goal).toBe('Build a payment processing system');
      expect(result.value.version).toBe('1.0.0');
      expect(result.value.metadata.interviewSessionId).toBe(session.sessionId);
      expect(result.value.constraints).toHaveLength(2);
    }
  });

  it('validateAndStore with invalid spec returns Zod error', () => {
    const session = makeSession();
    const invalidSpec = {
      goal: '',  // empty goal should fail
      constraints: [],
      acceptanceCriteria: [],
      ontologySchema: { entities: [], relations: [] },
      gestaltAnalysis: [],
    };

    const result = generator.validateAndStore(session, invalidSpec);
    expect(isErr(result)).toBe(true);
  });

  it('validateAndStore with low resolution and force=false returns ResolutionThresholdError', () => {
    const session = makeSession({
      resolutionScore: { overall: 0.5, dimensions: [], isReady: false },
    });

    const result = generator.validateAndStore(session, validExternalSpec, false);
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.message).toContain('below threshold');
    }
  });

  it('validateAndStore with low resolution and force=true succeeds', () => {
    const session = makeSession({
      resolutionScore: { overall: 0.5, dimensions: [], isReady: false },
    });

    const result = generator.validateAndStore(session, validExternalSpec, true);
    expect(isOk(result)).toBe(true);
  });

  it('validateAndStore with incomplete session returns error', () => {
    const session = makeSession({
      status: 'in_progress',
      resolutionScore: { overall: 0.85, dimensions: [], isReady: true },
    });

    const result = generator.validateAndStore(session, validExternalSpec);
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.message).toContain('must be completed');
    }
  });
});
