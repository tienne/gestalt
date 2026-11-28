import { CLIENT_HANDLE } from './html-client.js';
import { SIDE_PANEL_SHEET_MAX } from './layout-tuning.js';
import { LIVE_QUESTION_MAX } from './live-ask.js';
import {
  LIVE_ASK_PATH,
  LIVE_STATUS_PATH,
  LIVE_TOKEN_HEADER,
  LIVE_TOKEN_META,
} from './live-port.js';

/** 라이브 스크립트가 두 번 돌지 않게 거는 전역 표식 */
export const LIVE_HANDLE = '__gestaltArchLive';

/** 세션이 떠 있는지와 그림이 바뀌었는지 보는 주기 */
const STATUS_MS = 15_000;
/** 질문을 보내고 답을 기다리는 동안 보는 주기 */
const WAIT_MS = 3_000;
/** 다른 탭을 보는 동안 보는 주기 */
const HIDDEN_MS = 60_000;
/** 답을 기다리는 최대 시간. 지나면 기다림 표시를 걷는다 */
const WAIT_LIMIT_MS = 10 * 60_000;

/**
 * 질문 폼 모양. 본인용 페이지 style에만 싣는다.
 * 폼은 접힌 단추 하나로 시작한다. 펼친 채로 두면 오른쪽 아래의 확대 단추와 서랍 아래쪽을 가린다.
 * 좁은 화면에서 개요 시트가 열리면 단추와 폼을 함께 시트 위로 올린다. 기준은 client가 body에 다는 overview-open이다.
 * :has를 못 읽는 브라우저에서도 같이 올라가야 해서 클래스로 고른다
 */
export const LIVE_FORM_CSS = `.live-ask-toggle { position: fixed; right: 16px; bottom: 16px; z-index: 40; padding: 8px 14px; font: inherit; font-weight: 650; color: var(--on-accent); background: var(--accent-fill); border: 0; border-radius: 999px; box-shadow: var(--shadow-pop); cursor: pointer; }
.live-ask-toggle:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
.live-ask { position: fixed; right: 16px; bottom: 64px; z-index: 40; width: min(360px, calc(100vw - 32px)); display: grid; gap: 6px; padding: 10px; background: var(--surface); color: var(--text); border: 1px solid var(--border-strong); border-radius: 10px; box-shadow: var(--shadow-pop); font: inherit; }
.live-ask label { font-weight: 650; font-size: 13px; }
.live-ask textarea { width: 100%; box-sizing: border-box; min-height: 56px; resize: vertical; padding: 6px 8px; font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 6px; }
.live-ask .live-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.live-ask button { padding: 4px 12px; font: inherit; color: var(--on-accent); background: var(--accent-fill); border: 0; border-radius: 6px; cursor: pointer; }
.live-ask button[disabled] { opacity: 0.5; cursor: default; }
.live-ask[hidden] { display: none; }
.live-ask .live-msg { margin: 0; font-size: 12px; color: var(--text-3); }
@media (max-width: ${SIDE_PANEL_SHEET_MAX}px) {
  .live-ask-toggle { right: 12px; bottom: 164px; }
  .live-ask { right: 12px; bottom: 212px; }
  .overview-open .live-ask-toggle { bottom: calc(60vh + 8px); }
  .overview-open .live-ask { bottom: calc(60vh + 56px); max-height: calc(40vh - 64px); overflow: auto; }
}
@media print { .live-ask, .live-ask-toggle { display: none; } }`;

/**
 * 본인용 페이지에만 싣는 라이브 스크립트. 라이브 서버가 끼운 토큰 meta가 없으면(file://로 열었거나 공유본)
 * 아무것도 하지 않는다. 세션이 떠 있을 때만 질문 폼을 만들고 꺼지면 DOM에서 뗀다.
 * 그림이 다시 렌더되면 새 페이지를 받아 스크립트와 style이 같을 때 body만 갈아 끼우고 다르면 새로 읽는다.
 * 같은 입력이면 같은 글자를 내야 CSP 해시가 고정된다
 */
export function renderLiveScript(): string {
  return `(function () {
  'use strict';
  if (window.${LIVE_HANDLE}) return;
  var meta = document.querySelector('meta[name="${LIVE_TOKEN_META}"]');
  if (!meta || !window.fetch || !window.DOMParser) return;
  var token = meta.getAttribute('content') || '';
  var match = /^\\/([a-z-]+)\\.html$/.exec(location.pathname);
  if (!token || !match) return;
  var view = match[1];
  window.${LIVE_HANDLE} = true;
  var form = null;
  var toggle = null;
  var input = null;
  var send = null;
  var msg = null;
  var base = null;
  var waitingSince = 0;
  var timer = null;
  var busy = false;

  function headers(extra) {
    var h = { '${LIVE_TOKEN_HEADER}': token };
    for (var k in extra) h[k] = extra[k];
    return h;
  }
  function say(text) { if (msg) msg.textContent = text; }
  function sessionAlive() {
    return fetch('${LIVE_STATUS_PATH}', { headers: headers({}), cache: 'no-store', credentials: 'same-origin' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (body) { return !!(body && body.session === true); }, function () { return false; });
  }
  function pageTag() {
    return fetch(location.pathname, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' })
      .then(function (res) { return res.ok ? res.headers.get('ETag') : null; }, function () { return null; });
  }
  function setOpen(open, moveFocus) {
    form.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (moveFocus) (open ? input : toggle).focus();
  }
  function buildForm() {
    toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.id = 'live-ask-toggle';
    toggle.className = 'live-ask-toggle';
    toggle.textContent = '그림에 질문하기';
    toggle.setAttribute('aria-controls', 'live-ask');
    toggle.addEventListener('click', function () { setOpen(form.hidden, true); });
    form = document.createElement('form');
    form.id = 'live-ask';
    form.className = 'live-ask';
    form.setAttribute('aria-label', '그림에 질문하기');
    var label = document.createElement('label');
    label.htmlFor = 'live-q';
    label.textContent = '이 그림에 질문하기';
    input = document.createElement('textarea');
    input.id = 'live-q';
    input.maxLength = ${LIVE_QUESTION_MAX};
    input.placeholder = '보고 있는 레벨과 고른 카드를 함께 보내요';
    var row = document.createElement('div');
    row.className = 'live-row';
    msg = document.createElement('p');
    msg.className = 'live-msg';
    msg.setAttribute('aria-live', 'polite');
    send = document.createElement('button');
    send.type = 'submit';
    send.textContent = '보내기';
    row.appendChild(msg);
    row.appendChild(send);
    form.appendChild(label);
    form.appendChild(input);
    form.appendChild(row);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      ask();
    });
    // 그림 단축키로 새지 않게 막으므로 Escape도 전역 핸들러까지 안 간다. 폼 접기는 여기서 받는다
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ask(); }
      else if (e.key === 'Escape') { e.preventDefault(); setOpen(false, true); }
    });
    setOpen(false, false);
  }
  function showForm() {
    if (!form) buildForm();
    if (toggle.parentNode !== document.body) document.body.appendChild(toggle);
    if (form.parentNode !== document.body) document.body.appendChild(form);
  }
  function hideForm() {
    if (toggle && toggle.parentNode) toggle.parentNode.removeChild(toggle);
    if (form && form.parentNode) form.parentNode.removeChild(form);
  }
  function where() {
    var h = window.${CLIENT_HANDLE};
    var s = null;
    try { s = h && h.state ? h.state() : null; } catch (e) {}
    var out = {};
    if (s && typeof s.level === 'string') out.level = s.level;
    if (s && typeof s.node === 'string') out.node = s.node;
    return out;
  }
  function ask() {
    var q = input.value.trim();
    if (!q || send.disabled) return;
    var body = where();
    body.view = view;
    body.question = q;
    send.disabled = true;
    say('보내는 중이에요');
    fetch('${LIVE_ASK_PATH}', {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin'
    }).then(function (res) {
      return res.json().then(function (b) { return b && b.code; }, function () { return null; });
    }, function () { return null; }).then(function (code) {
      send.disabled = false;
      if (code === 'sent') {
        input.value = '';
        waitingSince = Date.now();
        say('세션에 보냈어요. 다시 렌더되면 이 화면이 바뀌어요');
        poke();
      } else if (code === 'no_session') {
        hideForm();
      } else if (code === 'rate_limited') {
        say('잠깐 뒤에 다시 보내 주세요');
      } else if (code === 'unknown_target') {
        say('그림이 바뀌었어요. 카드를 다시 골라 주세요');
      } else {
        say('보내지 못했어요');
      }
    });
  }
  function scriptsOf(doc) {
    return Array.prototype.filter.call(doc.querySelectorAll('script'), function (s) { return !s.type; });
  }
  function signature(doc) {
    var csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
    return [csp ? csp.getAttribute('content') : '', doc.documentElement.getAttribute('data-icons') || ''].join('\\n');
  }
  // CSP meta에는 스크립트와 style의 해시가 다 들어 있다. 같으면 새 페이지 스크립트도 지금 정책으로 돈다
  function patch(html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    if (!doc.body || signature(doc) !== signature(document)) return false;
    var client = null;
    scriptsOf(doc).forEach(function (s) {
      if (s.textContent.indexOf("${CLIENT_HANDLE}") >= 0 && s.textContent.indexOf("${LIVE_HANDLE}") < 0) client = s;
    });
    if (!client) return false;
    var h = window.${CLIENT_HANDLE};
    var saved = null;
    try { saved = h && h.state ? h.state() : null; } catch (e) {}
    if (h && h.dispose) h.dispose();
    var keep = form && form.parentNode ? [toggle, form] : null;
    var had = document.activeElement;
    var refocus = keep && had && (had === toggle || form.contains(had)) ? had : null;
    var next = document.adoptNode(doc.body);
    document.documentElement.replaceChild(next, document.body);
    document.title = doc.title;
    if (keep) keep.forEach(function (el) { next.appendChild(el); });
    var fresh = document.createElement('script');
    fresh.textContent = client.textContent;
    client.parentNode.replaceChild(fresh, client);
    // 새 그림에서도 고른 카드와 검색어를 이어 간다. 레벨은 해시라 그대로 남는다
    var nh = window.${CLIENT_HANDLE};
    if (saved && nh && nh !== h && nh.restore) {
      try { nh.restore(saved); } catch (e) {}
    }
    if (refocus) refocus.focus({ preventScroll: true });
    return true;
  }
  function refresh(tag) {
    return fetch(location.pathname, { cache: 'no-store', credentials: 'same-origin' }).then(function (res) {
      if (!res.ok) return;
      var got = res.headers.get('ETag') || tag;
      return res.text().then(function (html) {
        // 렌더가 파일을 쓰는 도중이면 잘린 페이지가 온다. 데이터 칸이 없으면 다음 차례에 다시 받는다
        if (html.indexOf('</html>') < 0) return;
        base = got;
        var ok = false;
        try { ok = patch(html); } catch (e) { ok = false; }
        if (!ok) { location.reload(); return; }
        waitingSince = 0;
        say('다시 렌더된 그림으로 바꿨어요');
      });
    }).then(null, function () {});
  }
  function schedule() {
    clearTimeout(timer);
    var ms = document.hidden ? ${HIDDEN_MS} : waitingSince ? ${WAIT_MS} : ${STATUS_MS};
    timer = setTimeout(tick, ms);
  }
  function tick() {
    timer = null;
    if (busy) return schedule();
    if (waitingSince && Date.now() - waitingSince > ${WAIT_LIMIT_MS}) {
      waitingSince = 0;
      say('아직 다시 렌더되지 않았어요. 세션을 확인해 주세요');
    }
    busy = true;
    sessionAlive().then(function (alive) {
      if (alive) showForm(); else hideForm();
      return pageTag();
    }).then(function (tag) {
      if (!tag) return;
      if (base === null) { base = tag; return; }
      if (tag !== base) return refresh(tag);
    }).then(function () {
      busy = false;
      schedule();
    }, function () {
      busy = false;
      schedule();
    });
  }
  function poke() {
    if (busy) return;
    clearTimeout(timer);
    tick();
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poke(); });
  tick();
})();`;
}
