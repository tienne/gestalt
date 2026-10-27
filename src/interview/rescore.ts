import type {
  GestaltPrinciple,
  ResolutionDimensionName,
  ResolutionScore,
  RescoreMode,
  RescoreResult,
} from '../core/types.js';
import type { InterviewConfig } from '../core/config.js';
import { selectNextPrinciple } from '../gestalt/principles.js';
import { isResolutionDimensionName } from '../gestalt/signals.js';

export type RescoreSetting = InterviewConfig['rescore'];

/** none: 기준값을 넘은 채점이 아직 없다. pending: 넘었는데 다시 채점을 안 받았다. done: 받았다 */
export type RescoreState = 'none' | 'pending' | 'done';

/** gate 모드에서 차원 하나라도 이보다 크게 흔들리면 판정을 미룬다 */
export const RESCORE_SPREAD_LIMIT = 0.2;

/**
 * 이 채점 뒤에 다시 채점하기를 요청할지 정한다.
 * record는 처음 기준값을 넘을 때 한 번만 요청한다. gate는 다시 채점을 받기 전까지
 * 판정을 미루므로 넘을 때마다 요청한다.
 */
export function shouldRequestRescore(
  setting: RescoreSetting,
  state: RescoreState,
  score: ResolutionScore,
  threshold: number,
): boolean {
  if (setting === 'off' || state === 'done') return false;
  if (score.overall < threshold) return false;
  return setting === 'gate' || state === 'none';
}

export function compareRescore(
  first: ResolutionScore,
  second: ResolutionScore,
  mode: RescoreMode,
  threshold: number,
): RescoreResult {
  const again = new Map(second.dimensions.map((d) => [d.name, d.clarity]));
  let maxDimensionSpread = 0;
  const droppedDimensions: ResolutionDimensionName[] = [];
  for (const d of first.dimensions) {
    const clarity = again.get(d.name);
    if (clarity === undefined) continue;
    maxDimensionSpread = Math.max(maxDimensionSpread, Math.abs(d.clarity - clarity));
    if (d.clarity >= threshold && clarity < threshold && isResolutionDimensionName(d.name)) {
      droppedDimensions.push(d.name);
    }
  }
  return {
    mode,
    overall: second.overall,
    maxDimensionSpread: Math.round(maxDimensionSpread * 10000) / 10000,
    droppedDimensions,
  };
}

/** record는 첫 점수의 판정을 그대로 두고 gate는 낮은 overall과 흔들림으로 다시 정한다 */
export function readinessAfterRescore(
  setting: RescoreSetting,
  first: ResolutionScore,
  rescore: RescoreResult,
  threshold: number,
): boolean {
  if (setting !== 'gate') return first.isReady;
  return (
    Math.min(first.overall, rescore.overall) >= threshold &&
    rescore.maxDimensionSpread <= RESCORE_SPREAD_LIMIT
  );
}

/**
 * gate가 판정을 미뤘을 때 다음 질문의 원칙.
 * 흔들림이 기준을 넘었으면 가장 많이 흔들린 차원을 묻는다. 안 넘었으면 낮은 쪽 점수로 고른다.
 */
export function principleAfterRescore(
  first: ResolutionScore,
  second: ResolutionScore,
  rescore: RescoreResult,
  roundNumber: number,
): GestaltPrinciple {
  if (rescore.maxDimensionSpread > RESCORE_SPREAD_LIMIT) {
    const again = new Map(second.dimensions.map((d) => [d.name, d.clarity]));
    let shaken = first.dimensions[0]!;
    let widest = -1;
    for (const d of first.dimensions) {
      const spread = Math.abs(d.clarity - (again.get(d.name) ?? d.clarity));
      if (spread > widest) {
        widest = spread;
        shaken = d;
      }
    }
    return shaken.gestaltPrinciple;
  }
  const lower = second.overall < first.overall ? second : first;
  return selectNextPrinciple({
    roundNumber,
    dimensions: lower.dimensions,
    hasContradictions: (lower.contradictions?.length ?? 0) > 0,
  });
}
