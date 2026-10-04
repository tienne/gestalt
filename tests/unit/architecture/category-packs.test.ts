import { describe, expect, it } from 'vitest';
import { computeDrilldown } from '../../../src/architecture/drilldown.js';
import {
  parseArchitectureIr,
  validateArchitectureIr,
  type ArchitectureIr,
} from '../../../src/architecture/index.js';
import { dataPipelineIr } from '../../fixtures/architecture-categories/data-pipeline.js';
import { infraIr } from '../../fixtures/architecture-categories/infra.js';
import { orgProcessIr } from '../../fixtures/architecture-categories/org-process.js';
import { renderBoth } from '../../fixtures/architecture-legacy/render.js';

function validated(ir: ArchitectureIr) {
  const r = validateArchitectureIr(ir, { checkFiles: false });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
}

describe.each<[string, () => ArchitectureIr, string[], string]>([
  ['인프라', infraIr, ['saas', 'vpc-data', 'vpc-main'], 'group:vpc-main'],
  [
    '데이터 파이프라인',
    dataPipelineIr,
    ['dw', 'etl', 'orders-db', 'orders-topic', 'sales-dash'],
    'group:etl',
  ],
  ['업무 조직', orgProcessIr, ['hq', 'pos', 'refund-form', 'store'], 'group:store'],
])('%s 팩', (_name, build, rootIds, groupLevel) => {
  it('스키마와 검증을 통과한다', () => {
    expect(parseArchitectureIr(JSON.parse(JSON.stringify(build()))).ok).toBe(true);
    validated(build());
  });

  it('전체는 parent 없는 노드, 묶음마다 레벨이 하나씩 생긴다', async () => {
    const d = await computeDrilldown(validated(build()));
    expect(d.levels[0]!.nodeIds).toEqual(rootIds);
    expect(d.levels.map((l) => l.id)).toContain(groupLevel);
  });

  it('같은 입력이면 같은 HTML이 나온다', async () => {
    const a = await renderBoth(build());
    const b = await renderBoth(build());
    expect(a.private).toBe(b.private);
    expect(a.shared).toBe(b.shared);
    expect(a.private).toContain(`data-level-id="${groupLevel}"`);
  });
});

describe('팩 엣지 끝 규칙', () => {
  it('발행은 원천이나 작업에서 토픽으로만 잇는다', () => {
    const ir = dataPipelineIr();
    ir.edges.find((e) => e.id === 'e-src-topic')!.to = 'sales-dash';
    const r = validateArchitectureIr(ir, { checkFiles: false });
    expect(r.ok).toBe(false);
  });

  it('문서와 사용자 근거만 있는 업무 조직은 선이 전부 점선이다', async () => {
    const d = await computeDrilldown(validated(orgProcessIr()));
    const store = d.levels.find((l) => l.id === 'group:store')!;
    expect(store.edges.length).toBeGreaterThan(0);
    expect(store.edges.every((e) => e.lineStyle === 'dashed')).toBe(true);
  });
});
