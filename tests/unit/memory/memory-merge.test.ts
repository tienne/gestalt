import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProjectMemory } from '../../../src/core/types.js';
import { mergeMemory, runMemoryMergeDriver } from '../../../src/memory/memory-merge.js';

function memory(overrides: Partial<ProjectMemory> = {}): ProjectMemory {
  return {
    version: '1.0.0',
    repoRoot: '/repo',
    specHistory: [],
    executionHistory: [],
    architectureDecisions: [],
    lastUpdated: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const spec = (specId: string) => ({
  specId,
  goal: specId,
  createdAt: '2026-01-01T00:00:00.000Z',
  sourceType: 'interview' as const,
});

describe('mergeMemory', () => {
  it('양쪽 기록을 키 기준 합집합으로 합친다', () => {
    const merged = mergeMemory(
      memory({
        specHistory: [spec('a'), spec('b')],
        compressedContexts: [{ sessionId: 's1', summary: 'local', compressedAt: 't' }],
      }),
      memory({
        specHistory: [spec('b'), spec('c')],
        compressedContexts: [{ sessionId: 's1', summary: 'remote', compressedAt: 't' }],
      }),
    );
    expect(merged.specHistory.map((s) => s.specId)).toEqual(['b', 'c', 'a']);
    expect(merged.compressedContexts).toEqual([
      { sessionId: 's1', summary: 'remote', compressedAt: 't' },
    ]);
  });

  it('같은 결정은 timestamp가 달라도 하나만 남기고 outcome이 있는 쪽을 고른다', () => {
    const decision = { decision: 'Use WAL', rationale: 'r', specId: 'a' };
    const merged = mergeMemory(
      memory({
        architectureDecisions: [
          { ...decision, outcome: 'worked', timestamp: '2026-01-02T00:00:00.000Z' },
        ],
      }),
      memory({ architectureDecisions: [{ ...decision, timestamp: '2026-01-01T00:00:00.000Z' }] }),
    );
    expect(merged.architectureDecisions).toHaveLength(1);
    expect(merged.architectureDecisions[0]!.outcome).toBe('worked');
  });

  it('lastUpdated는 더 최신 값을 쓴다', () => {
    const merged = mergeMemory(
      memory({ lastUpdated: '2026-01-01T00:00:00.000Z' }),
      memory({ lastUpdated: '2026-02-01T00:00:00.000Z' }),
    );
    expect(merged.lastUpdated).toBe('2026-02-01T00:00:00.000Z');
  });
});

describe('runMemoryMergeDriver', () => {
  const dir = join('.gestalt-test', `memory-merge-${randomUUID()}`);

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('합친 결과를 ours 파일에 쓰고 v1 문자열 결정도 읽는다', () => {
    mkdirSync(dir, { recursive: true });
    const ours = join(dir, 'ours.json');
    const theirs = join(dir, 'theirs.json');
    writeFileSync(
      ours,
      JSON.stringify({
        ...memory({ specHistory: [spec('a')] }),
        architectureDecisions: ['Use pnpm'],
      }),
    );
    writeFileSync(theirs, JSON.stringify(memory({ specHistory: [spec('b')] })));

    runMemoryMergeDriver(ours, theirs);

    const written = JSON.parse(readFileSync(ours, 'utf-8')) as ProjectMemory;
    expect(written.specHistory.map((s) => s.specId)).toEqual(['b', 'a']);
    expect(written.architectureDecisions[0]!.decision).toBe('Use pnpm');
  });

  it('JSON이 깨져 있으면 던지고 ours를 건드리지 않는다', () => {
    mkdirSync(dir, { recursive: true });
    const ours = join(dir, 'ours.json');
    const theirs = join(dir, 'theirs.json');
    writeFileSync(ours, '{"broken"');
    writeFileSync(theirs, JSON.stringify(memory()));

    expect(() => runMemoryMergeDriver(ours, theirs)).toThrow();
    expect(readFileSync(ours, 'utf-8')).toBe('{"broken"');
  });
});
