import { describe, expect, it } from 'vitest';
import {
  CANVAS_PAD_TOP,
  CANVAS_PAD_X,
  routeCanvas,
  type RouteInput,
} from '../../../src/architecture/canvas-geometry.js';
import type { LayoutResult } from '../../../src/architecture/layout.js';

function layout(): LayoutResult {
  return {
    width: 600,
    height: 200,
    nodes: [
      { id: 'a', x: 0, y: 0, width: 120, height: 48 },
      { id: 'b', x: 0, y: 80, width: 120, height: 48 },
      { id: 'c', x: 300, y: 40, width: 120, height: 48 },
    ],
    edges: [],
    lanes: [],
  };
}

const edge = (id: string, from: string, to: string, width = 1.5): RouteInput => ({
  id,
  from,
  to,
  width,
});

function start(d: string): [number, number] {
  const m = d.match(/^M([\d.]+) ([\d.]+)/);
  return [Number(m![1]), Number(m![2])];
}

describe('routeCanvas', () => {
  it('앞으로 가는 선은 출발 카드 오른쪽에서 나와 도착 카드 왼쪽에 화살촉을 단다', () => {
    const r = routeCanvas(layout(), [edge('ac', 'a', 'c')]).edges.get('ac')!;
    expect(r.reverse).toBe(false);
    expect(start(r.d)).toEqual([120 + CANVAS_PAD_X, 24 + CANVAS_PAD_TOP]);
    expect(r.tip.startsWith(`M${300 + CANVAS_PAD_X} `)).toBe(true);
    expect(r.d).toMatch(/^M[\d.]+ [\d.]+C[\d. ]+$/);
  });

  it('한 카드에 붙는 선 여럿은 포트를 세로로 나누고 맞은편이 위에 있는 선이 위에 앉는다', () => {
    const routed = routeCanvas(layout(), [edge('ac', 'a', 'c'), edge('bc', 'b', 'c')]).edges;
    const tipY = (id: string) => Number(routed.get(id)!.tip.match(/^M[\d.]+ ([\d.]+)/)![1]);
    expect(tipY('ac')).toBeLessThan(tipY('bc'));
  });

  it('왼쪽으로 돌아가는 선은 두 카드 아래로 감아 돌고 캔버스 높이를 늘린다', () => {
    const base = routeCanvas(layout(), []);
    const r = routeCanvas(layout(), [edge('ca', 'c', 'a')]);
    const loop = r.edges.get('ca')!;
    expect(loop.reverse).toBe(true);
    expect(loop.mid.y).toBeGreaterThan(88 + CANVAS_PAD_TOP);
    expect(r.height).toBeGreaterThanOrEqual(base.height);
  });

  it('같은 열 카드끼리는 왼쪽 바깥으로 휜 활로 잇는다', () => {
    const r = routeCanvas(layout(), [edge('ab', 'a', 'b')]).edges.get('ab')!;
    expect(start(r.d)).toEqual([CANVAS_PAD_X, 24 + CANVAS_PAD_TOP]);
    const controlX = Number(r.d.match(/C([\d.-]+) /)![1]);
    expect(controlX).toBeLessThan(CANVAS_PAD_X);
  });

  it('굵은 선은 화살촉도 크고 같은 입력이면 같은 경로다', () => {
    const thin = routeCanvas(layout(), [edge('ac', 'a', 'c', 1.5)]).edges.get('ac')!;
    const thick = routeCanvas(layout(), [edge('ac', 'a', 'c', 8)]).edges.get('ac')!;
    expect(thick.tip).not.toBe(thin.tip);
    const again = routeCanvas(layout(), [edge('ac', 'a', 'c', 8)]).edges.get('ac')!;
    expect(again).toEqual(thick);
  });
});
