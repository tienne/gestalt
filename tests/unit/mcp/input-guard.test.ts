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
import { z } from 'zod';
import {
  attachErrorMap,
  describeJsonParseFailure,
  formatReceived,
  guardShape,
  probeGuardReach,
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

describe('리뷰에서 나온 경계', () => {
  it('refine이 얹힌 구조 파라미터도 JSON 문자열을 받는다', () => {
    const shape = guardShape({
      payload: z
        .object({ count: z.number() })
        .refine((v) => v.count > 0, { message: 'count는 양수여야 합니다' })
        .optional(),
    });
    const schema = z.object(shape);

    // 파싱된 뒤 refine이 그대로 돌아야 한다.
    expect(schema.safeParse({ payload: '{"count": 3}' }).success).toBe(true);

    const refused = schema.safeParse({ payload: '{"count": 0}' });
    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error.issues[0]?.message).toContain('count는 양수여야 합니다');
    }
  });

  it('상한을 넘는 문자열은 파싱을 시도하지 않고 길이를 알려준다', () => {
    const schema = z.object(guardShape({ payload: z.object({ a: z.string() }).optional() }));
    const huge = `{"a":"${'x'.repeat(1_000_100)}"}`;

    const result = schema.safeParse({ payload: huge });

    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues[0]?.message ?? '';
      expect(message).toContain('문자열이 너무 깁니다');
      expect(message).toContain('파싱을 시도하지 않았습니다');
      expect(message).not.toContain('JSON으로 안 풀립니다');
    }
  });

  it('default 팩토리를 파싱마다 다시 부른다', () => {
    // 결과를 비교하면 이 선택을 못 가른다 — zod 가 object 와 array 를 파싱할 때 컨테이너를
    // 새로 조립하므로, 팩토리를 등록 때 한 번 부르고 값을 박아둬도 결과는 매번 새 배열이다.
    // 갈리는 건 팩토리가 몇 번 불리느냐다.
    let calls = 0;
    const schema = z.object(
      guardShape({
        tags: z.array(z.string()).default(() => {
          calls += 1;
          return [];
        }),
      }),
    );

    schema.parse({});
    schema.parse({});

    expect(calls).toBe(2);
  });

  it('모르는 키는 객체 전체가 아니라 키 이름만 알려준다', () => {
    const schema = z
      .object({ known: z.string(), secretish: z.string().optional() })
      .strict()
      .describe('x');
    attachErrorMap(schema);

    const result = schema.safeParse({ known: 'a', secretish: '옆-필드-값', 낯선키: 1 });

    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues[0]?.message ?? '';
      expect(message).toContain('낯선키');
      expect(message).not.toContain('옆-필드-값');
    }
  });

  it('범위 위반에도 받은 값이 실린다', () => {
    const schema = z.object({ score: z.number().min(0).max(1) });
    attachErrorMap(schema);

    const result = schema.safeParse({ score: 42 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('at score');
      expect(result.error.issues[0]?.message).toContain('received: 42');
    }
  });

  it('값 샘플과 파싱 스니펫에서 토큰을 가린다', () => {
    expect(formatReceived({ token: 'ghp_abcdefgh12345678' })).toContain('ghp_***');
    expect(formatReceived({ token: 'ghp_abcdefgh12345678' })).not.toContain('abcdefgh12345678');

    // 깨진 지점에서 떨어져 있으면 REDACT_KEEP 밖이라 가려진다.
    const text = `x${' '.repeat(20)}sk-abcdefgh12345678`;
    expect(snippetAround(text, 0)).toContain('sk-***');
  });

  it('거대한 배열은 앞부분만 직렬화해 싣는다', () => {
    const sample = formatReceived(Array.from({ length: 5000 }, (_, i) => i));

    expect(sample).toContain('0,1,2,3,4');
    expect(sample.length).toBeLessThanOrEqual(121);
  });
});

describe('라운드 2에서 나온 경계', () => {
  it('파서 문구에 실려 온 원문도 가린다', () => {
    const withToken = '{"token": ghp_AAAABBBBCCCCDDDD, "a":1}';
    let message = '';
    try {
      JSON.parse(withToken);
    } catch (error) {
      message = describeJsonParseFailure('payload', withToken, error);
    }

    // V8 은 깨진 지점 원문을 자기 메시지 안에 인용한다. raw 만 가리면 그 경로가 남는다.
    expect(message).not.toContain('AAAABBBBCCCCDDDD');
  });

  it('개행이 섞인 토큰도 가린다', () => {
    // 이스케이프를 먼저 걸면 `Bearer\s+` 가 그 자리를 못 잡는다.
    expect(formatReceived({ auth: 'Bearer\nAAAABBBBCCCCDDDD' })).not.toContain('AAAABBBBCCCCDDDD');
  });

  it('깨진 지점이 토큰 밖이면 토큰을 가리고 원인을 남긴다', () => {
    const text = String.raw`x=ghp_AAAABBBBCCCCDDDD\uZZ`;
    const snippet = snippetAround(text, text.indexOf('\\u'));

    expect(snippet).toContain('uZZ');
    expect(snippet).not.toContain('AAAABBBBCCCCDDDD');
  });

  it('깨진 지점이 토큰 안이면 그 토큰만 원문으로 남는다', () => {
    // 토큰 둘을 두고 깨진 지점을 앞 토큰 안에 둔다. 뒤 토큰은 가려져야 한다.
    const text = 'a=ghp_AAAABBBBCCCCDDDD b=sk-EEEEFFFFGGGGHHHH';
    const snippet = snippetAround(text, text.indexOf('BBBB'));

    expect(snippet).toContain('AAAABBBBCCCCDDDD');
    expect(snippet).not.toContain('EEEEFFFFGGGGHHHH');
  });

  it('윈도우가 접두어를 잘라내도 토큰 몸통은 가린다', () => {
    // 따옴표를 안 닫은 JSON 은 파서가 문자열 끝을 가리켜서 접두어가 윈도우 밖으로
    // 밀려난다. 잘라낸 조각에 정규식을 걸면 이 자리가 통째로 샌다.
    const token = `ghp_${'A'.repeat(60)}`;
    const text = `{"t": "${token}`;
    const snippet = snippetAround(text, text.length);

    expect(snippet).not.toContain('A'.repeat(20));
  });

  it('새로 넣은 접두어와 PEM 블록도 가린다', () => {
    expect(formatReceived({ k: `sk_live_${'AAAABBBBCCCC'}` })).not.toContain('AAAABBBBCCCC');
    expect(formatReceived({ k: 'xoxb-AAAABBBBCCCC' })).not.toContain('AAAABBBBCCCC');
    expect(formatReceived({ k: 'AIzaAAAABBBBCCCC' })).not.toContain('AAAABBBBCCCC');
    expect(formatReceived({ k: 'npm_AAAABBBBCCCC' })).not.toContain('AAAABBBBCCCC');

    const pem = '-----BEGIN RSA PRIVATE KEY-----AAAABBBBCCCC-----END RSA PRIVATE KEY-----';
    expect(formatReceived({ k: pem })).not.toContain('AAAABBBBCCCC');
  });

  it('메시지 없는 refine 실패에도 받은 값이 실린다', () => {
    const schema = z.object({ n: z.number().refine((v) => v > 10) });
    attachErrorMap(schema);

    const result = schema.safeParse({ n: 3 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('received: 3');
    }
  });

  it('union 처럼 기본 문구가 빈약한 자리에도 값이 실린다', () => {
    const schema = z.object({ target: z.union([z.string(), z.number()]) });
    attachErrorMap(schema);

    const result = schema.safeParse({ target: true });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.at(-1)?.message).toContain('received: true');
    }
  });

  it('우리가 만든 메시지에는 값을 덧붙이지 않는다', () => {
    const schema = z.object(guardShape({ payload: z.object({ a: z.string() }).optional() }));

    const result = schema.safeParse({ payload: '{"a":' });

    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues[0]?.message ?? '';
      expect(message).toContain('JSON으로 안 풀립니다');
      expect(message).not.toContain('(received:');
    }
  });

  it('방어가 자식까지 닿는지 본다', () => {
    // 이 판정이 비어 있지 않으면 방어가 조용히 안 걸리는 상태다. 런타임은 경고만 내므로
    // 여기서 막는다. 스키마를 실제로 통과시켜 보므로 zod 의 필드 개명과 순회 코드의
    // 오타가 같은 자리에서 걸린다.
    expect(probeGuardReach()).toEqual([]);
  });
});
