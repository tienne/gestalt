import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyzeTranscript,
  collectTranscripts,
  compare,
  leakBreakdown,
  measure,
  RESUME_MARKER,
} from '../../../src/conductor/metrics.js';
import { cleanupStateDirs, tempStateDir } from './fixtures.js';

afterEach(cleanupStateDirs);

let n = 0;
const user = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  message: { role: 'user', content },
  ...extra,
});
const assistant = (content: unknown[], tokens = 100, id = `msg-${++n}`) => ({
  type: 'assistant',
  message: {
    id,
    content,
    usage: {
      input_tokens: tokens,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  },
});
const skill = (name: string) =>
  assistant([{ type: 'tool_use', name: 'Skill', input: { skill: name } }]);
const bash = (command: string, tokens = 100) =>
  assistant([{ type: 'tool_use', name: 'Bash', input: { command } }], tokens);

describe('analyzeTranscript', () => {
  it('스킬 호출 뒤 사람 발화 8개까지만 센다', () => {
    const entries = [
      user('처음 부탁'),
      skill('gestalt:ship'),
      ...Array.from({ length: 10 }, (_, i) => user(`끼어듦 ${i}`)),
    ];
    const m = analyzeTranscript(entries);
    expect(m.skillCalls).toBe(1);
    expect(m.interventions).toBe(8);
  });

  it('도구 결과, 메타, 압축 요약, 작업 알림, 워커 알림은 빼고 슬래시 명령은 스킬 호출로 센다', () => {
    const entries = [
      user('<command-name>/ship</command-name>'),
      user([{ type: 'tool_result', content: 'x' }]),
      user('meta', { isMeta: true }),
      user('summary', { isCompactSummary: true }),
      user('<task-notification>done</task-notification>'),
      user('You have 2 orchestration messages'),
      user('──── From: worker-1\nhi'),
      user('<local-command-stdout>x</local-command-stdout>'),
      user([{ type: 'text', text: '이거 왜 멈췄어요?' }]),
    ];
    const m = analyzeTranscript(entries);
    expect(m.skillCalls).toBe(1);
    expect(m.interventions).toBe(1);
    expect(m.skills).toEqual(['ship']);
  });

  it('토큰은 같은 message.id를 한 번만 센다', () => {
    const a = assistant([], 300, 'same');
    expect(analyzeTranscript([a, a, assistant([], 50)]).tokens).toBe(350);
  });

  it('워커 세션과 재개 세션을 가린다', () => {
    expect(analyzeTranscript([user('GESTALT_CONDUCTOR_WORKER_ID=wrk-1 작업 시작')]).isWorker).toBe(
      true,
    );
    expect(analyzeTranscript([user(`${RESUME_MARKER} 체크포인트부터`)]).isResume).toBe(true);
  });
});

describe('compare', () => {
  it('끼어든 발화 40% 감소로 합격을 정하고 토큰 초과는 보고만 한다', () => {
    const c = compare(
      { sessions: 10, interventions: 10, tokens: 1000 },
      { sessions: 3, interventions: 5, tokens: 1300 },
    );
    expect(c.interventionReduction).toBeCloseTo(0.5);
    expect(c.interventionGoalMet).toBe(true);
    expect(c.tokenTargetMet).toBe(false);
    expect(c.passed).toBe(true);
    expect(c.notes.join()).toMatch(/30\.0% 늘어/);
  });

  it('감소가 40%에 못 미치면 불합격이다', () => {
    const c = compare(
      { sessions: 1, interventions: 10, tokens: 1 },
      { sessions: 1, interventions: 7, tokens: 1 },
    );
    expect(c.passed).toBe(false);
  });
});

describe('leakBreakdown', () => {
  it('tick과 status는 polling, report와 gate list는 results, 나머지는 컨덕터 컨텍스트로 센다', () => {
    const l = leakBreakdown([
      bash('gestalt conductor tick --json', 10),
      bash('gestalt conductor status', 20),
      bash('gestalt conductor worker report --file r.json', 30),
      bash('gestalt conductor gate list', 40),
      bash('git status', 50),
    ]);
    expect(l).toEqual({ polling: 30, results: 70, conductorContext: 50, restart: 0 });
  });

  it('재개 세션은 통째로 restart다', () => {
    const l = leakBreakdown([user(`${RESUME_MARKER} x`), bash('git status', 70)]);
    expect(l.restart).toBe(70);
  });
});

describe('measure', () => {
  function writeSession(root: string, rel: string, entries: unknown[], mtime: number) {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n'));
    utimesSync(p, mtime / 1000, mtime / 1000);
  }

  it('since 이전 45일의 사람 세션을 기준으로 컨덕터 세션을 비교한다. subagents는 뺀다', () => {
    const root = tempStateDir();
    const since = Date.parse('2026-11-01T00:00:00Z');
    const day = 86_400_000;
    const human = [user('부탁'), skill('ship'), user('a'), user('b'), user('c'), user('d')];
    writeSession(root, 'p/a.jsonl', human, since - 3 * day);
    writeSession(root, 'p/old.jsonl', human, since - 60 * day);
    writeSession(root, 'p/subagents/s.jsonl', human, since - day);
    writeSession(root, 'p/m.jsonl', [user('/conductor'), user('하나')], since + day);
    writeSession(
      root,
      'p/w.jsonl',
      [user('GESTALT_CONDUCTOR_WORKER_ID=wrk-1'), assistant([], 500)],
      since + day,
    );

    expect(collectTranscripts(root, since - 45 * day, since)).toHaveLength(1);
    const r = measure({ root, since, now: since + 2 * day });
    expect(r.comparison.baseline).toMatchObject({ sessions: 1, interventions: 4 });
    expect(r.comparison.current).toMatchObject({ sessions: 1, interventions: 1, tokens: 500 });
    expect(r.comparison.passed).toBe(true);
  });
});
