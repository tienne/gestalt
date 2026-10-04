import { describe, expect, it } from 'vitest';
import {
  mergeWithPrevious,
  parseArchitectureIr,
  validateArchitectureIr,
  type ArchitectureIr,
} from '../../../src/architecture/index.js';
import { code } from '../../fixtures/architecture-categories/common.js';
import { checkoutSequenceIr } from '../../fixtures/architecture-categories/sequence.js';
import { renderBoth } from '../../fixtures/architecture-legacy/render.js';

function errorCodes(ir: ArchitectureIr): string[] {
  const r = validateArchitectureIr(ir, { checkFiles: false });
  return r.ok ? [] : r.errors.map((e) => e.code);
}

function checkout(): NonNullable<ArchitectureIr['projections']>[number] {
  return checkoutSequenceIr().projections![0]!;
}

describe('질문별 sequence 투영', () => {
  it('스키마를 통과하고 근거 없는 메시지만 질문으로 돌린다', () => {
    const ir = checkoutSequenceIr();
    expect(parseArchitectureIr(JSON.parse(JSON.stringify(ir))).ok).toBe(true);
    const r = validateArchitectureIr(ir, { checkFiles: false });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect([...(r.value.drawableMessageIds ?? [])].sort()).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
      'm5',
      'm6',
    ]);
    expect(r.value.autoUnresolved.map((q) => q.id)).toContain('auto:message:m7');
    expect(r.value.autoUnresolved.find((q) => q.id === 'auto:message:m7')?.subject).toEqual({
      messageId: 'm7',
    });
  });

  it('엣지 근거를 물려받은 메시지는 실선, 문서 근거만 있으면 점선이다', () => {
    const r = validateArchitectureIr(checkoutSequenceIr(), { checkFiles: false });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const style = new Map(
      r.value.ir.projections![0]!.messages.map((m) => [m.id, m.lineStyle] as const),
    );
    expect(style.get('m1')).toBe('solid');
    expect(style.get('m2')).toBe('dashed');
  });

  it.each<[string, (ir: ArchitectureIr) => void]>([
    ['PROJECTION_NODE_NOT_FOUND', (ir) => (ir.projections![0]!.messages[0]!.to = 'ghost')],
    ['PROJECTION_EDGE_NOT_FOUND', (ir) => (ir.projections![0]!.messages[0]!.edge = 'e-ghost')],
    ['PROJECTION_EDGE_MISMATCH', (ir) => (ir.projections![0]!.messages[0]!.edge = 'e-api-pg')],
    ['PROJECTION_BLOCK_NOT_FOUND', (ir) => (ir.projections![0]!.messages[0]!.block = 'b-ghost')],
    [
      'PROJECTION_BLOCK_SPLIT',
      (ir) => {
        const ms = ir.projections![0]!.messages;
        ms.push({ ...ms[5]!, id: 'm8' });
      },
    ],
    [
      'SOLID_MESSAGE_WITHOUT_EVIDENCE',
      (ir) => (ir.projections![0]!.messages[1]!.lineStyle = 'solid'),
    ],
    ['DUPLICATE_MESSAGE_ID', (ir) => (ir.projections![0]!.messages[1]!.id = 'm1')],
    ['DUPLICATE_PROJECTION_ID', (ir) => ir.projections!.push({ ...checkout() })],
  ])('%s를 거부한다', (expected, mutate) => {
    const ir = checkoutSequenceIr();
    mutate(ir);
    expect(errorCodes(ir)).toContain(expected);
  });

  it('투영 레벨과 메시지를 그리고 전체에는 구성 요소 카드를 세운다', async () => {
    const html = (await renderBoth(checkoutSequenceIr())).private;
    expect(html).toContain('data-level-id="view:checkout"');
    expect(html).toContain('href="#/level/view%3Acheckout"');
    expect(html).toContain('data-message-id="m1"');
    expect(html).toContain('data-message-id="m6"');
    expect(html).not.toContain('data-message-id="m7"');
    expect(html).toContain('id="views-btn"');
    expect(html).toContain('data-node-id="ledger"');
  });

  it('같은 입력이면 같은 HTML이 나온다', async () => {
    const a = await renderBoth(checkoutSequenceIr());
    const b = await renderBoth(checkoutSequenceIr());
    expect(a.private).toBe(b.private);
    expect(a.shared).toBe(b.shared);
  });

  it('shared 사본은 메시지 글자의 계정 ID를 가린다', async () => {
    const ir = checkoutSequenceIr();
    ir.projections![0]!.messages[2]!.label = '승인 요청 123456789012';
    const html = await renderBoth(ir);
    expect(html.private).toContain('123456789012');
    expect(html.shared).not.toContain('123456789012');
  });

  it('지난 실행과 합치면 투영이 바뀐 노드와 엣지 id를 따라간다', () => {
    const prev = checkoutSequenceIr();
    prev.nodes = prev.nodes.map((n) => (n.id === 'api' ? { ...n, id: 'order-api' } : n));
    prev.edges = prev.edges.map((e) =>
      e.id === 'e-app-api'
        ? { ...e, id: 'e-old', to: 'order-api' }
        : { ...e, from: e.from === 'api' ? 'order-api' : e.from },
    );
    const merged = mergeWithPrevious(prev, checkoutSequenceIr());
    const p = merged.projections![0]!;
    expect(p.participants).toContain('order-api');
    expect(p.messages[0]).toMatchObject({ from: 'app', to: 'order-api', edge: 'e-old' });
    expect(validateArchitectureIr(merged, { checkFiles: false }).ok).toBe(true);
  });

  it('투영 메시지 근거도 문서 묶음 레포를 code로 가리키지 못한다', () => {
    const ir = checkoutSequenceIr();
    ir.repos.push({ id: 'wiki', name: 'acme-wiki' });
    ir.projections![0]!.messages[1]!.evidence = [code('wiki:src/pay.ts:1')];
    expect(errorCodes(ir)).toContain('CODE_EVIDENCE_IN_DOC_REPO');
  });
});
