import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  conductorBrowseCommand,
  conductorResultsListCommand,
  conductorResultsSearchCommand,
  conductorResultsShowCommand,
} from '../../../src/cli/commands/conductor-results.js';
import { cleanupStateDirs, tempStateDir } from './fixtures.js';
import { cleanupOutsideDirs, hasControl, outsideDir, put, seed } from './results-fixtures.js';

let out: string[] = [];
let err: string[] = [];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((v: unknown) => void out.push(String(v)));
  vi.spyOn(console, 'error').mockImplementation((v: unknown) => void err.push(String(v)));
  vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanupStateDirs();
  cleanupOutsideDirs();
});

const A = 'ord-aaaaaaaa';
const B = 'ord-bbbbbbbb';
const text = () => out.join('\n');
const json = () => JSON.parse(out.join('\n')) as Record<string, any>;

function fixture() {
  const base = tempStateDir();
  const abs = realpathSync(base);
  const note = put(join(abs, 'reports', 'final.md'), '# 최종\n본문 needle 한 줄\n둘째 줄');
  const outside = put(join(outsideDir(), 'tmp.md'), '밖');
  const { dir } = seed(
    [
      {
        order: {
          id: A,
          title: '결과 뷰어 만들기',
          repo: 'acme/app',
          status: 'done',
          issueKey: 'ACME-1',
          prRef: 'acme/app#12',
          updatedAt: '2026-11-03T00:00:00.000Z',
        },
        reports: [
          { summary: '첫 보고 needle', skill: 'solve' },
          {
            summary: '마무리',
            refs: [note, outside, 'https://example.com/pr/12'],
            prRef: 'acme/app#12',
          },
        ],
      },
      {
        order: {
          id: B,
          title: '다른 일',
          repo: 'acme/web',
          status: 'queued',
          updatedAt: '2026-11-04T00:00:00.000Z',
        },
      },
    ],
    base,
  );
  put(join(abs, 'reports', 'loose.md'), '떠도는 needle');
  put(join(abs, 'notes', `${A}-extra.md`), '관련 파일의 본문은 터미널에 안 찍는다');
  return { dir };
}

describe('results list', () => {
  it('평문으로 머리 줄과 주문 줄을 최근 갱신순으로 찍는다', () => {
    const { dir } = fixture();
    conductorResultsListCommand({ stateDir: dir });
    const lines = text().split('\n');
    expect(lines[0]).toBe('주문 2개 중 2개 (최근 갱신순)');
    expect(lines[1]).toContain(B);
    expect(lines[2]).toContain(A);
    expect(lines[2]).toContain('done');
    expect(lines[2]).toContain('acme/app');
    expect(lines[2]).toContain('2026-11-03');
    expect(lines[2]).toContain('보고 2');
    expect(lines[2]).toContain('참조 3');
    expect(lines[2]).toContain('결과 뷰어 만들기');
    expect(text()).not.toContain('\u001b');
  });

  it('--json은 total과 orders', () => {
    const { dir } = fixture();
    conductorResultsListCommand({ stateDir: dir, json: true, limit: '1' });
    const j = json();
    expect(j.total).toBe(2);
    expect(j.orders).toHaveLength(1);
    expect(j.orders[0].id).toBe(B);
  });

  it('필터와 limit을 적용하고 맞는 게 없으면 안내한다', () => {
    const { dir } = fixture();
    conductorResultsListCommand({ stateDir: dir, repo: 'acme/app', json: true });
    expect(json().orders.map((o: { id: string }) => o.id)).toEqual([A]);
    out = [];
    conductorResultsListCommand({ stateDir: dir, status: 'parked' });
    expect(text()).toBe('맞는 주문이 없어요');
    out = [];
    conductorResultsListCommand({ stateDir: dir, since: '2026-11-04', json: true });
    expect(json().total).toBe(1);
  });

  it('잘못된 status, since, limit과 없는 저장소는 메시지와 exit 1', () => {
    const { dir } = fixture();
    expect(() => conductorResultsListCommand({ stateDir: dir, status: 'bogus' })).toThrow('exit 1');
    expect(err.at(-1)).toContain('--status는');
    expect(() => conductorResultsListCommand({ stateDir: dir, since: 'nope' })).toThrow('exit 1');
    expect(err.at(-1)).toContain('--since는');
    for (const limit of ['0', '-1', 'abc', '1.5']) {
      expect(() => conductorResultsListCommand({ stateDir: dir, limit })).toThrow('exit 1');
      expect(err.at(-1)).toContain('--limit는');
    }
  });

  it('없는 저장소는 디렉토리를 만들지 않고 exit 1', () => {
    const missing = join('.gestalt-test', 'conductor-없는경로-cli');
    expect(() => conductorResultsListCommand({ stateDir: missing })).toThrow('exit 1');
    expect(err.at(-1)).toContain('상태 저장소가 없어요');
    expect(existsSync(missing)).toBe(false);
  });

  it('events.jsonl이 없는 저장소는 안내하고 exit 1', () => {
    const dir = tempStateDir();
    expect(() => conductorResultsListCommand({ stateDir: dir })).toThrow('exit 1');
    expect(err.at(-1)).toContain('events.jsonl');
    expect(existsSync(join(dir, 'events.jsonl'))).toBe(false);
  });
});

describe('results search', () => {
  it('주문 머리 아래에 출처별 줄과 발췌를 찍고 주문 없음 파일도 낸다', () => {
    const { dir } = fixture();
    conductorResultsSearchCommand('NEEDLE', { stateDir: dir });
    const t = text();
    expect(t).toContain('"NEEDLE" 결과');
    expect(t).toContain(`${A}  acme/app  결과 뷰어 만들기`);
    expect(t).toContain('요약 #1');
    expect(t).toContain('final.md:2');
    expect(t).toContain('본문 needle 한 줄');
    expect(t).toContain('주문 없음  reports/loose.md');
  });

  it('--json과 --no-body, --limit', () => {
    const { dir } = fixture();
    conductorResultsSearchCommand('needle', { stateDir: dir, json: true });
    const all = json();
    expect(all.total).toBeGreaterThanOrEqual(3);
    out = [];
    conductorResultsSearchCommand('needle', { stateDir: dir, json: true, body: false });
    expect(json().hits.map((h: { source: string }) => h.source)).toEqual(['summary']);
    out = [];
    conductorResultsSearchCommand('needle', { stateDir: dir, limit: '1' });
    expect(text()).toContain(`(전체 ${all.total}건 중 앞 1건)`);
  });

  it('맞는 게 없으면 안내하고 빈 검색어는 exit 1', () => {
    const { dir } = fixture();
    conductorResultsSearchCommand('zzzzzz', { stateDir: dir });
    expect(text()).toBe('"zzzzzz"에 맞는 결과가 없어요');
    expect(() => conductorResultsSearchCommand('   ', { stateDir: dir })).toThrow('exit 1');
    expect(err.at(-1)).toContain('찾을 말을 적어 주세요');
  });

  it('ESC가 섞인 요약과 제목은 제어 문자가 공백으로 바뀐다', () => {
    const { dir } = seed([
      {
        order: { id: A, title: '제목\u001b[31m빨강' },
        reports: [{ summary: '앞\u001b]0;탈취\u0007needle\u001b[2J뒤' }],
      },
    ]);
    conductorResultsSearchCommand('needle', { stateDir: dir });
    expect(hasControl(text(), true)).toBe(false);
    expect(text()).toContain('needle');
  });
});

describe('results show', () => {
  it('머리, 보고 타임라인, refs 분류, 관련 파일, refs 본문 순으로 찍는다', () => {
    const { dir } = fixture();
    conductorResultsShowCommand(A, { stateDir: dir });
    const t = text();
    expect(t.split('\n')[0]).toBe(`${A}  결과 뷰어 만들기`);
    expect(t).toContain('레포: acme/app  상태: done');
    expect(t).toContain('지라: ACME-1  PR: acme/app#12');
    expect(t).toContain('보고 이력 (2건)');
    expect(t).toContain('#1  ');
    expect(t).toContain('solve');
    expect(t).toContain('참조 (3)');
    expect(t).toContain('[1] 파일  ');
    expect(t).toContain('[2] 바깥  ');
    expect(t).toContain('(허용 범위 밖이라 본문을 안 읽어요)');
    expect(t).toContain('[3] 링크  https://example.com/pr/12');
    expect(t).toContain('관련 파일 (1)');
    expect(t).toContain('notes/ord-aaaaaaaa-extra.md');
    expect(t).toContain('── [1] ');
    expect(t).toContain('# 최종\n본문 needle 한 줄\n둘째 줄');
    expect(t).not.toContain('관련 파일의 본문은 터미널에 안 찍는다');
    expect(t).not.toContain('밖\n');
    expect(t.indexOf('참조 (3)')).toBeLessThan(t.indexOf('── [1]'));
  });

  it('앞부분 id가 유일하면 받는다', () => {
    const { dir } = fixture();
    conductorResultsShowCommand('ord-bb', { stateDir: dir });
    expect(text().split('\n')[0]).toBe(`${B}  다른 일`);
  });

  it('모호한 id는 후보를 보여주고 exit 1, 모르는 id도 exit 1', () => {
    const { dir } = fixture();
    expect(() => conductorResultsShowCommand('ord-', { stateDir: dir })).toThrow('exit 1');
    expect(err.at(-1)).toContain(A);
    expect(err.at(-1)).toContain(B);
    expect(() => conductorResultsShowCommand('zzz', { stateDir: dir })).toThrow('exit 1');
    expect(err.at(-1)).toContain('모르는 주문이에요');
  });

  it('--no-body는 본문을 안 찍고 --report n은 그 보고만 찍는다', () => {
    const { dir } = fixture();
    conductorResultsShowCommand(A, { stateDir: dir, body: false });
    expect(text()).not.toContain('── [1]');
    expect(text()).not.toContain('본문 needle 한 줄');
    out = [];
    conductorResultsShowCommand(A, { stateDir: dir, report: '1' });
    expect(text()).toContain('보고 #1 (전체 2건 중)');
    expect(text()).toContain('첫 보고 needle');
    expect(text()).not.toContain('마무리');
    expect(text()).toContain('참조 (0)');
    expect(text()).not.toContain('관련 파일');
    out = [];
    conductorResultsShowCommand(A, { stateDir: dir, report: '2' });
    expect(text()).toContain('참조 (3)');
  });

  it('--report 범위를 벗어나거나 숫자가 아니면 exit 1', () => {
    const { dir } = fixture();
    for (const report of ['0', '3', 'x', '1.5']) {
      expect(() => conductorResultsShowCommand(A, { stateDir: dir, report })).toThrow('exit 1');
      expect(err.at(-1)).toContain('--report는');
    }
  });

  it('--json은 order, reports, refs(본문 포함), related를 낸다', () => {
    const { dir } = fixture();
    conductorResultsShowCommand(A, { stateDir: dir, json: true });
    const j = json();
    expect(j.order.id).toBe(A);
    expect(j.reports).toHaveLength(2);
    expect(j.refs.map((r: { kind: string }) => r.kind)).toEqual(['file', 'outside', 'url']);
    expect(j.refs[0].body.text).toContain('본문 needle 한 줄');
    expect(j.refs[1].body).toBeUndefined();
    expect(j.related[0].rel).toBe(`notes/${A}-extra.md`);
    expect(j.related[0].path).toBeTruthy();
    out = [];
    conductorResultsShowCommand(A, { stateDir: dir, json: true, body: false });
    expect(json().refs[0].body).toBeUndefined();
  });

  it('ESC가 섞인 요약, 제목, refs 본문은 제어 문자가 공백이 되고 줄바꿈은 남는다', () => {
    const base = tempStateDir();
    const note = put(
      join(realpathSync(base), 'reports', 'esc.md'),
      '줄1\u001b[31m빨강\n줄2\u0007끝',
    );
    const { dir } = seed(
      [
        {
          order: { id: A, title: '제목\u001b[2J' },
          reports: [{ summary: '요약\u001b]0;x\u0007뒤', refs: [note] }],
        },
      ],
      base,
    );
    conductorResultsShowCommand(A, { stateDir: dir });
    expect(hasControl(text(), true)).toBe(false);
    expect(text()).toContain('줄1 [31m빨강\n줄2 끝');
  });
});

describe('browse 인자 검증', () => {
  it('잘못된 --port는 안내하고 exit 1', async () => {
    const { dir } = fixture();
    for (const port of ['abc', '-1', '1.5', '123456']) {
      await expect(conductorBrowseCommand({ stateDir: dir, port, open: false })).rejects.toThrow(
        'exit 1',
      );
      expect(err.at(-1)).toContain('--port는');
    }
  });

  it('없는 저장소는 서버를 띄우지 않고 exit 1', async () => {
    const missing = join('.gestalt-test', 'conductor-없는경로-browse');
    await expect(
      conductorBrowseCommand({ stateDir: missing, port: '0', open: false }),
    ).rejects.toThrow('exit 1');
    expect(err.at(-1)).toContain('결과 뷰어를 못 띄웠어요');
    expect(existsSync(missing)).toBe(false);
  });
});
