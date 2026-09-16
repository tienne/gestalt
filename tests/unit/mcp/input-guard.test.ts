/**
 * MCP 입력 검증이 진짜 원인을 돌려주는지 본다.
 *
 * 왕복은 실제 MCP 클라이언트로 건다. SDK가 우리 핸들러보다 먼저 검증하므로
 * 스키마만 직접 `.parse()` 해서는 부르는 쪽이 실제로 받는 문구를 못 본다.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../../src/mcp/server.js';
import {
  describeJsonParseFailure,
  formatReceived,
  snippetAround,
} from '../../../src/mcp/input-guard.js';

const dbPaths: string[] = [];

function dbPath(): string {
  const path = `.gestalt-test/input-guard-${randomUUID()}.db`;
  dbPaths.push(path);
  return path;
}

afterEach(() => {
  for (const path of dbPaths) {
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${path}${suffix}`;
      if (existsSync(file)) rmSync(file);
    }
  }
  dbPaths.length = 0;
});

async function withServer(fn: (client: Client) => Promise<void>): Promise<void> {
  const { server, eventStore } = await createMcpServer({
    dbPath: dbPath(),
    llm: { apiKey: '', model: 'test-model' },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'input-guard-test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    await fn(client);
  } finally {
    await client.close();
    eventStore.close();
  }
}

/** 도구를 부르고 부르는 쪽이 실제로 받는 텍스트를 돌려준다. */
async function callText(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    const result = await client.callTool({ name, arguments: args });
    return (result.content as Array<{ text?: string }>)[0]?.text ?? '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// 한글을 부분적으로만 이스케이프하다 남은 잔재. `\u` 뒤에 16진수 4자리가 없다.
const BROKEN_JSON = `{"issues": [{"id": "i1", "severity": "high", "category": "ui", "file": "a.tsx", "message": "m", "suggestion": "'구조, 간격, 토큰을 그대로'로 \\ud푼다."}], "approved": false, "summary": "s"}`;

describe('깨진 JSON 문자열', () => {
  it('타입 에러로 둔갑하지 않고 파서 원본 에러를 돌려준다', async () => {
    await withServer(async (client) => {
      const text = await callText(client, 'ges_execute', {
        action: 'review_submit',
        reviewSessionId: 'no-such-session',
        reviewAgentName: 'frontend-reviewer',
        reviewResult: BROKEN_JSON,
      });

      expect(text).not.toContain('Expected object, received string');
      expect(text).toContain('reviewResult');
      expect(text).toContain('JSON으로 안 풀립니다');
      // 파서가 실제로 문제 삼은 자리 — 런타임 문구는 달라도 위치는 실린다.
      expect(text).toMatch(/position \d+/);
    });
  });

  it('깨진 지점 주변을 잘라 보여준다', async () => {
    await withServer(async (client) => {
      const text = await callText(client, 'ges_execute', {
        action: 'review_submit',
        reviewSessionId: 'no-such-session',
        reviewAgentName: 'frontend-reviewer',
        reviewResult: BROKEN_JSON,
      });

      expect(text).toContain('깨진 지점 주변');
      expect(text).toContain('푼다');
    });
  });

  it('멀쩡한 JSON 문자열은 객체로 풀어 검증을 통과시킨다', async () => {
    await withServer(async (client) => {
      const text = await callText(client, 'ges_execute', {
        action: 'review_submit',
        reviewSessionId: 'no-such-session',
        reviewAgentName: 'frontend-reviewer',
        reviewResult: JSON.stringify({ issues: [], approved: true, summary: 'ok' }),
      });

      // 검증을 통과해 핸들러까지 갔다는 뜻 — 세션이 없다는 도메인 에러가 나온다.
      expect(text).not.toContain('Invalid arguments');
      expect(text).toContain('error');
    });
  });
});

describe('스키마 에러', () => {
  it('타입이 어긋나면 실제 받은 값과 경로를 함께 싣는다', async () => {
    await withServer(async (client) => {
      const text = await callText(client, 'ges_execute', {
        action: 'review_consensus',
        reviewSessionId: 'no-such-session',
        reviewConsensus: {
          mergedIssues: [
            {
              id: 'i1',
              severity: 'high',
              category: 'ui',
              file: 'a.tsx',
              message: 'm',
              suggestion: 's',
              reportedBy: ['harness-architect', 'quality-reviewer'],
            },
          ],
          approvedBy: [],
          blockedBy: ['frontend-reviewer'],
          summary: 's',
          overallApproved: false,
        },
      });

      expect(text).toContain('reviewConsensus.mergedIssues[0].reportedBy');
      // 값 샘플은 SDK가 한 번 더 직렬화할 수 있어 따옴표 이스케이프는 따지지 않는다.
      expect(text).toContain('received:');
      expect(text).toContain('harness-architect');
      expect(text).toContain('quality-reviewer');
    });
  });

  it('필수 필드가 빠지면 어떤 타입을 기대하는지 같이 알려준다', async () => {
    await withServer(async (client) => {
      const text = await callText(client, 'ges_execute', {
        action: 'review_consensus',
        reviewSessionId: 'no-such-session',
        reviewConsensus: {
          mergedIssues: [
            {
              id: 'i1',
              severity: 'high',
              category: 'ui',
              file: 'a.tsx',
              message: 'm',
              suggestion: 's',
            },
          ],
          approvedBy: [],
          blockedBy: [],
          summary: 's',
          overallApproved: false,
        },
      });

      expect(text).toContain('Required at reviewConsensus.mergedIssues[0].reportedBy');
      expect(text).toContain('expected: string');
    });
  });
});

describe('다른 도구도 같은 방어를 받는다', () => {
  it('ges_code_graph 의 배열 파라미터도 JSON 문자열을 받는다', async () => {
    await withServer(async (client) => {
      const text = await callText(client, 'ges_code_graph', {
        action: 'db_exists',
        repoRoot: process.cwd(),
        include: '["src/**"]',
      });

      expect(text).not.toContain('Invalid arguments');
    });
  });

  it('ges_interview 의 깨진 JSON 문자열도 파서 에러를 돌려준다', async () => {
    await withServer(async (client) => {
      const text = await callText(client, 'ges_interview', {
        action: 'score',
        sessionId: 'no-such-session',
        resolutionScore: '{"goalClarity": 0.9, "constraintClarity": 0.8,',
      });

      expect(text).toContain('resolutionScore');
      expect(text).toContain('JSON으로 안 풀립니다');
    });
  });
});

describe('도구 스키마 노출', () => {
  it('JSON 문자열을 허용해도 스키마는 object 로 남고 필수 여부도 그대로다', async () => {
    await withServer(async (client) => {
      const tools = await client.listTools();
      const execute = tools.tools.find((tool) => tool.name === 'ges_execute');
      const schema = execute?.inputSchema as {
        properties?: Record<string, { type?: string; description?: string }>;
        required?: string[];
      };

      expect(schema.properties?.['reviewResult']?.type).toBe('object');
      expect(schema.properties?.['reviewResult']?.description).toContain('review_submit');
      expect(schema.required).toEqual(['action']);
    });
  });
});

describe('메시지 조립', () => {
  it('깨진 지점 앞뒤만 잘라내고 잘린 쪽을 표시한다', () => {
    const text = `${'a'.repeat(100)}X${'b'.repeat(100)}`;
    const snippet = snippetAround(text, 100);

    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet).toContain('X');
    expect(snippet.length).toBeLessThan(100);
  });

  it('개행은 눈에 보이게 바꾼다', () => {
    expect(snippetAround('a\nb', 1)).toBe('a\\nb');
  });

  it('위치를 못 뽑으면 길이라도 알려준다', () => {
    const message = describeJsonParseFailure('x', 'abc', new Error('총체적 난국'));

    expect(message).toContain('총체적 난국');
    expect(message).toContain('길이 3자');
  });

  it('값 샘플은 길면 자른다', () => {
    expect(formatReceived(['a', 'b'])).toBe('["a","b"]');
    expect(formatReceived('x'.repeat(500)).endsWith('…')).toBe(true);
  });
});
