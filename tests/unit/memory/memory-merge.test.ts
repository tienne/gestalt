import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProjectMemory } from '../../../src/core/types.js';
import { mergeMemory, runMemoryMergeDriver } from '../../../src/memory/memory-merge.js';
import { memoryMergeCommand } from '../../../src/cli/commands/memory-merge.js';
import { createCli } from '../../../src/cli/index.js';

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

  it('같은 세션 요약은 compressedAt이 더 최신인 쪽을 남긴다', () => {
    const merged = mergeMemory(
      memory({
        compressedContexts: [{ sessionId: 's1', summary: 'newer', compressedAt: '2026-01-02' }],
      }),
      memory({
        compressedContexts: [{ sessionId: 's1', summary: 'older', compressedAt: '2026-01-01' }],
      }),
    );
    expect(merged.compressedContexts?.map((c) => c.summary)).toEqual(['newer']);
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

  it.each([
    ['theirs JSON이 깨졌을 때', '{"broken"'],
    ['배열이어야 할 필드가 객체일 때', JSON.stringify({ ...memory(), specHistory: {} })],
    ['spec 항목에 goal이 없을 때', JSON.stringify(memory({ specHistory: [{}] as never }))],
    [
      '실행 이력에 completedTasks가 없을 때',
      JSON.stringify(
        memory({
          executionHistory: [{ executeSessionId: 'x', specId: 's', completedAt: 't' }] as never,
        }),
      ),
    ],
    [
      '결정의 rationale이 문자열이 아닐 때',
      JSON.stringify(memory({ architectureDecisions: [{ decision: 'd', rationale: 1 }] as never })),
    ],
    ['루트가 null일 때', 'null'],
    ['루트가 배열일 때', '[]'],
    [
      'architectureDecisions가 객체일 때',
      JSON.stringify({ ...memory(), architectureDecisions: {} }),
    ],
    ['specHistory가 null일 때', JSON.stringify({ ...memory(), specHistory: null })],
    ['executionHistory가 null일 때', JSON.stringify({ ...memory(), executionHistory: null })],
    ['lastUpdated가 숫자일 때', JSON.stringify({ ...memory(), lastUpdated: 1 })],
  ])('%s 던지고 ours를 건드리지 않는다', (_label, theirsContent) => {
    mkdirSync(dir, { recursive: true });
    const ours = join(dir, 'ours.json');
    const theirs = join(dir, 'theirs.json');
    const original = JSON.stringify(memory({ specHistory: [spec('a')] }));
    writeFileSync(ours, original);
    writeFileSync(theirs, theirsContent);

    expect(() => runMemoryMergeDriver(ours, theirs)).toThrow(/theirs\.json/);
    expect(readFileSync(ours, 'utf-8')).toBe(original);
  });

  it('루트 구조가 틀리면 어느 자리인지 메시지에 남긴다', () => {
    mkdirSync(dir, { recursive: true });
    const ours = join(dir, 'ours.json');
    const theirs = join(dir, 'theirs.json');
    writeFileSync(ours, JSON.stringify(memory()));
    writeFileSync(theirs, '[]');

    expect(() => runMemoryMergeDriver(ours, theirs)).toThrow(/shape at \(root\)$/);
  });
});

describe('gestalt memory-merge', () => {
  const dir = join('.gestalt-test', `memory-merge-cli-${randomUUID()}`);

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function files(oursContent: string, theirsContent: string) {
    mkdirSync(dir, { recursive: true });
    const paths = {
      base: join(dir, 'base.json'),
      ours: join(dir, 'ours.json'),
      theirs: join(dir, 'theirs.json'),
    };
    writeFileSync(paths.base, JSON.stringify(memory()));
    writeFileSync(paths.ours, oursContent);
    writeFileSync(paths.theirs, theirsContent);
    return paths;
  }

  it('git이 넘기는 %O %A %B 순서대로 받아 %A에 쓴다', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const p = files(
      JSON.stringify(memory({ specHistory: [spec('a')] })),
      JSON.stringify(memory({ specHistory: [spec('b')] })),
    );

    await createCli().parseAsync(['node', 'gestalt', 'memory-merge', p.base, p.ours, p.theirs]);

    const written = JSON.parse(readFileSync(p.ours, 'utf-8')) as ProjectMemory;
    expect(written.specHistory.map((s) => s.specId)).toEqual(['b', 'a']);
    expect(process.exitCode).toBeUndefined();
  });

  it('머지에 실패하면 종료 코드 1로 끝난다', () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const p = files('{"broken"', JSON.stringify(memory()));

    memoryMergeCommand(p.ours, p.theirs);

    expect(process.exitCode).toBe(1);
  });
});
