import type { BasisKind, EvidenceRef } from './evidence.js';
import type { Research } from './schema.js';
import {
  hypothesisPower,
  LIFT_METHOD_LABEL,
  liftCoverage,
  SHORTFALL_DECISION_LABEL,
  type Target,
} from './target.js';

/** HTML과 Figma가 같은 칸을 그리도록 목표치 블록을 표 모양으로 펴 둔다 */
export interface TargetCell {
  text: string;
  basis?: BasisKind;
  evidence?: EvidenceRef[];
  note?: string;
  /** 칸 아래 작은 글씨 */
  sub?: string;
}

export interface TargetView {
  rows: [string, TargetCell][];
  steps: { label: string; value: TargetCell; method: string }[];
  coverage?: string;
  /** 가설을 다 성공해도 못 닿을 때 사용자와 고른 대응 */
  shortfall?: string;
  /** 가설, 기대 효과, 군당 표본, 걸리는 일수 칸과 기대 효과의 근거 칸 */
  power: { cells: string[]; liftBasis: TargetCell }[];
  tracking: string[][];
}

export const TARGET_STEP_METHOD_LABEL: Record<Target['steps'][number]['method'], string> = {
  internal: '우리 데이터',
  proxy: '비슷한 퍼널',
  business: '사업 계획',
  market: '시장 자료',
  case: '타사 사례',
  assumption: '가정',
};

export const TRACKING_STATUS_LABEL: Record<Target['trackingPlan'][number]['status'], string> = {
  exists: '있음',
  missing: '없음',
  planned: '심기로 함',
};

const DATA_SOURCE_LABEL: Record<NonNullable<Target['dataSource']>['kind'], string> = {
  amplitude: 'Amplitude',
  export: '내보낸 숫자',
};

const pp = (x: number): string => `${x > 0 ? '+' : ''}${x}%p`;
const people = (n: number): string => `${n.toLocaleString('ko-KR')}명`;

export function targetView(research: Research, shared: boolean): TargetView | undefined {
  const t = research.target;
  if (!t) return undefined;
  const b = t.baseline;
  const rows: [string, TargetCell][] = [
    ['목표 지표', { text: `${t.metric.name}: ${t.metric.denominator} 대비 ${t.metric.numerator}` }],
    ['화면', { text: t.mode === 'new' ? '새로 만드는 화면' : '있는 화면 개선' }],
    [
      '기준값',
      {
        text: b.valuePct === undefined ? `못 구함 (${b.period})` : `${b.valuePct}% (${b.period})`,
        basis: b.basis,
        evidence: b.evidence,
        ...(b.note ? { note: b.note } : {}),
        ...(b.proxyOf ? { sub: `대신 쓴 퍼널: ${b.proxyOf}` } : {}),
      },
    ],
  ];
  const d = t.dailyEntrants;
  if (d) {
    rows.push([
      '하루 진입 수',
      {
        text: people(d.value),
        basis: d.basis,
        evidence: d.evidence,
        ...(d.note ? { note: d.note } : {}),
        ...(d.derivation ? { sub: d.derivation } : {}),
      },
    ]);
  }
  if (t.weeklySpreadPp !== undefined) {
    rows.push(['주별 변동', { text: `±${t.weeklySpreadPp}%p` }]);
  }
  if (t.trendPp !== undefined) rows.push(['자연 추세', { text: pp(t.trendPp) }]);
  if (t.range) {
    const r = t.range;
    rows.push([
      '목표 범위',
      { text: `보수 ${r.conservativePct}%, 기대 ${r.expectedPct}%, 도전 ${r.stretchPct}%` },
    ]);
  }
  const ds = t.dataSource;
  if (ds) {
    const events = ds.events.map((x) => `${x.step}: ${x.event}`).join(', ');
    const chart = ds.chartUrl && !shared ? ` ${ds.chartUrl}` : '';
    rows.push([
      '데이터 출처',
      {
        text: `${DATA_SOURCE_LABEL[ds.kind]} ${ds.project}, ${ds.from}부터 ${ds.to}까지${chart}`,
        ...(events ? { sub: events } : {}),
      },
    ]);
  }

  const coverage = liftCoverage(research);
  const power = hypothesisPower(research).map((p) => {
    const lb = research.verification[p.index]?.liftBasis;
    return {
      cells: [
        `가설 ${p.index + 1}`,
        pp(p.liftPp),
        Number.isFinite(p.nPerArm) ? people(p.nPerArm) : '계산 못함',
        p.days === undefined ? '하루 진입 수 없음' : `${p.days}일`,
      ],
      liftBasis: lb
        ? {
            text: LIFT_METHOD_LABEL[lb.method],
            basis: lb.basis,
            evidence: lb.evidence,
            ...(lb.note ? { note: lb.note } : {}),
          }
        : { text: '근거 없음', basis: 'absent' as const },
    };
  });
  const sf = t.shortfall;
  const shortfall = sf
    ? [
        `가설 합이 기대 목표에 모자라서 고른 대응은 '${SHORTFALL_DECISION_LABEL[sf.decision]}'이다.`,
        sf.originalExpectedPct === undefined
          ? ''
          : `처음 기대 목표는 ${sf.originalExpectedPct}%였다.`,
        sf.note,
      ]
        .filter(Boolean)
        .join(' ')
    : undefined;

  return {
    rows,
    steps: t.steps.map((s) => ({
      label: s.label,
      value: {
        text: s.value,
        basis: s.basis,
        evidence: s.evidence,
        ...(s.note ? { note: s.note } : {}),
      },
      method: TARGET_STEP_METHOD_LABEL[s.method],
    })),
    ...(coverage
      ? {
          coverage: `가설을 다 성공하면 ${coverage.reachPct}%까지 간다. 기대 목표까지 시안으로 올려야 하는 몫은 ${coverage.neededPp}%p이고 가설 기대 효과의 합은 ${coverage.plannedPp}%p다. 효과가 겹칠 수 있어서 합은 많이 잡은 값이다.`,
        }
      : {}),
    ...(shortfall ? { shortfall } : {}),
    power,
    tracking: t.trackingPlan
      .filter((x) => x.status !== 'exists')
      .map((x) => [x.event, x.step, TRACKING_STATUS_LABEL[x.status], x.note ?? '']),
  };
}
