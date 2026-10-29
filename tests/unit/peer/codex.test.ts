import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexTransformer, codexHome, locateCodexRollout } from '../../../src/peer/codex.js';
import { ShareStream } from '../../../src/peer/share.js';
import type { PeerEvent } from '../../../src/peer/transform.js';
import { FAKE_HOME, FAKE_SECRETS } from '../../fixtures/peer/transcript.js';
import {
  CODEX_PROMPT,
  CODEX_UNKNOWN_LINES,
  codexLines,
  codexText,
} from '../../fixtures/peer/codex-rollout.js';

function run(tools: 'full' | 'summary' | 'none' = 'summary'): {
  events: PeerEvent[];
  t: CodexTransformer;
} {
  const t = new CodexTransformer({ tools, home: FAKE_HOME });
  const events = codexLines().flatMap((l) => t.push(l));
  return { events, t };
}

describe('CodexTransformer', () => {
  it('사람이 친 프롬프트와 모델 답, 도구 호출과 결과만 순서대로 꺼낸다', () => {
    const { events, t } = run();
    expect(events.map((e) => e.kind)).toEqual([
      'prompt',
      'reply',
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'tool_call',
      'reply',
    ]);
    expect(t.version).toBe('0.147.0');
    expect(t.failedLines).toBe(0);
  });

  it('시스템 프롬프트, AGENTS.md, 환경 정보, 추론 원문과 response_item 메시지는 안 나간다', () => {
    const out = JSON.stringify(run('full').events);
    expect(out).not.toContain('LEAK_');
    expect(out).not.toContain('AGENTS.md');
    expect(out).not.toContain('environment_context');
  });

  it('모르는 줄 종류는 건너뛰고 개수만 센다', () => {
    const { t } = run();
    expect(t.unknownLines).toBe(CODEX_UNKNOWN_LINES);
  });

  it('비밀값 패턴과 홈 경로는 Claude Code 기록과 같은 규칙으로 가린다', () => {
    const out = JSON.stringify(run('full').events);
    for (const secret of [
      FAKE_SECRETS.ghp,
      FAKE_SECRETS.aws,
      FAKE_SECRETS.tokenValue,
      FAKE_SECRETS.keyOnlyValue,
      FAKE_SECRETS.passwordValue,
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).not.toContain(FAKE_HOME);
    expect(out).toContain('[가림]');
    const prompt = run().events[0] as Extract<PeerEvent, { kind: 'prompt' }>;
    expect(prompt.text).toBe(
      CODEX_PROMPT.replace(FAKE_HOME, '~').replace(FAKE_SECRETS.ghp, '[가림]'),
    );
  });

  it('도구 호출은 이름과 call_id로 결과와 이어지고 실패한 결과는 에러로 표시한다', () => {
    const { events } = run();
    const calls = events.filter((e) => e.kind === 'tool_call');
    expect(calls.map((c) => [c.id, c.name])).toEqual([
      ['call_exec', 'exec'],
      ['call_fn', 'shell'],
      ['call_sh', 'local_shell'],
    ]);
    const results = events.filter((e) => e.kind === 'tool_result');
    expect(results.map((r) => [r.toolUseId, r.isError])).toEqual([
      ['call_exec', false],
      ['call_fn', true],
    ]);
    // function_call의 arguments는 JSON으로 읽어 키 이름 가리기도 탄다
    expect(calls[1]!.input).toContain('"password":"[가림]"');
  });

  it('--tools none이면 도구 입력과 결과 글자를 안 보낸다', () => {
    const { events } = run('none');
    for (const e of events) {
      if (e.kind === 'tool_call') expect(e.input).toBeUndefined();
      if (e.kind === 'tool_result') {
        expect(e.hidden).toBe(true);
        expect(e.text).toBeUndefined();
      }
    }
  });

  it('JSON이 아니거나 payload가 없는 줄은 모르는 줄로 센다', () => {
    const t = new CodexTransformer({ tools: 'summary' });
    expect(t.push('{not json')).toEqual([]);
    expect(t.push(JSON.stringify({ type: 'event_msg' }))).toEqual([]);
    expect(t.unknownLines).toBe(2);
  });
});

describe('locateCodexRollout', () => {
  let home: string;
  const id = '01a1885d-8687-7033-a0b2-e3a17555a249';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'codex-home-'));
    mkdirSync(join(home, 'sessions', '2026', '10', '30'), { recursive: true });
    writeFileSync(
      join(home, 'sessions', '2026', '10', '30', `rollout-2026-10-30T00-53-13-${id}.jsonl`),
      codexText(),
    );
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('thread id로 sessions 아래 rollout을 찾는다', () => {
    const found = locateCodexRollout(id, home);
    expect(found).toMatchObject({ ok: true });
    expect(found.ok && found.path.endsWith(`-${id}.jsonl`)).toBe(true);
  });

  it('경로를 주면 그 파일을 쓴다', () => {
    const path = join(
      home,
      'sessions',
      '2026',
      '10',
      '30',
      `rollout-2026-10-30T00-53-13-${id}.jsonl`,
    );
    expect(locateCodexRollout(path, home)).toEqual({ ok: true, path, home });
  });

  it('없는 id, 경로 조각이 든 값, 없는 파일은 이유를 담아 돌려준다', () => {
    expect(locateCodexRollout('01a1885d-0000-0000-0000-000000000000', home)).toMatchObject({
      ok: false,
    });
    expect(locateCodexRollout('../etc', home)).toMatchObject({ ok: false });
    expect(locateCodexRollout(join(home, 'nope.jsonl'), home)).toMatchObject({ ok: false });
  });

  it('CODEX_HOME이 절대경로일 때만 따른다', () => {
    expect(codexHome({ CODEX_HOME: '/abs/codex' })).toBe('/abs/codex');
    expect(codexHome({ CODEX_HOME: 'rel' })).not.toBe('rel');
  });
});

describe('ShareStream (codex)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codex-share-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('Codex 형식으로 따라 읽고 모르는 줄 수와 codex-cli 버전을 낸다', () => {
    const path = join(dir, 'rollout.jsonl');
    writeFileSync(path, codexText());
    const stream = new ShareStream({
      id: 's1',
      transcriptPath: path,
      tools: 'summary',
      format: 'codex',
      home: FAKE_HOME,
    });
    stream.poll();
    const { items } = stream.backlogAfter(0, Infinity);
    const kinds = items.map((i) => (JSON.parse(i.json) as PeerEvent).kind);
    expect(kinds).toContain('prompt');
    expect(items.map((i) => i.json).join('')).not.toContain('LEAK_');
    expect(stream.unknownLines).toBe(CODEX_UNKNOWN_LINES);
    expect(stream.toolVersion).toBe('0.147.0');
    stream.close('test');
  });
});
