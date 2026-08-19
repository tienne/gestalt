import { describe, it, expect } from 'vitest';
import { summarizeEntries } from '../../../src/knowledge-base/summarizer.js';
import type { LLMAdapter, LLMRequest, LLMResponse } from '../../../src/llm/types.js';
import type { KnowledgeEntry } from '../../../src/knowledge-base/types.js';

class ScriptedLLM implements LLMAdapter {
  requests: LLMRequest[] = [];

  constructor(private replies: Array<string | Error>) {}

  async chat(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(request);
    const reply = this.replies[this.requests.length - 1] ?? '{"summaries": []}';
    if (reply instanceof Error) throw reply;
    return { content: reply, usage: { inputTokens: 10, outputTokens: 5 } };
  }
}

function makeEntry(title: string): KnowledgeEntry {
  return {
    id: `id-${title}`,
    type: 'code-graph',
    title,
    content: `## ${title}\n\n### Functions\n- doThing`,
    filePath: `.gestalt-kb/code-graph/id-${title}.md`,
    createdAt: '2026-01-01T00:00:00.000Z',
    tags: ['code-graph'],
  };
}

describe('summarizeEntries', () => {
  it('요약을 content 맨 앞에 끼우고 원본 본문을 남긴다', async () => {
    const entries = [makeEntry('src/a.ts'), makeEntry('src/b.ts')];
    const llm = new ScriptedLLM([
      JSON.stringify({
        summaries: [
          { path: 'src/a.ts', summary: '토큰을 검증한다.' },
          { path: 'src/b.ts', summary: '요청을 라우팅한다.' },
        ],
      }),
    ]);

    const result = await summarizeEntries(entries, llm);

    expect(result).toEqual({ summarized: 2, failedBatches: 0 });
    expect(entries[0]!.content).toContain('토큰을 검증한다.');
    expect(entries[0]!.content).toContain('### Functions');
    expect(entries[1]!.content.startsWith('<!-- summary -->')).toBe(true);
  });

  it('batchSize대로 나눠 호출한다', async () => {
    const entries = [makeEntry('a'), makeEntry('b'), makeEntry('c')];
    const llm = new ScriptedLLM([
      JSON.stringify({
        summaries: [
          { path: 'a', summary: 'A' },
          { path: 'b', summary: 'B' },
        ],
      }),
      JSON.stringify({ summaries: [{ path: 'c', summary: 'C' }] }),
    ]);

    const result = await summarizeEntries(entries, llm, { batchSize: 2 });

    expect(llm.requests).toHaveLength(2);
    expect(result.summarized).toBe(3);
  });

  it('배치가 던져도 나머지 배치는 그대로 진행한다', async () => {
    const entries = [makeEntry('a'), makeEntry('b')];
    const llm = new ScriptedLLM([
      new Error('rate limited'),
      JSON.stringify({ summaries: [{ path: 'b', summary: 'B' }] }),
    ]);

    const result = await summarizeEntries(entries, llm, { batchSize: 1 });

    expect(result).toEqual({ summarized: 1, failedBatches: 1 });
    expect(entries[0]!.content.startsWith('## a')).toBe(true); // 손대지 않았다
    expect(entries[1]!.content).toContain('B');
  });

  it('JSON이 아닌 응답은 실패로 세고 엔트리를 건드리지 않는다', async () => {
    const entries = [makeEntry('a')];
    const original = entries[0]!.content;
    const llm = new ScriptedLLM(['요약해 드릴게요! 어떤 파일인가요?']);

    const result = await summarizeEntries(entries, llm);

    expect(result).toEqual({ summarized: 0, failedBatches: 1 });
    expect(entries[0]!.content).toBe(original);
  });

  it('응답에 없는 경로는 그대로 두고 있는 것만 붙인다', async () => {
    const entries = [makeEntry('a'), makeEntry('b')];
    const llm = new ScriptedLLM([
      JSON.stringify({
        summaries: [
          { path: 'a', summary: 'A' },
          { path: 'zzz', summary: '없음' },
        ],
      }),
    ]);

    const result = await summarizeEntries(entries, llm);

    expect(result.summarized).toBe(1);
    expect(entries[1]!.content.startsWith('## b')).toBe(true);
  });

  it('본문이 길면 maxContentChars로 잘라 보낸다', async () => {
    const entry = makeEntry('big.ts');
    entry.content = 'x'.repeat(5000);
    const llm = new ScriptedLLM([JSON.stringify({ summaries: [] })]);

    await summarizeEntries([entry], llm, { maxContentChars: 100 });

    const sent = llm.requests[0]!.messages[0]!.content;
    expect(sent.length).toBeLessThan(500);
  });
});
