import { createHash } from 'node:crypto';

/**
 * 브라우저에 싣는 코드라 문자열로 둔다. 판단만 하는 순수 함수는 VIEWER_LOGIC_JS에 모아
 * 테스트가 이 문자열을 그대로 실행해 본다. DOM과 유튜브 플레이어를 다루는 나머지 IIFE는
 * 테스트에서 문법만 확인하고 실제 동작은 브라우저에서만 돈다.
 */
const VIEWER_LOGIC_JS = `
function findSegmentIndex(starts, t) {
  if (!starts.length || !(t >= starts[0])) return -1;
  var lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    var mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}
function shouldFollow(idx, from, to, now, manualUntil) {
  if (now < manualUntil) return false;
  return !(idx >= from && idx <= to);
}
function shouldFollowHeld(state, idx, from, to, now, manualUntil) {
  if (state === 1 || state === 3) return false;
  return shouldFollow(idx, from, to, now, manualUntil);
}
function cueAction(state) {
  return state === 1 || state === 2 || state === 3 ? 'seek' : 'cue';
}
function citeWindow(from, to, max) {
  var end = Math.min(to, from + max - 1);
  return { end: end, more: Math.max(0, to - end) };
}
function pickReport(reports, length, difficulty) {
  for (var i = 0; i < reports.length; i++) {
    var r = reports[i];
    if (r.preset && r.length === length && r.difficulty === difficulty) return i;
  }
  return -1;
}
function reportCommand(slug, length, difficulty) {
  return '/gestalt:video-digest slug=' + slug + ' length=' + length + ' difficulty=' + difficulty;
}
`;

export interface ViewerLogic {
  /** 재생 시각 t에 해당하는 문장 번호. 첫 문장보다 이르면 -1 */
  findSegmentIndex: (starts: number[], t: number) => number;
  /** 읽는 소섹션이 바뀌었을 때 영상을 그 구간으로 옮길지 */
  shouldFollow: (
    idx: number,
    from: number,
    to: number,
    now: number,
    manualUntil: number,
  ) => boolean;
  /** 시각을 누른 직후라 미뤄 둔 소섹션 이동을 유예가 끝난 뒤 할지. 그사이 재생이나 버퍼링 중이면 사용자가 옮긴 자리를 둔다 */
  shouldFollowHeld: (
    state: number,
    idx: number,
    from: number,
    to: number,
    now: number,
    manualUntil: number,
  ) => boolean;
  /** 유튜브 재생 상태별로 seekTo를 쓸지 cueVideoById를 쓸지 */
  cueAction: (state: number) => 'seek' | 'cue';
  /** 출처 툴팁에 보일 마지막 문장 번호와 생략한 문장 수 */
  citeWindow: (from: number, to: number, max: number) => { end: number; more: number };
  /** 툴바의 분량과 난이도 조합에 맞는 리포트 자리. 없으면 -1 */
  pickReport: (
    reports: { preset: boolean; length: string; difficulty: string }[],
    length: string,
    difficulty: string,
  ) => number;
  /** 없는 조합을 고르면 복사해 주는 생성 명령 */
  reportCommand: (slug: string, length: string, difficulty: string) => string;
}

export const viewerLogic = new Function(
  `${VIEWER_LOGIC_JS}; return { findSegmentIndex: findSegmentIndex, shouldFollow: shouldFollow, shouldFollowHeld: shouldFollowHeld, cueAction: cueAction, citeWindow: citeWindow, pickReport: pickReport, reportCommand: reportCommand };`,
)() as ViewerLogic;

export const findSegmentIndex = viewerLogic.findSegmentIndex;

// 템플릿 리터럴 안이라 백틱과 달러 중괄호를 쓰지 않는다
export const VIEWER_JS =
  VIEWER_LOGIC_JS +
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

  // 플레이어 어댑터. 2차에 HTML5 video를 같은 꼴로 붙인다
  function createPlayer() {
    var player = { live: false, seek: function(){}, cue: function(){}, currentTime: function(){ return null; }, state: function(){ return -1; } };
    if (isFile || !data.videoId || !holder) return player;
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

  // 파일로 열었거나 플레이어가 못 떴으면 링크 그대로 유튜브 새 탭이 열린다
  function setupTimeLinks(player) {
    document.addEventListener('click', function(ev){
      var el = ev.target.closest ? ev.target.closest('[data-sec]') : null;
      if (!el || !player.live) return;
      ev.preventDefault();
      manualUntil = Date.now() + 5000;
      player.seek(Number(el.getAttribute('data-sec')));
    });
  }

  function setupPopups() {
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
    function lineText(i){ var li = lines[i]; var t = li && li.querySelector('.txt'); return t ? t.textContent : ''; }
    var MAX_LINES = 8;
    function openCite(btn){
      var key = Number(btn.getAttribute('data-key'));
      var from = Number(btn.getAttribute('data-from'));
      var to = Number(btn.getAttribute('data-to'));
      var win = citeWindow(from, to, MAX_LINES);
      pop.textContent = '';
      var head = document.createElement('div');
      head.className = 'pop-head';
      head.appendChild(timeLink(starts[key] || 0));
      var range = document.createElement('span');
      range.className = 'pop-range';
      range.textContent = from === to ? ' 문장 ' + (from + 1) : ' 문장 ' + (from + 1) + '-' + (to + 1);
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

  // 사용자가 패널을 직접 움직이면 3초 동안 멈춘다
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
      if (idx === current) return;
      if (lines[current]) lines[current].classList.remove('is-playing');
      current = idx;
      var li = lines[idx];
      if (!li) return;
      li.classList.add('is-playing');
      if (!panel || Date.now() < holdUntil) return;
      panel.scrollTo({ top: Math.max(0, li.offsetTop - panel.clientHeight / 3), behavior: reduceMotion ? 'auto' : 'smooth' });
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

  // 읽는 소섹션이 바뀌면 영상을 그 구간 첫 문장으로 옮긴다. 이미 그 구간을 재생 중이면 그대로 두고 빠르게 훑을 때는 멈춘 자리만 따른다.
  // 방금 시각을 눌렀으면 유예가 끝난 뒤 영상이 멈춰 있을 때만 따라간다. 기다리는 사이 그 소섹션이 화면에서 빠지면 따라가지 않는다
  function setupSubsectionFollow(player) {
    var subs = document.querySelectorAll('.sub[data-from]');
    if (!player.live || !('IntersectionObserver' in window) || !subs.length) return;
    var followTimer = null, heldTimer = null, pendingSub = null;
    var currentIdx = function(){
      var t = player.currentTime();
      return t === null || t === undefined ? -1 : findSegmentIndex(starts, t);
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
        pendingSub = en.target;
        followTimer = setTimeout(function(){
          if (!player.live) return;
          var now = Date.now();
          // 시각을 누른 직후에 넘어온 소섹션은 버리지 않고 유예가 끝난 뒤 한 번만 다시 본다
          if (now < manualUntil) {
            heldTimer = setTimeout(function(){
              if (!player.live) return;
              if (!shouldFollowHeld(player.state(), currentIdx(), from, to, Date.now(), manualUntil)) return;
              if (typeof starts[from] === 'number') player.cue(starts[from]);
            }, manualUntil - now + 50);
            return;
          }
          if (!shouldFollow(currentIdx(), from, to, now, manualUntil)) return;
          if (typeof starts[from] === 'number') player.cue(starts[from]);
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

  function copyText(text, done) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else fallback();
    function fallback(){
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) {}
      ta.remove();
    }
  }
  function flash(btn, label) {
    var before = btn.textContent;
    btn.textContent = '복사했어요';
    setTimeout(function(){ btn.textContent = label || before; }, 1500);
  }

  function setupCopyButton(reports) {
    var copyBtn = document.getElementById('copy-md');
    if (!copyBtn) return;
    copyBtn.addEventListener('click', function(){
      copyText(data.reports[reports.current()].markdown, function(){ flash(copyBtn, '마크다운 복사'); });
    });
  }

  // 툴바는 분량과 난이도 조합으로 리포트를 고른다. 없는 조합은 서버가 만들지 않고 생성 명령만 보여 준다
  function setupReports() {
    var REPORT_KEY = 'gestalt-digest-report:' + data.slug;
    var boxes = document.querySelectorAll('.report[data-ri]');
    var maps = document.querySelectorAll('.minimap[data-ri]');
    var lengthBtns = document.querySelectorAll('.report-bar [data-length]');
    var diffBtns = document.querySelectorAll('.report-bar [data-difficulty]');
    var select = document.getElementById('report-select');
    var missing = document.getElementById('report-missing');
    var cmd = document.getElementById('report-cmd');
    var copyCmd = document.getElementById('copy-cmd');
    var current = 0;
    function press(list, attr, value){
      list.forEach(function(b){ b.setAttribute('aria-pressed', b.getAttribute(attr) === value ? 'true' : 'false'); });
    }
    function show(ri){
      if (!data.reports[ri]) ri = 0;
      current = ri;
      boxes.forEach(function(b){ b.hidden = Number(b.getAttribute('data-ri')) !== ri; });
      maps.forEach(function(m){ m.hidden = Number(m.getAttribute('data-ri')) !== ri; });
      var r = data.reports[ri];
      press(lengthBtns, 'data-length', r.length);
      press(diffBtns, 'data-difficulty', r.difficulty);
      if (select) select.value = String(ri);
      if (missing) missing.hidden = true;
      try { localStorage.setItem(REPORT_KEY, r.key); } catch (e) {}
    }
    function choose(length, difficulty){
      var ri = pickReport(data.reports, length, difficulty);
      if (ri >= 0) { show(ri); return; }
      press(lengthBtns, 'data-length', length);
      press(diffBtns, 'data-difficulty', difficulty);
      if (cmd) cmd.textContent = reportCommand(data.slug, length, difficulty);
      if (missing) missing.hidden = false;
    }
    function pressedOf(list, attr){
      var v = null;
      list.forEach(function(b){ if (b.getAttribute('aria-pressed') === 'true') v = b.getAttribute(attr); });
      return v;
    }
    lengthBtns.forEach(function(b){
      b.addEventListener('click', function(){
        choose(b.getAttribute('data-length'), pressedOf(diffBtns, 'data-difficulty') || data.reports[current].difficulty);
      });
    });
    diffBtns.forEach(function(b){
      b.addEventListener('click', function(){
        choose(pressedOf(lengthBtns, 'data-length') || data.reports[current].length, b.getAttribute('data-difficulty'));
      });
    });
    if (select) select.addEventListener('change', function(){ show(Number(select.value)); });
    if (copyCmd && cmd) copyCmd.addEventListener('click', function(){
      copyText(cmd.textContent, function(){ flash(copyCmd, '명령 복사'); });
    });
    var saved = null;
    try { saved = localStorage.getItem(REPORT_KEY); } catch (e) {}
    var start = 0;
    data.reports.forEach(function(r, i){ if (r.key === saved) start = i; });
    // 공유된 앵커가 다른 리포트의 섹션을 가리키면 그 리포트를 연다
    var target = location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
    var owner = target && target.closest ? target.closest('.report[data-ri]') : null;
    if (owner) start = Number(owner.getAttribute('data-ri'));
    if (start !== 0) show(start);
    if (owner && target) target.scrollIntoView();
    return { current: function(){ return current; } };
  }

  setupFontScale();
  var reports = setupReports();
  var player = createPlayer();
  setupTimeLinks(player);
  var popups = setupPopups();
  setupScriptFollow(player);
  setupSectionMarks();
  setupSubsectionFollow(player);
  var mini = setupMiniPlayer(player);
  setupCopyButton(reports);
  // 툴팁과 미니 플레이어가 함께 열려 있으면 Escape 한 번에 하나씩 닫는다
  document.addEventListener('keydown', function(ev){
    if (ev.key !== 'Escape') return;
    if (popups.isOpen()) popups.closeAndReturn();
    else mini.close();
  });
})();
`;

/** CSP script-src에 싣는 VIEWER_JS 해시. 렌더가 이 문자열을 그대로 인라인으로 싣는다 */
export const VIEWER_JS_SHA256 = createHash('sha256').update(VIEWER_JS, 'utf8').digest('base64');
