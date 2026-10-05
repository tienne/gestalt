import { describe, expect, it } from 'vitest';
import { computeDrilldown } from '../../../src/architecture/drilldown.js';
import {
  parseArchitectureIr,
  redactForSharing,
  validateArchitectureIr,
  type ArchitectureIr,
} from '../../../src/architecture/index.js';
import { knowledgeIr } from '../../fixtures/architecture-categories/knowledge.js';
import { LEGACY_IRS, renderBoth } from '../../fixtures/architecture-legacy/render.js';

function validated(ir: ArchitectureIr) {
  const r = validateArchitectureIr(ir, { checkFiles: false });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
}

describe('지식 팩', () => {
  it('스키마와 검증을 통과하고 doc 필드가 파싱 뒤에도 남는다', () => {
    const parsed = parseArchitectureIr(JSON.parse(JSON.stringify(knowledgeIr())));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const status = parsed.value.nodes.find((n) => n.id === 'd-status')!;
    expect(status.doc?.gaps?.[0]?.owner).toBe('kim');
    validated(knowledgeIr());
  });

  it('doc는 지식 팩 노드에만 쓸 수 있다', () => {
    const ir = knowledgeIr();
    ir.packs = ['knowledge', 'web-product'];
    ir.nodes.push({
      id: 'x',
      kind: 'screen',
      label: 'x',
      repo: 'kb',
      evidence: [],
      doc: { path: 'x.md' },
    });
    expect(parseArchitectureIr(JSON.parse(JSON.stringify(ir))).ok).toBe(false);
  });

  it('describes는 문서에서 나가고 점선이어야 한다', () => {
    const ir = knowledgeIr();
    ir.edges.push({
      id: 'bad',
      from: 'g-orders',
      to: 'd-status',
      kind: 'describes',
      evidence: [],
      lineStyle: 'solid',
    });
    const r = validateArchitectureIr(ir, { checkFiles: false });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.code)).toEqual(
      expect.arrayContaining(['INVALID_DESCRIBES_FROM', 'SOLID_DESCRIBES']),
    );
  });

  it('tree 드릴다운으로 분류에서 도메인, 문서로 내려간다', async () => {
    const d = await computeDrilldown(validated(knowledgeIr()));
    expect(d.levels[0]!.nodeIds).toEqual(['g-design', 'g-domain']);
    expect(d.levels.map((l) => l.id)).toEqual(
      expect.arrayContaining(['group:g-domain', 'group:g-orders', 'group:g-store']),
    );
  });

  it('공유본은 문서 제목과 경로를 남기고 본문에서 온 글자를 뺀다', () => {
    const shared = redactForSharing(knowledgeIr());
    const status = shared.nodes.find((n) => n.id === 'd-status')!;
    expect(status.displayName).toBe('주문 상태');
    expect(status.label).toBe('kb/domains/orders/status.md');
    expect(status.doc).toEqual({
      path: 'kb/domains/orders/status.md',
      updatedAt: '2025-11-02',
      gaps: [{ kind: 'gap' }],
      evidenceMix: { code: 4, wiki: 1 },
      links: { total: 5, broken: 1, branchOnly: 3, pinned: 1, unchecked: 0 },
    });
    // 문서 노드 자기 근거는 private이라 위치가 가려진다
    expect(status.evidence[0]!.location).toBeUndefined();
    const index = shared.nodes.find((n) => n.id === 'd-orders-index')!;
    expect(index.doc!.routes!.every((r) => r.keywords.length === 1)).toBe(true);
    expect(JSON.stringify(index.doc)).not.toContain('주문 상태');
    const pay = shared.nodes.find((n) => n.id === 's-pay')!;
    expect(pay.doc!.screen).toEqual({
      route: '/pay/:id',
      screenType: '바텀시트',
      symbolized: false,
      hasSpec: false,
    });
  });

  it('같은 입력이면 같은 HTML이 나오고 공유본에 본문 글자가 없다', async () => {
    const a = await renderBoth(knowledgeIr());
    const b = await renderBoth(knowledgeIr());
    expect(a.private).toBe(b.private);
    expect(a.shared).toBe(b.shared);
    expect(a.private).toContain('취소 사유 코드 목록이 비었다');
    expect(a.shared).not.toContain('취소 사유 코드 목록이 비었다');
    expect(a.shared).toContain('kb/domains/orders/status.md');
    expect(a.shared).not.toContain('Cart / Default');
  });

  it('문서 카드에 열린 구멍과 깨진 링크 배지를 달고 서랍 코드는 지식 팩 그림에만 싣는다', async () => {
    const kn = await renderBoth(knowledgeIr());
    expect(kn.private).toContain('title="열린 구멍 1개">구멍 1</span>');
    expect(kn.private).toContain('title="깨진 근거 링크 1개">깨짐 1</span>');
    expect(kn.private).toContain('function renderDoc(n, body)');
    const legacy = await renderBoth(LEGACY_IRS.web!());
    expect(legacy.private).not.toContain('renderDoc');
    expect(legacy.private).not.toContain('.doc-badge');
  });
});
