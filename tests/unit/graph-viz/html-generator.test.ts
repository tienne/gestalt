import { describe, it, expect } from 'vitest';
import { generateVisualizationHtml } from '../../../src/graph-viz/html-generator.js';
import { NodeKind, EdgeKind } from '../../../src/code-graph/types.js';
import type { CodeGraphNode, CodeGraphEdge } from '../../../src/code-graph/types.js';

function makeNode(overrides: Partial<CodeGraphNode> = {}): CodeGraphNode {
  return {
    id: 'file:src/index.ts',
    kind: NodeKind.File,
    name: 'index.ts',
    filePath: 'src/index.ts',
    isTest: false,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeEdge(
  sourceId: string,
  targetId: string,
  kind: CodeGraphEdge['kind'] = EdgeKind.IMPORTS_FROM,
): CodeGraphEdge {
  return { kind, sourceId, targetId, updatedAt: Date.now() };
}

describe('generateVisualizationHtml()', () => {
  it('유효한 HTML 문자열을 반환한다', () => {
    const html = generateVisualizationHtml([], []);
    expect(typeof html).toBe('string');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
  });

  it('D3.js v7 CDN 스크립트 태그를 포함한다', () => {
    const html = generateVisualizationHtml([], []);
    expect(html).toContain('https://d3js.org/d3.v7.min.js');
  });

  it('노드 데이터를 JSON으로 임베드한다', () => {
    const node = makeNode({ id: 'file:src/app.ts', name: 'app.ts', filePath: 'src/app.ts' });
    const html = generateVisualizationHtml([node], []);
    expect(html).toContain('file:src/app.ts');
    expect(html).toContain('app.ts');
  });

  it('엣지 데이터를 JSON으로 임베드한다', () => {
    const src = makeNode({ id: 'file:src/a.ts' });
    const tgt = makeNode({ id: 'file:src/b.ts' });
    const edge = makeEdge('file:src/a.ts', 'file:src/b.ts', EdgeKind.CALLS);
    const html = generateVisualizationHtml([src, tgt], [edge]);
    expect(html).toContain('file:src/a.ts');
    expect(html).toContain('file:src/b.ts');
    expect(html).toContain(EdgeKind.CALLS);
  });

  it('다크 테마 배경색(#0d1117)을 포함한다', () => {
    const html = generateVisualizationHtml([], []);
    expect(html).toContain('#0d1117');
  });

  it('/api/graph fetch 코드를 포함하지 않는다 (데이터가 임베드되므로)', () => {
    const html = generateVisualizationHtml([], []);
    // 데이터는 JSON.stringify로 직접 임베드 — fetch 호출 불필요
    expect(html).not.toContain("fetch('/api/graph')");
  });

  it('빈 노드/엣지 배열로도 에러 없이 완전한 HTML을 반환한다', () => {
    expect(() => generateVisualizationHtml([], [])).not.toThrow();
    const html = generateVisualizationHtml([], []);
    expect(html.trim().startsWith('<!DOCTYPE html>')).toBe(true);
  });

  it('노드 kind에 따른 컬러 코드를 포함한다', () => {
    const html = generateVisualizationHtml([], []);
    // File = blue, Function = green, Class = orange
    expect(html).toContain('#388bfd'); // file
    expect(html).toContain('#3fb950'); // function
    expect(html).toContain('#f0883e'); // class
  });

  it('노드 이름에 HTML 특수문자가 있어도 에러 없이 생성된다', () => {
    const node = makeNode({
      id: 'file:src/evil.ts',
      name: '<script>alert(1)</script>',
      filePath: 'src/evil.ts',
    });
    // 에러 없이 HTML이 생성되어야 함
    expect(() => generateVisualizationHtml([node], [])).not.toThrow();
    const html = generateVisualizationHtml([node], []);
    // 노드 데이터가 임베드되어야 함
    expect(html).toContain('file:src/evil.ts');
  });
});
