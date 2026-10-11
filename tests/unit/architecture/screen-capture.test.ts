import { describe, expect, it } from 'vitest';
import {
  computeDrilldown,
  computeFlowLayout,
  FLOW_STEP_HEIGHT,
  parseArchitectureIr,
  renderDrilldownHtml,
  validateArchitectureIr,
  type ArchitectureIr,
  type ArchitectureFlow,
  type ArchitectureNode,
  type Evidence,
  type ScreenCapture,
} from '../../../src/architecture/index.js';
import { CAPTURE_MAX_CHARS } from '../../../src/architecture/ir-schema.js';
import { FLOW_THUMB_GAP, FLOW_THUMB_HEIGHT } from '../../../src/architecture/flow-layout.js';

const code = (location: string): Evidence => ({ type: 'code', location, visibility: 'public' });

const IMAGE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ';

const capture = (over: Partial<ScreenCapture> = {}): ScreenCapture => ({
  image: IMAGE,
  capturedAt: '2026-10-11T09:00:00.000Z',
  env: 'dev',
  source: 'browser',
  ...over,
});

function node(
  id: string,
  kind: ArchitectureNode['kind'],
  extra: Partial<ArchitectureNode> = {},
): ArchitectureNode {
  return { id, kind, label: id, repo: 'web', evidence: [code(`web:src/${id}.ts:1`)], ...extra };
}

function fixture(screenExtra: Partial<ArchitectureNode> = {}): ArchitectureIr {
  return {
    schemaVersion: '1.0.0',
    view: 'screen-chain',
    repos: [{ id: 'web', name: 'acme-web', root: '/srv/acme-web' }],
    nodes: [
      node('svc-shop', 'service'),
      node('f-queue', 'feature', { parent: 'svc-shop' }),
      node('s-queue', 'screen', { parent: 'f-queue', ...screenExtra }),
    ],
    edges: [],
    unresolved: [],
    sourcesUsed: [],
    generatedAt: '2026-10-11T00:00:00.000Z',
  };
}

async function render(ir: ArchitectureIr, audience: 'private' | 'shared') {
  const r = validateArchitectureIr(ir, { checkFiles: false });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  const drill = await computeDrilldown(r.value);
  return renderDrilldownHtml(r.value, drill, { audience });
}

describe('화면 캡처', () => {
  it('screen 노드의 capture를 읽는다', () => {
    expect(parseArchitectureIr(fixture({ capture: capture() })).ok).toBe(true);
  });

  it('screen이 아닌 노드에 달면 거부한다', () => {
    const ir = fixture();
    ir.nodes.find((n) => n.id === 'f-queue')!.capture = capture();
    expect(parseArchitectureIr(ir).ok).toBe(false);
  });

  it('data URI가 아니면 거부한다', () => {
    const bad = fixture({ capture: capture({ image: 'https://example.com/a.png' }) });
    expect(parseArchitectureIr(bad).ok).toBe(false);
  });

  it('상한을 넘는 이미지는 거부한다', () => {
    const big = `data:image/jpeg;base64,${'A'.repeat(CAPTURE_MAX_CHARS)}`;
    expect(parseArchitectureIr(fixture({ capture: capture({ image: big }) })).ok).toBe(false);
  });

  it('private 산출물에는 이미지가 실린다', async () => {
    const html = await render(fixture({ capture: capture() }), 'private');
    expect(html).toContain(IMAGE);
    expect(html).toContain('.capture figcaption');
    expect(html).toContain('function renderCapture');
  });

  it('캡처 이미지는 DOC_CSS 없이도 드로어 폭에 맞춘다', async () => {
    const html = await render(fixture({ capture: capture() }), 'private');
    expect(html).toMatch(/\.capture img \{[^}]*max-width: 100%/);
  });

  it('shared 산출물에서는 이미지와 캡처 메타를 뺀다', async () => {
    const html = await render(fixture({ capture: capture() }), 'shared');
    expect(html).not.toContain(IMAGE);
    expect(html).not.toContain('2026-10-11T09:00:00.000Z');
  });

  it('캡처가 없는 IR에는 캡처 CSS를 싣지 않는다', async () => {
    const html = await render(fixture(), 'private');
    expect(html).not.toContain('.capture figcaption');
    expect(html).not.toContain('function renderCapture');
  });
});

describe('흐름 카드 아래 썸네일', () => {
  const flowOf = (): ArchitectureFlow => ({
    id: 'queue',
    service: 'svc-shop',
    title: '줄서기',
    actors: [{ id: 'guest', label: '손님', kind: 'person' }],
    steps: [
      {
        id: 'st-a',
        actor: 'guest',
        label: '이름 입력',
        refs: ['s-queue'],
        evidence: [code('web:src/a.ts:1')],
      },
      { id: 'st-b', actor: 'guest', label: '완료', evidence: [code('web:src/b.ts:1')] },
    ],
    transitions: [
      {
        id: 't-1',
        from: 'st-a',
        to: 'st-b',
        path: 'main',
        evidence: [code('web:src/a.ts:2')],
        lineStyle: 'solid',
      },
    ],
  });
  const withFlow = (screenExtra: Partial<ArchitectureNode> = {}): ArchitectureIr => ({
    ...fixture(screenExtra),
    flows: [flowOf()],
  });
  const all = (f: ArchitectureFlow) => ({
    steps: new Set(f.steps.map((st) => st.id)),
    trans: new Set(f.transitions.map((t) => t.id)),
  });

  it('썸네일이 서는 줄은 모든 행이 썸네일만큼 늘어난다', () => {
    const f = flowOf();
    const { steps, trans } = all(f);
    const plain = computeFlowLayout(f, steps, trans);
    const thumbed = computeFlowLayout(f, steps, trans, new Set(['st-a']));
    expect(thumbed.height - plain.height).toBe(FLOW_THUMB_GAP + FLOW_THUMB_HEIGHT);
    const a = thumbed.steps.find((b) => b.id === 'st-a')!;
    expect(a.thumb).toEqual({
      y: a.y + FLOW_STEP_HEIGHT + FLOW_THUMB_GAP,
      height: FLOW_THUMB_HEIGHT,
    });
    expect(thumbed.steps.find((b) => b.id === 'st-b')!.thumb).toBeUndefined();
  });

  it('썸네일이 없으면 좌표가 그대로다', () => {
    const f = flowOf();
    const { steps, trans } = all(f);
    expect(computeFlowLayout(f, steps, trans, new Set())).toEqual(
      computeFlowLayout(f, steps, trans),
    );
  });

  it('private 산출물은 이어진 화면의 캡처를 카드 아래에 싣는다', async () => {
    const html = await render(withFlow({ capture: capture() }), 'private');
    expect(html).toContain('<div class="flow-thumb" data-step-id="st-a"');
    expect(html).not.toContain('data-step-id="st-b"');
    expect(html).toContain('.flow-thumb img');
  });

  it('shared 산출물은 썸네일과 그 자리를 모두 뺀다', async () => {
    const html = await render(withFlow({ capture: capture() }), 'shared');
    expect(html).not.toContain('flow-thumb');
    expect(html).not.toContain(IMAGE);
    const plain = await render(withFlow(), 'shared');
    const h = (s: string) => /class="level flow-level"[^>]*data-h="([\d.]+)"/.exec(s)![1];
    expect(h(html)).toBe(h(plain));
  });

  it('캡처가 없으면 썸네일 마크업도 CSS도 없다', async () => {
    const html = await render(withFlow(), 'private');
    expect(html).not.toContain('flow-thumb');
  });
});
