import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReviewContextCollector } from '../../../src/review/context-collector.js';
import type { Spec, TaskExecutionResult } from '../../../src/core/types.js';

vi.mock('../../../src/code-graph/engine.js', () => ({
  codeGraphEngine: {
    dbExists: vi.fn().mockReturnValue(false),
    blastRadius: vi.fn().mockReturnValue({
      changedFiles: [],
      impactedFiles: [],
      impactedNodes: [],
      riskScore: 0,
      maxDepthUsed: 0,
      summary: '',
    }),
  },
}));

import { codeGraphEngine } from '../../../src/code-graph/engine.js';

const mockDbExists = vi.mocked(codeGraphEngine.dbExists);
const mockBlastRadius = vi.mocked(codeGraphEngine.blastRadius);

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

  beforeEach(() => {
    mockDbExists.mockReturnValue(false);
    mockBlastRadius.mockReturnValue({
      changedFiles: [],
      impactedFiles: [],
      impactedNodes: [],
      riskScore: 0,
      maxDepthUsed: 0,
      summary: '',
    });
  });

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
      const ctx = collector.collectFromFiles(['src/z.ts', 'src/a.ts', 'src/m.ts'], '/repo');

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

  describe('extractDependenciesFromGraph (code graph path)', () => {
    it('returns [] when DB does not exist', () => {
      mockDbExists.mockReturnValue(false);

      const taskResults: TaskExecutionResult[] = [
        { taskId: 't1', status: 'completed', output: '', artifacts: ['src/a.ts'] },
      ];

      const ctx = collector.collect(mockSpec, taskResults, '/repo');
      expect(ctx.dependencyFiles).toEqual([]);
    });

    it('returns impactedFiles excluding changedFiles when DB exists', () => {
      mockDbExists.mockReturnValue(true);
      mockBlastRadius.mockReturnValue({
        changedFiles: ['/repo/src/a.ts'],
        impactedFiles: ['/repo/src/a.ts', '/repo/src/b.ts', '/repo/src/c.ts'],
        impactedNodes: [],
        riskScore: 0.2,
        maxDepthUsed: 2,
        summary: '',
      });

      const changedFiles = ['/repo/src/a.ts'];
      const taskResults: TaskExecutionResult[] = [
        { taskId: 't1', status: 'completed', output: '', artifacts: changedFiles },
      ];

      const ctx = collector.collect(mockSpec, taskResults, '/repo');
      expect(ctx.dependencyFiles).toEqual(['/repo/src/b.ts', '/repo/src/c.ts']);
      expect(ctx.dependencyFiles).not.toContain('/repo/src/a.ts');
    });

    it('returns [] when blastRadius throws', () => {
      mockDbExists.mockReturnValue(true);
      mockBlastRadius.mockImplementation(() => {
        throw new Error('DB error');
      });

      const taskResults: TaskExecutionResult[] = [
        { taskId: 't1', status: 'completed', output: '', artifacts: ['src/a.ts'] },
      ];

      const ctx = collector.collect(mockSpec, taskResults, '/repo');
      expect(ctx.dependencyFiles).toEqual([]);
    });

    it('uses output regex fallback when repoRoot is not provided', () => {
      mockDbExists.mockClear();

      const taskResults: TaskExecutionResult[] = [
        {
          taskId: 't1',
          status: 'completed',
          output: 'import { foo } from "./utils/helper.js"',
          artifacts: ['src/a.ts'],
        },
      ];

      // repoRoot 미전달 → 정규식 fallback → dbExists 호출 안 함
      const ctx = collector.collect(mockSpec, taskResults);
      expect(mockDbExists).not.toHaveBeenCalled();
      expect(ctx.dependencyFiles).toContain('./utils/helper.js');
    });
  });
});
