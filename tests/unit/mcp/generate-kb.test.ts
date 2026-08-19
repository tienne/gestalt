import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadConfig } from '../../../src/core/config.js';
import type { KnowledgeEntry } from '../../../src/knowledge-base/types.js';

// 이 핸들러의 계약은 "frugal tier가 없으면 기존 동작 그대로"다. 실제 코드 그래프나
// 임베딩 모델을 돌리지 않고 그 분기만 보려고 주변 모듈을 전부 대역으로 세운다.
const generateFromCodeGraph = vi.hoisted(() => vi.fn());
const writeKnowledgeBase = vi.hoisted(() => vi.fn());
const summarizeEntries = vi.hoisted(() => vi.fn());
const embedBatch = vi.hoisted(() => vi.fn());
const saveEmbeddingIndex = vi.hoisted(() => vi.fn());

vi.mock('../../../src/knowledge-base/generator.js', () => ({ generateFromCodeGraph }));
vi.mock('../../../src/knowledge-base/writer.js', () => ({ writeKnowledgeBase }));
vi.mock('../../../src/knowledge-base/summarizer.js', () => ({ summarizeEntries }));
vi.mock('../../../src/knowledge-base/embedding-index.js', () => ({ saveEmbeddingIndex }));
vi.mock('../../../src/knowledge-base/embedding.js', () => ({
  EmbeddingService: class {
    embedBatch = embedBatch;
  },
}));

const { handleGenerateKb } = await import('../../../src/mcp/tools/generate-kb.js');

const isolated = { skipDotEnv: true, skipGestaltJson: true } as const;

function entry(title: string): KnowledgeEntry {
  return {
    id: `id-${title}`,
    type: 'code-graph',
    title,
    content: `## ${title}`,
    filePath: `.gestalt-kb/code-graph/id-${title}.md`,
    createdAt: '2026-01-01T00:00:00.000Z',
    tags: ['code-graph'],
  };
}

describe('handleGenerateKb — frugal tier 분기', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generateFromCodeGraph.mockResolvedValue([entry('a.ts'), entry('b.ts')]);
    writeKnowledgeBase.mockResolvedValue(undefined);
    saveEmbeddingIndex.mockResolvedValue(undefined);
    embedBatch.mockResolvedValue([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    summarizeEntries.mockResolvedValue({ summarized: 2, failedBatches: 0 });
  });

  it('config를 안 넘기면 요약 단계를 건너뛴다', async () => {
    const raw = await handleGenerateKb({ repoRoot: '/repo' }, '/cwd');

    expect(summarizeEntries).not.toHaveBeenCalled();
    expect(JSON.parse(raw).entriesSummarized).toBe(0);
  });

  it('llm.frugal이 없으면 요약 단계를 건너뛴다 (기존 동작 그대로)', async () => {
    const config = loadConfig({ llm: { apiKey: 'sk-ant-test' } }, isolated);

    const raw = await handleGenerateKb({ repoRoot: '/repo' }, '/cwd', config);

    expect(summarizeEntries).not.toHaveBeenCalled();
    const result = JSON.parse(raw);
    expect(result.entriesSummarized).toBe(0);
    expect(result.entriesGenerated).toBe(2);
    expect(writeKnowledgeBase).toHaveBeenCalledOnce();
  });

  it('llm.frugal이 있으면 요약하고 그 개수를 응답에 싣는다', async () => {
    const config = loadConfig(
      {
        llm: {
          apiKey: 'sk-ant-test',
          frugal: { provider: 'anthropic', model: 'claude-haiku-4-5' },
        },
      },
      isolated,
    );

    const raw = await handleGenerateKb({ repoRoot: '/repo' }, '/cwd', config);

    expect(summarizeEntries).toHaveBeenCalledOnce();
    expect(JSON.parse(raw).entriesSummarized).toBe(2);
  });

  it('요약이 붙은 content로 임베딩을 계산한다', async () => {
    const config = loadConfig(
      {
        llm: {
          apiKey: 'sk-ant-test',
          frugal: { provider: 'anthropic', model: 'claude-haiku-4-5' },
        },
      },
      isolated,
    );
    // summarizeEntries는 엔트리를 제자리에서 고친다. 그 결과가 임베딩 텍스트에 실려야
    // 이름이 안 겹치는 질의가 검색에 걸린다는 이 기능의 목적이 성립한다.
    summarizeEntries.mockImplementation((entries: KnowledgeEntry[]) => {
      for (const e of entries) e.content = `<!-- summary -->\n토큰을 검증한다.\n\n${e.content}`;
      return Promise.resolve({ summarized: entries.length, failedBatches: 0 });
    });

    await handleGenerateKb({ repoRoot: '/repo' }, '/cwd', config);

    const texts = embedBatch.mock.calls[0]![0] as string[];
    expect(texts[0]).toContain('토큰을 검증한다.');
  });

  it('엔트리가 0개면 frugal이 있어도 요약을 안 부른다', async () => {
    generateFromCodeGraph.mockResolvedValue([]);
    embedBatch.mockResolvedValue([]);
    const config = loadConfig(
      {
        llm: {
          apiKey: 'sk-ant-test',
          frugal: { provider: 'anthropic', model: 'claude-haiku-4-5' },
        },
      },
      isolated,
    );

    const raw = await handleGenerateKb({ repoRoot: '/repo' }, '/cwd', config);

    expect(summarizeEntries).not.toHaveBeenCalled();
    expect(JSON.parse(raw).entriesGenerated).toBe(0);
  });
});
