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
    document.querySelectorAll('.cite, .kw').forEach(function(b){
      b.setAttribute('aria-expanded', 'false');
      b.setAttribute('aria-controls', 'digest-pop');
    });
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

  function setupSectionMarks() {
    var marks = document.querySelectorAll('[data-nav]');
    if (!('IntersectionObserver' in window) || !marks.length) return;
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(en){
        if (!en.isIntersecting) return;
        var id = en.target.id;
        marks.forEach(function(m){
          var on = m.getAttribute('data-nav') === id;
          m.classList.toggle('is-current', on);
          if (on) m.setAttribute('aria-current', 'location');
          else m.removeAttribute('aria-current');
        });
      });
    }, { rootMargin: '-15% 0px -70% 0px' });
    document.querySelectorAll('section.sec').forEach(function(s){ io.observe(s); });
  }

  // 읽는 소섹션이 바뀌면 영상을 그 구간 첫 문장으로 옮긴다. 재생 중이면 요약을 스크롤해도 영상을 옮기지 않고 빠르게 훑을 때는 멈춘 자리만 따른다.
  // 방금 시각을 눌렀으면 유예가 끝난 뒤 영상이 멈춰 있을 때만 따라간다. 기다리는 사이 그 소섹션이 화면에서 빠지면 따라가지 않는다
  // 앞선 이동의 버퍼링이 덜 끝났으면 재생 중으로 읽히므로 300ms 뒤 두 번까지 다시 본다
  function setupSubsectionFollow(player) {
    var subs = document.querySelectorAll('.sub[data-from]');
    if (!player.live || !('IntersectionObserver' in window) || !subs.length) return;
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
    subs.forEach(function(s){ subIo.observe(s); });
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

  // 요약 탭과 확장 탭을 오간다. 리포트 바와 미니맵은 요약 탭 안이나 body 표시로 같이 숨는다
  function setupTabs() {
    var TAB_KEY = 'gestalt-digest-tab:' + data.slug;
    var SUMMARY = 'panel-summary';
    var tabs = Array.prototype.slice.call(document.querySelectorAll('.tabs [role="tab"]'));
    var current = SUMMARY;
    function select(id, focus){
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
      try { localStorage.setItem(TAB_KEY, id); } catch (e) {}
    }
    tabs.forEach(function(t, i){
      t.addEventListener('click', function(){ select(t.getAttribute('data-tab'), false); });
      t.addEventListener('keydown', function(ev){
        var j = tabStep(i, tabs.length, ev.key);
        if (j < 0) return;
        ev.preventDefault();
        select(tabs[j].getAttribute('data-tab'), true);
      });
    });
    if (tabs.length) {
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
      markdown: function(){
        if (current === SUMMARY) return null;
        var hit = null;
        (data.extensions || []).forEach(function(x){ if (x.panel === current) hit = x.markdown; });
        return hit;
      }
    };
  }

  // 없는 템플릿은 뷰어가 만들지 않고 세션에 붙여 넣을 명령만 복사해 준다
  function setupMore(reports) {
    var btn = document.getElementById('more-btn');
    var menu = document.getElementById('more-menu');
    var box = document.getElementById('more-cmd-box');
    var code = document.getElementById('more-cmd');
    var copy = document.getElementById('more-copy');
    if (!btn || !menu || !box || !code || !copy) return { close: function(){ return false; } };
    function setOpen(open){
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    btn.addEventListener('click', function(){ setOpen(menu.hidden); });
    menu.querySelectorAll('[data-template]').forEach(function(b){
      b.addEventListener('click', function(){
        code.textContent = templateCommand(data.slug, b.getAttribute('data-template'), data.reports[reports.current()].lang);
        box.hidden = false;
        copyWith(copy, '명령 복사', code.textContent);
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

  // 툴바는 쉽게 보기 토글 하나로 보통과 쉬운 리포트를 오간다. 없는 리포트는 서버가 만들지 않고 생성 명령만 보여 준다
  function setupReports() {
    var REPORT_KEY = 'gestalt-digest-report:' + data.slug;
    var boxes = document.querySelectorAll('.report[data-ri]');
    var maps = document.querySelectorAll('.minimap[data-ri]');
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
    function hideMissing(){
      if (missing) missing.hidden = true;
      if (status) status.textContent = '';
    }
    function show(ri){
      if (!data.reports[ri]) ri = initial;
      current = ri;
      boxes.forEach(function(b){ b.hidden = Number(b.getAttribute('data-ri')) !== ri; });
      maps.forEach(function(m){ m.hidden = Number(m.getAttribute('data-ri')) !== ri; });
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
      var notice = missingNotice(r, data.slug, difficulty);
      if (missingMsg) missingMsg.textContent = notice.msg;
      if (cmdWrap) cmdWrap.hidden = notice.cmd === null;
      if (cmd) cmd.textContent = notice.cmd || '';
      if (missing) missing.hidden = false;
      if (status) status.textContent = notice.msg;
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
    return { current: function(){ return current; } };
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
  function wrapShots() {
    if (typeof document.createElement('dialog').showModal !== 'function') return;
    var imgs = document.querySelectorAll('.shot > img');
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

  // 그림과 장면을 화면 크기로 키워 본다. 노드를 눌러 영상으로 가면 창을 닫는다
  function setupZoom() {
    wrapShots();
    if (!document.querySelector('[data-zoom]')) return { isOpen: function(){ return false; } };
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
      else if (ev.target.closest && ev.target.closest('[data-sec]')) dialog.close();
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
    return { isOpen: function(){ return dialog.open; } };
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
  // 요약 앵커로 스크롤하려면 요약 패널이 먼저 보여야 해서 탭을 리포트보다 먼저 연다
  var tabs = setupTabs();
  var reports = setupReports();
  var more = setupMore(reports);
  var player = createPlayer();
  setupTimeLinks(player);
  var docPane = setupDocPane();
  var popups = setupPopups(docPane);
  setupScriptFollow(player);
  setupSectionMarks();
  setupSubsectionFollow(player);
  var mini = setupMiniPlayer(player);
  setupCopyButton(reports, tabs);
  setupQuiz();
  var zoom = setupZoom();
  // 도식 노드는 Enter와 Space를 클릭으로 넘겨야 시각 이동과 확대 창 닫기가 같이 돈다
  document.addEventListener('keydown', function(ev){
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    var el = ev.target.closest ? ev.target.closest('g[data-sec]') : null;
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
