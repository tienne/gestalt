import { escapeHtml } from '../local-pr-web/html-generator.js';

/**
 * 컨덕터 결과 웹 뷰어의 페이지 한 장. 데이터는 페이지가 `/api/*`에서 받아 그린다.
 *
 * 주문 제목, 요약, 경로 같은 값은 워커와 바깥이 적은 글자라 textContent로만 넣는다.
 * innerHTML로 넣는 건 서버가 마크다운 렌더러로 만든 HTML(본문, 주문 설명, 보고 요약)뿐이다.
 * 스크립트는 nonce를 단 인라인 하나이고 바깥 자산을 끌어오지 않는다.
 */
export function renderBrowsePage(nonce: string, stateDir: string): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>컨덕터 결과</title>
<style>${STYLE}</style>
</head>
<body>
<header class="top">
  <strong class="brand">컨덕터 결과</strong>
  <input id="q" type="search" placeholder="요약과 refs 본문 검색 (Enter)" autocomplete="off">
  <label class="chk"><input id="q-body" type="checkbox" checked> 본문 포함</label>
  <span class="muted small" title="상태 저장소">${escapeHtml(stateDir)}</span>
</header>
<div class="layout">
  <aside class="side">
    <div class="filters">
      <select id="f-repo"><option value="">모든 레포</option></select>
      <select id="f-status"><option value="">모든 상태</option></select>
      <input id="f-since" type="date" title="이 날 이후 갱신">
      <input id="f-issue" type="text" placeholder="지라 키" autocomplete="off">
      <select id="f-group" title="목록 묶기">
        <option value="repo">레포별로 묶기</option>
        <option value="ticket">티켓, PR별로 묶기</option>
        <option value="date">날짜별로 묶기</option>
        <option value="status">상태별로 묶기</option>
        <option value="">묶지 않기</option>
      </select>
      <input id="f-text" type="text" placeholder="목록 안에서 거르기" autocomplete="off">
    </div>
    <div id="count" class="muted small"></div>
    <ul id="orders" class="orders"></ul>
    <a id="unlinked-link" class="unlinked" href="#unlinked">주문 없는 파일</a>
  </aside>
  <main id="main" class="main"><p class="muted">왼쪽에서 주문을 고르거나 위에서 검색하세요.</p></main>
</div>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

const STYLE = `
:root { color-scheme: light dark; --bg:#fff; --fg:#1f2328; --muted:#6b7280; --line:#e5e7eb; --side:#f7f7f5; --hl:#fff3a3; --sel:#ebeef3; --code:#f3f4f6; }
@media (prefers-color-scheme: dark) { :root { --bg:#191919; --fg:#e6e6e6; --muted:#9b9b9b; --line:#2f2f2f; --side:#202020; --hl:#5c4d00; --sel:#2c2c2c; --code:#262626; } }
* { box-sizing: border-box; }
body { margin:0; font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Segoe UI", sans-serif; background:var(--bg); color:var(--fg); }
.top { display:flex; gap:12px; align-items:center; padding:10px 16px; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--bg); z-index:1; }
.brand { white-space:nowrap; }
#q { flex:1; max-width:640px; padding:6px 10px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg); }
.chk { white-space:nowrap; }
.layout { display:flex; height:calc(100vh - 49px); }
.side { width:340px; min-width:260px; border-right:1px solid var(--line); background:var(--side); display:flex; flex-direction:column; }
.filters { display:grid; grid-template-columns:1fr 1fr; gap:6px; padding:10px; }
.filters select, .filters input { width:100%; padding:4px 6px; border:1px solid var(--line); border-radius:4px; background:var(--bg); color:var(--fg); }
#count { padding:0 12px 6px; }
.orders { list-style:none; margin:0; padding:0; overflow:auto; flex:1; }
.orders li a { display:block; padding:8px 12px; border-bottom:1px solid var(--line); color:inherit; text-decoration:none; }
.orders li a:hover, .orders li a.sel { background:var(--sel); }
.orders .t { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; font-weight:500; overflow:hidden; overflow-wrap:anywhere; }
.orders .grp { position:sticky; top:0; z-index:1; display:flex; gap:6px; align-items:center; width:100%; padding:6px 12px; border:0; border-bottom:1px solid var(--line); background:var(--side); color:var(--muted); font:inherit; font-size:12px; font-weight:600; text-align:left; cursor:pointer; }
.orders .grp .n { margin-left:auto; font-weight:400; }
.orders .grp .name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.unlinked { display:block; padding:10px 12px; border-top:1px solid var(--line); color:inherit; }
.main { flex:1; overflow:auto; padding:24px 40px 80px; }
.main h1 { font-size:24px; margin:0 0 8px; }
.meta { display:flex; flex-wrap:wrap; gap:6px 16px; color:var(--muted); margin-bottom:20px; }
.badge { display:inline-block; padding:0 6px; border-radius:4px; font-size:12px; background:var(--code); color:var(--fg); }
.badge.done, .badge.merged { background:#d1f4dc; color:#14532d; }
.badge.failed, .badge.cancelled, .badge.escalated { background:#fde2e1; color:#7f1d1d; }
.badge.running, .badge.waiting-gate, .badge.queued { background:#dbeafe; color:#1e3a8a; }
.muted { color:var(--muted); }
.small { font-size:12px; }
section { margin:28px 0; }
section > h2 { font-size:16px; border-bottom:1px solid var(--line); padding-bottom:4px; }
.timeline { list-style:none; padding:0; margin:0; border-left:2px solid var(--line); }
.timeline li { padding:6px 0 12px 16px; position:relative; }
.timeline li::before { content:""; position:absolute; left:-6px; top:12px; width:10px; height:10px; border-radius:50%; background:var(--line); }
.timeline li.focus { background:var(--sel); }
.summary { white-space:pre-wrap; margin-top:4px; }
.md { margin-top:4px; overflow-wrap:anywhere; }
.md > :first-child { margin-top:0; }
.md > :last-child { margin-bottom:0; }
.md h1, .md h2, .md h3, .md h4 { font-size:15px; margin:12px 0 4px; border:0; padding:0; }
.md p, .md ul, .md ol { margin:4px 0; }
.card { border:1px solid var(--line); border-radius:8px; margin:8px 0; }
.card > summary { padding:8px 12px; cursor:pointer; overflow-wrap:anywhere; }
.card.focus { outline:2px solid #3b82f6; }
.card .body { padding:4px 16px 12px; border-top:1px solid var(--line); overflow-wrap:anywhere; }
.body pre { background:var(--code); padding:10px; border-radius:6px; overflow:auto; }
.body code { background:var(--code); padding:0 3px; border-radius:3px; }
.body pre code { padding:0; }
.body table { border-collapse:collapse; }
.body th, .body td { border:1px solid var(--line); padding:4px 8px; }
.body blockquote { margin:0; padding-left:12px; border-left:3px solid var(--line); color:var(--muted); }
.raw { white-space:pre-wrap; font-family: ui-monospace, Menlo, monospace; font-size:12px; }
mark { background:var(--hl); color:inherit; }
.hits { list-style:none; padding:0; }
.hits li { padding:8px 0; border-bottom:1px solid var(--line); }
.hits a { color:inherit; }
.ex { font-size:13px; overflow-wrap:anywhere; }
`;

/**
 * 브라우저 스크립트. TS 템플릿 안에 있으니 백틱과 달러-중괄호를 쓰지 않는다.
 * 바깥 값은 전부 text()와 textContent로 넣는다.
 */
const SCRIPT = `
'use strict';
var state = { orders: [], filters: {}, current: '', closed: {} };
var GROUP_KEY = 'conductor-results-group';
function $(id) { return document.getElementById(id); }
function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}
function add(parent) { for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i]); return parent; }
function stamp(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  function p(n) { return n < 10 ? '0' + n : String(n); }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function getJson(url) {
  return fetch(url, { headers: { Accept: 'application/json' } }).then(function (r) {
    if (!r.ok) return r.text().then(function (t) { throw new Error(r.status + ' ' + t); });
    return r.json();
  });
}
function qs(obj) {
  var parts = [];
  Object.keys(obj).forEach(function (k) { if (obj[k]) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(obj[k])); });
  return parts.length ? '?' + parts.join('&') : '';
}
function safeUrl(u) { return /^https?:\\/\\//i.test(String(u || '')) ? String(u) : null; }
function prUrl(ref) {
  var m = /^([\\w.-]+)\\/([\\w.-]+)#(\\d+)$/.exec(String(ref || ''));
  if (m) return 'https://github.com/' + m[1] + '/' + m[2] + '/pull/' + m[3];
  return safeUrl(ref);
}
function link(href, text) {
  var a = el('a', '', text);
  a.href = href; a.rel = 'noreferrer noopener'; a.target = '_blank';
  return a;
}
function badge(status) { return el('span', 'badge ' + String(status).replace(/[^a-z-]/g, ''), status); }
function highlight(parent, text, start, len) {
  add(parent, document.createTextNode(text.slice(0, start)), el('mark', '', text.slice(start, start + len)), document.createTextNode(text.slice(start + len)));
  return parent;
}
function setMain(nodes) {
  var main = $('main');
  main.textContent = '';
  nodes.forEach(function (n) { if (n) main.appendChild(n); });
  main.scrollTop = 0;
}
function fail(e) { setMain([el('p', 'muted', '불러오지 못했어요: ' + e.message)]); }

function filters() {
  return { repo: $('f-repo').value, status: $('f-status').value, since: $('f-since').value, issue: $('f-issue').value.trim(), q: $('f-text').value.trim() };
}
function fillSelect(sel, values) {
  var cur = sel.value;
  while (sel.options.length > 1) sel.remove(1);
  values.forEach(function (v) { var o = el('option', '', v); o.value = v; sel.appendChild(o); });
  sel.value = cur;
}
function loadOrders() {
  return getJson('/api/orders' + qs(filters())).then(function (data) {
    state.orders = data.orders;
    fillSelect($('f-repo'), data.repos);
    fillSelect($('f-status'), data.statuses);
    $('count').textContent = '주문 ' + data.orders.length + '개 / 전체 ' + data.total + '개';
    $('unlinked-link').textContent = '주문 없는 파일 (' + data.unlinkedCount + ')';
    renderOrders();
    markSelected();
  }).catch(fail);
}
function groupOf(o, mode) {
  if (mode === 'repo') return o.repo;
  if (mode === 'date') return stamp(o.updatedAt).slice(0, 10);
  if (mode === 'status') return o.status;
  if (mode === 'ticket') return o.issueKey || o.prRef || '티켓 없음';
  return '';
}
function orderItem(o, mode) {
  var a = el('a');
  a.href = '#order/' + encodeURIComponent(o.id);
  a.dataset.id = o.id;
  add(a, el('span', 't', o.title));
  var meta = el('span', 'muted small');
  var bits = [];
  if (mode !== 'repo') bits.push(o.repo);
  if (mode !== 'date') bits.push(stamp(o.updatedAt).slice(0, 10));
  if (mode !== 'ticket' && o.issueKey) bits.push(o.issueKey);
  bits.push('보고 ' + o.reportCount);
  add(meta, mode === 'status' ? null : badge(o.status), document.createTextNode(' ' + bits.join('  ')));
  add(a, meta);
  return add(el('li'), a);
}
// 목록은 갱신순이라 묶음도 가장 최근 주문이 든 묶음부터 나온다
function renderOrders() {
  var mode = $('f-group').value;
  var ul = $('orders');
  ul.textContent = '';
  if (!mode) {
    state.orders.forEach(function (o) { ul.appendChild(orderItem(o, mode)); });
    return;
  }
  var groups = [];
  var byKey = {};
  state.orders.forEach(function (o) {
    var k = groupOf(o, mode);
    if (!byKey[k]) { byKey[k] = []; groups.push(k); }
    byKey[k].push(o);
  });
  groups.forEach(function (k) {
    var id = mode + ':' + k;
    var closed = !!state.closed[id];
    var btn = el('button', 'grp');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', String(!closed));
    add(btn, el('span', '', closed ? '▸' : '▾'), el('span', 'name', k), el('span', 'n', String(byKey[k].length)));
    btn.addEventListener('click', function () { state.closed[id] = !closed; renderOrders(); markSelected(); });
    ul.appendChild(add(el('li'), btn));
    if (!closed) byKey[k].forEach(function (o) { ul.appendChild(orderItem(o, mode)); });
  });
}
function markSelected() {
  var id = state.current;
  Array.prototype.forEach.call(document.querySelectorAll('.orders a'), function (a) { a.classList.toggle('sel', a.dataset.id === id); });
}

function bodyCard(title, url, open, focus) {
  var d = el('details', 'card' + (focus ? ' focus' : ''));
  var s = el('summary');
  if (typeof title === 'string') s.textContent = title; else s.appendChild(title);
  d.appendChild(s);
  var body = el('div', 'body');
  d.appendChild(body);
  var loaded = false;
  function load() {
    if (loaded) return;
    loaded = true;
    body.textContent = '불러오는 중…';
    getJson(url).then(function (b) {
      body.textContent = '';
      if (b.truncated) body.appendChild(el('p', 'muted small', '파일이 커서 앞 ' + Math.round(b.text.length / 1024) + 'KB만 보여요 (전체 ' + Math.round(b.size / 1024) + 'KB)'));
      var rendered = el('div');
      // 서버의 마크다운 렌더러가 이스케이프를 마친 HTML이다
      rendered.innerHTML = b.html;
      body.appendChild(rendered);
      var raw = el('details');
      add(raw, el('summary', 'muted small', '원문'), el('div', 'raw', b.text));
      body.appendChild(raw);
    }).catch(function (e) { body.textContent = '못 읽었어요: ' + e.message; });
  }
  d.addEventListener('toggle', function () { if (d.open) load(); });
  if (open) { d.open = true; load(); }
  return d;
}

var KIND = { file: '파일', dir: '디렉토리', url: '링크', outside: '허용 범위 밖', missing: '없는 파일', unsupported: '못 읽는 형식', reference: '참조' };

function showOrder(id, focus) {
  state.current = id;
  markSelected();
  getJson('/api/orders/' + encodeURIComponent(id)).then(function (d) {
    var o = d.order;
    var nodes = [];
    nodes.push(el('h1', '', o.title));
    var meta = el('div', 'meta');
    add(meta, el('span', '', o.id), badge(o.status), el('span', '', o.repo), el('span', '', '범위 ' + o.scope));
    if (o.issueKey) add(meta, el('span', '', o.issueKey));
    if (o.prRef) { var pu = prUrl(o.prRef); add(meta, pu ? link(pu, o.prRef) : el('span', '', o.prRef)); }
    add(meta, el('span', '', '생성 ' + stamp(o.createdAt)), el('span', '', '갱신 ' + stamp(o.updatedAt)));
    nodes.push(meta);
    var desc = null;
    if (o.description) {
      // 설명은 주문 지시문이라 길다. 보고 이력이 먼저 보이게 접어 두고 보고가 없을 때만 펼친다
      desc = el('details', 'card');
      if (!d.reports.length) desc.open = true;
      var ds = el('summary', '', '설명');
      var db = el('div', 'body md');
      db.innerHTML = o.descriptionHtml || '';
      add(desc, ds, db);
      nodes.push(desc);
    }

    var tl = el('section');
    tl.appendChild(el('h2', '', '보고 이력 (' + d.reports.length + ')'));
    var ul = el('ul', 'timeline');
    d.reports.forEach(function (r) {
      var li = el('li');
      li.id = 'report-' + r.index;
      if (focus && focus.type === 'report' && focus.n === r.index) li.className = 'focus';
      var head = el('div', 'small');
      add(head, el('strong', '', '#' + r.index + ' '), badge(r.status), document.createTextNode(' ' + stamp(r.at) + '  ' + r.workerId + (r.skill ? '  ' + r.skill : '')));
      if (r.prRef) { var u = prUrl(r.prRef); head.appendChild(document.createTextNode('  ')); head.appendChild(u ? link(u, r.prRef) : el('span', '', r.prRef)); }
      if (r.need) head.appendChild(el('span', 'muted', '  필요: ' + r.need.kind + ' ' + r.need.detail));
      var sm = el('div', 'md');
      sm.innerHTML = r.summaryHtml || '';
      add(li, head, sm);
      ul.appendChild(li);
    });
    tl.appendChild(ul);
    nodes.push(tl);

    if (d.gates.length) {
      var gs = add(el('section'), el('h2', '', '사람 확인 (' + d.gates.length + ')'));
      d.gates.forEach(function (g) {
        var p = el('div', 'small');
        add(p, el('strong', '', g.type + ' '), badge(g.status), document.createTextNode(' ' + (g.decision || '') + '  ' + stamp(g.openedAt)));
        add(gs, p, el('div', 'summary', g.reason + (g.answer ? '\\n답: ' + g.answer : '')));
      });
      nodes.push(gs);
    }
    if (d.bypasses.length) {
      var bs = add(el('section'), el('h2', '', 'bypass (' + d.bypasses.length + ')'));
      var bl = el('ul');
      d.bypasses.forEach(function (b) { bl.appendChild(el('li', 'small', stamp(b.at) + '  ' + b.need + (b.step ? '/' + b.step : '') + '  ' + b.action)); });
      nodes.push(add(bs, bl));
    }

    var rs = add(el('section'), el('h2', '', '참조 (' + d.refs.length + ')'));
    d.refs.forEach(function (r) {
      var isFocus = focus && focus.type === 'ref' && focus.n === r.index;
      var label = el('span');
      add(label, el('span', 'badge', KIND[r.kind] || r.kind), document.createTextNode(' [' + r.index + '] '), el('span', '', r.display), el('span', 'muted small', '  보고 #' + r.firstReport));
      var base = '/api/orders/' + encodeURIComponent(o.id) + '/refs/' + r.index;
      if (r.kind === 'file') {
        var c = bodyCard(label, base, isFocus && focus.entry === undefined, isFocus);
        c.id = 'ref-' + r.index;
        rs.appendChild(c);
      } else if (r.kind === 'dir') {
        var box = el('div', 'card' + (isFocus ? ' focus' : ''));
        box.id = 'ref-' + r.index;
        add(box, add(el('div', 'body'), label));
        (r.entries || []).forEach(function (e) {
          box.appendChild(bodyCard(e.name, base + '?entry=' + e.index, isFocus && focus.entry === e.index, false));
        });
        rs.appendChild(box);
      } else if (r.kind === 'url' && safeUrl(r.display)) {
        var p = el('div', 'card');
        add(p, add(el('div', 'body'), add(label, document.createTextNode(' '), link(r.display, '열기'))));
        rs.appendChild(p);
      } else {
        rs.appendChild(add(el('div', 'card'), add(el('div', 'body'), label)));
      }
    });
    nodes.push(rs);

    if (d.related.length) {
      var rel = add(el('section'), el('h2', '', '관련 파일 (' + d.related.length + ')'), el('p', 'muted small', '보고 refs에는 없지만 이름에 이 주문 id가 있는 저장소 파일'));
      d.related.forEach(function (f) {
        var c = bodyCard(f.rel, '/api/file?id=' + encodeURIComponent(f.key), focus && focus.type === 'file' && focus.key === f.key, focus && focus.key === f.key);
        c.id = 'file-' + f.key;
        rel.appendChild(c);
      });
      nodes.push(rel);
    }
    setMain(nodes);
    if (focus) {
      var target = focus.type === 'report' ? $('report-' + focus.n) : focus.type === 'ref' ? $('ref-' + focus.n) : $('file-' + focus.key);
      if (target) target.scrollIntoView({ block: 'center' });
    }
  }).catch(fail);
}

function showUnlinked(focusKey) {
  state.current = '';
  markSelected();
  getJson('/api/unlinked').then(function (d) {
    var nodes = [el('h1', '', '주문 없는 파일'), el('p', 'muted', '상태 저장소에 있지만 어느 주문 보고에도 안 걸리고 이름에 주문 id도 없는 파일 ' + d.files.length + '개')];
    d.files.forEach(function (f) {
      var label = el('span');
      add(label, el('span', '', f.rel), el('span', 'muted small', '  ' + stamp(f.mtime) + '  ' + Math.max(1, Math.round(f.size / 1024)) + 'KB'));
      var c = bodyCard(label, '/api/file?id=' + encodeURIComponent(f.key), f.key === focusKey, f.key === focusKey);
      c.id = 'file-' + f.key;
      nodes.push(c);
    });
    setMain(nodes);
    if (focusKey && $('file-' + focusKey)) $('file-' + focusKey).scrollIntoView({ block: 'center' });
  }).catch(fail);
}

function hitHref(h) {
  if (!h.orderId) return '#unlinked/' + encodeURIComponent(h.fileKey || '');
  var base = '#order/' + encodeURIComponent(h.orderId);
  if (h.source === 'summary') return base + '/report/' + h.reportIndex;
  if (h.source === 'ref') return base + '/ref/' + h.refIndex + (h.entryIndex !== undefined ? '/' + h.entryIndex : '');
  if (h.source === 'file') return base + '/file/' + encodeURIComponent(h.fileKey);
  return base;
}
var WHERE = { title: '제목', summary: '요약', ref: '참조', file: '파일' };
function showSearch(q) {
  state.current = '';
  markSelected();
  $('q').value = q;
  var f = filters();
  var params = { q: q, repo: f.repo, status: f.status, since: f.since, issue: f.issue, body: $('q-body').checked ? '' : '0' };
  setMain([el('p', 'muted', '찾는 중…')]);
  getJson('/api/search' + qs(params)).then(function (d) {
    var nodes = [el('h1', '', '"' + d.query + '" 검색'), el('p', 'muted', d.total + '건' + (d.total > d.hits.length ? ' 중 앞 ' + d.hits.length + '건' : ''))];
    var ul = el('ul', 'hits');
    d.hits.forEach(function (h) {
      var li = el('li');
      var a = el('a');
      a.href = hitHref(h);
      add(a, el('strong', '', h.title));
      var meta = el('div', 'muted small', (h.orderId ? h.orderId + '  ' + h.repo + '  ' : '주문 없음  ') + stamp(h.at) + '  ' + (WHERE[h.source] || h.source) + (h.reportIndex ? ' #' + h.reportIndex : '') + (h.source === 'ref' || h.source === 'file' ? '  ' + h.where + (h.line ? ':' + h.line : '') : ''));
      add(li, a, meta, highlight(el('div', 'ex'), h.excerpt, h.matchStart, h.matchLength));
      ul.appendChild(li);
    });
    nodes.push(ul);
    setMain(nodes);
  }).catch(fail);
}

function route() {
  var h = location.hash.replace(/^#/, '');
  var parts = h.split('/').map(function (p) { try { return decodeURIComponent(p); } catch (e) { return ''; } });
  if (parts[0] === 'order' && parts[1]) {
    var focus = null;
    if (parts[2] === 'report') focus = { type: 'report', n: Number(parts[3]) };
    else if (parts[2] === 'ref') focus = { type: 'ref', n: Number(parts[3]), entry: parts[4] !== undefined ? Number(parts[4]) : undefined };
    else if (parts[2] === 'file') focus = { type: 'file', key: parts[3] };
    return showOrder(parts[1], focus);
  }
  if (parts[0] === 'unlinked') return showUnlinked(parts[1]);
  if (parts[0] === 'search' && parts[1]) return showSearch(parts[1]);
}

$('q').addEventListener('keydown', function (e) {
  if (e.key !== 'Enter') return;
  var q = $('q').value.trim();
  if (!q) return;
  var next = '#search/' + encodeURIComponent(q);
  if (location.hash === next) showSearch(q); else location.hash = next;
});
['f-repo', 'f-status', 'f-since'].forEach(function (id) { $(id).addEventListener('change', loadOrders); });
try { var savedGroup = localStorage.getItem(GROUP_KEY); if (savedGroup !== null) $('f-group').value = savedGroup; } catch (e) {}
$('f-group').addEventListener('change', function () {
  try { localStorage.setItem(GROUP_KEY, $('f-group').value); } catch (e) {}
  renderOrders();
  markSelected();
});
var timer = null;
['f-issue', 'f-text'].forEach(function (id) {
  $(id).addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(loadOrders, 200); });
});
window.addEventListener('hashchange', route);
loadOrders().then(route);
`;
