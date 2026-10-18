import { z } from 'zod';
import { basisFields, checkBasis, type BasisKind } from './evidence.js';
import { httpsUrlSchema, idSchema, textSchema } from './schema-base.js';
import type { Research, ResearchWarning } from './schema.js';

/** improve: 이미 있는 화면을 고친다. new: 아직 없는 화면이라 기준값을 비슷한 퍼널에서 빌려온다 */
export const TARGET_MODES = ['improve', 'new'] as const;
/** 목표치 계산 한 단계가 어디서 온 숫자인지. 위에 있을수록 믿을 만하다 */
export const TARGET_STEP_METHODS = [
  'internal',
  'proxy',
  'business',
  'market',
  'case',
  'assumption',
] as const;
export const TRACKING_STATUSES = ['exists', 'missing', 'planned'] as const;
export const DATA_SOURCE_KINDS = ['amplitude', 'export'] as const;

/** 분석 도구 키처럼 보이는 값. 프로젝트 이름이나 파일 경로 자리에 키를 붙여 넣는 실수를 막는다 */
const KEY_LIKE = /\b[0-9a-f]{32}\b/i;
export const looksLikeKey = (s: string): boolean => KEY_LIKE.test(s);
const noKey = (s: string): boolean => !looksLikeKey(s);
export const KEY_MESSAGE = '키처럼 보이는 값은 적지 않는다. 키가 있는 파일 경로만 적는다';

const pctSchema = z.number().min(0).max(100);

const isUsableBasis = (basis: BasisKind): boolean => basis !== 'unconfirmed' && basis !== 'absent';

const baselineSchema = z
  .object({
    /** 지금 값(%). 못 구했으면 비우고 basis를 unconfirmed로 둔다 */
    valuePct: pctSchema.optional(),
    /** 어느 기간의 값인지. 예: "2026-08-01부터 2026-09-25까지 8주" */
    period: textSchema,
    /** 신규 화면이라 대신 쓴 기존 퍼널. 예: "포인트 충전 진입 대비 결제 완료" */
    proxyOf: z.string().optional(),
    ...basisFields,
  })
  .superRefine((b, ctx) => {
    checkBasis(b, ctx);
    if (b.valuePct === undefined && isUsableBasis(b.basis)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['valuePct'],
        message: '값이 없으면 basis를 unconfirmed로 두고 이유를 적는다',
      });
    }
  });

const entrantsSchema = z
  .object({
    /** 분모에 들어오는 하루 사람 수 */
    value: z.number().positive(),
    /** 신규 화면이면 어떻게 추정했는지. 예: "마이 탭 하루 조회 6만 × 비슷한 배너 클릭률 7%" */
    derivation: z.string().optional(),
    ...basisFields,
  })
  .superRefine(checkBasis);

const rangeSchema = z
  .object({
    conservativePct: pctSchema,
    expectedPct: pctSchema,
    stretchPct: pctSchema,
  })
  .refine(
    (r) => r.conservativePct <= r.expectedPct && r.expectedPct <= r.stretchPct,
    '목표 범위는 보수 ≤ 기대 ≤ 도전 순서다',
  );

const targetStepSchema = z
  .object({
    id: idSchema,
    label: textSchema,
    /** 값과 단위를 같이. 예: "하루 4,200명" */
    value: textSchema,
    method: z.enum(TARGET_STEP_METHODS),
    ...basisFields,
  })
  .superRefine(checkBasis);

const dataSourceSchema = z.object({
  kind: z.enum(DATA_SOURCE_KINDS),
  /** 프로젝트 이름. 키는 적지 않는다 */
  project: textSchema.refine(noKey, KEY_MESSAGE),
  /** 같은 숫자를 다시 볼 수 있는 저장된 차트 */
  chartUrl: httpsUrlSchema.optional(),
  /** 퍼널 단계마다 쓴 이벤트 */
  events: z.array(z.object({ step: textSchema, event: textSchema })).default([]),
  from: textSchema,
  to: textSchema,
});

const trackingItemSchema = z.object({
  event: textSchema,
  /** 퍼널의 어느 단계를 재는지 */
  step: textSchema,
  status: z.enum(TRACKING_STATUSES),
  note: z.string().optional(),
});

export const targetSchema = z.object({
  mode: z.enum(TARGET_MODES),
  metric: z.object({
    name: textSchema,
    numerator: textSchema,
    denominator: textSchema,
  }),
  baseline: baselineSchema,
  dailyEntrants: entrantsSchema.optional(),
  /** 주마다 출렁이는 폭(%p). 이보다 작은 효과는 실험 없이는 안 보인다 */
  weeklySpreadPp: z.number().nonnegative().optional(),
  /** 아무것도 안 해도 목표 시점까지 움직일 몫(%p). 내려가면 음수 */
  trendPp: z.number().optional(),
  range: rangeSchema.optional(),
  steps: z.array(targetStepSchema).default([]),
  dataSource: dataSourceSchema.optional(),
  /** 가설을 재는 데 필요한 이벤트. 신규 화면이면 심어야 할 목록이 된다 */
  trackingPlan: z.array(trackingItemSchema).default([]),
});

export type Target = z.infer<typeof targetSchema>;

// 두 비율 비교, 양측 유의수준 0.05, 검정력 0.8
const Z_ALPHA = 1.959964;
const Z_BETA = 0.841621;
/** 이보다 오래 걸리는 실험은 이 트래픽으로 못 가려낸다고 본다 */
export const MAX_TEST_DAYS = 56;

/** 기준 전환율 basePct에서 liftPp만큼 오른 걸 가려내는 데 필요한 군당 표본 */
export function requiredSamplePerArm(basePct: number, liftPp: number): number {
  const p1 = basePct / 100;
  const p2 = (basePct + liftPp) / 100;
  if (liftPp <= 0 || p2 >= 1) return Number.POSITIVE_INFINITY;
  const pBar = (p1 + p2) / 2;
  const a = Z_ALPHA * Math.sqrt(2 * pBar * (1 - pBar));
  const b = Z_BETA * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil((a + b) ** 2 / (p2 - p1) ** 2);
}

/** 군당 표본 n으로 가려낼 수 있는 가장 작은 효과(%p). 소수 첫째 자리까지 */
export function minDetectableLiftPp(basePct: number, nPerArm: number): number {
  let lo = 0;
  let hi = 100 - basePct;
  if (requiredSamplePerArm(basePct, hi - 1e-9) > nPerArm) return Number.POSITIVE_INFINITY;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (requiredSamplePerArm(basePct, mid) <= nPerArm) hi = mid;
    else lo = mid;
  }
  return Math.ceil(hi * 10) / 10;
}

export function daysNeeded(nPerArm: number, dailyEntrants: number, arms = 2): number {
  return Math.ceil((nPerArm * arms) / dailyEntrants);
}

export interface LiftCoverage {
  /** 기대 목표까지 시안으로 올려야 하는 몫(%p). 추세는 뺀다 */
  neededPp: number;
  /** 기대 효과가 적힌 가설의 합(%p) */
  plannedPp: number;
  /** 다 성공하면 닿는 값(%) */
  reachPct: number;
}

/** 기대 효과가 하나도 없거나 기준값, 목표 범위가 없으면 계산하지 않는다 */
export function liftCoverage(research: Research): LiftCoverage | undefined {
  const t = research.target;
  const base = t?.baseline.valuePct;
  if (!t?.range || base === undefined) return undefined;
  const lifts = research.verification.flatMap((v) =>
    v.expectedLiftPp === undefined ? [] : [v.expectedLiftPp],
  );
  if (lifts.length === 0) return undefined;
  const trend = t.trendPp ?? 0;
  const plannedPp = round1(lifts.reduce((s, x) => s + x, 0));
  return {
    neededPp: round1(t.range.expectedPct - base - trend),
    plannedPp,
    reachPct: round1(base + trend + plannedPp),
  };
}

export interface HypothesisPower {
  index: number;
  liftPp: number;
  nPerArm: number;
  /** 하루 진입 수가 없으면 비운다 */
  days?: number;
}

/** 기대 효과가 적힌 가설마다 필요한 표본과 걸리는 일수 */
export function hypothesisPower(research: Research): HypothesisPower[] {
  const t = research.target;
  const base = t?.baseline.valuePct;
  if (!t || base === undefined) return [];
  return research.verification.flatMap((v, index) => {
    if (v.expectedLiftPp === undefined) return [];
    const nPerArm = requiredSamplePerArm(base, v.expectedLiftPp);
    const days =
      t.dailyEntrants && Number.isFinite(nPerArm)
        ? daysNeeded(nPerArm, t.dailyEntrants.value)
        : undefined;
    return [{ index, liftPp: v.expectedLiftPp, nPerArm, ...(days === undefined ? {} : { days }) }];
  });
}

/** 기준값을 실제 데이터로 채웠는지. 채웠으면 타사 사례는 교차 확인용으로 내려간다 */
export function hasUsableBaseline(research: Research): boolean {
  const b = research.target?.baseline;
  return !!b && b.valuePct !== undefined && isUsableBasis(b.basis);
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

export function lintTarget(research: Research, warnings: ResearchWarning[]): void {
  const t = research.target;
  if (!t) {
    if (research.verification.length > 0) {
      warnings.push({
        path: 'target',
        message:
          '목표치 근거가 없다. 기준값과 하루 진입 수를 기존 데이터에서 뽑아 목표 범위를 계산한다',
      });
    }
    return;
  }

  if (!hasUsableBaseline(research)) {
    warnings.push({
      path: 'target.baseline',
      message: '기준값을 아직 못 구했다. 열린 질문(owner: data)으로 넘긴다',
    });
  }
  if (t.mode === 'new' && !t.baseline.proxyOf?.trim()) {
    warnings.push({
      path: 'target.baseline.proxyOf',
      message: '신규 화면인데 기준값을 어느 기존 퍼널에서 빌렸는지 없다',
    });
  }
  if (!t.range) {
    warnings.push({ path: 'target.range', message: '목표 범위(보수, 기대, 도전)가 없다' });
  }

  const coverage = liftCoverage(research);
  if (coverage && coverage.plannedPp < coverage.neededPp) {
    warnings.push({
      path: 'verification',
      message: `가설을 다 성공해도 목표에 못 닿는다 (기대 효과 합 ${coverage.plannedPp}%p, 필요 ${coverage.neededPp}%p)`,
    });
  }
  if (!coverage && t.range && research.verification.length > 0) {
    if (!research.verification.some((v) => v.expectedLiftPp !== undefined)) {
      warnings.push({
        path: 'verification',
        message: '기대 효과(expectedLiftPp)가 적힌 가설이 없어서 목표까지 닿는지 못 본다',
      });
    }
  }

  research.verification.forEach((v, i) => {
    const lift = v.expectedLiftPp;
    if (lift !== undefined && t.weeklySpreadPp !== undefined && lift < t.weeklySpreadPp) {
      warnings.push({
        path: `verification.${i}.expectedLiftPp`,
        message: `기대 효과 ${lift}%p가 주별 변동 ${t.weeklySpreadPp}%p보다 작다 (가설 ${i + 1}). 실험 없이 전후 비교로는 안 보인다`,
      });
    }
  });
  for (const p of hypothesisPower(research)) {
    if (p.days !== undefined && p.days > MAX_TEST_DAYS) {
      warnings.push({
        path: `verification.${p.index}.expectedLiftPp`,
        message: `이 트래픽으로는 못 가려낸다 (가설 ${p.index + 1}: 군당 ${p.nPerArm.toLocaleString('ko-KR')}명, ${p.days}일)`,
      });
    }
  }

  const tracked = new Map(t.trackingPlan.map((x) => [x.event, x.status]));
  research.verification.forEach((v, i) => {
    v.events.forEach((event, k) => {
      const status = tracked.get(event);
      if (status === 'missing') {
        warnings.push({
          path: `verification.${i}.events.${k}`,
          message: `측정할 이벤트가 없다 (가설 ${i + 1}: ${event}). 심을지 정한다`,
        });
      } else if (status === undefined && t.trackingPlan.length > 0) {
        warnings.push({
          path: `verification.${i}.events.${k}`,
          message: `이벤트 목록(trackingPlan)에 없는 이벤트다 (가설 ${i + 1}: ${event})`,
        });
      }
    });
  });
}
