/**
 * ges_code_graph 질의 액션이 답하기 전에 최신화를 거치는지, 끄는 스위치가 먹는지.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleCodeGraphPassthrough } from '../../../src/mcp/tools/code-graph-passthrough.js';
import { codeGraphEngine } from '../../../src/code-graph/index.js';
import type { FreshnessReport } from '../../../src/code-graph/index.js';

const FRESH: FreshnessReport = { status: 'fresh', checkedFiles: 3, durationMs: 1 };

function stubQueries(): void {
  vi.spyOn(codeGraphEngine, 'blastRadius').mockReturnValue(
    {} as ReturnType<typeof codeGraphEngine.blastRadius>,
  );
  vi.spyOn(codeGraphEngine, 'diffRadius').mockReturnValue(
    {} as ReturnType<typeof codeGraphEngine.diffRadius>,
  );
  vi.spyOn(codeGraphEngine, 'query').mockReturnValue({ nodes: [], edges: [] });
  vi.spyOn(codeGraphEngine, 'coChange').mockReturnValue(
    {} as ReturnType<typeof codeGraphEngine.coChange>,
  );
  vi.spyOn(codeGraphEngine, 'stats').mockReturnValue(
    {} as ReturnType<typeof codeGraphEngine.stats>,
  );
}

const QUERY_INPUTS = [
  { action: 'blast_radius' },
  { action: 'diff_radius' },
  { action: 'query', pattern: 'imports_of', target: 'a.ts' },
  { action: 'co_change' },
  { action: 'stats' },
] as const;

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['GESTALT_NO_REFRESH'];
});

describe('ges_code_graph 질의 전 최신화', () => {
  it.each(QUERY_INPUTS)('$action는 최신화 뒤 결과에 freshness를 싣는다', async (input) => {
    stubQueries();
    const refresh = vi.spyOn(codeGraphEngine, 'refresh').mockResolvedValue(FRESH);

    const result = await handleCodeGraphPassthrough({ ...input, repoRoot: '/repo' });

    expect(refresh).toHaveBeenCalledWith('/repo');
    expect(result).toMatchObject({ freshness: FRESH });
  });

  it('refresh:false면 최신화를 건너뛴다', async () => {
    stubQueries();
    const refresh = vi.spyOn(codeGraphEngine, 'refresh');

    const result = await handleCodeGraphPassthrough({
      action: 'blast_radius',
      repoRoot: '/repo',
      refresh: false,
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(result).toMatchObject({ freshness: { status: 'skipped', reason: 'disabled' } });
  });

  it('GESTALT_NO_REFRESH=1이면 최신화를 건너뛴다', async () => {
    stubQueries();
    process.env['GESTALT_NO_REFRESH'] = '1';
    const refresh = vi.spyOn(codeGraphEngine, 'refresh');

    await handleCodeGraphPassthrough({ action: 'stats', repoRoot: '/repo' });

    expect(refresh).not.toHaveBeenCalled();
  });

  it('최신화가 실패해도 이전 그래프로 답한다', async () => {
    stubQueries();
    vi.spyOn(codeGraphEngine, 'refresh').mockRejectedValue(new Error('disk gone'));

    const result = await handleCodeGraphPassthrough({ action: 'blast_radius', repoRoot: '/repo' });

    expect(result).not.toHaveProperty('error');
    expect(result).toMatchObject({ freshness: { status: 'stale', reason: 'refresh_failed' } });
  });

  it('build와 db_exists는 최신화를 거치지 않는다', async () => {
    const refresh = vi.spyOn(codeGraphEngine, 'refresh');
    vi.spyOn(codeGraphEngine, 'dbExists').mockReturnValue(false);
    vi.spyOn(codeGraphEngine, 'build').mockReturnValue({
      nodesBuilt: 0,
      edgesBuilt: 0,
      timeTakenMs: 0,
      installedHook: false,
      skippedFiles: [],
    });
    vi.spyOn(codeGraphEngine, 'buildEmbeddings').mockResolvedValue({
      embeddingsBuilt: 0,
      timeTakenMs: 0,
    });

    await handleCodeGraphPassthrough({ action: 'db_exists', repoRoot: '/repo' });
    await handleCodeGraphPassthrough({ action: 'build', repoRoot: '/repo' });

    expect(refresh).not.toHaveBeenCalled();
  });
});
