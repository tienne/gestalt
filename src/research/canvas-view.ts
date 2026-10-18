// 리서치 HTML의 캔버스 보기. 섹션 하나가 보드 하나이고 피그마처럼 펼쳐 놓고 끌고 확대한다.
// 문서 보기는 보드 클래스에 아무 모양도 없어서 감싸기 전과 똑같이 보인다.

/** h2마다 섹션을 끊어 보드로 감싼다. 첫 h2 앞의 제목과 안내는 첫 보드로 묶는다 */
export function boardMarkup(parts: string[], firstTitle: string): string {
  const out = [`<section class="board" data-title="${firstTitle}">`];
  for (const p of parts) {
    const m = /^<h2>(.*)<\/h2>$/s.exec(p);
    if (m) out.push('</section>', `<section class="board" data-title="${m[1]!}">`);
    out.push(p);
  }
  out.push('</section>');
  return out.join('\n');
}

export const CANVAS_CSS = `
:root{--canvas:#e7e5e4}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--canvas:#000}}
:root[data-theme="dark"]{--canvas:#000}
.board-label{display:none}
.cv-bar{position:fixed;top:12px;right:12px;z-index:10;display:flex;gap:4px;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:4px;box-shadow:0 2px 8px rgba(0,0,0,.08);font-size:13px}
.cv-bar select{max-width:140px}
.cv-bar button,.cv-bar select{font:inherit;color:var(--fg);background:transparent;border:0;border-radius:6px;padding:4px 8px;cursor:pointer}
.cv-bar button:hover,.cv-bar select:hover{background:var(--chip)}
.cv-bar .cv-only{display:none}
.cv-zoom{min-width:48px;text-align:center;color:var(--muted)}
body.canvas{overflow:hidden;height:100vh;background:var(--canvas);overscroll-behavior:none}
body.canvas .cv-bar .cv-only{display:inline-block}
body.canvas main{position:absolute;left:0;top:0;max-width:none;margin:0;padding:0;transform-origin:0 0}
body.canvas .board{position:absolute;width:1080px;background:var(--card);border-radius:12px;padding:28px 40px 40px;box-shadow:0 1px 3px rgba(0,0,0,.08),0 0 0 1px var(--line)}
body.canvas .board>h2:first-of-type{border-top:0;margin-top:0;padding-top:0}
body.canvas .wrap{overflow:visible}
body.canvas .board-label{display:block;position:absolute;bottom:100%;left:0;padding-bottom:calc(8px / var(--z,1));font-size:calc(13px / var(--z,1));line-height:1.2;color:var(--muted);white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis;cursor:pointer;user-select:none}
body.canvas .board-label:hover{color:var(--accent)}
body.canvas.grab,body.canvas.grab *{cursor:grab!important;user-select:none}
body.canvas.grabbing,body.canvas.grabbing *{cursor:grabbing!important}
@media print{.cv-bar{display:none}}
`;

// 템플릿 리터럴 안이라 백틱과 달러 중괄호를 쓰지 않는다
export const CANVAS_JS = `
(function(){
  var main = document.querySelector('main');
  var boards = Array.prototype.slice.call(document.querySelectorAll('.board'));
  if (!main || boards.length === 0) return;
  var body = document.body;
  var GAP_X = 160, GAP_Y = 200, COLS = 4, MIN_Z = 0.05, MAX_Z = 4;
  var view = { x: 0, y: 0, z: 1 };
  var bounds = { w: 0, h: 0 };
  var on = false, laidOut = false;

  var bar = document.createElement('div');
  bar.className = 'cv-bar';
  bar.innerHTML =
    '<button type="button" data-act="toggle"></button>' +
    '<select class="cv-only" data-act="jump" title="보드로 이동"></select>' +
    '<button type="button" class="cv-only" data-act="out" title="축소 (-)">−</button>' +
    '<span class="cv-only cv-zoom"></span>' +
    '<button type="button" class="cv-only" data-act="in" title="확대 (+)">+</button>' +
    '<button type="button" class="cv-only" data-act="fit" title="전체 보기 (Shift+1)">전체</button>';
  body.appendChild(bar);
  var toggleBtn = bar.querySelector('[data-act="toggle"]');
  var jump = bar.querySelector('[data-act="jump"]');
  var zoomText = bar.querySelector('.cv-zoom');
  jump.innerHTML = '<option value="">보드</option>' + boards.map(function (b, i) {
    var o = document.createElement('option');
    o.value = String(i);
    o.textContent = b.dataset.title || '';
    return o.outerHTML;
  }).join('');

  boards.forEach(function (b, i) {
    var label = document.createElement('div');
    label.className = 'board-label';
    label.textContent = b.dataset.title || '';
    label.dataset.board = String(i);
    b.insertBefore(label, b.firstChild);
  });

  function apply() {
    main.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.z + ')';
    main.style.setProperty('--z', String(view.z));
    zoomText.textContent = Math.round(view.z * 100) + '%';
  }

  // 첫 보드(제목과 안내)는 맨 위에 혼자 두고 나머지는 가장 짧은 열에 차례로 채운다
  function layout() {
    var head = boards[0], rest = boards.slice(1);
    head.style.left = '0px';
    head.style.top = '0px';
    var top = head.offsetHeight + GAP_Y;
    var colW = 0;
    rest.forEach(function (b) { colW = Math.max(colW, b.offsetWidth); });
    var cols = [];
    for (var c = 0; c < Math.min(COLS, rest.length); c++) cols.push(top);
    rest.forEach(function (b) {
      var i = cols.indexOf(Math.min.apply(null, cols));
      b.style.left = i * (colW + GAP_X) + 'px';
      b.style.top = cols[i] + 'px';
      cols[i] += b.offsetHeight + GAP_Y;
    });
    bounds = {
      w: Math.max(head.offsetWidth, cols.length * (colW + GAP_X) - GAP_X),
      h: Math.max.apply(null, cols.concat(top)) - GAP_Y,
    };
  }

  function widen() {
    boards.forEach(function (b) {
      b.style.width = '';
      var need = 0;
      b.querySelectorAll('table').forEach(function (t) { need = Math.max(need, t.scrollWidth); });
      if (need > 1000) b.style.width = (need + 80) + 'px';
    });
  }

  function zoomAt(z, cx, cy) {
    z = Math.min(MAX_Z, Math.max(MIN_Z, z));
    view.x = cx - (cx - view.x) * (z / view.z);
    view.y = cy - (cy - view.y) * (z / view.z);
    view.z = z;
    apply();
  }

  function frame(x, y, w, h, maxZ) {
    var pad = 64, top = 56;
    var vw = window.innerWidth - pad * 2, vh = window.innerHeight - pad - top;
    var z = Math.min(maxZ, vw / w, vh / h);
    view.z = Math.max(MIN_Z, z);
    view.x = pad + (vw - w * view.z) / 2 - x * view.z;
    view.y = top + Math.max(0, (vh - h * view.z) / 2) - y * view.z;
    apply();
  }

  function fit() { frame(0, 0, bounds.w, bounds.h, 1); }

  function focusBoard(b) { frame(b.offsetLeft, b.offsetTop, b.offsetWidth, Math.min(b.offsetHeight, 900), 1); }

  function focusEl(el) {
    var b = el.closest('.board');
    if (!b) return;
    var r = el.getBoundingClientRect();
    var z = Math.max(view.z, 0.8);
    var wx = (r.left - view.x) / view.z, wy = (r.top - view.y) / view.z, ww = r.width / view.z;
    view.z = z;
    view.x = window.innerWidth / 2 - (wx + ww / 2) * z;
    view.y = window.innerHeight / 3 - wy * z;
    apply();
  }

  var relayoutQueued = false;
  function relayout() {
    if (!on || relayoutQueued) return;
    relayoutQueued = true;
    requestAnimationFrame(function () { relayoutQueued = false; if (on) layout(); });
  }
  var ro = typeof ResizeObserver === 'function' ? new ResizeObserver(relayout) : null;

  function enter() {
    on = true;
    body.classList.add('canvas');
    toggleBtn.textContent = '문서로 보기';
    document.querySelectorAll('img[loading="lazy"]').forEach(function (img) { img.loading = 'eager'; });
    widen();
    layout();
    if (ro) boards.forEach(function (b) { ro.observe(b); });
    if (!laidOut) { fit(); laidOut = true; } else apply();
    history.replaceState(null, '', '#canvas');
  }

  function leave() {
    on = false;
    if (ro) ro.disconnect();
    body.classList.remove('canvas', 'grab', 'grabbing');
    toggleBtn.textContent = '캔버스로 보기';
    main.style.transform = '';
    boards.forEach(function (b) { b.style.left = ''; b.style.top = ''; b.style.width = ''; });
    history.replaceState(null, '', location.pathname + location.search);
  }

  bar.addEventListener('click', function (ev) {
    var act = ev.target.closest('[data-act]');
    if (!act) return;
    var a = act.dataset.act;
    var cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    if (a === 'toggle') { if (on) leave(); else enter(); }
    else if (a === 'in') zoomAt(view.z * 1.25, cx, cy);
    else if (a === 'out') zoomAt(view.z / 1.25, cx, cy);
    else if (a === 'fit') fit();
  });
  jump.addEventListener('change', function () {
    var b = boards[Number(jump.value)];
    if (b) focusBoard(b);
    jump.value = '';
  });

  window.addEventListener('wheel', function (ev) {
    if (!on || ev.target.closest('.cv-bar')) return;
    ev.preventDefault();
    if (ev.ctrlKey || ev.metaKey) {
      zoomAt(view.z * Math.exp(-ev.deltaY * 0.01), ev.clientX, ev.clientY);
    } else {
      var dx = ev.deltaX, dy = ev.deltaY;
      if (ev.shiftKey && dx === 0) { dx = dy; dy = 0; }
      view.x -= dx;
      view.y -= dy;
      apply();
    }
  }, { passive: false });

  // 사파리 트랙패드 핀치는 wheel이 아니라 gesture 이벤트로 온다
  var gestureZ = 1;
  window.addEventListener('gesturestart', function (ev) { if (on) { ev.preventDefault(); gestureZ = view.z; } });
  window.addEventListener('gesturechange', function (ev) {
    if (on) { ev.preventDefault(); zoomAt(gestureZ * ev.scale, ev.clientX, ev.clientY); }
  });

  var space = false, drag = null;
  window.addEventListener('keydown', function (ev) {
    if (!on) return;
    var tag = (ev.target.tagName || '').toLowerCase();
    if (tag === 'select' || tag === 'input' || tag === 'textarea') return;
    var cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    if (ev.code === 'Space') { ev.preventDefault(); if (!space) { space = true; body.classList.add('grab'); } }
    else if (ev.shiftKey && ev.code === 'Digit1') fit();
    else if (ev.shiftKey && ev.code === 'Digit0') zoomAt(1, cx, cy);
    else if (ev.key === '+' || ev.key === '=') { ev.preventDefault(); zoomAt(view.z * 1.25, cx, cy); }
    else if (ev.key === '-' || ev.key === '_') { ev.preventDefault(); zoomAt(view.z / 1.25, cx, cy); }
  });
  window.addEventListener('keyup', function (ev) {
    if (ev.code === 'Space') { space = false; body.classList.remove('grab'); }
  });

  window.addEventListener('pointerdown', function (ev) {
    if (!on || ev.target.closest('.cv-bar')) return;
    var label = ev.target.closest('.board-label');
    var onBoard = ev.target.closest('.board') && !label;
    if (onBoard && !space && ev.button !== 1) return;
    ev.preventDefault();
    drag = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y, moved: false, label: label };
    body.classList.add('grabbing');
  });
  window.addEventListener('pointermove', function (ev) {
    if (!drag) return;
    var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    view.x = drag.vx + dx;
    view.y = drag.vy + dy;
    apply();
  });
  window.addEventListener('pointerup', function () {
    if (!drag) return;
    if (drag.label && !drag.moved) focusBoard(boards[Number(drag.label.dataset.board)]);
    drag = null;
    body.classList.remove('grabbing');
  });

  // 캡처 썸네일처럼 문서 안 앵커는 캔버스에서 스크롤 대신 그 자리로 화면을 옮긴다
  document.addEventListener('click', function (ev) {
    if (!on) return;
    var a = ev.target.closest('a[href^="#"]');
    if (!a) return;
    var id = decodeURIComponent(a.getAttribute('href').slice(1));
    var el = id && document.getElementById(id);
    if (!el) return;
    ev.preventDefault();
    focusEl(el);
  });

  window.addEventListener('resize', function () { if (on) apply(); });

  toggleBtn.textContent = '캔버스로 보기';
  if (location.hash === '#canvas') enter();
})();
`;
