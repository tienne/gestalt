import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { buildFigmaPlan, type FigmaPlan } from '../../../src/research/figma-plan.js';
import {
  buildFigmaFitScript,
  buildFigmaScript,
  buildFigmaVerifyScript,
} from '../../../src/research/figma-script.js';
import { parseResearch, type Research } from '../../../src/research/schema.js';
import { sampleResearch } from './fixture.js';

const LS = String.fromCharCode(0x2028);

function research(overrides: Parameters<typeof sampleResearch>[0] = {}): Research {
  const parsed = parseResearch(sampleResearch(overrides));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

function planOf(r: Research, audience: 'private' | 'shared' = 'private'): FigmaPlan {
  const result = buildFigmaPlan(r, { audience });
  if (!result.ok) throw new Error(result.message);
  return result.plan;
}

class FakeNode {
  static seq = 0;
  id = `n${++FakeNode.seq}`;
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  [key: string]: unknown;
  constructor(public kind: string) {}
  appendChild(child: FakeNode): void {
    child.parent = this;
    this.children.push(child);
  }
  getStyledTextSegments(): { fontName: unknown }[] {
    return [{ fontName: this.fontName }];
  }
  resize(w: number, h: number): void {
    this.width = w;
    this.height = h;
  }
  findAll(pred: (n: FakeNode) => boolean): FakeNode[] {
    const out: FakeNode[] = [];
    const walk = (n: FakeNode): void => {
      for (const c of n.children) {
        if (pred(c)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

function fakeFigma(opts: { fonts?: string[] } = {}) {
  const nodes = new Map<string, FakeNode>();
  const make = (kind: string): FakeNode => {
    const n = new FakeNode(kind);
    nodes.set(n.id, n);
    return n;
  };
  let hashSeq = 0;
  const loaded: string[] = [];
  const figma = {
    createPage: () => make('PAGE'),
    createFrame: () => make('FRAME'),
    createText: () => make('TEXT'),
    createRectangle: () => make('RECT'),
    createImage: (bytes: Uint8Array) => {
      if (bytes.length === 0) throw new Error('empty');
      return { hash: `hash-${++hashSeq}`, getSizeAsync: async () => ({ width: 300, height: 600 }) };
    },
    getImageByHash: () => ({ getSizeAsync: async () => ({ width: 300, height: 600 }) }),
    base64Decode: (b: string) => new Uint8Array(Buffer.from(b, 'base64')),
    loadFontAsync: async (font: { family: string }) => {
      if (opts.fonts && !opts.fonts.includes(font.family)) throw new Error('no font');
      loaded.push(font.family);
    },
    setCurrentPageAsync: async () => undefined,
    getNodeByIdAsync: async (id: string) => nodes.get(id) ?? null,
  };
  return { figma, nodes, loaded };
}

/** use_figma처럼 본문을 async 문맥에 넣어 돌린다 */
async function runBody(script: string, figma: unknown): Promise<Record<string, unknown>> {
  return runInNewContext(`(async () => {\n${script}\n})()`, {
    figma,
    atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
  });
}

async function run(script: string, figma: unknown): Promise<Record<string, unknown>> {
  return runInNewContext(`(${script})()`, {
    figma,
    atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
  });
}

describe('Figma 계획', () => {
  it('섹션 0부터 8까지를 순서대로 담고 캡처를 이미지 목록에 올린다', () => {
    const plan = planOf(research());
    const titles = plan.nodes.filter((n) => n.type === 'section').map((n) => n.title);
    expect(titles[0]).toBe('0. 전제');
    expect(titles[titles.length - 1]).toBe('8. 열린 질문');
    expect(titles).toHaveLength(9);
    expect(plan.images.map((i) => i.id)).toEqual(research().captures.map((c) => c.id));
  });

  it('공유용은 unchecked 캡처가 있으면 막고 계획 메모를 싣지 않는다', () => {
    const base = research();
    const bad = {
      ...base,
      captures: base.captures.map((c) => ({ ...c, pii: 'unchecked' as const })),
    };
    const blocked = buildFigmaPlan(bad, { audience: 'shared' });
    expect(blocked.ok).toBe(false);
    const withNote = { ...base, plan: { ...base.plan, note: '내부 메모 XYZ' } };
    expect(JSON.stringify(planOf(withNote, 'shared'))).not.toContain('내부 메모 XYZ');
    expect(JSON.stringify(planOf(withNote, 'private'))).toContain('내부 메모 XYZ');
  });

  it('계획 JSON에는 이미지 바이트가 없다', () => {
    expect(JSON.stringify(planOf(research()))).not.toContain('base64');
  });
});

describe('Figma Plugin API 스크립트', () => {
  it('문법이 맞고 계획을 담는다', () => {
    const script = buildFigmaScript(planOf(research()));
    expect(() => new Function(`return (${script})`)).not.toThrow();
    expect(script).toContain('"pageName"');
  });

  it('줄 구분 문자가 들어간 글자도 스크립트를 깨지 않는다', () => {
    const r = research({
      meta: { slug: 'demo', title: `줄${LS}나눔`, task: 't', kind: 'ux-research' },
    });
    const script = buildFigmaScript(planOf(r));
    expect(script).not.toContain(LS);
    expect(() => new Function(`return (${script})`)).not.toThrow();
  });

  it('가짜 figma에서 끝까지 돌고 새 페이지와 표를 만든다', async () => {
    const { figma, nodes, loaded } = fakeFigma();
    const result = await run(buildFigmaScript(planOf(research())), figma);
    expect(result.ok).toBe(true);
    expect(loaded).toContain('Pretendard');
    expect(nodes.get(result.pageId as string)?.name).toBe(research().meta.title);
    expect(result.tableCount as number).toBeGreaterThan(5);
    expect(result.missingImages).toEqual(research().captures.map((c) => c.id));
  });

  it('이미지를 주면 image fill을 붙이고 verify가 통과한다', async () => {
    const r = research();
    const images = Object.fromEntries(
      r.captures.map((c) => [c.id, { base64: Buffer.from('png').toString('base64') }]),
    );
    const { figma } = fakeFigma();
    const result = await run(buildFigmaScript(planOf(r), images), figma);
    expect(result.missingImages).toEqual([]);
    const ids = r.captures.map((c) => c.id);
    const verify = await run(buildFigmaVerifyScript(result.pageId as string, ids), figma);
    expect(verify).toMatchObject({ ok: true, found: ids.length, missing: [] });
  });

  it('verify는 이미지가 빠진 자리를 알려준다', async () => {
    const r = research();
    const { figma } = fakeFigma();
    const result = await run(buildFigmaScript(planOf(r)), figma);
    const ids = r.captures.map((c) => c.id);
    const verify = await run(buildFigmaVerifyScript(result.pageId as string, ids), figma);
    expect(verify.ok).toBe(false);
    expect(verify.missing).toEqual(ids);
  });

  it('렌더 결과가 이미지 자리의 노드 ID를 돌려준다', async () => {
    const r = research();
    const { figma, nodes } = fakeFigma();
    const result = await run(buildFigmaScript(planOf(r)), figma);
    const slots = result.imageSlots as { id: string; nodeId: string }[];
    expect(slots.map((s) => s.id)).toEqual(r.captures.map((c) => c.id));
    expect(nodes.get(slots[0]!.nodeId)?.name).toBe(`img:${slots[0]!.id}`);
  });

  it('body 형태는 함수 껍데기 없이 최상위에서 돈다', async () => {
    const r = research();
    const script = buildFigmaScript(planOf(r), undefined, 'body');
    expect(script.startsWith('async () =>')).toBe(false);
    const { figma } = fakeFigma();
    const result = await runBody(script, figma);
    expect(result.ok).toBe(true);
    const ids = r.captures.map((c) => c.id);
    const verify = await runBody(
      buildFigmaVerifyScript(result.pageId as string, ids, 'body'),
      figma,
    );
    expect(verify.missing).toEqual(ids);
  });

  it('fit은 올린 이미지 비율로 높이를 맞추고 캡션의 이미지 없음 줄을 지운다', async () => {
    const { figma, nodes } = fakeFigma();
    const result = await run(buildFigmaScript(planOf(research())), figma);
    const slots = result.imageSlots as { id: string; nodeId: string }[];
    const rect = nodes.get(slots[0]!.nodeId)!;
    rect.fills = [{ type: 'IMAGE', imageHash: 'uploaded' }];
    const caption = rect.parent!.children.find((c) => c.kind === 'TEXT')!;
    expect(String(caption.characters)).toContain('(이미지 없음)');

    const fit = await run(buildFigmaFitScript(result.pageId as string), figma);
    expect(fit).toMatchObject({ ok: true, fitted: slots.map((s) => s.id), noImage: [] });
    expect(rect.height).toBe(480);
    expect(String(caption.characters)).not.toContain('이미지 없음');
  });

  it('fit은 이미지가 안 올라간 자리를 알려주고 캡션을 그대로 둔다', async () => {
    const { figma, nodes } = fakeFigma();
    const result = await run(buildFigmaScript(planOf(research())), figma);
    const slots = result.imageSlots as { id: string; nodeId: string }[];
    const fit = await runBody(buildFigmaFitScript(result.pageId as string, 'body'), figma);
    expect(fit).toMatchObject({ ok: false, fitted: [], noImage: slots.map((s) => s.id) });
    const rect = nodes.get(slots[0]!.nodeId)!;
    expect(String(rect.parent!.children.find((c) => c.kind === 'TEXT')!.characters)).toContain(
      '(이미지 없음)',
    );
  });

  it('Pretendard가 없으면 Inter로 내려가고 둘 다 없으면 실패한다', async () => {
    const inter = fakeFigma({ fonts: ['Inter'] });
    const ok = await run(buildFigmaScript(planOf(research())), inter.figma);
    expect(ok.ok).toBe(true);
    expect(inter.loaded).not.toContain('Pretendard');
    const none = fakeFigma({ fonts: [] });
    const fail = await run(buildFigmaScript(planOf(research())), none.figma);
    expect(fail).toMatchObject({ ok: false, code: 'NO_FONT' });
  });

  it('figma 전역이 없으면 안내와 함께 실패한다', async () => {
    const fail = await run(buildFigmaScript(planOf(research())), undefined);
    expect(fail).toMatchObject({ ok: false, code: 'NO_FIGMA' });
  });
});
