import { describe, expect, it } from 'vitest';
import { TranscriptTransformer, stripSystemReminders } from '../../../src/peer/transform.js';
import type { PeerEvent } from '../../../src/peer/transform.js';
import type { ToolsLevel } from '../../../src/peer/redact.js';
import {
  FAKE_HOME,
  FAKE_SECRETS,
  FIXTURE_UNKNOWN_LINES,
  TAIL_MARKER,
  fixtureLines,
} from '../../fixtures/peer/transcript.js';

function run(tools: ToolsLevel): { events: PeerEvent[]; unknown: number; out: string } {
  const t = new TranscriptTransformer({ tools, home: FAKE_HOME });
  const events = fixtureLines().flatMap((line) => t.push(line));
  return { events, unknown: t.unknownLines, out: JSON.stringify(events) };
}

describe('TranscriptTransformer', () => {
  it.each(['full', 'summary', 'none'] as const)(
    '허용 목록 밖 본문이 출력 어디에도 없다 (--tools %s)',
    (tools) => {
      const { out } = run(tools);
      expect(out).not.toContain('LEAK_');
      expect(out).not.toContain('system-reminder');
      for (const secret of Object.values(FAKE_SECRETS)) expect(out).not.toContain(secret);
      expect(out).not.toContain(FAKE_HOME);
    },
  );

  it('보내는 줄 종류만 순서대로 나온다', () => {
    const { events } = run('summary');
    expect(events.map((e) => e.kind)).toEqual([
      'prompt',
      'reply',
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'sidechain',
      'title',
      'reply',
      'prompt',
    ]);
  });

  it('user 텍스트에서 system-reminder를 지우고 나머지는 가려서 남긴다', () => {
    const { events } = run('summary');
    const first = events[0];
    expect(first?.kind).toBe('prompt');
    if (first?.kind !== 'prompt') return;
    expect(first.text).toContain('안녕하세요, ~/dev/proj');
    expect(first.text).toContain('API_KEY=[가림]');
    const last = events.at(-1);
    expect(last).toMatchObject({ kind: 'prompt', text: '고마워요' });
  });

  it('모르는 줄 종류와 깨진 줄만 센다', () => {
    expect(run('summary').unknown).toBe(FIXTURE_UNKNOWN_LINES);
  });

  it('바꾸다 던지는 줄은 버리고 모르는 줄과 따로 센다', () => {
    const t = new TranscriptTransformer({ tools: 'full', home: FAKE_HOME });
    const depth = 100_000;
    const nested = '{"a":'.repeat(depth) + '1' + '}'.repeat(depth);
    const deep = `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t","name":"X","input":${nested}}]}}`;
    expect(t.push(deep)).toEqual([]);
    expect(t.failedLines).toBe(1);
    expect(t.unknownLines).toBe(0);
    const next = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '다음 줄' }] },
    });
    expect(t.push(next)).toMatchObject([{ kind: 'reply', text: '다음 줄' }]);
  });

  it('서브에이전트 줄이 이어지면 표시를 한 번만 낸다', () => {
    expect(run('summary').events.filter((e) => e.kind === 'sidechain')).toHaveLength(1);
  });

  it('summary면 도구 결과를 4KB에서 자르고 표시한다', () => {
    const results = run('summary').events.filter((e) => e.kind === 'tool_result');
    const big = results[1];
    expect(big).toMatchObject({ kind: 'tool_result', truncated: true, hidden: false });
    if (big?.kind !== 'tool_result') return;
    expect(Buffer.byteLength(big.text ?? '')).toBeLessThanOrEqual(4096);
    expect(big.text).not.toContain(TAIL_MARKER);
  });

  it('full이면 도구 결과를 자르지 않지만 그래도 가린다', () => {
    const results = run('full').events.filter((e) => e.kind === 'tool_result');
    expect(results[1]).toMatchObject({ truncated: false });
    if (results[1]?.kind !== 'tool_result') return;
    expect(results[1].text).toContain(TAIL_MARKER);
    expect(results[0]).toMatchObject({ kind: 'tool_result' });
    if (results[0]?.kind !== 'tool_result') return;
    expect(results[0].text).toContain('[이미지]');
  });

  it('none이면 도구 입력과 결과 본문을 안 보낸다', () => {
    const { events } = run('none');
    for (const e of events) {
      if (e.kind === 'tool_call') expect(e.input).toBeUndefined();
      if (e.kind === 'tool_result') {
        expect(e.hidden).toBe(true);
        expect(e.text).toBeUndefined();
      }
    }
    expect(events.find((e) => e.kind === 'tool_call')).toMatchObject({ name: 'Bash' });
  });

  it('tool_use 입력은 줄여서 보내고 비밀값을 가린다', () => {
    const call = run('summary').events.find((e) => e.kind === 'tool_call');
    expect(call?.kind).toBe('tool_call');
    if (call?.kind !== 'tool_call') return;
    expect(call.input).toContain('GH_TOKEN=[가림]');
    expect(call.input).toContain('~/dev/proj');
  });

  it('isCompactSummary 줄은 본문 없이 표시만 낸다', () => {
    const t = new TranscriptTransformer({ tools: 'summary', home: FAKE_HOME });
    const events = t.push(
      JSON.stringify({
        type: 'user',
        isCompactSummary: true,
        message: { role: 'user', content: 'LEAK_COMPACT 지난 대화 요약' },
      }),
    );
    expect(events).toEqual([{ kind: 'compacted', at: undefined }]);
  });
});

describe('stripSystemReminders', () => {
  it('여러 블록과 닫히지 않은 블록을 지운다', () => {
    expect(
      stripSystemReminders(
        'a<system-reminder>x</system-reminder>b<system-reminder>y</system-reminder>c<system-reminder>z',
      ),
    ).toBe('abc');
  });
});
