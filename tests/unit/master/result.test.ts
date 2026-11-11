import { describe, expect, it } from 'vitest';
import { checkSummary, parseWorkerReport, ReportRejected } from '../../../src/master/result.js';

const ok = {
  workerId: 'wrk-1',
  status: 'done',
  summary: 'PR #12 머지 완료',
  refs: ['https://example.com/pr/12'],
};

describe('워커 결과 검증', () => {
  it('요약과 참조만 있는 결과는 받는다', () => {
    const r = parseWorkerReport({ ...ok, merged: true, skill: 'ship' }, 2000);
    expect(r).toMatchObject({ workerId: 'wrk-1', status: 'done', merged: true, skill: 'ship' });
  });

  it('diff, 스택 트레이스, 코드 블록, 긴 로그는 거절한다', () => {
    const cases = [
      'diff --git a/x b/x\n--- a/x\n+++ b/x',
      '변경\n@@ -1,3 +1,4 @@\n+x',
      'Error: boom\n    at run (/repo/src/x.ts:10:5)',
      'Traceback (most recent call last):\n  File "x.py"',
      '```\nlog\n```',
      Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'),
    ];
    for (const summary of cases) expect(checkSummary(summary, 2000).ok).toBe(false);
  });

  it('상한을 넘는 요약은 거절하고 이유를 돌려준다', () => {
    try {
      parseWorkerReport({ ...ok, summary: 'a'.repeat(2001) }, 2000);
      throw new Error('통과하면 안 된다');
    } catch (e) {
      expect(e).toBeInstanceOf(ReportRejected);
      expect((e as ReportRejected).problems[0]).toMatch(/상한 2000자/);
    }
  });

  it('여러 줄짜리 ref나 모르는 status는 거절한다', () => {
    expect(() => parseWorkerReport({ ...ok, refs: ['a\nb'] }, 2000)).toThrow(ReportRejected);
    expect(() => parseWorkerReport({ ...ok, status: 'whatever' }, 2000)).toThrow(ReportRejected);
  });

  it('needs는 need가 있어야 하고 stopped는 이유가 없으면 unknown으로 둔다', () => {
    expect(() => parseWorkerReport({ ...ok, status: 'needs' }, 2000)).toThrow(/need가/);
    const r = parseWorkerReport({ ...ok, status: 'stopped' }, 2000);
    expect(r.stopReason).toBe('unknown');
    const n = parseWorkerReport(
      { ...ok, status: 'needs', need: { kind: 'cleanup', detail: '워크트리 삭제' } },
      2000,
    );
    expect(n.need).toEqual({ kind: 'cleanup', detail: '워크트리 삭제' });
  });

  it('하위 워커 요청을 받는다', () => {
    const r = parseWorkerReport(
      {
        ...ok,
        status: 'progress',
        spawnRequest: { title: '문서 따로', detail: '문서 갱신을 나눠 주세요' },
      },
      2000,
    );
    expect(r.spawnRequest?.title).toBe('문서 따로');
  });

  it('경로 문자가 든 workerId는 거절한다', () => {
    for (const workerId of ['../wrk-1', 'wrk/1', 'a'.repeat(65)]) {
      expect(() => parseWorkerReport({ ...ok, workerId }, 2000)).toThrow(ReportRejected);
    }
  });

  it('prRef는 owner/name#번호로 맞추고 알아볼 수 없으면 버린다', () => {
    const url = parseWorkerReport(
      { ...ok, prRef: 'https://github.com/acme/app/pull/012/files' },
      2000,
    );
    expect(url.prRef).toBeUndefined();
    expect(
      parseWorkerReport({ ...ok, prRef: 'https://github.com/acme/app/pull/12' }, 2000).prRef,
    ).toBe('acme/app#12');
    expect(parseWorkerReport({ ...ok, prRef: ' acme/app#7 ' }, 2000).prRef).toBe('acme/app#7');
    expect(parseWorkerReport({ ...ok, prRef: 'PR 12' }, 2000).prRef).toBeUndefined();
  });
});
