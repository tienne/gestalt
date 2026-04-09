import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PassthroughAgentGenerator } from '../../../src/agent/passthrough-generator.js';
import { EventStore } from '../../../src/events/store.js';
import { isOk, isErr } from '../../../src/core/result.js';
import { existsSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { InterviewSession } from '../../../src/core/types.js';
import { GestaltPrinciple } from '../../../src/core/types.js';
import { parseAgentMd } from '../../../src/agent/parser.js';

function makeSession(overrides: Partial<InterviewSession> = {}): InterviewSession {
  return {
    sessionId: randomUUID(),
    topic: 'Security agent for auth flows',
    status: 'completed',
    projectType: 'greenfield',
    rounds: [
      {
        roundNumber: 1,
        question: 'What kind of agent do you need?',
        userResponse: 'A security-focused agent for authentication flows',
        gestaltFocus: GestaltPrinciple.CLOSURE,
        timestamp: new Date().toISOString(),
      },
      {
        roundNumber: 2,
        question: 'What domains should the agent cover?',
        userResponse: 'OAuth, JWT, session management, RBAC',
        gestaltFocus: GestaltPrinciple.PROXIMITY,
        timestamp: new Date().toISOString(),
      },
    ],
    resolutionScore: {
      overall: 0.15,
      dimensions: [],
      isReady: true,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const validAgentContent = `---
name: security-expert
tier: standard
pipeline: execute
role: true
domain: ["oauth", "jwt", "session-management", "rbac"]
description: "보안 전문가. 인증/인가 플로우, 세션 관리, RBAC 관점을 제공한다."
---

You are the Security Expert role agent.

## Perspective Focus

When reviewing a task, provide guidance on:
1. Authentication flows (OAuth, JWT)
2. Session management best practices
3. Role-based access control
`;

const nonRoleAgentContent = `---
name: test-helper
tier: frugal
pipeline: execute
role: false
domain: ["testing"]
description: "A test helper agent."
---

Test helper system prompt.
`;

describe('PassthroughAgentGenerator', () => {
  let store: EventStore;
  let generator: PassthroughAgentGenerator;
  let dbPath: string;
  let tmpDir: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/pt-agent-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    generator = new PassthroughAgentGenerator(store);
    tmpDir = `.gestalt-test/agent-cwd-${randomUUID()}`;
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    store.close();
    try {
      if (existsSync(dbPath)) rmSync(dbPath);
      if (existsSync(dbPath + '-wal')) rmSync(dbPath + '-wal');
      if (existsSync(dbPath + '-shm')) rmSync(dbPath + '-shm');
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
    } catch {
      /* ignore */
    }
  });

  // ─── buildAgentContext ───────────────────────────────────────

  it('buildAgentContext returns creation context with prompts', () => {
    const session = makeSession();
    const result = generator.buildAgentContext(session);

    expect(isOk(result)).toBe(true);
    if (!result.ok) return;

    expect(result.value.systemPrompt).toContain('Gestalt agent creator');
    expect(result.value.creationPrompt).toContain('Security agent for auth flows');
    expect(result.value.creationPrompt).toContain('security-focused agent');
    expect(result.value.agentMdSchema).toContain('name:');
    expect(result.value.agentMdSchema).toContain('role: true');
  });

  it('buildAgentContext includes existing agents list', () => {
    const session = makeSession();
    const result = generator.buildAgentContext(session);

    expect(isOk(result)).toBe(true);
    if (!result.ok) return;

    // No registry → "(none)"
    expect(result.value.existingAgents).toHaveLength(0);
    expect(result.value.creationPrompt).toContain('(none)');
  });

  it('buildAgentContext fails for incomplete session', () => {
    const session = makeSession({ status: 'in_progress' });
    const result = generator.buildAgentContext(session);

    expect(isErr(result)).toBe(true);
    if (result.ok) return;
    expect(result.error.message).toContain('must be completed');
  });

  it('buildAgentContext includes interview round summaries', () => {
    const session = makeSession();
    const result = generator.buildAgentContext(session);

    expect(isOk(result)).toBe(true);
    if (!result.ok) return;

    expect(result.value.creationPrompt).toContain('Q1:');
    expect(result.value.creationPrompt).toContain('Q2:');
    expect(result.value.creationPrompt).toContain('OAuth, JWT, session management, RBAC');
  });

  // ─── validateAndSave ────────────────────────────────────────

  it('validateAndSave creates AGENT.md file', () => {
    const session = makeSession();
    const result = generator.validateAndSave(session, validAgentContent, tmpDir);

    expect(isOk(result)).toBe(true);
    if (!result.ok) return;

    expect(result.value.agent.frontmatter.name).toBe('security-expert');
    expect(result.value.agent.frontmatter.role).toBe(true);
    expect(result.value.overridden).toBe(false);

    const filePath = join(tmpDir, 'agents', 'security-expert', 'AGENT.md');
    expect(existsSync(filePath)).toBe(true);

    // Verify file is parseable
    const content = readFileSync(filePath, 'utf-8');
    const parsed = parseAgentMd(content, filePath);
    expect(parsed.frontmatter.name).toBe('security-expert');
  });

  it('validateAndSave rejects non-role agents', () => {
    const session = makeSession();
    const result = generator.validateAndSave(session, nonRoleAgentContent, tmpDir);

    expect(isErr(result)).toBe(true);
    if (result.ok) return;
    expect(result.error.message).toContain('role=true');
  });

  it('validateAndSave rejects invalid AGENT.md content', () => {
    const session = makeSession();
    const result = generator.validateAndSave(session, 'not valid yaml frontmatter', tmpDir);

    expect(isErr(result)).toBe(true);
    if (result.ok) return;
    expect(result.error.message).toContain('Invalid AGENT.md content');
  });

  it('validateAndSave overrides existing agent and reports overridden=true', () => {
    const session = makeSession();

    // Create first
    const first = generator.validateAndSave(session, validAgentContent, tmpDir);
    expect(isOk(first)).toBe(true);
    if (!first.ok) return;
    expect(first.value.overridden).toBe(false);

    // Override
    const second = generator.validateAndSave(session, validAgentContent, tmpDir);
    expect(isOk(second)).toBe(true);
    if (!second.ok) return;
    expect(second.value.overridden).toBe(true);
  });

  it('validateAndSave fails for incomplete session', () => {
    const session = makeSession({ status: 'in_progress' });
    const result = generator.validateAndSave(session, validAgentContent, tmpDir);

    expect(isErr(result)).toBe(true);
    if (result.ok) return;
    expect(result.error.message).toContain('must be completed');
  });

  it('validateAndSave emits AGENT_CREATED event', () => {
    const session = makeSession();
    const result = generator.validateAndSave(session, validAgentContent, tmpDir);

    expect(isOk(result)).toBe(true);

    const events = store.getByAggregate('agent', 'security-expert');
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.eventType).toBe('agent.created');
  });
});
