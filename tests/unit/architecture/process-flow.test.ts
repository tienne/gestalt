import { describe, expect, it } from 'vitest';
import { parseArchitectureIr, validateArchitectureIr } from '../../../src/architecture/index.js';
import { code } from '../../fixtures/architecture-categories/common.js';
import { refundApprovalIr } from '../../fixtures/architecture-categories/process.js';
import { renderBoth } from '../../fixtures/architecture-legacy/render.js';

describe('서비스 없는 업무 흐름', () => {
  it('service 없는 흐름과 root 없는 레포가 스키마와 검증을 통과한다', () => {
    const ir = refundApprovalIr();
    expect(parseArchitectureIr(JSON.parse(JSON.stringify(ir))).ok).toBe(true);
    const r = validateArchitectureIr(ir, { checkFiles: false });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it('문서 묶음 레포를 가리키는 code 근거는 막는다', () => {
    const ir = refundApprovalIr();
    ir.flows![0]!.steps[0]!.evidence = [code('wiki:src/refund.ts:1')];
    const r = validateArchitectureIr(ir, { checkFiles: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toContain('CODE_EVIDENCE_IN_DOC_REPO');
  });

  it('흐름 레벨을 그리고 빈 전체 레벨에는 흐름 링크를 둔다', async () => {
    const html = (await renderBoth(refundApprovalIr())).private;
    expect(html).toContain('<title>업무 흐름');
    expect(html).toContain('data-level-id="flow:refund"');
    expect(html).toContain('href="#/level/flow%3Arefund"');
    expect(html).not.toContain('여기는 보여줄 항목이 없어요.');
  });
});
