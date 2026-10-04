import { createHash } from 'node:crypto';
import {
  computeDrilldown,
  mergeArchitectureIrs,
  renderArchitectureHtml,
  renderDrilldownHtml,
  shouldDrillDown,
  validateArchitectureIr,
  type ArchitectureIr,
} from '../../../src/architecture/index.js';
import { computeLayout } from '../../../src/architecture/layout.js';
import { deployIr, flowIr, harnessIr, partnerIr, webIr } from './irs.js';

function merged(): ArchitectureIr {
  const r = mergeArchitectureIrs([webIr(), partnerIr()], { groupNames: ['상점', '파트너'] });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.ir;
}

export const LEGACY_IRS: Record<string, () => ArchitectureIr> = {
  web: webIr,
  flow: flowIr,
  harness: harnessIr,
  deploy: deployIr,
  merged,
};

/** 서버 render 액션과 같은 길로 private과 shared HTML을 그린다. 이전 실행 병합만 빠진다 */
export async function renderBoth(ir: ArchitectureIr): Promise<{ private: string; shared: string }> {
  const r = validateArchitectureIr(ir, { checkFiles: false });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  const v = r.value;
  if (shouldDrillDown(v)) {
    const d = await computeDrilldown(v);
    return {
      private: renderDrilldownHtml(v, d, { audience: 'private' }),
      shared: renderDrilldownHtml(v, d, { audience: 'shared' }),
    };
  }
  const layout = await computeLayout(v.ir, v.drawableNodeIds, v.drawableEdgeIds);
  return {
    private: renderArchitectureHtml(v, layout, { audience: 'private' }),
    shared: renderArchitectureHtml(v, layout, { audience: 'shared' }),
  };
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
