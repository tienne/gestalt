import { describe, expect, it } from 'vitest';
import { parseArchitectureIr, validateArchitectureIr } from '../../../src/architecture/index.js';
import {
  BUILTIN_PACKS,
  LEGACY_PACK_IDS,
  RENDER_CLASSES,
  resolvePackIds,
  vocabularyOf,
} from '../../../src/architecture/packs/index.js';
import {
  CONTAINS_ABOUT,
  EDGE_KIND_ABOUT,
  LANE_ABOUT,
  NODE_KIND_ABOUT,
  STAGE_LANE_ABOUT,
  withCopula,
} from '../../../src/architecture/kind-text.js';
import { NAME_REF_MATCHERS } from '../../../src/architecture/name-ref-match.js';
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

  it('팩마다 matcher가 있고 전부 서버가 아는 이름이다', () => {
    const known = new Set<string>(['http-endpoint', 'mcp-tool', ...NAME_REF_MATCHERS]);
    for (const p of BUILTIN_PACKS) {
      expect(p.matchers.length, p.id).toBeGreaterThan(0);
      for (const m of p.matchers) expect(known.has(m), `${p.id}:${m}`).toBe(true);
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

describe('팩 어휘의 설명 문장', () => {
  const MIDDLE_DOT = '\u00b7';

  const sentences = (): Array<[string, string | undefined]> => {
    const out: Array<[string, string | undefined]> = [];
    for (const p of BUILTIN_PACKS) {
      const looks = { ...p.nodeKinds, ...('displayKinds' in p ? p.displayKinds : {}) };
      for (const k of Object.keys(looks)) out.push([`${p.id} kind ${k}`, NODE_KIND_ABOUT[k]]);
      for (const [k, d] of Object.entries(p.edgeKinds))
        out.push([`${p.id} edge ${k}`, (d as { about?: string }).about]);
      for (const [k, d] of Object.entries(p.lanes))
        out.push([`${p.id} lane ${k}`, (d as { about?: string }).about]);
    }
    out.push(['contains', CONTAINS_ABOUT], ['stage lane', STAGE_LANE_ABOUT]);
    return out;
  };

  it('모든 팩의 kind, displayKind, 엣지, 레인에 비지 않은 설명 문장이 있다', () => {
    const empty = sentences()
      .filter(([, s]) => s === undefined || s.trim() === '')
      .map(([where]) => where);
    expect(empty).toEqual([]);
  });

  it('설명 문장은 해요체 마침표로 끝나고 가운뎃점이 없다', () => {
    const bad = sentences()
      .filter(([, s]) => s !== undefined && (!s.endsWith('.') || s.includes(MIDDLE_DOT)))
      .map(([where, s]) => `${where}: ${s}`);
    expect(bad).toEqual([]);
  });

  it('표 조회가 팩 정의와 어긋나지 않는다', () => {
    for (const p of BUILTIN_PACKS) {
      for (const [k, d] of Object.entries(p.edgeKinds))
        expect(EDGE_KIND_ABOUT[k]).toBe((d as { about: string }).about);
      for (const [k, d] of Object.entries(p.lanes))
        expect(LANE_ABOUT[k as keyof typeof LANE_ABOUT]).toBe((d as { about: string }).about);
    }
    expect(EDGE_KIND_ABOUT['contains']).toBe(CONTAINS_ABOUT);
  });

  it('about이 없는 노드 종류는 이름 끝 받침에 맞춰 이에요나 예요로 맺는다', () => {
    expect(withCopula('버킷')).toBe('버킷이에요.');
    expect(withCopula('방화벽')).toBe('방화벽이에요.');
    expect(withCopula('토픽')).toBe('토픽이에요.');
    expect(withCopula('서비스')).toBe('서비스예요.');
    expect(withCopula('API')).toBe('API예요.');
  });

  it('harness의 mcp_tool은 AI가 보내는 명령이라는 뜻을 담는다', () => {
    expect(NODE_KIND_ABOUT['mcp_tool']).toContain('MCP 서버에 보내는 명령');
  });
});
