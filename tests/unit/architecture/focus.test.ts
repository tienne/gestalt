import { describe, expect, it } from 'vitest';
import { FOCUS_SOURCE } from '../../../src/architecture/focus.js';

interface Edge {
  id: string;
  from: string;
  to: string;
}
interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
type FocusSet = (edges: Edge[], id: string) => { nodes: string[]; edges: string[] };
type FocusLayout = (
  boxes: Box[],
  keep: Record<string, boolean>,
  top: number,
  gap: number,
) => Record<string, { x: number; y: number; w: number; h: number }>;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
type FocusBandLayout = (
  boxes: Box[],
  keep: Record<string, boolean>,
  top: number,
  gap: number,
  bandOf: Record<string, number>,
  names: string[],
) => {
  pos: Record<string, { x: number; y: number; w: number; h: number }>;
  regions?: { groups: Array<Rect & { name: string }>; shared?: Rect };
  bottom?: number;
};

// 브라우저에 싣는 바로 그 문자열을 실행한다
const { focusSet, focusLayout, focusBandLayout } = new Function(
  `${FOCUS_SOURCE}\nreturn { focusSet: focusSet, focusLayout: focusLayout, focusBandLayout: focusBandLayout };`,
)() as { focusSet: FocusSet; focusLayout: FocusLayout; focusBandLayout: FocusBandLayout };

// 앱 셋이 게이트웨이 하나를 같이 쓰고 그 뒤로 서버와 외부 서비스가 이어지는 전체 화면 모양
const rootEdges: Edge[] = [
  { id: 'b1', from: 'svc:pad', to: 'gw:main' },
  { id: 'b2', from: 'svc:web', to: 'gw:main' },
  { id: 'b3', from: 'svc:did', to: 'gw:main' },
  { id: 'b4', from: 'svc:pad', to: 'gw:pad' },
  { id: 'b5', from: 'gw:main', to: 'm:order' },
  { id: 'b6', from: 'gw:pad', to: 'm:waiting' },
  { id: 'b7', from: 'm:order', to: 'x:pay' },
  { id: 'b8', from: 'svc:did', to: 'gw:did' },
];

describe('focusSet', () => {
  it('하류와 상류만 남기고 같은 게이트웨이를 쓰는 다른 앱은 뺀다', () => {
    const set = focusSet(rootEdges, 'svc:pad');
    expect(set.nodes).toEqual(['gw:main', 'gw:pad', 'm:order', 'm:waiting', 'svc:pad', 'x:pay']);
    expect(set.edges).toEqual(['b1', 'b4', 'b5', 'b6', 'b7']);
  });

  it('가운데 노드는 위아래 양쪽을 다 남긴다', () => {
    const set = focusSet(rootEdges, 'gw:main');
    expect(set.nodes).toEqual(['gw:main', 'm:order', 'svc:did', 'svc:pad', 'svc:web', 'x:pay']);
    // 상류로 올라간 앱의 다른 하류(gw:did, gw:pad)로는 꺾지 않는다
    expect(set.edges).toEqual(['b1', 'b2', 'b3', 'b5', 'b7']);
  });

  it('순환이 있어도 끝난다', () => {
    const set = focusSet(
      [
        { id: 'a', from: 'p', to: 'q' },
        { id: 'b', from: 'q', to: 'p' },
      ],
      'p',
    );
    expect(set.nodes).toEqual(['p', 'q']);
    expect(set.edges).toEqual(['a', 'b']);
  });

  it('선이 없는 노드는 자기 하나만 남는다', () => {
    expect(focusSet(rootEdges, 'lonely')).toEqual({ nodes: ['lonely'], edges: [] });
  });
});

describe('focusLayout', () => {
  const boxes: Box[] = [
    { id: 'svc:web', x: 40, y: 60, w: 160, h: 48 },
    { id: 'svc:pad', x: 40, y: 132, w: 160, h: 48 },
    { id: 'svc:did', x: 40, y: 204, w: 160, h: 60 },
    { id: 'gw:main', x: 300, y: 60, w: 180, h: 48 },
    { id: 'gw:pad', x: 300, y: 132, w: 180, h: 48 },
  ];

  it('남은 카드를 같은 열 안에서 원래 순서대로 위에서부터 다시 쌓고 x는 그대로 둔다', () => {
    const keep = { 'svc:pad': true, 'svc:did': true, 'gw:pad': true };
    expect(focusLayout(boxes, keep, 60, 24)).toEqual({
      'svc:pad': { x: 40, y: 60, w: 160, h: 48 },
      'svc:did': { x: 40, y: 132, w: 160, h: 60 },
      'gw:pad': { x: 300, y: 60, w: 180, h: 48 },
    });
  });

  it('입력 순서가 달라도 같은 자리를 낸다', () => {
    const keep = { 'svc:web': true, 'svc:did': true, 'gw:main': true };
    expect(focusLayout([...boxes].reverse(), keep, 60, 24)).toEqual(
      focusLayout(boxes, keep, 60, 24),
    );
  });
});

describe('focusBandLayout', () => {
  // 위 제품 전용 앱, 같이 쓰는 게이트웨이, 아래 제품 전용 앱
  const boxes: Box[] = [
    { id: 'svc:shop', x: 40, y: 60, w: 160, h: 48 },
    { id: 'svc:admin', x: 40, y: 132, w: 160, h: 48 },
    { id: 'gw:shared', x: 300, y: 60, w: 180, h: 48 },
  ];
  const bandOf = { 'svc:shop': 0, 'gw:shared': 1, 'svc:admin': 2 };
  const keep = { 'svc:shop': true, 'svc:admin': true, 'gw:shared': true };

  it('띠 순서로 쌓고 두 영역이 같이 쓰는 띠에서 겹친다', () => {
    const { pos, regions } = focusBandLayout(boxes, keep, 60, 24, bandOf, ['쇼핑', '운영']);
    expect(pos['svc:shop']!.y).toBeLessThan(pos['gw:shared']!.y);
    expect(pos['gw:shared']!.y).toBeLessThan(pos['svc:admin']!.y);
    const [upper, lower] = regions!.groups;
    expect([upper!.name, lower!.name]).toEqual(['쇼핑', '운영']);
    const shared = regions!.shared!;
    expect(shared.y).toBe(lower!.y);
    expect(shared.y + shared.height).toBe(upper!.y + upper!.height);
    expect(pos['gw:shared']!.y).toBeGreaterThan(shared.y);
    expect(pos['gw:shared']!.y + 48).toBeLessThan(shared.y + shared.height);
  });

  it('한쪽 제품 전용 카드가 하나도 안 남으면 띠 없이 쌓는다', () => {
    const only = { 'svc:shop': true, 'gw:shared': true };
    const out = focusBandLayout(boxes, only, 60, 24, bandOf, ['쇼핑', '운영']);
    expect(out.regions).toBeUndefined();
    expect(out.pos).toEqual(focusLayout(boxes, only, 60, 24));
  });
});
