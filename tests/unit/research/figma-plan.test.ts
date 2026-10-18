import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  buildFigmaPlan,
  type FigmaLayout,
  type FigmaPlan,
} from '../../../src/research/figma-plan.js';
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

function planOf(
  r: Research,
  audience: 'private' | 'shared' = 'private',
  layout?: FigmaLayout,
): FigmaPlan {
  const result = buildFigmaPlan(r, { audience, layout });
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
  it('종합 뒤에 섹션 0부터 8까지를 순서대로 담고 캡처를 이미지 목록에 올린다', () => {
    const plan = planOf(research());
    const titles = plan.nodes.filter((n) => n.type === 'section').map((n) => n.title);
    expect(titles[0]).toBe('종합');
    expect(titles[1]).toBe('0. 전제');
    expect(titles[titles.length - 1]).toBe('8. 열린 질문');
    expect(titles).toHaveLength(10);
    expect(plan.images.map((i) => i.id)).toEqual(research().captures.map((c) => c.id));
  });

  it('시안이 없으면 비교표의 열이 레퍼런스 화면이라고 적고 보류에는 결정 조건을 붙인다', () => {
    const json = JSON.stringify(planOf(research()));
    expect(json).toContain('시안 대신 레퍼런스 화면이다');
    expect(json).toContain('수량 한도 정책이 확정되면 결정');
    expect(json).not.toContain('뒤에 정함');
  });

  it('제외 판단은 확신 칸에 제외로 싣는다', () => {
    const input = sampleResearch();
    input.judgment!.push({
      area: '선물 분기',
      conclusion: '이번 과제 범위에서 뺀다',
      confidence: 'out',
      rationale: '구매 단계를 하나 늘린다',
    });
    const parsed = parseResearch(input);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(JSON.stringify(planOf(parsed.value))).toContain('"제외"');
  });

  it('근거 상태와 발견과 채택 기록을 표 글자로 싣는다', () => {
    const base = sampleResearch();
    base.comparison![0]!.pattern = 'common';
    base.comparison![0]!.definition = '첫 화면의 상품 수';
    base.captures![0]!.frameNo = '08';
    const plan = planOf(research(base));
    const all = JSON.stringify(plan);
    expect(all).toContain('(동일 패턴)');
    expect(all).toContain('첫 화면의 상품 수');
    expect(all).toContain('(프레임 08)');
    expect(all).toContain('[확인 못함] 영상에서 확인 못함');
    expect(all).toContain('구현 정보는 화면에 안 나온다');
    expect(all).toContain('5개 상품을 비교하려면 5번 진입');
    expect(all).toContain('시안이 가져온 것과 푼 것');
    expect(all).toContain('데이터 확인 선행');
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

describe('Figma board 배치', () => {
  it('기본은 가로 3열이고 구획을 결론과 근거 열로 나눈다', () => {
    const plan = planOf(research());
    expect(plan.layout).toBe('board');
    const cols = plan.board!.columns;
    expect(cols.map((c) => c.kind)).toEqual(['captures', 'conclusion', 'evidence']);
    expect(cols[1]!.sections).toEqual(['종합', '6. 판단 (해석)', '7. 검증 제안', '8. 열린 질문']);
    expect(cols[2]!.sections.map((t) => t.slice(0, 2))).toEqual([
      '0.',
      '3.',
      '4.',
      '2.',
      '5.',
      '1.',
    ]);
    const placed = cols.flatMap((c) => c.sections).sort();
    const titles = plan.nodes.filter((n) => n.type === 'section').map((n) => n.title);
    expect(placed).toEqual([...titles].sort());
  });

  it('판단과 검증 제안과 와우 구획에 색을 입힌다', () => {
    const plan = planOf(research());
    const tint = (prefix: string) =>
      plan.nodes.find((n) => n.type === 'section' && n.title.startsWith(prefix));
    expect(tint('6.')).toMatchObject({ tint: 'green' });
    expect(tint('7.')).toMatchObject({ tint: 'blue' });
    expect(tint('4.')).toMatchObject({ tint: 'orange' });
    expect(tint('3.')).not.toHaveProperty('tint');
  });

  it('캡처는 제품별 그룹으로 board에 싣고 선정 구획에는 캡처 표가 남지 않는다', () => {
    const r = research();
    const plan = planOf(r);
    const group = plan.board!.groups[0]!;
    expect(group.title).toBe('A. 서비스 A');
    expect(group.description).toBe('순위 리스트형');
    expect(group.images.map((i) => i.imageId)).toEqual(r.captures.map((c) => c.id));
    expect(JSON.stringify(plan.nodes)).not.toContain('"type":"images"');
    expect(plan.images.map((i) => i.id)).toEqual(r.captures.map((c) => c.id));
  });

  it('화면에 걸린 발견은 화면 이름을 붙여 메모로 싣고 없으면 레퍼런스의 와우와 페인으로 채운다', () => {
    const fallback = planOf(research()).board!.groups[0]!.notes;
    expect(fallback.map((n) => n.label)).toContain('WOW');
    expect(fallback.map((n) => n.label)).toContain('BAD');
    expect(fallback.map((n) => n.text)).toContain('인기 상품을 바로 알아봐요');

    const input = sampleResearch();
    input.wowPain!.findings![0]!.screenMapId = 's1';
    const linked = planOf(research(input)).board!.groups[0]!.notes;
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({ kind: 'wow', label: 'WOW' });
    expect(linked[0]!.text).toContain('할인율이 가격보다 크게 보여서');
  });

  it('캡처가 없으면 캡처 열을 만들지 않는다', () => {
    const plan = planOf({ ...research(), captures: [] });
    expect(plan.board!.columns.map((c) => c.kind)).toEqual(['conclusion', 'evidence']);
  });

  it('page 배치는 board 없이 선정 구획 안에 캡처를 둔다', () => {
    const plan = planOf(research(), 'private', 'page');
    expect(plan.layout).toBe('page');
    expect(plan.board).toBeUndefined();
    expect(JSON.stringify(plan.nodes)).toContain('"type":"images"');
  });

  it('공유용 계획도 같은 열 구성을 쓴다', () => {
    const plan = planOf(research(), 'shared');
    expect(plan.board!.columns).toHaveLength(3);
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

  it('board 배치는 열 프레임 셋과 메모 카드를 만들고 구획에 색을 입힌다', async () => {
    const { figma, nodes } = fakeFigma();
    const result = await run(buildFigmaScript(planOf(research())), figma);
    expect(result.ok).toBe(true);
    const columnIds = result.columnIds as string[];
    expect(columnIds).toHaveLength(3);
    expect(columnIds.map((id) => nodes.get(id)?.name)).toEqual([
      '화면 캡처',
      '결론과 다음 할 일',
      '근거 (전제, 비교, 이유)',
    ]);
    const root = nodes.get(result.rootId as string)!;
    expect(root.layoutMode).toBe('HORIZONTAL');
    expect(root.children).toHaveLength(3);
    expect([...nodes.values()].some((n) => n.name === 'notes')).toBe(true);
    const slot = nodes.get((result.imageSlots as { nodeId: string }[])[0]!.nodeId)!;
    expect(slot.width).toBe(320);
    const verdict = [...nodes.values()].find((n) => n.name === '6. 판단 (해석)')!;
    const fill = (verdict.fills as { color: { g: number } }[])[0]!;
    expect(Math.round(fill.color.g * 255)).toBe(0xf5);
  });

  it('page 배치 스크립트는 세로 한 페이지로 돈다', async () => {
    const { figma, nodes } = fakeFigma();
    const result = await run(buildFigmaScript(planOf(research(), 'private', 'page')), figma);
    expect(result.ok).toBe(true);
    expect(result.columnIds).toEqual([]);
    expect(nodes.get(result.rootId as string)?.layoutMode).toBe('VERTICAL');
    const slot = nodes.get((result.imageSlots as { nodeId: string }[])[0]!.nodeId)!;
    expect(slot.width).toBe(240);
  });

  it('board 스크립트 본문은 use_figma 코드 한도 안에 든다', () => {
    const script = buildFigmaScript(planOf(research()), undefined, 'body');
    expect([...script].length).toBeLessThan(50_000);
  });

  it('표 셀은 같은 행의 높이를 맞추도록 세로 FILL로 두고 짧은 열도 글자가 꺾이지 않을 너비를 받는다', async () => {
    const { figma, nodes } = fakeFigma();
    const result = await run(buildFigmaScript(planOf(research())), figma);
    expect(result.ok).toBe(true);
    const cells = [...nodes.values()].filter((n) => n.name === 'cell');
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every((c) => c.layoutSizingVertical === 'FILL')).toBe(true);
    expect(cells.every((c) => (c.width as number) >= 40)).toBe(true);
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
    expect(rect.height).toBe((rect.width as number) * 2);
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
