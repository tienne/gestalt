import { describe, expect, it } from 'vitest';
import { lintResearch, parseResearch, type Research } from '../../../src/research/schema.js';
import {
  daysNeeded,
  liftCoverage,
  minDetectableLiftPp,
  requiredSamplePerArm,
} from '../../../src/research/target.js';
import { sampleResearch } from './fixture.js';

type Input = ReturnType<typeof sampleResearch>;

function build(edit: (input: Input) => void = () => {}): Research {
  const input = sampleResearch();
  edit(input);
  const parsed = parseResearch(input);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

function parseError(edit: (input: Input) => void): string {
  const input = sampleResearch();
  edit(input);
  const parsed = parseResearch(input);
  expect(parsed.ok).toBe(false);
  return parsed.ok ? '' : parsed.error.message;
}

const messages = (r: Research): string[] => lintResearch(r).map((w) => w.message);
const paths = (r: Research): string[] => lintResearch(r).map((w) => w.path);

describe('목표치 계산', () => {
  it('기준 10%에서 2%p를 가려내려면 군당 약 3,840명이 든다', () => {
    expect(requiredSamplePerArm(10, 2)).toBeGreaterThanOrEqual(3830);
    expect(requiredSamplePerArm(10, 2)).toBeLessThanOrEqual(3850);
  });

  it('효과가 0 이하면 표본이 끝없이 든다', () => {
    expect(requiredSamplePerArm(10, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it('최소 검출 효과는 표본 공식을 거꾸로 푼 값이다', () => {
    const mde = minDetectableLiftPp(10, requiredSamplePerArm(10, 2));
    expect(mde).toBeGreaterThanOrEqual(2);
    expect(mde).toBeLessThanOrEqual(2.1);
  });

  it('걸리는 일수는 두 군 표본을 하루 진입 수로 나눠 올린다', () => {
    expect(daysNeeded(3841, 1000)).toBe(8);
  });

  it('가설 기대 효과를 더해 목표까지 닿는지 본다', () => {
    const c = liftCoverage(
      build((input) => {
        input.target!.trendPp = 0.5;
      }),
    );
    expect(c).toEqual({ neededPp: 1.5, plannedPp: 2, reachPct: 12.5 });
  });
});

describe('목표치 스키마', () => {
  it('목표 범위 순서가 틀리면 막는다', () => {
    const msg = parseError((input) => {
      input.target!.range = { conservativePct: 13, expectedPct: 12, stretchPct: 11 };
    });
    expect(msg).toContain('보수 ≤ 기대 ≤ 도전');
  });

  it('값이 없는 기준값은 unconfirmed와 이유가 있어야 한다', () => {
    parseError((input) => {
      input.target!.baseline.valuePct = undefined;
    });
    build((input) => {
      const b = input.target!.baseline;
      b.valuePct = undefined;
      b.basis = 'unconfirmed';
      b.evidence = [];
      b.note = '분석 도구 권한이 없다';
    });
  });

  it('데이터 출처 프로젝트 자리에 키처럼 보이는 값을 넣으면 막는다', () => {
    const msg = parseError((input) => {
      input.target!.dataSource = {
        kind: 'amplitude',
        project: '0123456789abcdef0123456789abcdef',
        from: '2026-08-01',
        to: '2026-09-25',
      };
    });
    expect(msg).toContain('키처럼 보이는 값');
  });

  it('없는 캡처를 근거로 걸면 막는다', () => {
    const msg = parseError((input) => {
      input.target!.baseline.evidence = [{ type: 'capture', captureId: 'ghost' }];
    });
    expect(msg).toContain('없는 캡처: ghost');
  });
});

describe('목표치 경고', () => {
  it('가설이 있는데 목표치 근거가 없으면 경고한다', () => {
    const r = build((input) => {
      input.target = undefined;
    });
    expect(paths(r)).toContain('target');
  });

  it('신규 화면인데 대신 쓴 퍼널이 없으면 경고한다', () => {
    const r = build((input) => {
      input.target!.mode = 'new';
    });
    expect(paths(r)).toContain('target.baseline.proxyOf');
  });

  it('기준값을 못 구했으면 경고한다', () => {
    const r = build((input) => {
      const b = input.target!.baseline;
      b.valuePct = undefined;
      b.basis = 'unconfirmed';
      b.evidence = [];
      b.note = '권한 없음';
    });
    expect(paths(r)).toContain('target.baseline');
  });

  it('가설을 다 성공해도 목표에 못 닿으면 경고한다', () => {
    const r = build((input) => {
      input.target!.range = { conservativePct: 12, expectedPct: 15, stretchPct: 18 };
    });
    expect(messages(r)).toContainEqual(
      expect.stringContaining('가설을 다 성공해도 목표에 못 닿는다 (기대 효과 합 2%p, 필요 5%p)'),
    );
  });

  it('기대 효과가 주별 변동보다 작으면 경고한다', () => {
    const r = build((input) => {
      input.target!.weeklySpreadPp = 3;
    });
    expect(paths(r)).toContain('verification.0.expectedLiftPp');
  });

  it('하루 진입 수로 8주 안에 못 가려내면 경고한다', () => {
    const r = build((input) => {
      input.target!.dailyEntrants!.value = 100;
    });
    expect(messages(r)).toContainEqual(expect.stringContaining('이 트래픽으로는 못 가려낸다'));
  });

  it('측정할 이벤트가 없거나 목록에 없으면 경고한다', () => {
    const missing = build((input) => {
      input.target!.trackingPlan![0]!.status = 'missing';
    });
    expect(messages(missing)).toContainEqual(expect.stringContaining('측정할 이벤트가 없다'));
    const unknown = build((input) => {
      input.verification![0]!.events = ['ghost_event'];
    });
    expect(messages(unknown)).toContainEqual(expect.stringContaining('ghost_event'));
  });

  it('기대 효과가 적힌 가설이 하나도 없으면 경고한다', () => {
    const r = build((input) => {
      input.verification![0]!.expectedLiftPp = undefined;
    });
    expect(messages(r)).toContainEqual(expect.stringContaining('기대 효과(expectedLiftPp)'));
  });

  it('기준값을 우리 데이터로 채웠으면 타사 사례가 없어도 경고하지 않는다', () => {
    const r = build((input) => {
      input.metricCases = [];
      input.verification![0]!.metricCaseIds = [];
    });
    expect(paths(r)).not.toContain('metricCases');
  });
});

describe('기대 효과 근거', () => {
  it('기대 효과에 근거가 없으면 경고한다', () => {
    const r = build((input) => {
      delete input.verification[0]!.liftBasis;
    });
    expect(paths(r)).toContain('verification.0.liftBasis');
    expect(messages(r)).toContainEqual(expect.stringContaining('기대 효과 2%p의 근거가 없다'));
  });

  it('근거가 가정이면 경고한다', () => {
    const r = build((input) => {
      input.verification[0]!.liftBasis = {
        method: 'assumption',
        basis: 'interpretation',
        evidence: [],
      };
    });
    expect(messages(r)).toContainEqual(expect.stringContaining('기대 효과 2%p가 가정이다'));
  });

  it('근거를 확인 못했으면 사례라고 적어도 경고한다', () => {
    const r = build((input) => {
      input.verification[0]!.liftBasis = {
        method: 'case',
        basis: 'unconfirmed',
        evidence: [],
        note: '공개된 수치가 없다',
      };
    });
    expect(messages(r)).toContainEqual(expect.stringContaining('가 가정이다'));
  });

  it('근거에 없는 캡처를 걸면 막는다', () => {
    const message = parseError((input) => {
      input.verification[0]!.liftBasis = {
        method: 'case',
        basis: 'observation',
        evidence: [{ type: 'capture', captureId: 'ghost' }],
      };
    });
    expect(message).toContain('verification.0.liftBasis.evidence');
    expect(message).toContain('없는 캡처: ghost');
  });
});

describe('가설로 목표에 못 닿을 때', () => {
  const short = (input: Input): void => {
    input.target!.range = { conservativePct: 12, expectedPct: 15, stretchPct: 18 };
  };

  it('대응을 안 정했으면 고를 대응을 함께 알린다', () => {
    const r = build(short);
    expect(messages(r)).toContainEqual(expect.stringContaining('target.shortfall에 적는다'));
  });

  it('그대로 두기로 했으면 경고하지 않는다', () => {
    const r = build((input) => {
      short(input);
      input.target!.shortfall = { decision: 'keep', note: 'PM과 도전 목표로 두기로 했다' };
    });
    expect(messages(r).some((m) => m.includes('목표에 못 닿'))).toBe(false);
  });

  it('다른 대응을 골랐는데 아직 못 닿으면 경고한다', () => {
    const r = build((input) => {
      short(input);
      input.target!.shortfall = { decision: 'add-hypotheses', note: '진입점 가설을 더한다' };
    });
    expect(paths(r)).toContain('target.shortfall');
    expect(messages(r)).toContainEqual(expect.stringContaining("고른 대응은 '가설 추가'인데"));
  });

  it('목표를 낮췄으면 처음 목표를 적어야 한다', () => {
    const message = parseError((input) => {
      input.target!.shortfall = { decision: 'lower-target', note: '가설 합에 맞췄다' };
    });
    expect(message).toContain('originalExpectedPct');
  });
});
