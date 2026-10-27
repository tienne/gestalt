import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildReport,
  parseCsv,
  scoreBand,
  selectRows,
} from '../../../benchmarks/resolution-calibration.js';

const FIXTURE = resolve('tests/fixtures/resolution-calibration/outcomes.csv');
const csv = parseCsv(readFileSync(FIXTURE, 'utf-8'));

describe('해상도 결과 표', () => {
  it('따옴표 안의 쉼표는 칸을 나누지 않는다', () => {
    const rows = parseCsv('a,b,c\n1,"x, ""y""",3\n');
    expect(rows).toEqual([{ a: '1', b: 'x, "y"', c: '3' }]);
    expect(csv.find((r) => r.spec_id === 's046')!.termination_reason).toBe('done, forced');
  });

  it('해상도 점수가 없는 행과 final이 아닌 행은 표에서 뺀다', () => {
    const { rows, withoutScore, notFinal } = selectRows(csv);
    expect(rows).toHaveLength(48);
    expect(withoutScore).toBe(1);
    expect(notFinal).toBe(1);
  });

  it('force 구간은 행마다 남은 기준값으로 가른다', () => {
    const { rows } = selectRows(csv);
    const raised = rows.find((r) => r.threshold === 0.9)!;
    expect(raised.resolutionScore).toBe(0.86);
    expect(scoreBand(raised)).toBe('force (< 기준값)');
  });

  it('점수 구간별 표에 칸별 숫자와 표본 부족 표시가 나온다', () => {
    const report = buildReport(csv);
    expect(report).toContain('| force (< 기준값) | 3 | 66.7% 표본 부족 | 1.0 | 0.00 |');
    expect(report).toContain('| 기준값 ~ 0.85 | 22 | 50.0% | 1.0 | 0.23 |');
    expect(report).toContain('| 0.85 ~ 0.90 | 20 | 25.0% | 1.0 | 0.25 |');
    expect(report).toContain('| 0.90 이상 | 3 | 33.3% 표본 부족 | 1.0 | 0.00 |');
  });

  it('신호별 표는 값이 빈 행을 어느 칸에도 넣지 않는다', () => {
    const report = buildReport(csv);
    expect(report).toContain(
      '| 안 물은 차원 | 없음 | 21.6% (37) | 1개 이상 | 100.0% (11) 표본 부족 |',
    );
    expect(report).toContain('| 위임 답변 | 0 | 50.0% (28) | 1 이상 | 25.0% (20) |');
    // force 행 셋은 다시 채점을 안 받아서 42 + 3 = 45행만 들어간다
    expect(report).toContain(
      '| 다시 채점 흔들림 | 0.2 이하 | 38.1% (42) | 0.2 초과 | 33.3% (3) 표본 부족 |',
    );
    expect(report).toContain(
      '| overall 점프 | 0.3 이하 | 37.0% (46) | 0.3 초과 | 100.0% (2) 표본 부족 |',
    );
    expect(report).toContain('다시 채점을 안 받은 스펙은 3개다');
  });

  it('필요한 열이 없으면 멈춘다', () => {
    expect(() => buildReport(parseCsv('spec_id,resolution_score\ns1,0.9\n'))).toThrow(/threshold/);
  });
});
