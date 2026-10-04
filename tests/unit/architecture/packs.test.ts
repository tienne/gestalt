import { describe, expect, it } from 'vitest';
import { parseArchitectureIr, validateArchitectureIr } from '../../../src/architecture/index.js';
import {
  BUILTIN_PACKS,
  LEGACY_PACK_IDS,
  RENDER_CLASSES,
  resolvePackIds,
  vocabularyOf,
} from '../../../src/architecture/packs/index.js';
import { genericIr } from '../../fixtures/architecture-categories/generic.js';
import { renderBoth } from '../../fixtures/architecture-legacy/render.js';

describe('어휘 팩', () => {
  it('kind 이름이 팩끼리 겹치지 않는다', () => {
    const seen = new Map<string, string>();
    for (const p of BUILTIN_PACKS) {
      for (const k of [
        ...Object.keys(p.nodeKinds),
        ...Object.keys('displayKinds' in p ? p.displayKinds : {}),
        ...Object.keys(p.edgeKinds),
      ]) {
        expect(seen.get(k), `${k}가 ${seen.get(k)}와 ${p.id}에 둘 다 있다`).toBeUndefined();
        seen.set(k, p.id);
      }
    }
  });

  it('kind의 레인은 같은 팩이나 requires한 팩에 있다', () => {
    for (const p of BUILTIN_PACKS) {
      const vocab = vocabularyOf([p.id]);
      for (const [k, d] of Object.entries(p.nodeKinds)) {
        expect(vocab.lanes[d.lane], `${p.id}.${k}`).toBeDefined();
        expect(RENDER_CLASSES).toContain(d.renderClass);
      }
    }
  });

  it('packs가 없으면 팩을 나누기 전 어휘 전부로 읽는다', () => {
    expect(resolvePackIds(LEGACY_PACK_IDS)).toEqual(['web-product', 'harness']);
    expect(resolvePackIds(['harness'])).toEqual(['web-product', 'harness']);
  });
});

describe('범용 component', () => {
  it('component는 displayKind와 renderClass가 있어야 한다', () => {
    const ir = genericIr();
    delete ir.nodes[0]!.displayKind;
    const r = parseArchitectureIr(ir);
    expect(r.ok).toBe(false);
  });

  it('component가 아닌 노드는 renderClass를 못 쓴다', () => {
    const ir = genericIr();
    ir.nodes.push({
      id: 's',
      kind: 'screen',
      label: 's',
      repo: 'app',
      evidence: [],
      renderClass: 'store',
    });
    expect(parseArchitectureIr(ir).ok).toBe(false);
  });

  it('안 적은 팩의 kind를 쓰면 막는다', () => {
    const ir = genericIr();
    ir.nodes.push({ ...ir.nodes[0]!, id: 'scr', kind: 'screen' });
    delete ir.nodes.at(-1)!.displayKind;
    delete ir.nodes.at(-1)!.renderClass;
    const r = validateArchitectureIr(ir, { checkFiles: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toContain('KIND_NOT_IN_PACKS');
  });

  it('없는 팩 id를 적으면 막는다', () => {
    const ir = { ...genericIr(), packs: ['generic', 'nope'] };
    const r = validateArchitectureIr(ir, { checkFiles: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toContain('UNKNOWN_PACK');
  });

  it('칩에는 displayKind를, 색과 아이콘은 렌더 분류 것을 쓴다', async () => {
    const parsed = parseArchitectureIr(genericIr());
    expect(parsed.ok).toBe(true);
    const html = (await renderBoth(genericIr())).private;
    expect(html).toContain('class="node k-cx_queue"');
    expect(html).toContain('주문 큐</span>');
    expect(html).toContain('.k-cx_store{--kind:');
    expect(html).toContain('id="i-cx_store"');
    // 쓰지 않는 팩의 색과 아이콘은 싣지 않는다
    expect(html).not.toContain('.k-screen{');
    expect(html).not.toContain('id="i-screen"');
  });

  it('component가 있는 어휘에만 클라이언트 처리 코드를 싣는다', async () => {
    const html = (await renderBoth(genericIr())).private;
    expect(html).toContain("n.kind === 'component' ? 'cx_'");
  });
});
