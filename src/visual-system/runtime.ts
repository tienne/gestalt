import { COLOR_RESOLVER_JS } from './color-resolver-js.js';
import { COLOR_CATALOG } from './color.js';

/**
 * 정적 HTML에 싣는 ES5 런타임. 공통 시각화의 단계 조작과 Lens 위젯 규약(data-w-*)을 함께 처리한다.
 * 렌더러가 최종 단계를 기본으로 그려 두므로 이 스크립트가 없거나 실패해도 그림의 최종 값은 보인다.
 * 템플릿 리터럴 안이라 백틱과 달러 중괄호를 쓰지 않는다.
 */
export const VISUAL_STEP_JS = `(function(){
  function reduced(){
    var r = document.documentElement.getAttribute('data-gestalt-motion');
    if (r === 'reduce') return true;
    if (r === 'full') return false;
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function labels(fig){ try { return JSON.parse(fig.getAttribute('data-vs-labels') || '[]'); } catch (e) { return []; } }
  function countTo(el, to, ms){
    var dec = String(to).indexOf('.') >= 0 ? 1 : 0;
    var from = Number(el.textContent) || 0;
    if (reduced() || !window.requestAnimationFrame) { el.textContent = to.toFixed(dec); return; }
    var t0 = null;
    function tick(t){
      if (t0 === null) t0 = t;
      var p = Math.min(1, (t - t0) / ms);
      el.textContent = (from + (to - from) * p).toFixed(dec);
      if (p < 1) window.requestAnimationFrame(tick);
    }
    window.requestAnimationFrame(tick);
  }
  function setStep(fig, k){
    var n = Number(fig.getAttribute('data-vs-steps')) || 1;
    k = Math.max(1, Math.min(n, k));
    fig.setAttribute('data-vs-current', String(k));
    fig.querySelectorAll('[data-at]').forEach(function(el){ el.classList.toggle('vs-off', Number(el.getAttribute('data-at')) > k); });
    fig.querySelectorAll('[data-focus-at]').forEach(function(el){ el.classList.toggle('vs-focus', Number(el.getAttribute('data-focus-at')) === k); });
    fig.querySelectorAll('[data-strike-at]').forEach(function(el){ el.classList.toggle('is-struck', Number(el.getAttribute('data-strike-at')) <= k); });
    var sync = fig.querySelector('[data-vs-sync]');
    if (sync) {
      var frac = n > 1 ? (k - 1) / (n - 1) : 1;
      var arc = sync.querySelector('.vs-donut-arc');
      if (arc) {
        var full = Number(arc.style.getPropertyValue('--vs-c')) || 0;
        arc.setAttribute('stroke-dasharray', (full * Number(sync.getAttribute('data-vs-sync')) / 100 * frac).toFixed(2) + ' ' + full.toFixed(2));
      }
      var cnt = sync.querySelector('[data-vs-count]');
      // 호와 숫자가 같은 시간 동안 움직여야 비율과 값이 따로 놀지 않는다
      if (cnt) countTo(cnt, Number(cnt.getAttribute('data-vs-count')) * frac, 800);
    }
    var ls = labels(fig);
    var pos = fig.querySelector('.vs-pos');
    if (pos) pos.textContent = '단계 ' + k + ' / ' + n + (ls[k - 1] ? ' · ' + ls[k - 1] : '');
    var prev = fig.querySelector('[data-vs-step="prev"]');
    var next = fig.querySelector('[data-vs-step="next"]');
    // disabled로 막으면 버튼 포커스가 빠져 화살표 키가 더는 안 먹는다
    if (prev) prev.setAttribute('aria-disabled', k === 1 ? 'true' : 'false');
    if (next) next.setAttribute('aria-disabled', k === n ? 'true' : 'false');
  }
  function move(fig, d){ setStep(fig, (Number(fig.getAttribute('data-vs-current')) || 1) + d); }
  document.addEventListener('click', function(ev){
    var b = ev.target.closest ? ev.target.closest('[data-vs-step]') : null;
    if (b) { var fig = b.closest('[data-vs-steps]'); if (fig) move(fig, b.getAttribute('data-vs-step') === 'next' ? 1 : -1); return; }
    var lv = ev.target.closest ? ev.target.closest('[data-vs-live]') : null;
    if (!lv) return;
    var box = lv.closest('[data-vs]');
    var q = box && box.querySelector('template[data-vs-live-queue]');
    var log = box && box.querySelector('.vs-log');
    if (!q || !log) return;
    var item = q.content.firstElementChild;
    var msg = box.querySelector('.vs-live-n');
    if (!item) { if (msg) msg.textContent = '새 이벤트가 없어요'; lv.setAttribute('aria-disabled', 'true'); return; }
    item.classList.add('is-new');
    log.insertBefore(item, log.firstChild);
    if (msg) msg.textContent = '새 이벤트 1건: ' + item.textContent.replace(/\\s+/g, ' ').trim();
  });
  document.addEventListener('keydown', function(ev){
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    var fig = ev.target.closest ? ev.target.closest('[data-vs-steps]') : null;
    if (!fig || (ev.target.tagName === 'INPUT')) return;
    ev.preventDefault();
    move(fig, ev.key === 'ArrowRight' ? 1 : -1);
  });
  function init(root){
    (root || document).querySelectorAll('[data-vs-steps]').forEach(function(fig){ setStep(fig, Number(fig.getAttribute('data-vs-current')) || 1); });
  }
  window.gestaltVisual = { init: init, setStep: setStep, reduced: reduced };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function(){ init(); }); else init();
})();`;

/** Lens 뷰어(viewer-js.ts)의 data-w-* 규약을 그대로 옮긴 것. 문서 사이트에서 제품 위젯을 조작하려고 싣는다. */
export const WIDGET_RUNTIME_JS = `(function(){
  function show(box, key){ box.querySelectorAll('[data-w-state]').forEach(function(s){ s.hidden = s.getAttribute('data-w-state') !== key; }); }
  document.addEventListener('click', function(ev){
    var b = ev.target.closest ? ev.target.closest('[data-w-toggle]') : null;
    if (!b) return;
    var box = b.closest('[data-widget]');
    if (!box) return;
    var key = b.getAttribute('data-w-toggle');
    box.querySelectorAll('[data-w-toggle]').forEach(function(x){ x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
    show(box, key);
  });
  document.addEventListener('input', function(ev){
    var r = ev.target;
    if (!r || !r.hasAttribute || !r.hasAttribute('data-w-slider')) return;
    var box = r.closest('[data-widget]');
    if (!box) return;
    show(box, String(Math.round(Number(r.value))));
    var ls = [];
    try { ls = JSON.parse(r.getAttribute('data-labels') || '[]'); } catch (e) {}
    if (ls[r.value]) r.setAttribute('aria-valuetext', ls[r.value]);
  });
  function step(box, d){
    var states = box.querySelectorAll('[data-w-state]');
    var n = states.length;
    if (!n) return;
    var cur = 0;
    states.forEach(function(s, i){ if (!s.hidden) cur = i; });
    var next = Math.max(0, Math.min(n - 1, cur + d));
    show(box, String(next));
    var pos = box.querySelector('.w-pos');
    if (pos) pos.textContent = '단계 ' + (next + 1) + ' / ' + n;
    var live = box.querySelector('.w-live');
    var st = states[next].querySelector('.ws-step');
    if (live) live.textContent = '단계 ' + (next + 1) + ' / ' + n + (st ? ': ' + st.textContent.trim() : '');
    var p = box.querySelector('[data-w-step="prev"]');
    var f = box.querySelector('[data-w-step="next"]');
    if (p) p.setAttribute('aria-disabled', next === 0 ? 'true' : 'false');
    if (f) f.setAttribute('aria-disabled', next === n - 1 ? 'true' : 'false');
  }
  document.addEventListener('click', function(ev){
    var b = ev.target.closest ? ev.target.closest('[data-w-step]') : null;
    if (!b) return;
    var box = b.closest('[data-widget]');
    if (box) step(box, b.getAttribute('data-w-step') === 'next' ? 1 : -1);
  });
  document.addEventListener('keydown', function(ev){
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    var nav = ev.target.closest ? ev.target.closest('[data-w-steps]') : null;
    var box = nav && nav.closest('[data-widget]');
    if (!box) return;
    ev.preventDefault();
    step(box, ev.key === 'ArrowRight' ? 1 : -1);
  });
})();`;

/**
 * 테마 적용 런타임. 저장된 배경과 강조색을 읽어 :root에 역할 변수를 쓴다.
 * 배경과 강조색은 따로 저장해서 한쪽을 바꿔도 다른 쪽 선택이 남는다.
 * perPage를 켜면 저장 키에 문서 경로를 붙인다. 장표처럼 산출물마다 정한 테마가 다른 경우 한 장에서 고른 색이 다른 장으로 번지지 않게 한다.
 */
export function themeRuntimeJs(storageKey = 'gestalt-color', perPage = false): string {
  return `${COLOR_RESOLVER_JS}
(function(){
  var sys = gestaltColorSystem(${JSON.stringify(COLOR_CATALOG)});
  var KEY = ${JSON.stringify(storageKey)}${perPage ? " + ':' + location.pathname" : ''};
  function read(){ try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; } }
  function write(sel){ try { localStorage.setItem(KEY, JSON.stringify(sel)); } catch (e) {} }
  var root = document.documentElement;
  // 문서가 처음 들고 온 배경과 강조색이 그 산출물의 기본값이다. 적용할 때마다 속성을 덮어쓰므로 시작할 때 한 번만 읽는다
  var base = { background: root.getAttribute('data-gestalt-background') || undefined, accent: root.getAttribute('data-gestalt-accent') || undefined };
  function apply(sel){
    var t = sys.resolve({ background: sel.background || base.background, accent: sel.accent || base.accent });
    sys.apply(root, t);
    root.setAttribute('data-gestalt-background', t.background);
    root.setAttribute('data-gestalt-accent', t.accent);
    return t;
  }
  var current = read();
  window.gestaltTheme = {
    system: sys,
    get: function(){ return read(); },
    set: function(part){ var s = read(); for (var k in part) { if (Object.prototype.hasOwnProperty.call(part, k)) s[k] = part[k]; } write(s); var t = apply(s); document.dispatchEvent(new CustomEvent('gestalt-theme', { detail: t })); return t; },
    reset: function(){ write({}); var t = apply({}); document.dispatchEvent(new CustomEvent('gestalt-theme', { detail: t })); return t; },
    resolve: function(sel){ return sys.resolve(sel || read()); }
  };
  apply(current);
})();`;
}
