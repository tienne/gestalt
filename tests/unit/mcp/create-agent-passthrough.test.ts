import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleCreateAgentPassthrough } from '../../../src/mcp/tools/create-agent-passthrough.js';
import { PassthroughAgentGenerator } from '../../../src/agent/passthrough-generator.js';
import { PassthroughEngine } from '../../../src/interview/passthrough-engine.js';
import { EventStore } from '../../../src/events/store.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { AgentCreateInput } from '../../../src/mcp/schemas.js';

const validAgentContent = `---
name: security-expert
tier: standard
pipeline: execute
role: true
domain: ["oauth", "jwt"]
description: "보안 전문가 에이전트"
---

You are a security expert.
`;

describe('handleCreateAgentPassthrough', () => {
  let store: EventStore;
  let engine: PassthroughEngine;
  let generator: PassthroughAgentGenerator;
  let dbPath: string;
  let tmpDir: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/mcp-agent-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    engine = new PassthroughEngine(store);
    generator = new PassthroughAgentGenerator(store);
    tmpDir = `.gestalt-test/mcp-cwd-${randomUUID()}`;
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

  function createCompletedSession(): string {
    const startResult = engine.start('Security agent');
    if (!startResult.ok) throw new Error('Failed to start session');

    const sessionId = startResult.value.session.sessionId;

    engine.respond(sessionId, 'OAuth and JWT security', 'What domains?', {
      goalClarity: 0.9,
      constraintClarity: 0.9,
      successCriteria: 0.9,
      priorityClarity: 0.9,
    });

    engine.complete(sessionId);
    return sessionId;
  }

  // ─── action: start ───────────────────────────────────────────

  it('start returns agent creation context', () => {
    const sessionId = createCompletedSession();

    const result = handleCreateAgentPassthrough(engine, generator, {
      action: 'start',
      sessionId,
    } as AgentCreateInput);

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('agent_context_ready');
    expect(parsed.sessionId).toBe(sessionId);
    expect(parsed.agentContext).toBeDefined();
    expect(parsed.agentContext.systemPrompt).toContain('Gestalt agent creator');
    expect(parsed.agentContext.creationPrompt).toContain('Security agent');
    expect(parsed.agentContext.agentMdSchema).toBeDefined();
  });

  it('start with invalid sessionId returns error', () => {
    const result = handleCreateAgentPassthrough(engine, generator, {
      action: 'start',
      sessionId: 'nonexistent',
    } as AgentCreateInput);

    const parsed = JSON.parse(result);
    expect(parsed.error).toContain('Session not found');
  });

  it('start with incomplete session returns error', () => {
    const startResult = engine.start('Test topic');
    if (!startResult.ok) throw new Error('Failed to start');
    const sessionId = startResult.value.session.sessionId;

    const result = handleCreateAgentPassthrough(engine, generator, {
      action: 'start',
      sessionId,
    } as AgentCreateInput);

    const parsed = JSON.parse(result);
    expect(parsed.error).toContain('must be completed');
  });

  // ─── action: submit ──────────────────────────────────────────

  it('submit creates agent file', () => {
    const sessionId = createCompletedSession();

    const result = handleCreateAgentPassthrough(engine, generator, {
      action: 'submit',
      sessionId,
      agentContent: validAgentContent,
      cwd: tmpDir,
    } as AgentCreateInput);

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('agent_created');
    expect(parsed.agentName).toBe('security-expert');
    expect(parsed.overridden).toBe(false);
    expect(existsSync(parsed.filePath)).toBe(true);
  });

  it('submit without agentContent returns error', () => {
    const sessionId = createCompletedSession();

    const result = handleCreateAgentPassthrough(engine, generator, {
      action: 'submit',
      sessionId,
    } as AgentCreateInput);

    const parsed = JSON.parse(result);
    expect(parsed.error).toContain('agentContent is required');
  });

  it('submit with invalid content returns error', () => {
    const sessionId = createCompletedSession();

    const result = handleCreateAgentPassthrough(engine, generator, {
      action: 'submit',
      sessionId,
      agentContent: 'invalid content without frontmatter',
      cwd: tmpDir,
    } as AgentCreateInput);

    const parsed = JSON.parse(result);
    expect(parsed.error).toContain('Invalid AGENT.md content');
  });

  it('submit with non-role agent returns error', () => {
    const sessionId = createCompletedSession();

    const nonRoleContent = `---
name: helper
tier: frugal
pipeline: execute
role: false
domain: ["test"]
description: "Not a role agent"
---

System prompt.
`;

    const result = handleCreateAgentPassthrough(engine, generator, {
      action: 'submit',
      sessionId,
      agentContent: nonRoleContent,
      cwd: tmpDir,
    } as AgentCreateInput);

    const parsed = JSON.parse(result);
    expect(parsed.error).toContain('role=true');
  });

  it('submit reports overridden=true for existing agent', () => {
    const sessionId = createCompletedSession();

    // First creation
    handleCreateAgentPassthrough(engine, generator, {
      action: 'submit',
      sessionId,
      agentContent: validAgentContent,
      cwd: tmpDir,
    } as AgentCreateInput);

    // Second creation (override)
    const result = handleCreateAgentPassthrough(engine, generator, {
      action: 'submit',
      sessionId,
      agentContent: validAgentContent,
      cwd: tmpDir,
    } as AgentCreateInput);

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('agent_created');
    expect(parsed.overridden).toBe(true);
    expect(parsed.message).toContain('overridden');
  });
});
