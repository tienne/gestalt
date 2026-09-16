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
  secretPatternsForTest,
  tokenRulesForTest,
  verboseErrorMap,
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

// 표본은 접두어와 본문을 갈라 런타임에 합친다. 한 줄에 이어 붙이면 GitHub push
// protection 이 진짜 발급 키로 읽어 push 를 막는다 — 이 브랜치가 실제로 막혔다.
const withPrefix = (prefix: string, body: string) => prefix + body;
const BIG_BODY = 'AAAABBBBCCCCDDDD'.repeat(3);

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

/** 패턴마다 확실히 매치되는 표본. 그룹 위치 단언에 쓴다. */
function sampleForPattern(pattern: RegExp): string {
  if (pattern.source.includes('PRIVATE KEY')) {
    return `-----BEGIN RSA PRIVATE KEY-----${'A'.repeat(40)}-----END RSA PRIVATE KEY-----`;
  }
  // 접두어를 패턴에서 직접 뽑아 그 뒤에 넉넉한 본문을 붙인다. 표본을 손으로 고르면
  // 접두어별 하한을 올릴 때 조용히 안 걸리게 된다.
  const group = /^\(([^)]*)\)/.exec(pattern.source)?.[1] ?? '';
  const literal = group.startsWith('xox')
    ? 'xoxb-'
    : group.startsWith('Bearer')
      ? 'Bearer '
      : group;
  return `${literal}${'A'.repeat(40)}`;
}

describe('마스킹 계약', () => {
  it('모든 패턴이 접두어를 그룹 1 로 캡처한다', () => {
    // 그룹이 없는 패턴을 섞으면 String.replace 가 두 번째 인자로 매치 오프셋을 넘겨
    // 접두어가 숫자로 바뀐다. 라운드 다섯에서 실제로 그랬다.
    for (const pattern of secretPatternsForTest()) {
      // 그룹이 하나여야 replacer 의 두 번째 인자가 늘 그 그룹이다. 빈 대안을 붙여
      // 무조건 매치시키면 결과 배열 길이로 그룹 수를 셀 수 있다.
      const groups = new RegExp(`${pattern.source}|`).exec('');
      expect(groups).not.toBeNull();
      expect(groups).toHaveLength(2);

      // 그룹이 매치의 맨 앞이어야 치환 뒤에도 접두어가 남는다. source 가 `(` 로
      // 시작하는지 보는 것으로는 부족하다 — `(?<!` 나 `(?:` 도 그 검사를 통과한다.
      // 실제로 매치시켜 그룹 1 이 매치의 앞부분인지 본다.
      const sample = sampleForPattern(pattern);
      const matched = new RegExp(pattern.source, pattern.flags).exec(sample);
      expect(matched).not.toBeNull();
      if (matched) {
        expect(typeof matched[1]).toBe('string');
        expect(matched[0].startsWith(matched[1]!)).toBe(true);
      }
    }
  });

  it('암호화 PEM 도 본문과 푸터까지 가린다', () => {
    // 본문을 base64 집합으로 좁히면 Proc-Type 과 DEK-Info 의 콜론, 쉼표에서 끊긴다.
    const enc =
      '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,65C2F0AF\n\nMIIEvQSECRETBODY\n-----END RSA PRIVATE KEY-----';

    const sample = formatReceived({ k: enc });

    expect(sample).not.toContain('SECRETBODY');
    expect(sample).not.toContain('AES-128-CBC');
    expect(sample).toContain('BEGIN RSA PRIVATE KEY');
  });

  it('PEM 본문에 따옴표가 있어도 뒤가 안 남는다', () => {
    // 따옴표를 경계로 쓰면 거기서 일찍 끊긴다. formatReceived 는 stringify 를 거치므로
    // 값 안의 따옴표가 그 자리에 실제로 온다.
    const quoted = '-----BEGIN RSA PRIVATE KEY-----AAA"BBBSECRETTAIL-----END RSA PRIVATE KEY-----';

    expect(formatReceived({ k: quoted })).not.toContain('SECRETTAIL');
  });

  it('PEM 이 둘이면 사이 필드는 살아남는다', () => {
    // lazy 라서 첫 END 에서 멈춘다. 첫 BEGIN 부터 마지막 END 까지 한 덩어리로 삼키면
    // 사이에 있는 멀쩡한 값까지 가려진다.
    const payload = {
      a: '-----BEGIN RSA PRIVATE KEY-----AAAA-----END RSA PRIVATE KEY-----',
      mid: 'KEEPME',
      b: '-----BEGIN EC PRIVATE KEY-----BBBB-----END EC PRIVATE KEY-----',
    };

    const sample = formatReceived(payload);

    expect(sample).toContain('KEEPME');
    expect(sample).not.toContain('AAAA');
    expect(sample).not.toContain('BBBB');
  });

  it('PEM 본문에 토큰 접두어가 섞여도 뒤가 안 남는다', () => {
    const mixed =
      '-----BEGIN RSA PRIVATE KEY-----\nAAAA_BBBBnpm_CCCCCCCCDDDDREALTAIL\n-----END RSA PRIVATE KEY-----';

    expect(formatReceived({ k: mixed })).not.toContain('REALTAIL');
  });

  it('서비스별 진짜 키는 가린다', () => {
    for (const [key, expected] of [
      [withPrefix('sk-', 'proj0AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd'), 'sk-***'],
      [withPrefix('AKIA', 'IOSFODNN7EXAMPLE'), 'AKIA***'],
      [withPrefix('npm_', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'), 'npm_***'],
      [withPrefix('ghp_', 'AbCdEfGhIjKlMnOpQrStUvWxYz01234567'), 'ghp_***'],
      [withPrefix('sk_live_', 'AbCdEfGhIjKlMnOpQrStUv'), 'sk_live_***'],
      [withPrefix('xoxb-', '1234567890-abcdefghij'), 'xoxb-***'],
    ] as const) {
      expect(formatReceived({ k: key })).toBe(`{"k":"${expected}"}`);
    }
  });

  it('같은 서비스의 자매 접두어도 가린다', () => {
    // API 키만 덮으면 웹훅 서명 시크릿과 임시 자격증명이 남는다. whsec_ 가 새면 서명을
    // 위조해 임의 이벤트를 밀어넣을 수 있어 위험의 종류가 다르다.
    for (const [key, expected] of [
      [`whsec_${'A'.repeat(32)}`, 'whsec_***'],
      [`rk_live_${'A'.repeat(24)}`, 'rk_live_***'],
      [`rk_test_${'A'.repeat(24)}`, 'rk_test_***'],
      [`ghu_${'A'.repeat(36)}`, 'ghu_***'],
      [`ghr_${'A'.repeat(36)}`, 'ghr_***'],
      [withPrefix('xapp-', '1-A012345678-1234567890-abcdef'), 'xapp-***'],
      [withPrefix('ASIA', 'IOSFODNN7EXAMPLE'), 'ASIA***'],
    ] as const) {
      expect(formatReceived({ k: key })).toBe(`{"k":"${expected}"}`);
    }
  });

  it('ASIA 로 시작하는 짧은 말은 하한 밑으로 떨어진다', () => {
    // 하한 16 이 하는 일은 여기까지다. `ASIA_PACIFIC_SOUTHEAST_1` 처럼 열여섯 자를
    // 넘는 이름은 가려진다 — 못 가리는 쪽이 잘못 가리는 쪽보다 나쁘다는 우선순위를
    // 따른 결과다.
    for (const word of ['ASIA', 'ASIAN', 'ASIAPACIFIC', 'asia-region-1']) {
      expect(formatReceived({ k: word })).toContain(word);
    }
  });

  it('Bearer 는 짧은 불투명 토큰도 가린다', () => {
    // 서비스마다 꼴이 달라 8자짜리 공유 시크릿을 그대로 보내는 API 도 있다. 대문자로
    // 시작하는 Bearer 는 HTTP 헤더 자리라 영어 문장의 소문자 bearer 와 안 겹친다.
    expect(formatReceived({ a: 'Bearer a1b2c3' })).toBe('{"a":"Bearer ***"}');
    expect(formatReceived({ a: 'Bearer abc123xyz' })).toBe('{"a":"Bearer ***"}');
    // 하한 밑은 남는다.
    expect(formatReceived({ a: 'Bearer token' })).toContain('token');
  });

  it('하한 경계가 규칙 표와 맞는다', () => {
    // 기대값을 같은 표에서 뽑으므로 하한 값 자체는 못 고정한다. 이 판정이 잡는 건
    // 생성기가 표의 하한을 그대로 쓴다는 계약이다 — 단어 경계나 오프바이원이 다시
    // 들어오면 걸린다. 값을 박는 건 아래 잘못 가리기 판정들이 맡는다.
    for (const [prefix, minBody] of tokenRulesForTest()) {
      const literal = prefix.startsWith('xox')
        ? 'xoxb-'
        : prefix.startsWith('Bearer')
          ? 'Bearer '
          : prefix;
      const body = 'A';

      const atMin = formatReceived({ k: `${literal}${body.repeat(minBody)}` });
      expect(atMin).not.toContain(body.repeat(minBody));

      const belowMin = `${literal}${body.repeat(minBody - 1)}`;
      expect(formatReceived({ k: belowMin })).toContain(body.repeat(minBody - 1));
    }
  });

  it('Bearer JWT 는 세 조각을 다 가린다', () => {
    // 본문에 점을 안 받으면 헤더만 가려지고 payload 와 signature 가 남는다. 헤더는
    // 추측 가능하니 남은 쪽이 사실상 자격증명 전체다.
    const jwt =
      'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r';

    const sample = formatReceived({ auth: jwt });

    expect(sample).toBe('{"auth":"Bearer ***"}');
  });

  it('END 가 없는 PEM 은 뒤를 통째로 가린다', () => {
    // 받은 값 샘플과 부딪히는 자리다. 헤더가 보였다는 건 그 값이 키라는 뜻이라 노출을
    // 막는 쪽을 택했다. 다음에 종료 조건을 손댈 때 근거가 사라지지 않게 박아둔다.
    const sample = formatReceived({
      a: '-----BEGIN RSA PRIVATE KEY-----MIIabcdefgh',
      keepme: 'VISIBLE',
    });

    expect(sample).not.toContain('MIIabcdefgh');
    expect(sample).not.toContain('VISIBLE');
  });

  it('패턴 적용 순서가 결과를 안 바꾼다', () => {
    // 본문을 base64 집합으로 좁혔던 동안에는 순서가 결과를 갈랐다. 클래스를 되돌려
    // 의존이 사라졌는데, 그 사실이 주석에만 있으면 다음에 좁힐 때 조용히 되살아난다.
    const patterns = secretPatternsForTest();
    const text =
      '-----BEGIN RSA PRIVATE KEY-----\nAAAA npm_CCCCCCCCDDDDREALTAIL\n-----END RSA PRIVATE KEY-----';

    const apply = (order: RegExp[], preserve: boolean) =>
      order.reduce(
        (acc, pattern) =>
          acc.replace(new RegExp(pattern.source, pattern.flags), (match, group: unknown) => {
            const prefix = typeof group === 'string' ? group : '';
            return preserve ? prefix + '*'.repeat(match.length - prefix.length) : `${prefix}***`;
          }),
        text,
      );

    // 인덱스 둘만 집으면 배열이 늘어난 만큼 검사에서 빠진다.
    const reversed = [...patterns].reverse();
    for (const preserve of [false, true]) {
      expect(apply(patterns, preserve)).toBe(apply(reversed, preserve));
    }
  });

  it('접두어 앞에 단어 문자가 붙어도 가린다', () => {
    // 단어 경계를 그룹 앞에 두면 구분자 없이 이어 붙인 진짜 토큰을 놓친다. 미탐이
    // 잘못 가리는 쪽보다 나쁘다 — 가리는 게 이 함수의 일이다.
    for (const value of [
      'tokenabcghp_AAAABBBBCCCCDDDDAAAABBBBCCCCDDDDAAAABBBBCCCCDDDD',
      '123ghp_AAAABBBBCCCCDDDDAAAABBBBCCCCDDDDAAAABBBBCCCCDDDD',
      'my_ghp_AAAABBBBCCCCDDDDAAAABBBBCCCCDDDDAAAABBBBCCCCDDDD',
      'YWJjghp_AAAABBBBCCCCDDDDAAAABBBBCCCCDDDDAAAABBBBCCCCDDDD',
      'aaxoxb-AAAABBBBCCCCDDDDAAAABBBBCCCCDDDDAAAABBBBCCCCDDDD',
      'XBearer AAAABBBBCCCCDDDDAAAABBBBCCCCDDDDAAAABBBBCCCCDDDD',
      'token=ghp_AAAABBBBCCCCDDDDAAAABBBBCCCCDDDDAAAABBBBCCCCDDDD',
    ]) {
      expect(formatReceived({ k: value })).not.toContain(
        'AAAABBBBCCCCDDDDAAAABBBBCCCCDDDDAAAABBBBCCCCDDDD',
      );
    }
  });

  it('접두어가 낀 멀쩡한 표현은 안 가린다', () => {
    // 하한을 하나로 묶으면 여기가 깨진다. 접두어마다 실제 발급 길이에 맞춰 잡아야
    // 꼬리가 긴 식별자도 살아남는다.
    for (const word of [
      'risk-management',
      'risk-assessment',
      'desk-organizer',
      'task-scheduler',
      'task-runner',
      'desk-top',
      'ask-me-anything',
      'whisk-attachment',
      'risk-taking-culture',
      'AKIActually',
      'AKIActuallyworks',
      'npm_config',
      'npm_config_value',
      'npm_package_name',
      'npm_lifecycle_event',
    ]) {
      expect(formatReceived({ k: word })).toContain(word);
    }
  });

  it('하한을 유지한 접두어도 진짜 키는 가린다', () => {
    expect(
      formatReceived({ k: 'sk-AAAABBBBCCCCDDDDAAAABBBBCCCCDDDDAAAABBBBCCCCDDDD' }),
    ).not.toContain('AAAABBBBCCCCDDDDAAAABBBBCCCCDDDDAAAABBBBCCCCDDDD');
    expect(formatReceived({ k: 'AKIAIOSFODNN7EXAMPLE' })).not.toContain('IOSFODNN7EXAMPLE');
  });

  it('파서 문구의 짧은 인용은 안 가려진다', () => {
    // V8 은 문제 지점을 여섯 자쯤만 인용한다. 접두어별 하한이 그보다 높아서 그 조각은
    // 남는다. 하한을 내려 잡으려 했더니 npm_package_name 같은 멀쩡한 식별자가 원인
    // 설명에서 지워졌다 — 조각 여섯 자로는 키를 복원할 수 없고 원문 전체를 보는 두
    // 경로는 정확히 가려지므로 그쪽을 택했다. 받아들인 값이라 판정으로 남긴다.
    const raw = '{"t": ghp_AbCdEfGhIjKlMnOpQrStUvWxYz01234567}';
    let message = '';
    try {
      JSON.parse(raw);
    } catch (error) {
      message = describeJsonParseFailure('t', raw, error);
    }

    // 인용이 짧아 접두어와 몇 글자가 남는다.
    expect(message).toContain('ghp_');
    // 그래도 원문 전체를 보는 경로는 가린다.
    expect(formatReceived({ t: 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz01234567' })).toBe('{"t":"ghp_***"}');
  });

  it('본문 없는 PEM 헤더도 길이를 보존한다', () => {
    // 하한을 두면 별표가 덧붙어 자리가 밀린다.
    const text = '{"k":"-----BEGIN RSA PRIVATE KEY-----","s":"x"}';

    expect(snippetAround(text, text.length - 1, 500)).toHaveLength(text.length);
  });

  it('guardShape 를 두 번 지나도 결과가 같다', () => {
    // schemas.ts 의 guardObject 를 지난 스키마가 server.ts 의 guardedTool 에서 한 번 더
    // 지나는 게 실제 경로다. 네 라운드 미룬 판정이다.
    const base = { payload: z.object({ a: z.string() }).optional().describe('설명') };
    const once = z.object(guardShape(base));
    const twice = z.object(guardShape(guardShape(base)));

    for (const schema of [once, twice]) {
      expect(schema.safeParse({ payload: '{"a":"x"}' }).success).toBe(true);
      const broken = schema.safeParse({ payload: '{"a":' });
      expect(broken.success).toBe(false);
      if (!broken.success) {
        const message = broken.error.issues[0]?.message ?? '';
        expect(message).toContain('JSON으로 안 풀립니다');
        // 상한 검사와 파싱 실패 문구가 한 번만 실린다.
        expect(message.match(/JSON으로 안 풀립니다/g)).toHaveLength(1);
      }
    }
    expect((twice.shape.payload._def as { description?: string }).description).toBe('설명');
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
    expect(formatReceived({ token: `ghp_${'A'.repeat(40)}` })).toContain('ghp_***');
    expect(formatReceived({ token: `ghp_${'A'.repeat(40)}` })).not.toContain('A'.repeat(40));

    const text = `x${' '.repeat(20)}sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
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
    const withToken = '{"token": ghp_AAAABBBBCCCCDDDDAAAABBBBCCCCDDDDAAAABBBBCCCCDDDD, "a":1}';
    let message = '';
    try {
      JSON.parse(withToken);
    } catch (error) {
      message = describeJsonParseFailure('payload', withToken, error);
    }

    // V8 은 깨진 지점 원문을 자기 메시지 안에 인용한다. raw 만 가리면 그 경로가 남는다.
    expect(message).not.toContain('AAAABBBBCCCCDDDDAAAABBBBCCCCDDDDAAAABBBBCCCCDDDD');
  });

  it('개행이 섞인 토큰도 가린다', () => {
    // 이스케이프를 먼저 걸면 `Bearer\s+` 가 그 자리를 못 잡는다.
    expect(
      formatReceived({ auth: 'Bearer\nAAAABBBBCCCCDDDDAAAABBBBCCCCDDDDAAAABBBBCCCCDDDD' }),
    ).not.toContain('AAAABBBBCCCCDDDDAAAABBBBCCCCDDDDAAAABBBBCCCCDDDD');
  });

  it('토큰을 가리고 깨진 자리는 남긴다', () => {
    const text = String.raw`x=ghp_AAAABBBBCCCCDDDDAAAABBBBCCCCDDDDAAAABBBBCCCCDDDD\uZZ`;
    const snippet = snippetAround(text, text.indexOf('\\u'));

    expect(snippet).toContain('uZZ');
    expect(snippet).not.toContain('AAAABBBBCCCCDDDDAAAABBBBCCCCDDDDAAAABBBBCCCCDDDD');
  });

  it('토큰이 여럿이면 전부 가린다', () => {
    const text = 'a=ghp_AAAABBBBCCCCDDDDAAAABBBBCCCCDDDDAAAABBBBCCCCDDDD b=sk-EEEEFFFFGGGGHHHH';
    const snippet = snippetAround(text, text.indexOf('BBBB'));

    expect(snippet).not.toContain('AAAABBBBCCCCDDDDAAAABBBBCCCCDDDDAAAABBBBCCCCDDDD');
    expect(snippet).not.toContain('EEEEFFFFGGGGHHHH');
  });

  it('윈도우가 접두어를 잘라내도 토큰 몸통은 가린다', () => {
    // 따옴표를 안 닫은 JSON 은 파서가 문자열 끝을 가리켜서 접두어가 윈도우 밖으로
    // 밀려난다. 자른 뒤 가리면 이 자리가 통째로 샌다.
    const token = `ghp_${'A'.repeat(60)}`;
    const text = `{"t": "${token}`;
    const snippet = snippetAround(text, text.length);

    expect(snippet).not.toContain('A'.repeat(20));
  });

  it('깨진 지점이 자격증명 안이어도 가린다', () => {
    // 원인 바이트가 덮이는 건 받아들인 값이다. 위치와 사유는 파서 문구에 남는다.
    const text = 'k=ghp_AAAABBBBCCCCDDDDAAAABBBBCCCCDDDDAAAABBBBCCCCDDDD';
    const snippet = snippetAround(text, text.indexOf('CCCC'));

    expect(snippet).not.toContain('AAAABBBB');
  });

  it('마스킹이 길이를 보존해 깨진 지점이 제자리에 남는다', () => {
    // 시크릿을 깨진 지점보다 앞에 두고 전체가 창(2 * 40자)을 넘게 만든다. 치환이 줄여
    // 쓰면 뒤 문자들의 자리가 그만큼 밀려 창이 깨진 지점을 벗어난다.
    const token = `ghp_${'A'.repeat(60)}`;
    const text = `{"t":"${token}","pad":"${'x'.repeat(30)}","s":"` + String.raw`\uZZ` + '"}';
    const position = text.indexOf(String.raw`\u`);

    const snippet = snippetAround(text, position);

    expect(snippet).toContain('uZZ');
    expect(snippet).not.toContain('AAAA');
  });

  it('스니펫 치환은 원문과 길이가 같다', () => {
    const text = `k=ghp_${'A'.repeat(36)}`;

    // 창을 넉넉히 줘서 잘림 표시 없이 전체를 본다.
    expect(snippetAround(text, 0, 200)).toBe(`k=ghp_${'*'.repeat(36)}`);
  });

  it('값 샘플 치환은 길이를 안 드러낸다', () => {
    // 별표 개수가 원문 길이면 토큰 포맷을 좁히는 단서가 된다. 위치 보존이 필요 없는
    // 자리는 고정 길이로 덮는다.
    const short = formatReceived({ k: `ghp_${'A'.repeat(40)}` });
    const long = formatReceived({ k: `ghp_${'A'.repeat(60)}` });

    expect(short).toBe(long);
  });

  it('자르는 경계에 걸친 토큰도 조각이 안 남는다', () => {
    // 가리기보다 자르기가 먼저 오면 뒤 조각이 패턴의 최소 길이를 못 채워 접두어와 앞
    // 몇 글자가 그대로 남는다.
    for (let pad = 80; pad <= 118; pad += 1) {
      const sample = formatReceived({ p: 'x'.repeat(pad), t: `ghp_${'S'.repeat(60)}` });
      expect(sample).not.toContain('ghp_S');
    }
  });

  it('여러 줄 PEM 도 본문까지 가린다', () => {
    // 부르는 자리는 JSON.stringify 를 먼저 거치므로 개행이 두 글자로 이스케이프돼 온다.
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBgkqSECRETBYTES\n-----END RSA PRIVATE KEY-----';

    const sample = formatReceived({ k: pem });

    expect(sample).not.toContain('SECRETBYTES');
    expect(sample).toContain('BEGIN RSA PRIVATE KEY');
  });

  it('PEM 이 앞쪽에 와도 스니펫이 깨진 지점을 짚는다', () => {
    // 치환이 길이를 잃으면 창이 원문 끝을 넘어가 스니펫이 통째로 사라진다.
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----AAAABBBBCCCCDDDDAAAABBBBCCCCDDDDAAAABBBBCCCCDDDD-----END RSA PRIVATE KEY-----';
    const text = `{"note":"${pem}","s":"` + String.raw`\uZZ` + '"}';

    const snippet = snippetAround(text, text.indexOf(String.raw`\u`));

    expect(snippet).toContain('uZZ');
    expect(snippet).not.toContain('AAAABBBB');
  });

  it('새로 넣은 접두어와 PEM 블록도 가린다', () => {
    expect(formatReceived({ k: withPrefix('sk_live_', BIG_BODY) })).not.toContain(
      'AAAABBBBCCCCDDDDAAAABBBBCCCCDDDDAAAABBBBCCCCDDDD',
    );
    expect(formatReceived({ k: withPrefix('xoxb-', BIG_BODY) })).not.toContain(
      'AAAABBBBCCCCDDDDAAAABBBBCCCCDDDDAAAABBBBCCCCDDDD',
    );
    expect(formatReceived({ k: withPrefix('AIza', BIG_BODY) })).not.toContain(
      'AAAABBBBCCCCDDDDAAAABBBBCCCCDDDDAAAABBBBCCCCDDDD',
    );
    expect(formatReceived({ k: withPrefix('npm_', BIG_BODY) })).not.toContain(
      'AAAABBBBCCCCDDDDAAAABBBBCCCCDDDDAAAABBBBCCCCDDDD',
    );

    const pem =
      '-----BEGIN RSA PRIVATE KEY-----AAAABBBBCCCCDDDDAAAABBBBCCCCDDDDAAAABBBBCCCCDDDD-----END RSA PRIVATE KEY-----';
    expect(formatReceived({ k: pem })).not.toContain(
      'AAAABBBBCCCCDDDDAAAABBBBCCCCDDDDAAAABBBBCCCCDDDD',
    );
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

  it('순회가 컨테이너 종류마다 자식까지 닿는다', () => {
    // 필드 이름 목록을 따로 들고 비교하면 순회 코드의 오타를 못 잡는다 — zod 쪽 이름은
    // 그대로인데 우리가 다른 이름을 집고 있어도 목록끼리는 맞아 통과한다. 그래서 스키마를
    // 실제로 통과시켜 안쪽 잎에 errorMap 이 심겼는지 본다. 이러면 zod 의 필드 개명과 이
    // 파일 안의 오타가 같은 자리에서 걸린다.
    const cases: Array<[string, () => { root: z.ZodTypeAny; leaves: z.ZodTypeAny[] }]> = [
      [
        'object',
        () => {
          const leaf = z.string();
          return { root: z.object({ a: leaf }), leaves: [leaf] };
        },
      ],
      [
        'array',
        () => {
          const leaf = z.string();
          return { root: z.array(leaf), leaves: [leaf] };
        },
      ],
      [
        'optional',
        () => {
          const leaf = z.string();
          return { root: leaf.optional(), leaves: [leaf] };
        },
      ],
      [
        'nullable',
        () => {
          const leaf = z.string();
          return { root: leaf.nullable(), leaves: [leaf] };
        },
      ],
      [
        'default',
        () => {
          const leaf = z.string();
          return { root: leaf.default('x'), leaves: [leaf] };
        },
      ],
      [
        'catch',
        () => {
          const leaf = z.string();
          return { root: leaf.catch('x'), leaves: [leaf] };
        },
      ],
      [
        'readonly',
        () => {
          const leaf = z.string();
          return { root: leaf.readonly(), leaves: [leaf] };
        },
      ],
      [
        'promise',
        () => {
          const leaf = z.string();
          return { root: z.promise(leaf), leaves: [leaf] };
        },
      ],
      [
        'branded',
        () => {
          const leaf = z.string();
          return { root: leaf.brand('b'), leaves: [leaf] };
        },
      ],
      [
        'effects',
        () => {
          const leaf = z.string();
          return { root: leaf.refine(() => true), leaves: [leaf] };
        },
      ],
      [
        'union',
        () => {
          const leaf = z.string();
          const other = z.number();
          return { root: z.union([leaf, other]), leaves: [leaf, other] };
        },
      ],
      [
        'discriminatedUnion',
        () => {
          const a = z.object({ kind: z.literal('a'), v: z.string() });
          const b = z.object({ kind: z.literal('b'), v: z.number() });
          return { root: z.discriminatedUnion('kind', [a, b]), leaves: [a, b] };
        },
      ],
      [
        'intersection',
        () => {
          const left = z.object({ a: z.string() });
          const right = z.object({ b: z.string() });
          return { root: z.intersection(left, right), leaves: [left, right] };
        },
      ],
      [
        'record',
        () => {
          const key = z.string();
          const value = z.number();
          return { root: z.record(key, value), leaves: [key, value] };
        },
      ],
      [
        'tuple',
        () => {
          const item = z.string();
          const rest = z.number();
          return { root: z.tuple([item]).rest(rest), leaves: [item, rest] };
        },
      ],
      [
        'set',
        () => {
          const leaf = z.string();
          return { root: z.set(leaf), leaves: [leaf] };
        },
      ],
      [
        'map',
        () => {
          const key = z.string();
          const value = z.number();
          return { root: z.map(key, value), leaves: [key, value] };
        },
      ],
      [
        'pipeline',
        () => {
          const from = z.string();
          const to = z.number();
          return { root: from.transform(Number).pipe(to), leaves: [from, to] };
        },
      ],
    ];

    // 케이스가 줄어드는 것도 잡는다. 배열만 비우면 판정이 빈 배열로 통과한다.
    expect(cases).toHaveLength(18);

    const unreached = cases
      .filter(([, build]) => {
        const { root, leaves } = build();
        attachErrorMap(root);
        return leaves.some(
          (leaf) => (leaf._def as { errorMap?: z.ZodErrorMap }).errorMap !== verboseErrorMap,
        );
      })
      .map(([label]) => label);

    expect(unreached).toEqual([]);
  });

  it('errorMap 주입이 zod 에서 실제로 먹는다', () => {
    // 위 판정은 우리가 심었는지만 본다. zod 가 그 값을 읽는지는 따로 확인한다.
    const mark = 'self-check';
    const probe = z.string();
    (probe._def as { errorMap?: z.ZodErrorMap }).errorMap = () => ({ message: mark });

    const result = probe.safeParse(123);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe(mark);
  });

  it('default 는 팩토리로 남아 있다', () => {
    // 껍질 복원이 이 값을 그대로 다시 넘긴다. 값이면 모든 요청이 한 인스턴스를 나눠 쓴다.
    const withDefault = z.array(z.string()).default([]);
    const def = withDefault._def as unknown as Record<string, unknown>;

    expect(typeof def['defaultValue']).toBe('function');
  });

  it('describe 가 preprocess 재조립에서 살아남는다', () => {
    const guarded = z.object(
      guardShape({ payload: z.object({ a: z.string() }).optional().describe('설명') }),
    );

    expect((guarded.shape.payload._def as { description?: string }).description).toBe('설명');
  });
});
