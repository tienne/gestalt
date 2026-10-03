import { REGION_LABEL_H, REGION_PAD_X, REGION_PAD_Y } from './layout.js';

/**
 * 포커스 계산. 브라우저 스크립트에 이 소스를 그대로 싣고 단위 테스트도 같은 문자열을 실행해 검사한다.
 * TS 함수를 따로 두면 두 구현이 어긋나도 테스트가 못 잡는다.
 *
 * focusSet(edges, id): id에서 화살표 방향으로 닿는 노드 전부(하류)와 id로 들어오는 쪽을 거슬러 닿는 노드 전부(상류).
 *   하류에서 다시 상류로 꺾지 않는다. 그래서 같은 게이트웨이를 부르는 다른 앱은 빠진다.
 *   돌려주는 edges는 위아래로 따라가며 밟은 선뿐이다.
 * focusLayout(boxes, keep, top, gap): 남은 카드를 같은 열(x) 안에서 원래 위아래 순서대로 위에서부터 다시 쌓는다.
 *   x는 그대로 두므로 레인 자리가 안 바뀐다.
 * focusBandLayout(boxes, keep, top, gap, bandOf, names): 두 제품을 합친 그림이면 띠(첫째 전용, 같이 씀, 둘째 전용)별로 나눠 쌓고
 *   영역 박스 자리까지 낸다. 서버의 stackBands와 같은 규칙이다.
 */
export const FOCUS_SOURCE = `
var REGION_PAD_X = ${REGION_PAD_X}, REGION_PAD_Y = ${REGION_PAD_Y}, REGION_LABEL_H = ${REGION_LABEL_H};
function focusSet(edges, id) {
  var out = {};
  var inc = {};
  edges.forEach(function (e) {
    (out[e.from] = out[e.from] || []).push(e);
    (inc[e.to] = inc[e.to] || []).push(e);
  });
  var nodes = {};
  var kept = {};
  nodes[id] = true;
  function walk(index, next) {
    var seen = {};
    seen[id] = true;
    var queue = [id];
    while (queue.length) {
      var at = queue.shift();
      (index[at] || []).forEach(function (e) {
        kept[e.id] = true;
        var n = next(e);
        nodes[n] = true;
        if (!seen[n]) { seen[n] = true; queue.push(n); }
      });
    }
  }
  walk(out, function (e) { return e.to; });
  walk(inc, function (e) { return e.from; });
  return { nodes: Object.keys(nodes).sort(), edges: Object.keys(kept).sort() };
}
function focusLayout(boxes, keep, top, gap) {
  var columns = {};
  boxes.forEach(function (b) {
    if (!keep[b.id]) return;
    (columns[b.x] = columns[b.x] || []).push(b);
  });
  var pos = {};
  Object.keys(columns).forEach(function (x) {
    var col = columns[x];
    col.sort(function (a, b) { return a.y - b.y || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    var y = top;
    col.forEach(function (b) {
      pos[b.id] = { x: b.x, y: y, w: b.w, h: b.h };
      y += b.h + gap;
    });
  });
  return pos;
}
function focusBandLayout(boxes, keep, top, gap, bandOf, names) {
  var columns = {};
  var counts = [0, 0, 0];
  boxes.forEach(function (b) {
    if (!keep[b.id]) return;
    (columns[b.x] = columns[b.x] || []).push(b);
    counts[bandOf[b.id] === undefined ? 1 : bandOf[b.id]] += 1;
  });
  var band = function (id) { return bandOf[id] === undefined ? 1 : bandOf[id]; };
  if (!counts[0] || !counts[2]) return { pos: focusLayout(boxes, keep, top, gap) };
  var height = [0, 0, 0];
  Object.keys(columns).forEach(function (x) {
    [0, 1, 2].forEach(function (k) {
      var h = 0, n = 0;
      columns[x].forEach(function (b) { if (band(b.id) === k) { h += b.h; n += 1; } });
      if (n) height[k] = Math.max(height[k], h + gap * (n - 1));
    });
  });
  var bandTop = [null, null, null];
  var cursor = top + REGION_PAD_Y + REGION_LABEL_H;
  [0, 1, 2].forEach(function (k) {
    if (!counts[k]) return;
    bandTop[k] = cursor;
    cursor += height[k] + REGION_PAD_Y * 2 + REGION_LABEL_H;
  });
  var pos = {};
  Object.keys(columns).forEach(function (x) {
    var col = columns[x];
    col.sort(function (a, b) { return a.y - b.y || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    [0, 1, 2].forEach(function (k) {
      var y = bandTop[k];
      if (y === null) return;
      col.forEach(function (b) {
        if (band(b.id) !== k) return;
        pos[b.id] = { x: b.x, y: y, w: b.w, h: b.h };
        y += b.h + gap;
      });
    });
  });
  function span(ks) {
    var left = Infinity, right = -Infinity, used = [];
    Object.keys(pos).forEach(function (id) {
      if (ks.indexOf(band(id)) < 0) return;
      left = Math.min(left, pos[id].x);
      right = Math.max(right, pos[id].x + pos[id].w);
    });
    ks.forEach(function (k) { if (bandTop[k] !== null) used.push(k); });
    var last = used[used.length - 1];
    var y0 = bandTop[used[0]] - REGION_PAD_Y;
    var y1 = bandTop[last] + height[last] + REGION_PAD_Y;
    return { x: left - REGION_PAD_X, y: y0, width: right - left + REGION_PAD_X * 2, height: y1 - y0 };
  }
  var upper = span([0, 1]);
  var lower = span([1, 2]);
  upper.y -= REGION_LABEL_H;
  upper.height += REGION_LABEL_H;
  lower.height += REGION_LABEL_H;
  upper.name = names[0];
  lower.name = names[1];
  var regions = { groups: [upper, lower] };
  var st = Math.max(upper.y, lower.y), sb = Math.min(upper.y + upper.height, lower.y + lower.height);
  var sl = Math.max(upper.x, lower.x), sr = Math.min(upper.x + upper.width, lower.x + lower.width);
  if (counts[1] && sb > st && sr > sl) regions.shared = { x: sl, y: st, width: sr - sl, height: sb - st };
  return { pos: pos, regions: regions, bottom: cursor - REGION_PAD_Y };
}
`;
