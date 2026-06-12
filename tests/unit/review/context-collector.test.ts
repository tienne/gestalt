import { describe, it, expect } from 'vitest';
import { ReviewContextCollector } from '../../../src/review/context-collector.js';
import type { Spec, TaskExecutionResult } from '../../../src/core/types.js';

const mockSpec: Spec = {
  version: '1.0.0',
  goal: 'Test',
  constraints: [],
  acceptanceCriteria: [],
  ontologySchema: { entities: [], relations: [] },
  gestaltAnalysis: [],
  metadata: { specId: 's1', interviewSessionId: 'i1', resolutionScore: 0.9, generatedAt: '' },
};

describe('ReviewContextCollector', () => {
  const collector = new ReviewContextCollector();

  it('extracts changed files from task artifacts', () => {
    const taskResults: TaskExecutionResult[] = [
      {
        taskId: 't1',
        status: 'completed',
        output: '',
        artifacts: ['src/auth/login.ts', 'src/auth/session.ts'],
      },
      { taskId: 't2', status: 'completed', output: '', artifacts: ['src/api/routes.ts'] },
    ];

    const ctx = collector.collect(mockSpec, taskResults);

    expect(ctx.changedFiles).toEqual([
      'src/api/routes.ts',
      'src/auth/login.ts',
      'src/auth/session.ts',
    ]);
  });

  it('deduplicates file paths', () => {
    const taskResults: TaskExecutionResult[] = [
      { taskId: 't1', status: 'completed', output: '', artifacts: ['src/a.ts'] },
      { taskId: 't2', status: 'completed', output: '', artifacts: ['src/a.ts', 'src/b.ts'] },
    ];

    const ctx = collector.collect(mockSpec, taskResults);
    expect(ctx.changedFiles).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('extracts import dependencies from task output', () => {
    const taskResults: TaskExecutionResult[] = [
      {
        taskId: 't1',
        status: 'completed',
        output:
          'Created file with import from "./utils/hash.js" and import { foo } from "../core/types.js"',
        artifacts: ['src/auth/login.ts'],
      },
    ];

    const ctx = collector.collect(mockSpec, taskResults);
    expect(ctx.dependencyFiles).toContain('./utils/hash.js');
    expect(ctx.dependencyFiles).toContain('../core/types.js');
  });

  it('excludes node_modules imports from dependencies', () => {
    const taskResults: TaskExecutionResult[] = [
      {
        taskId: 't1',
        status: 'completed',
        output: 'import { z } from "zod"; import from "./local.js"',
        artifacts: ['src/a.ts'],
      },
    ];

    const ctx = collector.collect(mockSpec, taskResults);
    expect(ctx.dependencyFiles).not.toContain('zod');
    expect(ctx.dependencyFiles).toContain('./local.js');
  });

  it('passes through spec and taskResults', () => {
    const taskResults: TaskExecutionResult[] = [
      { taskId: 't1', status: 'completed', output: '', artifacts: [] },
    ];

    const ctx = collector.collect(mockSpec, taskResults);
    expect(ctx.spec).toBe(mockSpec);
    expect(ctx.taskResults).toBe(taskResults);
  });

  describe('collectFromFiles (direct review)', () => {
    it('returns a ReviewContext from a file list without execute session', () => {
      const ctx = collector.collectFromFiles(
        ['src/auth/jwt.ts', 'src/auth/middleware.ts'],
        '/repo',
      );

      expect(ctx.changedFiles).toEqual(['src/auth/jwt.ts', 'src/auth/middleware.ts']);
      expect(ctx.dependencyFiles).toEqual([]);
    });

    it('leaves spec and taskResults undefined', () => {
      const ctx = collector.collectFromFiles(['src/a.ts'], '/repo');

      expect(ctx.spec).toBeUndefined();
      expect(ctx.taskResults).toBeUndefined();
    });

    it('returns changedFiles sorted', () => {
      const ctx = collector.collectFromFiles(
        ['src/z.ts', 'src/a.ts', 'src/m.ts'],
        '/repo',
      );

      expect(ctx.changedFiles).toEqual(['src/a.ts', 'src/m.ts', 'src/z.ts']);
    });

    it('does not mutate the input array', () => {
      const input = ['src/z.ts', 'src/a.ts'];
      collector.collectFromFiles(input, '/repo');

      expect(input).toEqual(['src/z.ts', 'src/a.ts']);
    });

    it('handles an empty file list', () => {
      const ctx = collector.collectFromFiles([], '/repo');

      expect(ctx.changedFiles).toEqual([]);
      expect(ctx.dependencyFiles).toEqual([]);
      expect(ctx.spec).toBeUndefined();
      expect(ctx.taskResults).toBeUndefined();
    });
  });
});
