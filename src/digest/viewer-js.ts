import { createHash } from 'node:crypto';
import { VIEWER_LOGIC_JS } from './viewer-logic.js';

/** 테마 저장 키. VIEWER_JS의 setupTheme과 THEME_BOOT_JS가 같이 쓴다 */
export const THEME_STORAGE_KEY = 'gestalt-digest-theme';

// 템플릿 리터럴 안이라 백틱과 달러 중괄호를 쓰지 않는다. 바깥 값은 문자열 연결로 끼운다
export const VIEWER_JS =
  VIEWER_LOGIC_JS +
  "var THEME_STORAGE_KEY = '" +
  THEME_STORAGE_KEY +
  "';" +
  `
(function(){
  var dataEl = document.getElementById('digest-data');
  if (!dataEl) return;
  var data = JSON.parse(dataEl.textContent);
  var starts = data.starts;
  var root = document.documentElement;
  var isFile = location.protocol === 'file:';
  // serve가 내줄 때만 페이지에 끼우는 토큰. 있으면 없는 리포트를 serve를 띄운 세션에 바로 요청하고, 없거나 요청이 실패하면 명령 복사로 돌아간다
  var tokenMeta = document.querySelector('meta[name="gestalt-serve-token"]');
  var serveToken = !isFile && tokenMeta ? tokenMeta.getAttribute('content') : null;
  var SENT_MSG = '세션에 요청을 넣었어요. 다 만들어지면 새로고침하지 않아도 이 화면에 바로 들어와요.';
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var holder = document.getElementById('player');
  var slot = document.getElementById('player-slot');
  var lines = document.querySelectorAll('#script-list > li');
  var manualUntil = 0;

  function fmt(sec) {
    var s = Math.max(0, Math.floor(sec));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    var mm = (m < 10 ? '0' : '') + m, rr = (r < 10 ? '0' : '') + r;
    return h > 0 || data.long ? h + ':' + mm + ':' + rr : mm + ':' + rr;
  }
  function timeLink(sec) {
    var a = document.createElement(data.watchBase ? 'a' : 'span');
    a.className = 'ts';
    a.textContent = fmt(sec);
    a.setAttribute('data-sec', String(sec));
    if (data.watchBase) {
      a.href = data.watchBase + '&t=' + Math.floor(sec) + 's';
      a.target = '_blank';
      a.rel = 'noopener';
    }
    return a;
  }

  function setupFontScale() {
    var FONT_KEY = 'gestalt-digest-font';
    var range = document.getElementById('font-range');
    var fontOut = document.getElementById('font-value');
    function setScale(v) {
      v = Math.min(145, Math.max(85, Number(v) || 100));
      root.style.setProperty('--scale', String(v / 100));
      if (range) range.value = String(v);
      if (fontOut) fontOut.textContent = v + '%';
      try { localStorage.setItem(FONT_KEY, String(v)); } catch (e) {}
    }
    var saved = 100;
    try { saved = Number(localStorage.getItem(FONT_KEY)) || 100; } catch (e) {}
    setScale(saved);
    if (range) range.addEventListener('input', function(){ setScale(range.value); });
  }

  // 테마 전환. 자동이면 data-theme을 지워 OS 설정을 따르고 라이트와 다크는 고른 값을 기억한다.
  // 첫 화면이 깜빡이지 않게 head의 짧은 스크립트가 저장된 값을 먼저 붙인다
  function setupTheme() {
    var THEME_KEY = THEME_STORAGE_KEY;
    var btns = document.querySelectorAll('[data-theme-set]');
    function setTheme(t) {
      if (t !== 'light' && t !== 'dark') t = 'auto';
      if (t === 'auto') root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', t);
      btns.forEach(function(b){ b.setAttribute('aria-pressed', b.getAttribute('data-theme-set') === t ? 'true' : 'false'); });
      try { if (t === 'auto') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, t); } catch (e) {}
    }
    var saved = 'auto';
    try { saved = localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) {}
    setTheme(saved);
    btns.forEach(function(b){ b.addEventListener('click', function(){ setTheme(b.getAttribute('data-theme-set')); }); });
  }

  // 플레이어 어댑터. 유튜브와 로컬 영상이 같은 꼴을 내서 따라가기 코드는 둘을 가리지 않는다
  function createPlayer() {
    var player = { live: false, seek: function(){}, cue: function(){}, currentTime: function(){ return null; }, state: function(){ return -1; } };
    if (isFile || !holder) return player;
    if (data.localVideo) return createVideoPlayer(player);
    if (!data.videoId) return player;
    // live는 처음부터 켜 둬야 소섹션 따라가기와 미니 플레이어가 설치된다. 화면은 준비될 때까지 썸네일을 보인다
    player.live = true;
    var ready = false, failed = false, yt = null, pending = null, pendingCue = null;
    function fail() {
      if (failed) return;
      failed = true;
      ready = false;
      player.live = false;
      holder.classList.remove('is-live', 'is-floating');
      if (slot) slot.classList.remove('is-floating');
    }
    player.seek = function(sec){
      if (!ready) { pending = sec; return; }
      yt.seekTo(sec, true);
      if (yt.playVideo) yt.playVideo();
    };
    // 스크롤로 옮길 때는 재생 상태를 바꾸지 않는다. 시작 전이나 끝난 뒤에 seekTo를 부르면 재생이 시작돼서 위치만 잡는다
    player.cue = function(sec){
      if (!ready) { pendingCue = sec; return; }
      var state = yt.getPlayerState ? yt.getPlayerState() : -1;
      if (cueAction(state) === 'seek') yt.seekTo(sec, true);
      else yt.cueVideoById({ videoId: data.videoId, startSeconds: sec });
    };
    player.currentTime = function(){ return ready && yt.getCurrentTime ? yt.getCurrentTime() : null; };
    player.state = function(){ return ready && yt.getPlayerState ? yt.getPlayerState() : -1; };
    window.onYouTubeIframeAPIReady = function(){
      if (failed) return;
      yt = new YT.Player('player-frame', {
        videoId: data.videoId,
        playerVars: { playsinline: 1, rel: 0, origin: location.origin },
        events: {
          onReady: function(){
            if (failed) return;
            ready = true;
            holder.classList.add('is-live');
            if (pending !== null) player.seek(pending);
            else if (pendingCue !== null) player.cue(pendingCue);
            pending = null;
            pendingCue = null;
          },
          // 101, 150, 153은 임베드가 막힌 영상이라 썸네일과 새 탭 링크로 돌아간다
          onError: function(ev){ if (ev && (ev.data === 101 || ev.data === 150 || ev.data === 153)) fail(); }
        }
      });
    };
    var api = document.createElement('script');
    api.src = 'https://www.youtube.com/iframe_api';
    api.onerror = fail;
    document.head.appendChild(api);
    // 광고 차단기나 오프라인이면 onerror 없이 멈추기도 해서 시간으로도 끊는다
    setTimeout(function(){ if (!ready) fail(); }, 10000);
    return player;
  }

  // 서버가 transcript.json에 적힌 원본 파일 하나만 같은 출처로 내준다. file://로 열면 브라우저가 로컬 파일 재생을 막아 안내문을 둔다
  function createVideoPlayer(player) {
    var video = document.getElementById('player-video');
    if (!video) return player;
    player.live = true;
    holder.classList.add('is-live');
    var ready = false, failed = false, pending = null, pendingCue = null;
    function fail() {
      if (failed) return;
      failed = true;
      ready = false;
      player.live = false;
      holder.classList.remove('is-live', 'is-floating');
      if (slot) slot.classList.remove('is-floating');
    }
    player.seek = function(sec){
      if (!ready) { pending = sec; return; }
      video.currentTime = sec;
      var p = video.play();
      if (p && p.catch) p.catch(function(){});
    };
    player.cue = function(sec){
      if (!ready) { pendingCue = sec; return; }
      video.currentTime = sec;
    };
    player.currentTime = function(){ return ready ? video.currentTime : null; };
    player.state = function(){ return ready ? videoState(video.ended, video.paused, video.currentTime, video.readyState) : -1; };
    video.addEventListener('loadedmetadata', function(){
      if (failed) return;
      ready = true;
      if (pending !== null) player.seek(pending);
      else if (pendingCue !== null) player.cue(pendingCue);
      pending = null;
      pendingCue = null;
    });
    video.addEventListener('error', fail);
    video.src = 'video';
    return player;
  }

  // 현재 구간만 보기는 기본이 꺼짐이라 켠 상태만 기억한다. 풀 때는 재생 중인 줄로 되돌아가 스크롤 위치를 잃지 않게 한다
  function setupScriptFold() {
    var btn = document.getElementById('script-fold');
    var box = document.querySelector('.script');
    var panel = document.getElementById('script-body');
    if (!btn || !box || !panel) return;
    var FOLD_KEY = 'gestalt-digest-script-fold';
    var on = false;
    try { on = localStorage.getItem(FOLD_KEY) === 'on'; } catch (e) {}
    function set(v) {
      on = v;
      box.classList.toggle('is-focus', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on) { panel.scrollTop = 0; return; }
      var cur = panel.querySelector('li.is-playing');
      if (cur) panel.scrollTop = Math.max(0, cur.offsetTop - panel.clientHeight / 3);
    }
    set(on);
    btn.hidden = false;
    btn.addEventListener('click', function(){
      set(!on);
      try { localStorage.setItem(FOLD_KEY, on ? 'on' : 'off'); } catch (e) {}
    });
  }

  // 스크립트 번역은 기본으로 보이고 끈 상태만 기억한다
  function setupTranslation() {
    var btn = document.getElementById('tr-toggle');
    var box = document.querySelector('.script');
    if (!btn || !box) return;
    var TR_KEY = 'gestalt-digest-tr';
    var on = true;
    try { on = localStorage.getItem(TR_KEY) !== 'off'; } catch (e) {}
    function set(v) {
      on = v;
      box.classList.toggle('hide-tr', !on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    set(on);
    btn.hidden = false;
    btn.addEventListener('click', function(){
      set(!on);
      try { localStorage.setItem(TR_KEY, on ? 'on' : 'off'); } catch (e) {}
    });
  }

  // 파일로 열었거나 플레이어가 못 떴으면 링크 그대로 유튜브 새 탭이 열린다
  function setupTimeLinks(player) {
    document.addEventListener('click', function(ev){
      var el = ev.target.closest ? ev.target.closest('[data-sec]') : null;
      if (!el) return;
      if (!player.live) {
        // 도식 노드는 a가 아니라 href가 없다. 시각 링크와 같게 새 탭으로 연다
        if (el.tagName.toLowerCase() === 'a' || !data.watchBase) return;
        ev.preventDefault();
        window.open(data.watchBase + '&t=' + Math.floor(Number(el.getAttribute('data-sec'))) + 's', '_blank', 'noopener');
        return;
      }
      ev.preventDefault();
      manualUntil = Date.now() + 5000;
      player.seek(Number(el.getAttribute('data-sec')));
    });
  }

  // 글 자료의 원문 창. 문단 칩을 누르면 PDF는 그 쪽으로 가서 문단 자리를 칠하고 웹 글은 그 문단으로 스크롤한다
  function setupDocPane() {
    var api = { reveal: function(){}, closeSheet: function(){ return false; } };
    if (!data.doc) return api;
    var pagesBox = document.getElementById('doc-pages');
    var textBox = document.getElementById('script-body');
    var viewBtns = document.querySelectorAll('[data-view]');
    var view = 'text';
    function setView(v) {
      if (!pagesBox) v = 'text';
      view = v;
      if (pagesBox) pagesBox.hidden = v !== 'pages';
      if (textBox) textBox.hidden = v !== 'text';
      viewBtns.forEach(function(b){ b.setAttribute('aria-pressed', b.getAttribute('data-view') === v ? 'true' : 'false'); });
      return v;
    }
    viewBtns.forEach(function(b){ b.addEventListener('click', function(){ setView(b.getAttribute('data-view')); }); });
    setView(pagesBox ? 'pages' : 'text');
    function clearMarks() {
      document.querySelectorAll('.doc-hl').forEach(function(n){ n.remove(); });
      document.querySelectorAll('#script-list li.is-cited').forEach(function(n){ n.classList.remove('is-cited'); });
    }
    function pageEl(n) { return pagesBox ? pagesBox.querySelector('.doc-page[data-page="' + n + '"]') : null; }
    function scrollWithin(box, top) {
      box.scrollTo({ top: Math.max(0, top), behavior: reduceMotion ? 'auto' : 'smooth' });
    }
    api.reveal = function(from, to, key) {
      clearMarks();
      for (var i = from; i <= to; i++) { if (lines[i]) lines[i].classList.add('is-cited'); }
      var rects = data.units && data.pages ? data.units : null;
      if (view === 'pages' && rects && pagesBox) {
        var first = null;
        for (var u = from; u <= to; u++) {
          (rects[u] || []).forEach(function(r){
            var el = pageEl(r[0]);
            var pg = null;
            data.pages.forEach(function(p){ if (p.n === r[0]) pg = p; });
            if (!el || !pg) return;
            var box = document.createElement('span');
            box.className = 'doc-hl' + (u === key ? ' is-key' : '');
            box.style.left = (r[1] / pg.w * 100) + '%';
            box.style.top = (r[2] / pg.h * 100) + '%';
            box.style.width = ((r[3] - r[1]) / pg.w * 100) + '%';
            box.style.height = ((r[4] - r[2]) / pg.h * 100) + '%';
            el.appendChild(box);
            if (u === key && !first) first = { el: el, y: r[2] / pg.h };
          });
        }
        if (!first) {
          var any = pagesBox.querySelector('.doc-hl');
          if (any) first = { el: any.parentNode, y: parseFloat(any.style.top) / 100 };
        }
        if (first) scrollWithin(pagesBox, first.el.offsetTop + first.y * first.el.clientHeight - pagesBox.clientHeight / 4);
        return;
      }
      var li = lines[key];
      if (li && textBox) {
        if (textBox.hidden) setView('text');
        scrollWithin(textBox, li.offsetTop - textBox.clientHeight / 4);
      }
    };
    // 좁은 화면에서는 원문 창이 시트로 접혀 있다. 문단 칩을 누르면 시트를 연 뒤 자리를 찾는다
    // 900px은 render-lens.ts LENS_CSS의 시트 미디어 쿼리와 짝이다
    var narrow = window.matchMedia ? window.matchMedia('(max-width: 900px)') : null;
    var openBtn = document.getElementById('doc-open');
    var side = document.getElementById('side');
    var lastFocus = null;
    function isSheetOpen() { return document.body.classList.contains('doc-sheet-open'); }
    // 열 때는 닫기 버튼으로 포커스를 옮기고, 닫기 버튼과 Esc로 닫을 때만 연 자리로 되돌린다.
    // 화면이 넓어져 닫힐 때는 사용자가 보던 자리를 건드리지 않는다
    function setSheet(open, restore) {
      var wasOpen = isSheetOpen();
      if (open && !wasOpen) lastFocus = document.activeElement;
      document.body.classList.toggle('doc-sheet-open', open);
      if (openBtn) openBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open && !wasOpen) {
        var closeBtn = side ? side.querySelector('.doc-close') : null;
        if (closeBtn) closeBtn.focus();
      } else if (!open && wasOpen && restore) {
        var back = lastFocus && lastFocus.isConnected && lastFocus.getClientRects().length > 0 ? lastFocus : openBtn;
        if (back) back.focus();
        lastFocus = null;
      }
    }
    function markDialog() {
      if (!side) return;
      if (narrow && narrow.matches) { side.setAttribute('role', 'dialog'); side.setAttribute('aria-label', '원문'); }
      else { side.removeAttribute('role'); side.removeAttribute('aria-label'); }
    }
    markDialog();
    if (narrow && narrow.addEventListener) narrow.addEventListener('change', function(){
      markDialog();
      if (!narrow.matches) setSheet(false, false);
    });
    if (openBtn) openBtn.addEventListener('click', function(){ setSheet(true); });
    document.querySelectorAll('.doc-close').forEach(function(b){ b.addEventListener('click', function(){ setSheet(false, true); }); });
    api.closeSheet = function() {
      if (!isSheetOpen()) return false;
      setSheet(false, true);
      return true;
    };
    document.addEventListener('click', function(ev){
      var el = ev.target.closest ? ev.target.closest('[data-unit]') : null;
      if (!el) return;
      ev.preventDefault();
      var i = Number(el.getAttribute('data-unit'));
      var inSheet = el.closest && el.closest('#side');
      if (narrow && narrow.matches && !inSheet) setSheet(true);
      api.reveal(i, i, i);
    });
    return api;
  }

  function unitChip(i) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'loc';
    b.setAttribute('data-unit', String(i));
    var li = lines[i];
    var chip = li ? li.querySelector('.loc') : null;
    b.textContent = chip ? chip.textContent : '¶' + (i + 1);
    return b;
  }

  function setupPopups(docPane) {
    var pop = document.createElement('div');
    pop.id = 'digest-pop';
    pop.className = 'pop';
    pop.hidden = true;
    pop.tabIndex = -1;
    pop.setAttribute('role', 'dialog');
    document.body.appendChild(pop);
    function mark(root){
      root.querySelectorAll('.cite, .kw').forEach(function(b){
        b.setAttribute('aria-expanded', 'false');
        b.setAttribute('aria-controls', 'digest-pop');
      });
    }
    mark(document);
    var popFor = null;
    function closePop(){
      if (popFor) popFor.setAttribute('aria-expanded', 'false');
      pop.hidden = true;
      popFor = null;
    }
    function place(anchor, label){
      if (popFor && popFor !== anchor) popFor.setAttribute('aria-expanded', 'false');
      pop.setAttribute('aria-label', label);
      pop.hidden = false;
      var r = anchor.getBoundingClientRect();
      var w = pop.offsetWidth;
      var left = Math.min(Math.max(8, r.left + window.scrollX), window.scrollX + document.documentElement.clientWidth - w - 8);
      pop.style.left = left + 'px';
      pop.style.top = (r.bottom + window.scrollY + 6) + 'px';
      popFor = anchor;
      anchor.setAttribute('aria-expanded', 'true');
      // 스크롤이 움직이면 소섹션 따라가기가 영상을 옮긴다
      pop.focus({ preventScroll: true });
    }
    // 번역 줄은 같은 li 안에 있어서 원문 span만 읽는다
    function lineText(i){ var li = lines[i]; var t = li && li.querySelector('.txt .src'); return t ? t.textContent : ''; }
    var MAX_LINES = 8;
    function openCite(btn){
      var key = Number(btn.getAttribute('data-key'));
      var from = Number(btn.getAttribute('data-from'));
      var to = Number(btn.getAttribute('data-to'));
      var win = citeWindow(from, to, MAX_LINES);
      pop.textContent = '';
      var head = document.createElement('div');
      head.className = 'pop-head';
      head.appendChild(data.doc ? unitChip(key) : timeLink(starts[key] || 0));
      var range = document.createElement('span');
      range.className = 'pop-range';
      var word = data.doc ? ' 문단 ' : ' 문장 ';
      range.textContent = from === to ? word + (from + 1) : word + (from + 1) + '-' + (to + 1);
      head.appendChild(range);
      pop.appendChild(head);
      var ol = document.createElement('ol');
      ol.className = 'pop-lines';
      for (var i = from; i <= win.end; i++) {
        var li = document.createElement('li');
        if (i === key) li.className = 'is-key';
        li.textContent = lineText(i);
        ol.appendChild(li);
      }
      pop.appendChild(ol);
      if (win.more > 0) {
        var more = document.createElement('div');
        more.className = 'pop-more';
        more.textContent = '외 ' + win.more + '문장';
        pop.appendChild(more);
      }
      place(btn, '출처 툴팁');
      // 글 자료는 출처를 열 때 원문 창도 그 자리로 옮긴다
      if (data.doc) docPane.reveal(from, to, key);
    }
    function openKeyword(btn){
      var box = btn.closest('.report');
      var rep = box ? data.reports[Number(box.getAttribute('data-ri'))] : null;
      var k = rep ? rep.keywords[btn.getAttribute('data-kw')] : null;
      if (!k) return;
      pop.textContent = '';
      var head = document.createElement('div');
      head.className = 'pop-head';
      var term = document.createElement('strong');
      term.textContent = k.term;
      head.appendChild(term);
      head.appendChild(document.createTextNode(' '));
      head.appendChild(timeLink(k.sec));
      pop.appendChild(head);
      var p = document.createElement('p');
      p.textContent = k.explanation;
      pop.appendChild(p);
      place(btn, '키워드 팝업');
    }
    document.addEventListener('click', function(ev){
      var t = ev.target;
      var cite = t.closest ? t.closest('.cite') : null;
      var kw = t.closest ? t.closest('.kw') : null;
      if (cite) { ev.preventDefault(); if (popFor === cite) closePop(); else openCite(cite); return; }
      if (kw) { ev.preventDefault(); if (popFor === kw) closePop(); else openKeyword(kw); return; }
      if (!pop.contains(t)) closePop();
    });
    // Tab으로 빠져나가면 닫는다. 트리거로 돌아가는 포커스는 클릭 토글이 처리한다
    pop.addEventListener('focusout', function(ev){
      var to = ev.relatedTarget;
      if (pop.hidden || !to || pop.contains(to) || to === popFor) return;
      closePop();
    });
    return {
      mark: mark,
      isOpen: function(){ return !pop.hidden; },
      closeAndReturn: function(){
        var back = popFor;
        closePop();
        if (back) back.focus();
      }
    };
  }

  // 일시정지 중에도 하이라이트는 옮긴다. 사용자가 패널을 직접 움직이면 3초 동안 스크롤을 멈춘다
  function setupScriptFollow(player) {
    if (!player.live) return;
    var panel = document.getElementById('script-body');
    var current = -1, holdUntil = 0;
    if (panel) {
      ['wheel', 'touchmove', 'keydown', 'pointerdown'].forEach(function(name){
        panel.addEventListener(name, function(){ holdUntil = Date.now() + 3000; }, { passive: true });
      });
    }
    setInterval(function(){
      if (!player.live || document.hidden) return;
      var t = player.currentTime();
      if (t === null || t === undefined) return;
      var idx = findSegmentIndex(starts, t);
      var changed = idx !== current;
      if (changed) {
        if (lines[current]) lines[current].classList.remove('is-playing');
        current = idx;
      }
      var li = lines[idx];
      if (!li) return;
      if (changed) li.classList.add('is-playing');
      if (!panel) return;
      var visible = isLineVisible(li.offsetTop, li.offsetHeight, panel.scrollTop, panel.clientHeight);
      if (!shouldScrollScript(player.state(), changed, Date.now(), holdUntil, visible)) return;
      var top = Math.max(0, li.offsetTop - panel.clientHeight / 3);
      if (Math.abs(top - panel.scrollTop) <= 1) return;
      panel.scrollTo({ top: top, behavior: reduceMotion ? 'auto' : 'smooth' });
    }, 250);
  }

  // 리포트를 바꿔 끼우면 목차와 미니맵 링크도 바뀌어서 표시할 때마다 다시 읽는다
  function setupSectionMarks() {
    if (!('IntersectionObserver' in window)) return { observe: function(){} };
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(en){
        if (!en.isIntersecting) return;
        var id = en.target.id;
        document.querySelectorAll('[data-nav]').forEach(function(m){
          var on = m.getAttribute('data-nav') === id;
          m.classList.toggle('is-current', on);
          if (on) m.setAttribute('aria-current', 'location');
          else m.removeAttribute('aria-current');
        });
      });
    }, { rootMargin: '-15% 0px -70% 0px' });
    function observe(root){ root.querySelectorAll('section.sec').forEach(function(s){ io.observe(s); }); }
    observe(document);
    return { observe: observe };
  }

  // 요약 문장과 도식은 카드가 35% 보일 때 한 번 차례로 띄운다. 시작 상태(.armed)를 스크립트가 붙이므로 스크립트가 없으면 처음부터 다 그려진 채로 보인다.
  // 차례와 시간은 CSS의 --i와 animation-delay로만 정한다. 타이머 없이 시간표만 있어야 나중에 영상으로 뽑을 때 그대로 옮길 수 있다
  // 카드가 화면보다 길면 보이는 비율이 35%에 못 미쳐서 화면 높이의 35%를 채운 것도 보인 것으로 친다
  function setupMotion() {
    if (reduceMotion || !('IntersectionObserver' in window)) return { observe: function(){} };
    var SHOWN = 0.35;
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(en){
        if (!en.isIntersecting) return;
        var tall = en.rootBounds && en.intersectionRect.height >= en.rootBounds.height * SHOWN;
        if (en.intersectionRatio < SHOWN && !tall) return;
        en.target.classList.add('play');
        io.unobserve(en.target);
      });
    }, { threshold: [0, 0.1, 0.2, 0.3, SHOWN] });
    function observe(root){
      var cards = Array.prototype.slice.call(root.querySelectorAll('.sec-card, figure.diagram'));
      if (root.matches && root.matches('.sec-card, figure.diagram')) cards.unshift(root);
      cards.forEach(function(c){
        // 요약 카드 안 도식은 카드가 문장 다음 차례로 함께 띄운다
        if (c.classList.contains('armed') || (c.matches('figure.diagram') && c.closest('.sec-card'))) return;
        c.classList.add('armed');
        io.observe(c);
      });
      root.querySelectorAll('[data-replay]').forEach(function(b){ b.hidden = false; });
    }
    observe(document);
    document.addEventListener('click', function(ev){
      var btn = ev.target.closest ? ev.target.closest('[data-replay]') : null;
      var card = btn ? btn.closest('.armed') : null;
      if (!card) return;
      card.classList.remove('play');
      // 클래스를 뗀 상태를 한 번 그려야 같은 애니메이션이 처음부터 다시 돈다
      void card.offsetWidth;
      card.classList.add('play');
    });
    return { observe: observe };
  }

  // 읽는 소섹션이 바뀌면 영상을 그 구간 첫 문장으로 옮긴다. 재생 중이면 요약을 스크롤해도 영상을 옮기지 않고 빠르게 훑을 때는 멈춘 자리만 따른다.
  // 방금 시각을 눌렀으면 유예가 끝난 뒤 영상이 멈춰 있을 때만 따라간다. 기다리는 사이 그 소섹션이 화면에서 빠지면 따라가지 않는다
  // 앞선 이동의 버퍼링이 덜 끝났으면 재생 중으로 읽히므로 300ms 뒤 두 번까지 다시 본다
  function setupSubsectionFollow(player) {
    if (!player.live || !('IntersectionObserver' in window)) return { observe: function(){} };
    var followTimer = null, heldTimer = null, pendingSub = null;
    var currentIdx = function(){
      var t = player.currentTime();
      return t === null || t === undefined ? -1 : findSegmentIndex(starts, t);
    };
    var follow = function(target, from, to, tries){
      if (!player.live || pendingSub !== target) return;
      if (shouldRetryFollow(player.state(), tries)) {
        followTimer = setTimeout(function(){ follow(target, from, to, tries - 1); }, 300);
        return;
      }
      if (!shouldFollowHeld(player.state(), currentIdx(), from, to, Date.now(), manualUntil)) return;
      if (typeof starts[from] === 'number') player.cue(starts[from]);
    };
    var subIo = new IntersectionObserver(function(entries){
      entries.forEach(function(en){
        if (!en.isIntersecting) {
          if (en.target === pendingSub) {
            clearTimeout(followTimer);
            clearTimeout(heldTimer);
            pendingSub = null;
          }
          return;
        }
        var from = Number(en.target.getAttribute('data-from'));
        var to = Number(en.target.getAttribute('data-to'));
        clearTimeout(followTimer);
        clearTimeout(heldTimer);
        var target = pendingSub = en.target;
        followTimer = setTimeout(function(){
          if (!player.live) return;
          var now = Date.now();
          // 시각을 누른 직후에 넘어온 소섹션은 버리지 않고 유예가 끝난 뒤 한 번만 다시 본다
          if (now < manualUntil) {
            heldTimer = setTimeout(function(){ follow(target, from, to, 2); }, manualUntil - now + 50);
            return;
          }
          follow(target, from, to, 2);
        }, 400);
      });
    }, { rootMargin: '-15% 0px -70% 0px' });
    function observe(root){ root.querySelectorAll('.sub[data-from]').forEach(function(s){ subIo.observe(s); }); }
    observe(document);
    return { observe: observe };
  }

  // 플레이어 자리가 화면 밖으로 나가면 미니 플레이어로 띄운다. iframe을 DOM에서 옮기면 영상이 처음부터 다시 로드돼서 자리는 두고 위치만 고정한다
  function setupMiniPlayer(player) {
    var dock = document.getElementById('player-dock');
    var api = { close: function(){ return false; } };
    if (!player.live || !slot || !('IntersectionObserver' in window)) return api;
    var closed = false;
    var setFloating = function(on){
      slot.classList.toggle('is-floating', on);
      holder.classList.toggle('is-floating', on);
    };
    new IntersectionObserver(function(entries){
      if (!player.live) return;
      var en = entries[entries.length - 1];
      if (en.isIntersecting) { closed = false; setFloating(false); }
      else if (!closed) setFloating(true);
    }).observe(slot);
    // 닫기 버튼이 사라지면 포커스가 body로 떨어져서 원래 자리로 옮긴다. 스크롤이 움직이면 다시 떠서 막는다
    api.close = function(){
      if (!holder.classList.contains('is-floating')) return false;
      closed = true;
      setFloating(false);
      if (!slot.hasAttribute('tabindex')) slot.setAttribute('tabindex', '-1');
      slot.focus({ preventScroll: true });
      return true;
    };
    if (dock) dock.addEventListener('click', function(){ api.close(); });
    return api;
  }

  function copyText(text, done, fail) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else fallback();
    function fallback(){
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) {}
      ta.remove();
      (ok ? done : fail)();
    }
  }
  // 넣은 요청은 새로고침해도 이어서 기다리게 sessionStorage에 둔다. 세션이 다시 렌더하면 serve가 주는 ETag가 바뀌어서
  // 그때 새 페이지를 받아 새로 생긴 탭과 리포트만 지금 화면에 끼운다. 처음 연 페이지의 ETag를 기준으로 삼으려고 serve로 열었으면 열자마자 한 번 받아 둔다
  var PENDING_KEY = 'gestalt-digest-pending:' + data.slug;
  var WATCH_MS = 3000;
  var WATCH_LIMIT_MS = 30 * 60 * 1000;
  // 다른 탭을 보는 동안은 드물게만 묻는다. 돌아오면 바로 한 번 묻는다
  var WATCH_HIDDEN_MS = 30000;
  function readPending(){
    var raw = null;
    try { raw = sessionStorage.getItem(PENDING_KEY); } catch (e) {}
    return readPendingList(raw, Date.now());
  }
  function writePending(list){
    try {
      if (list.length) sessionStorage.setItem(PENDING_KEY, JSON.stringify(list));
      else sessionStorage.removeItem(PENDING_KEY);
    } catch (e) {}
  }
  function addPending(entry){
    var key = JSON.stringify(entry.b);
    writePending(readPending().filter(function(p){ return JSON.stringify(p.b) !== key; }).concat([entry]));
  }
  function pageTag(){
    return fetch(location.pathname, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' })
      .then(function(res){ return res.ok ? res.headers.get('ETag') : null; }, function(){ return null; });
  }
  // 렌더가 파일을 쓰는 도중에 받으면 데이터가 잘려 있다. 그때는 null을 돌려주고 다음 차례에 다시 받는다
  function fetchPage(){
    return fetch(location.pathname, { cache: 'no-store', credentials: 'same-origin' }).then(function(res){
      if (!res.ok) return null;
      var tag = res.headers.get('ETag');
      return res.text().then(function(html){
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var el = doc.getElementById('digest-data');
        var next = null;
        try { next = el ? JSON.parse(el.textContent) : null; } catch (e) {}
        return next ? { doc: doc, data: next, tag: tag } : null;
      });
    }).then(null, function(){ return null; });
  }
  var baseTag = serveToken && window.fetch && window.DOMParser ? pageTag() : null;
  var watching = false;
  var watchTimer = null;
  var watchBusy = false;
  var watchNow = null;
  function watchPage(){
    if (watching || !baseTag) return;
    watching = true;
    baseTag.then(function(base){
      function schedule(ms){ watchTimer = setTimeout(tick, ms); }
      function tick(){
        watchTimer = null;
        var list = readPending();
        if (!list.length) { watching = false; return; }
        if (list.every(function(p){ return Date.now() - p.at > WATCH_LIMIT_MS; })) {
          watching = false;
          progress.timeout();
          return;
        }
        if (document.hidden) { schedule(WATCH_HIDDEN_MS); return; }
        watchBusy = true;
        pageTag().then(function(tag){
          if (!tag || !base || tag === base) {
            watchBusy = false;
            if (!base) base = tag;
            schedule(WATCH_MS);
            return;
          }
          fetchPage().then(function(page){
            watchBusy = false;
            if (!page) { schedule(WATCH_MS); return; }
            base = page.tag || tag;
            // 끼우다 멈추면 화면이 반쯤 바뀐 채라 다시 읽는다. 남은 요청은 resumePending이 이어 받는다
            try {
              if (!livePatch(page)) { location.reload(); return; }
              progress.settle();
            } catch (e) {
              location.reload();
              return;
            }
            schedule(WATCH_MS);
          });
        });
      }
      watchNow = function(){
        if (!watching || watchBusy || !watchTimer) return;
        clearTimeout(watchTimer);
        tick();
      };
      schedule(WATCH_MS);
    });
  }
  document.addEventListener('visibilitychange', function(){ if (!document.hidden && watchNow) watchNow(); });
  // 새로 그려진 페이지에서 만들어진 요청은 그 리포트나 탭을 열고 아직 안 된 요청은 만드는 중 표시를 다시 띄운다.
  // 30분이 지난 요청은 세션이 놓친 것으로 보고 버린다
  function resumePending(reports, tabs){
    var list = readPending().filter(function(p){ return Date.now() - p.at < WATCH_LIMIT_MS; });
    var left = [];
    var ready = null;
    list.forEach(function(p){ if (requestMade(p.b, data.reports, data.extensions)) ready = p.b; else left.push(p); });
    writePending(left);
    left.forEach(function(p){
      requestState[JSON.stringify(p.b)] = 'sent';
      progress.add(p, true);
    });
    if (ready && ready.action === 'template') {
      (data.extensions || []).forEach(function(x){
        if (requestMade(ready, [], [x])) tabs.open(x.panel);
      });
    } else if (ready) {
      tabs.open('panel-summary');
      reports.open(ready.difficulty, ready.lang);
    }
    if (left.length) watchPage();
  }
  // 같은 요청은 한 번만 보낸다. 이미 넣은 요청을 다시 누르면 넣었다는 안내만 다시 보여 주고, 응답을 기다리는 중이면 그 응답에 함께 건다
  var requestState = {};
  function requestToSession(body, title, done, fail) {
    if (!serveToken || !window.fetch) { fail(); return; }
    var key = JSON.stringify(body);
    var state = requestState[key];
    if (state === 'sent') { done(); return; }
    if (state) { state.push([done, fail]); return; }
    var waiting = [[done, fail]];
    requestState[key] = waiting;
    function settle(ok){
      if (ok) {
        requestState[key] = 'sent';
        var entry = { b: body, t: title, at: Date.now() };
        addPending(entry);
        progress.add(entry);
        watchPage();
      } else delete requestState[key];
      waiting.forEach(function(w){ w[ok ? 0 : 1](); });
    }
    fetch('/__request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Gestalt-Token': serveToken },
      body: key,
      credentials: 'same-origin',
      cache: 'no-store'
    }).then(function(res){
      return res.json().then(function(j){ return res.ok && j && j.ok === true; }, function(){ return false; });
    }).then(settle, function(){ settle(false); });
  }

  // 만드는 중인 요청을 화면에 띄운다. 템플릿은 탭 줄에 빈 탭을 세우고 리포트는 쉽게 보기 옆에 칩을 단다. 흐른 시간은 1초마다 고친다
  function setupProgress(tabs, reports) {
    var items = [];
    var timer = null;
    var status = document.createElement('p');
    status.className = 'sr-only';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    document.body.appendChild(status);
    function tick(){
      if (document.hidden && timer) return;
      var els = document.querySelectorAll('[data-pending-at]');
      els.forEach(function(el){ el.textContent = elapsedLabel(Date.now() - Number(el.getAttribute('data-pending-at'))); });
      if (!els.length && timer) { clearInterval(timer); timer = null; }
    }
    function startTimer(){
      tick();
      if (!timer) timer = setInterval(tick, 1000);
    }
    function dot(){
      var s = document.createElement('span');
      s.className = 'busy-dot';
      s.setAttribute('aria-hidden', 'true');
      return s;
    }
    // 매초 바뀌는 글자라 스크린리더에는 숨긴다. 시간 초과 안내로 바뀌면 다시 읽히게 푼다
    function elapsed(p){
      var s = document.createElement('span');
      s.setAttribute('aria-hidden', 'true');
      s.setAttribute('data-pending-at', String(p.at));
      return s;
    }
    function para(cls, text){
      var el = document.createElement('p');
      el.className = cls;
      if (text) el.textContent = text;
      return el;
    }
    function find(p){
      var key = JSON.stringify(p.b);
      var hit = null;
      items.forEach(function(it){ if (it.key === key) hit = it; });
      return hit;
    }
    function addTemplate(p){
      var list = document.querySelector('.tab-row .tabs');
      if (!list) return null;
      var id = 'pending-' + p.b.template;
      var title = p.t || String(p.b.template);
      var tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'is-pending';
      tab.id = 'tab-' + id;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('data-tab', id);
      tab.setAttribute('aria-controls', id);
      tab.setAttribute('aria-selected', 'false');
      tab.tabIndex = -1;
      tab.appendChild(dot());
      tab.appendChild(document.createTextNode(title));
      var panel = document.createElement('section');
      panel.className = 'ext ext-pending';
      panel.id = id;
      panel.hidden = true;
      panel.tabIndex = 0;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
      var h = document.createElement('h2');
      h.textContent = title;
      panel.appendChild(h);
      panel.appendChild(para('', '세션이 만드는 중이에요. 다 만들어지면 새로고침하지 않아도 이 자리에 바로 들어와요.'));
      var meta = para('pending-meta', '');
      meta.appendChild(dot());
      meta.appendChild(elapsed(p));
      panel.appendChild(meta);
      panel.appendChild(para('pending-hint', '세션 화면에 승인 창이 떠 있으면 거기서 먼저 확인해 주세요.'));
      list.appendChild(tab);
      placePanel(panel);
      return { tab: tab, panel: panel, meta: meta };
    }
    function addReport(p){
      var toggle = document.getElementById('easy-toggle');
      if (!toggle) return null;
      var chip = document.createElement('span');
      chip.className = 'busy-chip';
      chip.appendChild(dot());
      chip.appendChild(document.createTextNode((p.b.difficulty === 'easy' ? '쉬운' : '보통') + ' 리포트 만드는 중 · '));
      chip.appendChild(elapsed(p));
      toggle.parentNode.insertBefore(chip, toggle.nextSibling);
      return { chip: chip };
    }
    // 버튼으로 넣은 요청은 넣었다는 안내를 따로 띄워서 announce는 새로고침 뒤 이어 받을 때만 켠다
    function add(p, announce){
      if (find(p)) return;
      var ui = p.b.action === 'template' ? addTemplate(p) : addReport(p);
      if (!ui) return;
      ui.key = JSON.stringify(p.b);
      ui.p = p;
      items.push(ui);
      if (announce) {
        var what = p.b.action === 'template' ? (p.t || String(p.b.template)) : (p.b.difficulty === 'easy' ? '쉬운' : '보통') + ' 리포트';
        status.textContent = what + ' 만드는 중이에요.';
      }
      startTimer();
      return ui;
    }
    function drop(it){ items = items.filter(function(x){ return x !== it; }); }
    // 새로 들어온 확장에 맞는 빈 탭을 넘겨준다. livePatch가 그 자리에 진짜 탭을 끼운다
    function takeTab(x){
      var hit = null;
      items.forEach(function(it){ if (it.tab && requestMade(it.p.b, [], [x])) hit = it; });
      if (hit) drop(hit);
      return hit;
    }
    // 들어온 요청은 목록에서 뺀다. 리포트 칩은 누르면 그 리포트를 여는 버튼으로 바꾼다
    function settle(){
      var left = [];
      var done = [];
      readPending().forEach(function(p){
        if (requestMade(p.b, data.reports, data.extensions)) done.push(p);
        else left.push(p);
      });
      writePending(left);
      done.forEach(function(p){
        delete requestState[JSON.stringify(p.b)];
        var it = find(p);
        if (p.b.action === 'template') {
          if (it) { it.tab.remove(); it.panel.remove(); drop(it); }
          status.textContent = (p.t || '확장') + ' 탭이 다 만들어졌어요.';
          return;
        }
        var label = (p.b.difficulty === 'easy' ? '쉬운' : '보통') + ' 리포트';
        status.textContent = label + '가 다 만들어졌어요.';
        if (!it) return;
        drop(it);
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'busy-chip is-done';
        btn.textContent = label + ' 보기';
        btn.addEventListener('click', function(){
          btn.remove();
          tabs.open('panel-summary');
          reports.open(p.b.difficulty, p.b.lang);
        });
        it.chip.parentNode.replaceChild(btn, it.chip);
      });
      tick();
    }
    function timeout(){
      items.forEach(function(it){
        var box = it.meta || it.chip;
        box.querySelectorAll('.busy-dot').forEach(function(d){ d.classList.add('is-stopped'); });
        box.querySelectorAll('[data-pending-at]').forEach(function(el){
          el.removeAttribute('data-pending-at');
          el.removeAttribute('aria-hidden');
          el.textContent = '30분이 지나도 안 들어왔어요. 세션 화면을 확인해 주세요.';
        });
      });
      if (items.length) status.textContent = '요청한 리포트가 30분이 지나도 안 들어왔어요. 세션 화면을 확인해 주세요.';
      tick();
    }
    return { add: add, takeTab: takeTab, settle: settle, timeout: timeout };
  }
  // 확장 패널은 요약 패널과 앞선 확장 패널 뒤에 차례로 붙는다
  function placePanel(panel){
    var all = document.querySelectorAll('section.ext');
    var after = all.length ? all[all.length - 1] : document.getElementById('panel-summary');
    if (after) after.parentNode.insertBefore(panel, after.nextSibling);
  }
  function reportKeys(list){ return (list || []).map(function(r){ return r.key; }).join('|'); }
  // 새 렌더에서 지금 화면에 없는 확장 탭과 바뀐 리포트 묶음만 옮겨 온다. 보던 탭과 리포트, 스크롤은 그대로 둔다.
  // 화면 짜임이 달라 끼울 자리를 못 찾으면 false를 돌려주고 부른 쪽이 새로고침한다
  function livePatch(page){
    var next = page.data;
    var doc = page.doc;
    if (next.slug !== data.slug) return false;
    var list = document.querySelector('.tab-row .tabs');
    var fresh = [];
    var ok = true;
    (next.extensions || []).forEach(function(x){
      if (document.getElementById(x.panel)) return;
      var panel = doc.getElementById(x.panel);
      var tab = doc.getElementById('tab-' + x.panel);
      if (!panel || !tab || !list) ok = false;
      else fresh.push({ x: x, panel: panel, tab: tab });
    });
    var swapReports = reportKeys(next.reports) !== reportKeys(data.reports);
    var oldBoxes = document.querySelectorAll('.report[data-ri]');
    var newBoxes = doc.querySelectorAll('.report[data-ri]');
    var oldSelect = document.getElementById('report-select');
    var newSelect = doc.getElementById('report-select');
    if (swapReports && (!oldBoxes.length || !newBoxes.length || Boolean(oldSelect) !== Boolean(newSelect))) ok = false;
    if (!ok) return false;
    var keep = data.reports[reports.current()].key;
    data.reports = next.reports;
    data.extensions = next.extensions;
    if (swapReports) {
      swapAll(oldBoxes, newBoxes, null);
      swapAll(document.querySelectorAll('.minimap[data-ri]'), doc.querySelectorAll('.minimap[data-ri]'), dataEl);
      if (oldSelect && newSelect) {
        oldSelect.textContent = '';
        Array.prototype.forEach.call(newSelect.children, function(o){ oldSelect.appendChild(document.importNode(o, true)); });
      }
      reports.refresh(keep);
    }
    fresh.forEach(function(f){
      var panel = document.importNode(f.panel, true);
      var tab = document.importNode(f.tab, true);
      var slot = progress.takeTab(f.x);
      var wasOpen = slot && slot.tab.getAttribute('aria-selected') === 'true';
      var active = document.activeElement;
      var hadFocus = slot && (active === slot.tab || slot.panel.contains(active));
      panel.hidden = true;
      tab.setAttribute('aria-selected', 'false');
      tab.tabIndex = -1;
      tab.classList.add('is-new');
      if (slot) {
        list.replaceChild(tab, slot.tab);
        slot.panel.parentNode.replaceChild(panel, slot.panel);
      } else {
        list.appendChild(tab);
        placePanel(panel);
      }
      enhance(panel);
      // 만들어진 템플릿은 더 만들기 메뉴에서 뺀다
      var id = f.x.key.split('.')[0];
      document.querySelectorAll('#more-menu [data-template]').forEach(function(b){
        if (b.getAttribute('data-template') === id && b.parentNode) b.parentNode.remove();
      });
      if (wasOpen) tabs.open(f.x.panel);
      if (hadFocus) tab.focus();
      setTimeout(function(){ tab.classList.remove('is-new'); }, 6000);
    });
    return true;
  }
  // 옛 노드 자리에 새 노드를 차례로 끼우고 옛 노드를 지운다. 옛 노드가 없으면 fallback 앞에 붙인다
  function swapAll(olds, news, fallback){
    var at = olds.length ? olds[0] : fallback;
    if (!at) return;
    Array.prototype.forEach.call(news, function(n){
      var el = document.importNode(n, true);
      at.parentNode.insertBefore(el, at);
      enhance(el);
    });
    Array.prototype.forEach.call(olds, function(o){ o.remove(); });
  }
  // 새로 끼운 노드에 처음 로드 때 한 번만 걸던 처리를 다시 건다. 클릭과 키 입력은 document에 걸려 있어 따로 안 건다
  function enhance(root){
    popups.mark(root);
    sectionMarks.observe(root);
    subFollow.observe(root);
    motion.observe(root);
    zoom.wrap(root);
  }

  var flash = makeFlash(function(){ return document.getElementById('copy-status'); });
  function copyWith(btn, label, text) {
    copyText(text, function(){ flash(btn, label, false); }, function(){ flash(btn, label, true); });
  }

  function setupCopyButton(reports, tabs) {
    var copyBtn = document.getElementById('copy-md');
    if (!copyBtn) return;
    copyBtn.addEventListener('click', function(){
      var ext = tabs.markdown();
      copyWith(copyBtn, '마크다운 복사', ext !== null ? ext : data.reports[reports.current()].markdown);
    });
  }

  // 요약 탭과 확장 탭을 오간다. 리포트 바와 미니맵은 요약 탭 안이나 body 표시로 같이 숨는다.
  // 탭은 나중에 끼워 넣기도 해서 누를 때마다 탭 목록을 다시 읽는다
  function setupTabs() {
    var TAB_KEY = 'gestalt-digest-tab:' + data.slug;
    var SUMMARY = 'panel-summary';
    var list = document.querySelector('.tab-row .tabs');
    function all(){ return Array.prototype.slice.call(document.querySelectorAll('.tabs [role="tab"]')); }
    var current = SUMMARY;
    function select(id, focus){
      var tabs = all();
      if (!tabs.some(function(t){ return t.getAttribute('data-tab') === id; })) id = SUMMARY;
      current = id;
      tabs.forEach(function(t){
        var on = t.getAttribute('data-tab') === id;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.tabIndex = on ? 0 : -1;
        var panel = document.getElementById(t.getAttribute('aria-controls'));
        if (panel) panel.hidden = !on;
        if (on && focus) t.focus();
      });
      if (id === SUMMARY) document.body.removeAttribute('data-tab');
      else document.body.setAttribute('data-tab', 'ext');
      // 만드는 중인 빈 탭은 다음에 열 때 없을 수 있어서 기억하지 않는다
      if (id.indexOf('pending-') === 0) return;
      try { localStorage.setItem(TAB_KEY, id); } catch (e) {}
    }
    function tabOf(ev){ return ev.target.closest ? ev.target.closest('[role="tab"]') : null; }
    if (list) {
      list.addEventListener('click', function(ev){
        var t = tabOf(ev);
        if (t) select(t.getAttribute('data-tab'), false);
      });
      list.addEventListener('keydown', function(ev){
        var tabs = all();
        var i = tabs.indexOf(tabOf(ev));
        if (i < 0) return;
        var j = tabStep(i, tabs.length, ev.key);
        if (j < 0) return;
        ev.preventDefault();
        select(tabs[j].getAttribute('data-tab'), true);
      });
    }
    if (all().length) {
      // 공유된 앵커가 있으면 그 앵커가 든 탭을 연다. 저장해 둔 탭보다 먼저다
      var anchor = safeDecode(location.hash.slice(1));
      var target = anchor ? document.getElementById(anchor) : null;
      var owner = target && target.closest ? target.closest('.ext') : null;
      var saved = null;
      try { saved = localStorage.getItem(TAB_KEY); } catch (e) {}
      if (owner) select(owner.id, false);
      else if (!target && saved) select(saved, false);
    }
    return {
      open: function(id){ select(id, false); },
      markdown: function(){
        if (current === SUMMARY) return null;
        var hit = null;
        (data.extensions || []).forEach(function(x){ if (x.panel === current) hit = x.markdown; });
        return hit;
      }
    };
  }

  // 없는 템플릿은 뷰어가 만들지 않는다. serve로 열었으면 세션에 요청하고 만드는 중 탭을 연다. 아니면 세션에 붙여 넣을 명령만 복사해 준다
  function setupMore(reports, tabs) {
    var btn = document.getElementById('more-btn');
    var menu = document.getElementById('more-menu');
    var box = document.getElementById('more-cmd-box');
    var code = document.getElementById('more-cmd');
    var copy = document.getElementById('more-copy');
    var hint = document.getElementById('more-hint');
    var msg = document.getElementById('more-msg');
    var wrap = document.getElementById('more-cmd-wrap');
    if (!btn || !menu || !box || !code || !copy) return { close: function(){ return false; } };
    if (serveToken && hint) hint.textContent = '템플릿을 고르면 serve를 띄운 세션에 만들어 달라고 요청해요.';
    // 응답이 오기 전에 다른 템플릿을 고르면 앞 응답은 안내를 덮지 않는다
    var seq = 0;
    function showCmd(text, message){
      code.textContent = text;
      if (msg) msg.textContent = message;
      if (wrap) wrap.hidden = false;
      box.hidden = false;
    }
    function setOpen(open){
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    btn.addEventListener('click', function(){ setOpen(menu.hidden); });
    menu.querySelectorAll('[data-template]').forEach(function(b){
      b.addEventListener('click', function(){
        var id = b.getAttribute('data-template');
        var lang = data.reports[reports.current()].lang;
        var command = templateCommand(data.slug, id, lang, data.lens);
        var name = b.querySelector('b');
        var mine = ++seq;
        if (!serveToken) {
          showCmd(command, '');
          copyWith(copy, '명령 복사', command);
          return;
        }
        if (msg) msg.textContent = '세션에 요청하는 중이에요.';
        if (wrap) wrap.hidden = true;
        box.hidden = false;
        requestToSession(templateRequest(data.slug, id, lang), name ? name.textContent : id, function(){
          if (mine !== seq) return;
          // 이 상자는 곧 숨기니 안내는 늘 보이는 status에 쓴다. 메뉴 항목이 사라져 포커스는 만드는 중 탭으로 옮긴다
          if (msg) msg.textContent = '';
          var status = document.getElementById('copy-status');
          if (status) status.textContent = SENT_MSG;
          box.hidden = true;
          setOpen(false);
          tabs.open('pending-' + id);
          var pendingTab = document.getElementById('tab-pending-' + id);
          (pendingTab || btn).focus();
        }, function(){
          if (mine === seq) showCmd(command, '세션에 요청을 넣지 못했어요. 아래 명령을 세션에 붙여 넣어 주세요.');
        });
      });
    });
    copy.addEventListener('click', function(){ copyWith(copy, '명령 복사', code.textContent); });
    return {
      close: function(){
        if (menu.hidden) return false;
        setOpen(false);
        btn.focus();
        return true;
      }
    };
  }

  // 툴바는 쉽게 보기 토글 하나로 보통과 쉬운 리포트를 오간다. 없는 리포트는 서버가 만들지 않고 생성 명령만 보여 준다.
  // 리포트 묶음은 나중에 통째로 바꿔 끼우기도 해서 보여 줄 때마다 다시 읽는다
  function setupReports() {
    var REPORT_KEY = 'gestalt-digest-report:' + data.slug;
    var easyToggle = document.getElementById('easy-toggle');
    var select = document.getElementById('report-select');
    var missing = document.getElementById('report-missing');
    var missingMsg = document.getElementById('report-missing-msg');
    var cmdWrap = document.getElementById('report-cmd-wrap');
    var status = document.getElementById('report-status');
    var cmd = document.getElementById('report-cmd');
    var copyCmd = document.getElementById('copy-cmd');
    var initial = data.reports[data.initial] ? data.initial : 0;
    var current = initial;
    // 안내를 닫거나 다른 리포트로 옮긴 뒤 도착한 요청 응답은 안내를 다시 띄우지 않는다
    var noticeSeq = 0;
    function hideMissing(){
      noticeSeq++;
      if (missing) missing.hidden = true;
      if (status) status.textContent = '';
    }
    function showNotice(msg, command){
      if (missingMsg) missingMsg.textContent = msg;
      if (cmdWrap) cmdWrap.hidden = command === null;
      if (cmd) cmd.textContent = command || '';
      if (missing) missing.hidden = false;
      if (status) status.textContent = msg;
    }
    function show(ri){
      if (!data.reports[ri]) ri = initial;
      current = ri;
      document.querySelectorAll('.report[data-ri]').forEach(function(b){ b.hidden = Number(b.getAttribute('data-ri')) !== ri; });
      document.querySelectorAll('.minimap[data-ri]').forEach(function(m){ m.hidden = Number(m.getAttribute('data-ri')) !== ri; });
      var r = data.reports[ri];
      if (easyToggle) easyToggle.setAttribute('aria-pressed', r.difficulty === 'easy' ? 'true' : 'false');
      if (select) select.value = String(ri);
      hideMissing();
      try { localStorage.setItem(REPORT_KEY, r.key); } catch (e) {}
    }
    function choose(difficulty){
      var r = data.reports[current];
      var ri = r.pair;
      // 짝이 없는 옛 짧게, 기본 리포트는 길게로 간다. 스킬이 길게만 만들어서다. 구간이나 요청이 붙은 리포트는 다른 리포트로 넘기지 않는다
      if (ri < 0 && r.preset) ri = pickReport(data.reports, 'long', difficulty);
      if (ri >= 0) { show(ri); return; }
      var notice = missingNotice(r, data.slug, difficulty, data.lens);
      var mine = ++noticeSeq;
      if (notice.cmd === null || !serveToken) { showNotice(notice.msg, notice.cmd); return; }
      showNotice('세션에 만들어 달라고 요청하는 중이에요.', null);
      requestToSession(reportRequest(data.slug, difficulty, r.lang, r.range), '', function(){
        if (mine === noticeSeq) showNotice(SENT_MSG, null);
      }, function(){
        if (mine === noticeSeq) showNotice('세션에 요청을 넣지 못했어요. 아래 명령을 세션에 붙여 넣으면 만들어요.', notice.cmd);
      });
    }
    // 눌림 상태는 보이는 리포트만 따른다. 안내가 떠 있으면 다시 눌러 닫는다
    if (easyToggle) easyToggle.addEventListener('click', function(){
      if (missing && !missing.hidden) { hideMissing(); return; }
      choose(data.reports[current].difficulty === 'easy' ? 'normal' : 'easy');
    });
    if (select) select.addEventListener('change', function(){ show(Number(select.value)); });
    if (copyCmd && cmd) copyCmd.addEventListener('click', function(){
      copyWith(copyCmd, '명령 복사', cmd.textContent);
    });
    var saved = null;
    try { saved = localStorage.getItem(REPORT_KEY); } catch (e) {}
    var start = initial;
    data.reports.forEach(function(r, i){ if (r.key === saved) start = i; });
    // 공유된 앵커가 다른 리포트의 섹션을 가리키면 그 리포트를 연다
    var anchor = safeDecode(location.hash.slice(1));
    var target = anchor ? document.getElementById(anchor) : null;
    var owner = target && target.closest ? target.closest('.report[data-ri]') : null;
    if (owner) start = Number(owner.getAttribute('data-ri'));
    if (start !== initial) show(start);
    if (owner && target) target.scrollIntoView();
    return {
      current: function(){ return current; },
      open: function(difficulty, lang){
        data.reports.forEach(function(r, i){
          if (r.difficulty === difficulty && (!lang || r.lang === lang) && data.reports[current].difficulty !== difficulty) show(i);
        });
      },
      // 리포트 묶음을 바꿔 끼운 뒤 보던 리포트를 키로 다시 찾는다. 자리 번호는 새 렌더에서 밀릴 수 있다
      refresh: function(key){
        var ri = current;
        data.reports.forEach(function(r, i){ if (r.key === key) ri = i; });
        show(ri);
      }
    };
  }

  // 고른 답을 맞춰 보고 해설을 연다. 아무것도 안 골랐으면 정답과 해설만 연다
  function setupQuiz() {
    document.addEventListener('click', function(ev){
      var btn = ev.target.closest ? ev.target.closest('.quiz-check') : null;
      if (!btn) return;
      var q = btn.closest('.quiz-q');
      if (!q) return;
      var answer = Number(q.getAttribute('data-answer'));
      var inputs = q.querySelectorAll('input[type="radio"]');
      var picked = -1;
      Array.prototype.forEach.call(inputs, function(input, i){
        if (input.checked) picked = i;
      });
      // 정답과 고른 답을 색으로만 가르면 스크린리더가 못 읽는다. 다시 누르면 앞 표시를 지우고 새로 단다
      Array.prototype.forEach.call(inputs, function(input, i){
        var label = input.closest('label');
        if (!label) return;
        Array.prototype.forEach.call(label.querySelectorAll('.quiz-mark'), function(m){ m.remove(); });
        label.classList.toggle('is-answer', i === answer);
        label.classList.toggle('is-picked', i === picked && i !== answer);
        var mark = i === answer ? ' (정답)' : i === picked ? ' (고른 답)' : '';
        if (!mark) return;
        var sr = document.createElement('span');
        sr.className = 'sr-only quiz-mark';
        sr.textContent = mark;
        label.appendChild(sr);
      });
      q.classList.toggle('is-right', picked === answer);
      q.classList.toggle('is-wrong', picked >= 0 && picked !== answer);
      var result = q.querySelector('.quiz-result');
      if (result) result.textContent = picked < 0 ? '' : picked === answer ? '정답이에요' : '오답이에요';
      var exp = q.querySelector('.quiz-exp');
      if (exp) exp.hidden = false;
    });
  }

  // 장면 사진은 확대 창을 열 수 있을 때만 버튼으로 감싼다. 서버가 버튼을 그리면 스크립트가 없을 때 Tab에는 잡히는데 눌러도 반응이 없다
  function wrapShots(root) {
    if (typeof document.createElement('dialog').showModal !== 'function') return;
    var imgs = root.querySelectorAll('.shot > img');
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'shot-btn';
      btn.setAttribute('data-zoom', '');
      img.parentNode.insertBefore(btn, img);
      btn.appendChild(img);
      // 버튼 이름이 "<캡션> 크게 보기"로 읽히게 한다. 확대 창에는 img만 복제돼 alt가 캡션 그대로 남는다
      var label = document.createElement('span');
      label.className = 'sr-only';
      label.textContent = ' 크게 보기';
      btn.appendChild(label);
    }
  }

  // 그림과 장면을 화면 크기로 키워 본다. 노드를 눌러 영상으로 가면 창을 닫는다.
  // 그림이 든 탭이 나중에 들어올 수 있어 그림이 없어도 창은 만들어 둔다
  function setupZoom() {
    wrapShots(document);
    var dialog = document.createElement('dialog');
    dialog.id = 'zoom-dialog';
    dialog.setAttribute('aria-label', '그림 크게 보기');
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'zoom-btn zoom-close';
    close.textContent = '닫기';
    var body = document.createElement('div');
    body.className = 'zoom-body';
    dialog.appendChild(close);
    dialog.appendChild(body);
    document.body.appendChild(dialog);
    var opener = null;
    close.addEventListener('click', function(){ dialog.close(); });
    dialog.addEventListener('click', function(ev){
      if (ev.target === dialog) dialog.close();
      else if (ev.target.closest && ev.target.closest('[data-sec], [data-unit]')) dialog.close();
    });
    dialog.addEventListener('close', function(){
      body.textContent = '';
      if (opener) opener.focus();
    });
    document.addEventListener('click', function(ev){
      var btn = ev.target.closest ? ev.target.closest('[data-zoom]') : null;
      if (!btn || typeof dialog.showModal !== 'function') return;
      // 장면은 버튼 안 사진을, 도식은 그림을 옮겨 담는다
      var fig = btn.closest('.diagram');
      var src = btn.classList.contains('shot-btn') ? btn.querySelector('img') : fig ? fig.querySelector('svg') : null;
      if (!src) return;
      body.textContent = '';
      var copy = src.cloneNode(true);
      // 이미 화면에 뜬 사진의 복제본이라 지연 로딩이 필요 없다
      if (copy.removeAttribute) copy.removeAttribute('loading');
      body.appendChild(copy);
      opener = btn;
      dialog.showModal();
    });
    return { isOpen: function(){ return dialog.open; }, wrap: wrapShots };
  }

  // 인터랙티브 그림은 렌더러가 상태마다 그려 둔 것 가운데 하나만 보인다. 여기서 값을 계산하지 않는다
  function showWidgetState(box, key) {
    box.querySelectorAll('[data-w-state]').forEach(function(s){ s.hidden = s.getAttribute('data-w-state') !== key; });
  }
  document.addEventListener('click', function(ev){
    var b = ev.target.closest ? ev.target.closest('[data-w-toggle]') : null;
    if (!b) return;
    var box = b.closest('[data-widget]');
    if (!box) return;
    var key = b.getAttribute('data-w-toggle');
    box.querySelectorAll('[data-w-toggle]').forEach(function(x){ x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
    showWidgetState(box, key);
  });
  document.addEventListener('input', function(ev){
    var r = ev.target;
    if (!r || !r.hasAttribute || !r.hasAttribute('data-w-slider')) return;
    var box = r.closest('[data-widget]');
    if (!box) return;
    showWidgetState(box, String(Math.round(Number(r.value))));
    var labels = [];
    try { labels = JSON.parse(r.getAttribute('data-labels') || '[]'); } catch (e) {}
    if (labels[r.value]) r.setAttribute('aria-valuetext', labels[r.value]);
  });
  // 한계 단락의 맥락 카드 링크를 누르면 접힌 카드를 펼친다
  document.addEventListener('click', function(ev){
    var a = ev.target.closest ? ev.target.closest('a.card-ref') : null;
    if (!a) return;
    var target = document.getElementById(safeDecode(a.getAttribute('href').slice(1)));
    if (target && target.tagName.toLowerCase() === 'details') target.open = true;
  });
  setupFontScale();
  setupTheme();
  setupTranslation();
  setupScriptFold();
  // 요약 앵커로 스크롤하려면 요약 패널이 먼저 보여야 해서 탭을 리포트보다 먼저 연다
  var tabs = setupTabs();
  var reports = setupReports();
  var more = setupMore(reports, tabs);
  var progress = setupProgress(tabs, reports);
  var player = createPlayer();
  setupTimeLinks(player);
  var docPane = setupDocPane();
  var popups = setupPopups(docPane);
  setupScriptFollow(player);
  var sectionMarks = setupSectionMarks();
  var motion = setupMotion();
  var subFollow = setupSubsectionFollow(player);
  var mini = setupMiniPlayer(player);
  setupCopyButton(reports, tabs);
  setupQuiz();
  var zoom = setupZoom();
  // 빈 탭을 다시 세우고 끼울 때 쓰는 처리가 모두 준비된 뒤에 이어서 기다린다
  resumePending(reports, tabs);
  // 도식 노드는 Enter와 Space를 클릭으로 넘겨야 시각 이동이나 문단 열기와 확대 창 닫기가 같이 돈다
  document.addEventListener('keydown', function(ev){
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    var el = ev.target.closest ? ev.target.closest('g[data-sec], g[data-unit]') : null;
    if (!el) return;
    ev.preventDefault();
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  // 툴팁과 원문 시트, 메뉴, 미니 플레이어가 함께 열려 있으면 Escape 한 번에 하나씩 닫는다
  document.addEventListener('keydown', function(ev){
    if (ev.key !== 'Escape' || zoom.isOpen()) return;
    if (popups.isOpen()) popups.closeAndReturn();
    else if (!docPane.closeSheet() && !more.close()) mini.close();
  });
})();
`;

/** CSP script-src에 싣는 VIEWER_JS 해시. 렌더가 이 문자열을 그대로 인라인으로 싣는다 */
export const VIEWER_JS_SHA256 = createHash('sha256').update(VIEWER_JS, 'utf8').digest('base64');

/** 첫 화면이 깜빡이지 않게 head에서 저장된 테마를 먼저 붙이는 스크립트. VIEWER_JS는 body 끝에서 돌아서 따로 둔다 */
export const THEME_BOOT_JS =
  "try{var t=localStorage.getItem('" +
  THEME_STORAGE_KEY +
  "');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}";

/** CSP script-src에 싣는 THEME_BOOT_JS 해시 */
export const THEME_BOOT_JS_SHA256 = createHash('sha256')
  .update(THEME_BOOT_JS, 'utf8')
  .digest('base64');
