import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ProjectMemoryStore } from '../../../src/memory/project-memory-store.js';

// cwd가 레포 루트가 아니어도 같은 파일을 가리키게 이 테스트 파일 기준으로 잡는다
const STORE_MODULE_URL = new URL('../../../src/memory/project-memory-store.ts', import.meta.url)
  .href;
const TSX_BIN = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url));

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
    vi.restoreAllMocks();
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
    store.addArchitectureDecision({
      decision: 'Use PostgreSQL over MongoDB',
      rationale: 'Better relational support',
      specId: '',
      timestamp: new Date().toISOString(),
    });
    store.addArchitectureDecision({
      decision: 'Use React for frontend',
      rationale: 'Team familiarity',
      specId: '',
      timestamp: new Date().toISOString(),
    });

    const memory = store.read();
    expect(memory.architectureDecisions).toHaveLength(2);
  });

  it('prevents duplicate architecture decisions', () => {
    const decision = {
      decision: 'Use PostgreSQL',
      rationale: 'ACID compliance',
      specId: '',
      timestamp: new Date().toISOString(),
    };
    store.addArchitectureDecision(decision);
    store.addArchitectureDecision(decision);

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

  it('깨진 memory.json은 백업하고 다음 쓰기가 기존 기록을 덮지 않는다', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const gestaltDir = join(tmpDir, '.gestalt');
    mkdirSync(gestaltDir, { recursive: true });
    const broken = '{"specHistory": [{"specId": "old"';
    writeFileSync(join(gestaltDir, 'memory.json'), broken, 'utf-8');

    store.addSpec({
      specId: 'new',
      goal: 'G',
      createdAt: new Date().toISOString(),
      sourceType: 'text',
    });

    const backups = readdirSync(gestaltDir).filter((n) => n.startsWith('memory.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(gestaltDir, backups[0]!), 'utf-8')).toBe(broken);
    expect(store.read().specHistory.map((s) => s.specId)).toEqual(['new']);
  });

  it('잠금 없이 읽을 때는 깨진 memory.json을 옮기지 않는다', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const gestaltDir = join(tmpDir, '.gestalt');
    mkdirSync(gestaltDir, { recursive: true });
    writeFileSync(join(gestaltDir, 'memory.json'), '{"specHistory": [', 'utf-8');

    expect(store.read().specHistory).toHaveLength(0);
    expect(readdirSync(gestaltDir)).toEqual(['memory.json']);
  });

  it('읽기 자체가 실패하면 쓰기를 멈추고 파일을 옮기지 않는다', () => {
    const gestaltDir = join(tmpDir, '.gestalt');
    // 디렉토리를 파일 자리에 두면 readFileSync가 EISDIR로 실패한다
    mkdirSync(join(gestaltDir, 'memory.json'), { recursive: true });

    expect(() =>
      store.addSpec({ specId: 'x', goal: 'G', createdAt: '', sourceType: 'text' }),
    ).toThrow();
    expect(readdirSync(gestaltDir)).toEqual(['memory.json']);
  });

  it('배열이 아닌 compressedContexts는 비우고 다시 기록한다', () => {
    mkdirSync(join(tmpDir, '.gestalt'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.gestalt', 'memory.json'),
      '{"specHistory":[],"compressedContexts":"oops"}',
      'utf-8',
    );

    store.addCompressedContext('s1', 'summary');
    expect(store.read().compressedContexts?.map((c) => c.sessionId)).toEqual(['s1']);
  });

  it('배열이 빠진 memory.json은 빈 배열로 채워 읽는다', () => {
    mkdirSync(join(tmpDir, '.gestalt'), { recursive: true });
    writeFileSync(join(tmpDir, '.gestalt', 'memory.json'), '{"version":"1.0.0"}', 'utf-8');

    store.addExecution({
      executeSessionId: 'e1',
      specId: 's1',
      completedTasks: [],
      failedTasks: [],
      resultSummary: '',
      completedAt: new Date().toISOString(),
    });

    expect(store.read().executionHistory).toHaveLength(1);
    expect(store.read().specHistory).toHaveLength(0);
  });

  it('쓰고 나면 임시 파일과 잠금이 안 남는다', () => {
    store.addSpec({
      specId: randomUUID(),
      goal: 'G',
      createdAt: new Date().toISOString(),
      sourceType: 'text',
    });

    expect(readdirSync(join(tmpDir, '.gestalt'))).toEqual(['memory.json']);
  });

  it('여러 프로세스가 동시에 기록해도 항목이 안 사라진다', async () => {
    const script = join(tmpDir, 'add-specs.mjs');
    writeFileSync(
      script,
      `const { ProjectMemoryStore } = await import(${JSON.stringify(STORE_MODULE_URL)});\n` +
        `const store = new ProjectMemoryStore(process.argv[2]);\n` +
        `for (let i = 0; i < 15; i++) store.addSpec({ specId: process.argv[3] + '-' + i, goal: 'g', createdAt: '', sourceType: 'text' });\n`,
      'utf-8',
    );

    const workers = ['a', 'b', 'c', 'd'];
    await Promise.all(workers.map((w) => promisify(execFile)(TSX_BIN, [script, tmpDir, w])));

    // 잠금 없이 읽고 고쳐 쓰면 늦게 쓴 쪽이 먼저 쓴 쪽의 항목을 덮어 60개보다 적게 남는다
    expect(store.read().specHistory).toHaveLength(workers.length * 15);
  }, 60_000);

  it('returns repoRoot', () => {
    expect(store.getRepoRoot()).toBe(tmpDir);
  });
});
