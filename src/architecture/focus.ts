import { BAND_HEAD, BAND_TAIL } from './layout.js';

/**
 * 포커스 계산. 브라우저 스크립트에 이 소스를 그대로 싣고 단위 테스트도 같은 문자열을 실행해 검사한다.
 * TS 함수를 따로 두면 두 구현이 어긋나도 테스트가 못 잡는다.
 *
 * focusSet(edges, id): id에서 화살표 방향으로 닿는 노드 전부(하류)와 id로 들어오는 쪽을 거슬러 닿는 노드 전부(상류).
 *   하류에서 다시 상류로 꺾지 않는다. 그래서 같은 게이트웨이를 부르는 다른 앱은 빠진다.
 *   돌려주는 edges는 위아래로 따라가며 밟은 선뿐이다.
 * focusLayout(boxes, keep, top, gap): 남은 카드를 같은 열(x) 안에서 원래 위아래 순서대로 위에서부터 다시 쌓는다.
 *   x는 그대로 두므로 레인 자리가 안 바뀐다.
 * focusBandLayout(boxes, keep, top, gap, bandOf, shareOf): 여러 제품을 합친 그림이면 띠(맨 위 같이 씀, 그 아래 제품마다 전용)별로
 *   나눠 쌓고 띠 자리까지 낸다. 서버의 stackBands와 같은 규칙이다. shareOf는 같이 쓰는 카드의 제품 수다.
 */
export const FOCUS_SOURCE = `
var BAND_HEAD = ${BAND_HEAD}, BAND_TAIL = ${BAND_TAIL};
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
function focusBandLayout(boxes, keep, top, gap, bandOf, shareOf) {
  var band = function (id) { return bandOf[id] === undefined ? 0 : bandOf[id]; };
  var share = function (id) { return shareOf[id] || 0; };
  var columns = {};
  var counts = {};
  boxes.forEach(function (b) {
    if (!keep[b.id]) return;
    (columns[b.x] = columns[b.x] || []).push(b);
    counts[band(b.id)] = (counts[band(b.id)] || 0) + 1;
  });
  var order = Object.keys(counts).map(Number).sort(function (a, b) { return a - b; });
  if (order.length < 2) return { pos: focusLayout(boxes, keep, top, gap) };
  var height = {};
  Object.keys(columns).forEach(function (x) {
    order.forEach(function (k) {
      var h = 0, n = 0;
      columns[x].forEach(function (b) { if (band(b.id) === k) { h += b.h; n += 1; } });
      if (n) height[k] = Math.max(height[k] || 0, h + gap * (n - 1));
    });
  });
  var bands = [];
  var bandTop = {};
  var cursor = top;
  order.forEach(function (k) {
    var h = BAND_HEAD + height[k] + BAND_TAIL;
    bands.push({ band: k, y: cursor, height: h });
    bandTop[k] = cursor + BAND_HEAD;
    cursor += h;
  });
  var pos = {};
  Object.keys(columns).forEach(function (x) {
    var col = columns[x];
    order.forEach(function (k) {
      var y = bandTop[k];
      col.filter(function (b) { return band(b.id) === k; })
        .sort(function (a, b) { return (k === 0 ? share(b.id) - share(a.id) : 0) || a.y - b.y || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); })
        .forEach(function (b) {
          pos[b.id] = { x: b.x, y: y, w: b.w, h: b.h };
          y += b.h + gap;
        });
    });
  });
  return { pos: pos, bands: bands, bottom: cursor };
}
`;
