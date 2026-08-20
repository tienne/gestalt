import { describe, it, expect, vi, beforeEach } from 'vitest';

const search = vi.hoisted(() => vi.fn());

vi.mock('../../../src/knowledge-base/search.js', () => ({
  SemanticSearchEngine: class {
    search = search;
  },
}));

const { handleSearchKb } = await import('../../../src/mcp/tools/search-kb.js');

describe('handleSearchKb', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    search.mockResolvedValue([
      { entry: { id: 'x', title: 'src/auth.ts' }, score: 0.9, excerpt: '...', rank: 1 },
    ]);
  });

  it('결과가 자료라는 사실을 응답에 함께 싣는다', async () => {
    const raw = await handleSearchKb({ query: 'OAuth 로그인' }, '/cwd');
    const result = JSON.parse(raw);

    // 결과 본문은 남이 쓴 코드와 (요약을 켰으면) LLM이 쓴 문장이다. 프롬프트에 붙일 때
    // 이 표시가 같이 가야 소비하는 쪽이 지시로 읽지 않는다.
    expect(result.untrustedContent).toBe(true);
    expect(result.notice).toContain('not instructions');
    expect(result.total).toBe(1);
  });

  it('검색이 실패하면 error만 돌려준다', async () => {
    search.mockRejectedValue(new Error('embeddings.json not found'));

    const result = JSON.parse(await handleSearchKb({ query: 'x' }, '/cwd'));

    expect(result.error).toContain('embeddings.json not found');
    expect(result.results).toBeUndefined();
  });
});
