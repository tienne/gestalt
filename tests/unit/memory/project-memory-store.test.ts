import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ProjectMemoryStore } from '../../../src/memory/project-memory-store.js';

describe('ProjectMemoryStore', () => {
  let tmpDir: string;
  let store: ProjectMemoryStore;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `gestalt-memory-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    // Create package.json so detectRepoRoot finds this dir
    writeFileSync(join(tmpDir, 'package.json'), '{"name":"test"}');
    store = new ProjectMemoryStore(tmpDir);
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns empty memory when no file exists', () => {
    const memory = store.read();
    expect(memory.specHistory).toHaveLength(0);
    expect(memory.executionHistory).toHaveLength(0);
    expect(memory.architectureDecisions).toHaveLength(0);
    expect(memory.version).toBe('1.0.0');
  });

  it('creates memory file on addSpec', () => {
    const memoryPath = join(tmpDir, '.gestalt', 'memory.json');
    expect(existsSync(memoryPath)).toBe(false);

    store.addSpec({
      specId: randomUUID(),
      goal: 'Test goal',
      createdAt: new Date().toISOString(),
      sourceType: 'text',
    });

    expect(existsSync(memoryPath)).toBe(true);
  });

  it('appends spec entries', () => {
    const specId1 = randomUUID();
    const specId2 = randomUUID();

    store.addSpec({
      specId: specId1,
      goal: 'Goal 1',
      createdAt: new Date().toISOString(),
      sourceType: 'interview',
    });
    store.addSpec({
      specId: specId2,
      goal: 'Goal 2',
      createdAt: new Date().toISOString(),
      sourceType: 'text',
    });

    const memory = store.read();
    expect(memory.specHistory).toHaveLength(2);
    expect(memory.specHistory[0]!.specId).toBe(specId1);
    expect(memory.specHistory[1]!.specId).toBe(specId2);
  });

  it('prevents duplicate specId entries', () => {
    const specId = randomUUID();
    store.addSpec({
      specId,
      goal: 'Goal',
      createdAt: new Date().toISOString(),
      sourceType: 'text',
    });
    store.addSpec({
      specId,
      goal: 'Goal',
      createdAt: new Date().toISOString(),
      sourceType: 'text',
    });

    const memory = store.read();
    expect(memory.specHistory).toHaveLength(1);
  });

  it('appends execution records', () => {
    const sessionId = randomUUID();
    store.addExecution({
      executeSessionId: sessionId,
      specId: randomUUID(),
      completedTasks: ['task-1', 'task-2'],
      failedTasks: [],
      resultSummary: 'Score: 0.90',
      completedAt: new Date().toISOString(),
    });

    const memory = store.read();
    expect(memory.executionHistory).toHaveLength(1);
    expect(memory.executionHistory[0]!.executeSessionId).toBe(sessionId);
    expect(memory.executionHistory[0]!.completedTasks).toHaveLength(2);
  });

  it('prevents duplicate execution records', () => {
    const sessionId = randomUUID();
    const record = {
      executeSessionId: sessionId,
      specId: randomUUID(),
      completedTasks: [],
      failedTasks: [],
      resultSummary: 'done',
      completedAt: new Date().toISOString(),
    };
    store.addExecution(record);
    store.addExecution(record);

    const memory = store.read();
    expect(memory.executionHistory).toHaveLength(1);
  });

  it('appends architecture decisions', () => {
    store.addArchitectureDecision('Use PostgreSQL over MongoDB');
    store.addArchitectureDecision('Use React for frontend');

    const memory = store.read();
    expect(memory.architectureDecisions).toHaveLength(2);
  });

  it('prevents duplicate architecture decisions', () => {
    store.addArchitectureDecision('Use PostgreSQL');
    store.addArchitectureDecision('Use PostgreSQL');

    const memory = store.read();
    expect(memory.architectureDecisions).toHaveLength(1);
  });

  it('updates lastUpdated on write', () => {
    const before = new Date().toISOString();
    store.addSpec({
      specId: randomUUID(),
      goal: 'G',
      createdAt: new Date().toISOString(),
      sourceType: 'text',
    });
    const memory = store.read();
    expect(memory.lastUpdated >= before).toBe(true);
  });

  it('returns repoRoot', () => {
    expect(store.getRepoRoot()).toBe(tmpDir);
  });
});
