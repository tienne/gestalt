import { BAND_LINE_X, BAND_LINE_Y, BAND_TITLE_HALF, BAND_TITLE_X } from './canvas-geometry.js';
import { FOCUS_SOURCE } from './focus.js';
import { PRODUCT_COLORS } from './html-theme.js';
import { FRAME_PAD, NODE_DESC_LINE, type LaneId } from './layout.js';

export interface ClientConstants {
  kindShort: Record<string, string>;
  /** 호스트 micro_app 칩 글자 */
  hostShort: string;
  kindText: Record<string, string>;
  /** 서랍의 종류 설명 문장. 노드 kind와 엣지 kind를 한 표에 담는다 */
  kindAbout: Record<string, string>;
  evidenceText: Record<string, string>;
  laneTitles: Record<LaneId, string>;
  laneAbout: Record<string, string>;
  /** 구간 레인(stage:<n>) 설명 */
  stageLaneAbout: string;
  inferredBadge: string;
  platformChip: Record<string, string>;
  platformName: Record<string, string>;
  webHostingChip: Record<string, string>;
  webHostingName: Record<string, string>;
  /** 평면 그림에서 오른쪽에서 왼쪽으로 그리는 엣지 kind */
  backwardKinds: string[];
  /** component를 쓸 수 있는 어휘면 true. 그때만 component 처리 코드를 싣는다 */
  components?: boolean;
  /** service 없는 흐름이 있으면 true. 전체 레벨의 흐름 단추가 그 흐름을 연다 */
  rootFlows?: boolean;
  /** 질문별 그림이 있으면 true. 메시지 서랍과 그림 단추 코드를 싣는다 */
  views?: boolean;
  /** 근거가 섞인 묶음 선이 있으면 true. 묶음 이름과 배지에 섞였다는 표시를 다는 코드를 싣는다 */
  mixedBundles?: boolean;
  /** 순서도가 있으면 true. 보기 전환과 따라가기 코드를 싣는다 */
  sequences?: boolean;
  /** 지식 문서 팩을 쓰면 true. 서랍에 문서 정보를 그리는 코드를 싣는다 */
  docs?: boolean;
}

// component는 칩 글자를 노드의 displayKind에서, 색과 아이콘은 renderClass에서 가져온다. types.ts의 displayKindOf, chipTextOverride와 같은 규칙이다.
// 이 조각은 component를 쓸 수 있는 어휘에만 싣는다. 늘 실으면 component가 없는 그림의 바이트까지 바뀐다
const COMPONENT_DKIND = "n.kind === 'component' ? 'cx_' + (n.renderClass || 'service') : ";
const COMPONENT_CHIP = "(n.kind === 'component' && n.displayKind) || ";
const ROOT_FLOWS = "current === 'root' ? flows.filter(function (f) { return !f.service; }) : []";

// 근거가 섞인 묶음 조각. 그런 묶음이 있는 그림에만 싣는다. 문구는 html-renderer.ts의 inferredNote와 같다
const MIXED_NOTE =
  " + (e.inferred !== undefined ? ' (문서 근거만 있는 연결 ' + e.inferred + '개 포함)' : '')";
const MIXED_PANEL_NOTE =
  " + (bundle.inferred !== undefined ? ' (문서 근거만 있는 연결 ' + bundle.inferred + '개 포함)' : '')";
const MIXED_PILL = `
        if (e.inferred !== undefined) pill.lastChild.setAttribute('stroke-dasharray', '3 2');`;

// 질문 안내 표가 문서로 보내는 말도 검색에 넣는다. 묶음 카드는 아래 레벨 문서의 이름과 말까지 품어서 전체보기에서 찾아도 들어갈 길이 켜진다
const DOC_HAY =
  " + (n.doc && n.doc.keywords ? ' ' + n.doc.keywords.join(' ') : '') + docLevelHay(enterMap[n.id])";

// 문서 정보 조각. 지식 문서 팩을 쓰는 그림에만 싣는다. 공유본은 본문 글자가 가려진 채로 온다
const DOC_FUNCS = `  var GAP_TEXT = { gap: '빈 곳', unverified: '확인 안 됨' };
  var VIA_TEXT = { 'code-ref': '코드 경로', 'api-path': 'API', 'screen-route': '화면 라우트', session: '세션' };
  function renderCover(list, body) {
    body.appendChild(el('h3', null, list.length ? '설명하는 문서 ' + list.length + '개' : '설명하는 문서 없음'));
    if (!list.length) return;
    var ul = el('ul', 'evidence doc-cover');
    list.forEach(function (x) {
      var li = el('li');
      li.appendChild(el('span', 'badge', VIA_TEXT[x.via] || x.via));
      var notes = [];
      if (!x.verified) notes.push('가리킨 파일 확인 못 함');
      if (x.gaps) notes.push('빈 곳 ' + x.gaps);
      if (x.unverified) notes.push('확인 안 됨 ' + x.unverified);
      if (x.broken) notes.push('깨진 링크 ' + x.broken);
      if (x.staleSince) notes.push('코드가 ' + x.staleSince + '에 바뀜');
      li.appendChild(el('span', 'loc', (x.title ? x.title + ' · ' : '') + x.path + (notes.length ? ' (' + notes.join(', ') + ')' : '')));
      ul.appendChild(li);
    });
    body.appendChild(ul);
  }
  function renderDoc(n, body) {
    var d = n.doc;
    if (!d) {
      if (data.docOverlay) renderCover(data.docOverlay[n.id] || [], body);
      return;
    }
    var facts = el('ul', 'facts');
    factRow(facts, '경로', d.path);
    if (d.updatedAt) factRow(facts, '최종 수정', d.updatedAt);
    if (d.committedAt) factRow(facts, '마지막 커밋', d.committedAt);
    if (d.reads !== undefined) factRow(facts, '읽힌 횟수', String(d.reads));
    if (d.orphan) factRow(facts, '질문 길', '진입 문서에서 안 닿음');
    if (d.aged) factRow(facts, '신선도', '반년 넘게 안 고침');
    if (d.keywords && d.keywords.length) factRow(facts, '찾는 말', d.keywords.join(', '));
    var sc = d.screen;
    if (sc) {
      if (sc.route) factRow(facts, '라우트', sc.route);
      if (sc.screenType) factRow(facts, '화면 종류', sc.screenType);
      if (sc.frame) factRow(facts, '피그마 프레임', sc.frame);
      if (sc.symbolized !== undefined) factRow(facts, '심볼화', sc.symbolized ? '됨' : '안 됨');
      if (sc.hasSpec !== undefined) factRow(facts, '화면 설계 문서', sc.hasSpec ? '있음' : '없음');
      if (sc.synonyms && sc.synonyms.length) factRow(facts, '동의어', sc.synonyms.join(', '));
    }
    if (n.owners && n.owners.length) factRow(facts, '담당', n.owners.join(', '));
    body.appendChild(facts);
    if (sc && sc.thumbnail) {
      var img = el('img', 'doc-thumb');
      img.src = sc.thumbnail;
      img.alt = nameOf(n) + ' 화면';
      body.appendChild(img);
    }
    var mix = d.evidenceMix ? Object.keys(d.evidenceMix).sort() : [];
    if (mix.length) {
      var total = mix.reduce(function (a, k) { return a + d.evidenceMix[k]; }, 0);
      body.appendChild(el('h3', null, '근거 구성 ' + total + '개'));
      var bar = el('div', 'doc-mix');
      var legend = el('ul', 'facts');
      mix.forEach(function (k, i) {
        var seg = el('span', 'mix-' + (i % 6));
        seg.style.width = (d.evidenceMix[k] / total * 100).toFixed(1) + '%';
        seg.title = k + ' ' + d.evidenceMix[k];
        bar.appendChild(seg);
        factRow(legend, k, String(d.evidenceMix[k]));
      });
      body.appendChild(bar);
      body.appendChild(legend);
    }
    var lk = d.links;
    if (lk && lk.total) {
      body.appendChild(el('h3', null, '근거 링크 ' + lk.total + '개'));
      var ll = el('ul', 'facts');
      if (lk.broken) factRow(ll, '깨짐', String(lk.broken));
      if (lk.branchOnly) factRow(ll, '브랜치만 가리킴', String(lk.branchOnly));
      if (lk.pinned) factRow(ll, '커밋 고정', String(lk.pinned));
      if (lk.unchecked) factRow(ll, '확인 못 함', String(lk.unchecked));
      body.appendChild(ll);
    }
    if (d.gaps && d.gaps.length) {
      body.appendChild(el('h3', null, '열린 구멍 ' + d.gaps.length + '개'));
      var gl = el('ul', 'evidence');
      d.gaps.forEach(function (g) {
        var li = el('li');
        li.appendChild(el('span', 'badge doc-' + g.kind, GAP_TEXT[g.kind] || g.kind));
        var who = [g.owner, g.line !== undefined ? g.line + '줄' : ''].filter(Boolean).join(', ');
        li.appendChild(el('span', 'loc', (g.text || '공유본이라 내용을 가렸어요') + (who ? ' (' + who + ')' : '')));
        gl.appendChild(li);
      });
      body.appendChild(gl);
    }
    if (d.routes && d.routes.length) {
      body.appendChild(el('h3', null, '질문 안내 ' + d.routes.length + '줄'));
      var rl = el('ul', 'refs-list doc-routes');
      d.routes.forEach(function (r) {
        var li = el('li');
        var text = r.keywords.join(', ') + ' → ' + (r.target && nodes[r.target] ? label(r.target) : r.targetPath);
        if (r.target && nodes[r.target]) {
          var b = el('button', null, text);
          b.type = 'button';
          b.addEventListener('click', function () { goToNode(r.target); });
          li.appendChild(b);
        } else {
          li.appendChild(el('span', 'loc', text + ' (그림에 없는 문서)'));
        }
        rl.appendChild(li);
      });
      body.appendChild(rl);
    }
    if (d.sections && d.sections.length) {
      body.appendChild(el('h3', null, '절 ' + d.sections.length + '개'));
      var sl = el('ul', 'facts');
      d.sections.forEach(function (t) { factRow(sl, '#', t); });
      body.appendChild(sl);
    }
  }
  var levelHay = {};
  function docLevelHay(id) {
    if (!id || id === current) return '';
    if (levelHay[id] !== undefined) return levelHay[id];
    levelHay[id] = '';
    var s = sectionOf(id);
    var out = '';
    if (s) s.querySelectorAll('.node').forEach(function (c) {
      var n = nodes[c.getAttribute('data-node-id')];
      if (n) out += ' ' + (n.displayName || '') + ' ' + n.label${DOC_HAY};
    });
    return (levelHay[id] = out);
  }
`;

// 질문별 그림 조각. 투영이 있는 그림에만 싣는다
const VIEW_CLICK = `var vm = e.target.closest('.link.seq-m');
    if (vm) { activateMessage(vm); return; }
    `;
const VIEW_KEY = `var vm = e.target.closest('.link.seq-m');
    if (vm) { e.preventDefault(); activateMessage(vm); return; }
    `;
// 순서도 보기 바가 화면 위를 덮으면 머리 카드는 그 바 아래에 붙인다
const STICK_FROM = '-view.y / view.k';
const SEQ_STICK_FROM = '(seqTop() - view.y) / view.k';
const viewFuncs = (sequences: boolean): string => `  var messages = data.messages || {};
  // 전체 레벨은 지도 위 카드 줄만큼 내려가 있다. 같은 이름으로 다시 선언해 그 거리를 더한 쪽이 쓰이게 한다
  function cardCenter(c) {
    var s = c.closest('.level');
    return { x: s.offsetLeft + c.offsetLeft + c.offsetWidth / 2, y: s.offsetTop + c.offsetTop + c.offsetHeight / 2 };
  }
  // 순서도를 아래로 내려도 머리 카드는 화면 위에 붙여 둔다. 확대와 이동이 viewport transform 하나라 CSS sticky가 안 먹어서 그 값이 바뀔 때마다 직접 내린다
  function stickHeads() {
    var bar = active && active.querySelector('.seq-sticky');
    if (!bar) return;
    var top = parseFloat(bar.style.top);
    var end = Number(active.getAttribute('data-h')) - top - bar.offsetHeight;
    var dy = Math.min(Math.max(0, ${sequences ? SEQ_STICK_FROM : STICK_FROM} - top), Math.max(0, end));
    var t = dy > 0 ? 'translateY(' + dy + 'px)' : '';
    bar.style.transform = t;
    bar.classList.toggle('stuck', dy > 0);
    active.querySelectorAll('.node').forEach(function (c) { c.style.transform = t; });
  }
  new MutationObserver(stickHeads).observe(viewport, { attributes: true, attributeFilter: ['style'] });
  function activateMessage(g) {
    var m = messages[g.getAttribute('data-message-id')];
    if (!m) return;
    active.querySelectorAll('.node.selected').forEach(function (x) { x.classList.remove('selected'); });
    lightLink(active, g);
    returnFocus = g;
    selectedId = null;
    syncFocusBtn();
    panel.textContent = '';
    panel.appendChild(panelHead('flow', 'u-flow', m.shape === 'dataflow' ? '데이터 이동' : '주고받기', m.view, m.label));
    var body = el('div', 'dr-body');
    var facts = el('ul', 'facts');
    factRow(facts, '보내는 쪽', label(m.from));
    factRow(facts, '받는 쪽', label(m.to));
    if (m.reply) factRow(facts, '종류', '응답');
    if (m.block) factRow(facts, '묶음', m.branch ? m.block + ', ' + m.branch : m.block);
    factRow(facts, '선', m.lineStyle === 'dashed' ? '점선 (문서나 사람 말로만 확인)' : '실선 (코드나 스펙으로 확인)');
    body.appendChild(facts);
    questionList(body, m.questions);
    refButtons(body, m.from === m.to ? [m.from] : [m.from, m.to], focusCard, function (r) { return 'i-' + dkind(nodes[r]); }, label);
    evidenceList(body, m.evidence);
    panel.appendChild(body);
    openDrawer();
  }
`;
const VIEW_POP = `  setupPop('views-btn', 'views');
  var viewsPop = byId('views');
  if (viewsPop) viewsPop.addEventListener('click', function (e) { if (e.target.closest('a')) closePops(false); });
`;

// 순서도 보기 조각. 순서도가 있는 그림에만 싣는다.
// 단계별 카드와 따라가기는 순서도 섹션 옆 형제 섹션(.seq-alt)이고 data-level-id가 없어 레벨 목록에 안 잡힌다.
// 보기는 레벨마다 페이지 메모리에만 둔다. 주소에 실으면 보기 전환이 뒤로가기 기록을 채운다
const SEQ_FUNCS = `  var seqBar = byId('seq-bar');
  var seqSteps = byId('seq-steps');
  var seqCap = seqBar.querySelector('.seq-cap');
  var seqPlayBtn = seqBar.querySelector('.sw-play');
  var seqModeBtns = Array.prototype.slice.call(seqBar.querySelectorAll('button[data-seq-mode]'));
  var seqAlts = Array.prototype.slice.call(doc.querySelectorAll('.seq-alt'));
  var seqBase = null;
  var seqMode = 'seq';
  var seqModes = {};
  var seqAt = {};
  var seqN = 0;
  var seqTimer = 0;
  function seqNarrow() { return window.matchMedia('(max-width: 860px)').matches; }
  function seqTop() { return seqBar.hidden ? 0 : seqBar.offsetTop + seqBar.offsetHeight; }
  function seqInset() {
    var r = { t: 0, r: 0, b: 0 };
    if (seqBar.hidden) return r;
    r.t = seqTop();
    if (!seqSteps.hidden) {
      if (seqNarrow()) r.b = seqSteps.offsetHeight + 16;
      else r.r = seqSteps.offsetWidth + 16;
    }
    return r;
  }
  function seqBaseId() { return seqBase ? seqBase.getAttribute('data-level-id') : null; }
  function seqAlt(mode) {
    var id = seqBaseId();
    for (var i = 0; i < seqAlts.length; i++) {
      if (seqAlts[i].getAttribute('data-seq-of') === id && seqAlts[i].getAttribute('data-seq-mode') === mode) return seqAlts[i];
    }
    return null;
  }
  function seqList() {
    var id = seqBaseId();
    var lists = seqSteps.querySelectorAll('.ss-list');
    for (var i = 0; i < lists.length; i++) if (lists[i].getAttribute('data-seq-of') === id) return lists[i];
    return null;
  }
  function seqTotal() {
    var walk = seqAlt('walk');
    return walk ? walk.querySelectorAll('.w-step').length : 0;
  }
  function seqStop() {
    if (seqTimer) clearInterval(seqTimer);
    seqTimer = 0;
    seqPlayBtn.textContent = '재생';
    seqPlayBtn.setAttribute('aria-pressed', 'false');
  }
  function seqLeave() {
    seqStop();
    seqAlts.forEach(function (s) { s.hidden = true; });
    seqBar.hidden = true;
    seqSteps.hidden = true;
    seqBase = null;
  }
  function showStep(n) {
    var walk = seqAlt('walk');
    var total = seqTotal();
    if (!walk || !total) return;
    seqN = Math.max(1, Math.min(total, n));
    seqAt[seqBaseId()] = seqN;
    var on = null;
    walk.querySelectorAll('.w-step').forEach(function (p) {
      var hit = Number(p.getAttribute('data-n')) === seqN;
      p.classList.toggle('on', hit);
      if (hit) on = p;
    });
    var from = on.getAttribute('data-from');
    var to = on.getAttribute('data-to');
    walk.querySelectorAll('.node').forEach(function (c) {
      var id = c.getAttribute('data-node-id');
      c.classList.toggle('w-dim', id !== from && id !== to);
    });
    var item = null;
    var list = seqList();
    if (list) list.querySelectorAll('button[data-n]').forEach(function (b) {
      if (Number(b.getAttribute('data-n')) === seqN) { b.setAttribute('aria-current', 'step'); item = b; }
      else b.removeAttribute('aria-current');
    });
    seqCap.querySelector('.sw-n').textContent = seqN + ' / ' + total;
    seqCap.querySelector('.sw-p').textContent = item ? item.getAttribute('data-phase') : '';
    seqCap.querySelector('.sw-t').textContent = item ? item.getAttribute('data-say') : '';
    var block = seqCap.querySelector('.sw-b');
    block.textContent = item ? item.getAttribute('data-block') : '';
    block.hidden = !block.textContent;
    if (item) item.scrollIntoView({ block: 'nearest' });
  }
  function applySeqMode(mode, refit) {
    if (!seqBase) return;
    seqStop();
    closeDrawer(false);
    if (active) clearLit(active);
    seqMode = mode;
    seqModes[seqBaseId()] = mode;
    seqBase.hidden = mode !== 'seq';
    var alt = mode === 'seq' ? null : seqAlt(mode);
    seqAlts.forEach(function (s) { s.hidden = s !== alt; });
    active = alt || seqBase;
    if (envPicker) applyEnv(active);
    seqModeBtns.forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-seq-mode') === mode)); });
    var walking = mode === 'walk';
    seqCap.hidden = !walking;
    seqSteps.hidden = !walking;
    var list = seqList();
    seqSteps.querySelectorAll('.ss-list').forEach(function (l) { l.hidden = l !== list; });
    // 보기 바가 두 줄로 접히면 목록이 그 아래에서 시작해야 안 겹친다
    seqSteps.style.top = walking && !seqNarrow() ? seqTop() + 8 + 'px' : '';
    if (walking) showStep(seqAt[seqBaseId()] || 1);
    syncFocusBtn();
    if (refit) {
      fit('smart');
      runSearch(false);
    }
  }
  function syncSeqBar(id) {
    seqStop();
    var base = sectionOf(id);
    var has = !!base && seqAlts.some(function (s) { return s.getAttribute('data-seq-of') === id; });
    seqAlts.forEach(function (s) { s.hidden = true; });
    seqBar.hidden = !has;
    seqSteps.hidden = true;
    seqBase = has ? base : null;
    if (has) applySeqMode(seqModes[id] || 'seq', false);
  }
  function seqPlay() {
    if (seqTimer) { seqStop(); return; }
    if (seqN >= seqTotal()) showStep(1);
    seqPlayBtn.textContent = '멈춤';
    seqPlayBtn.setAttribute('aria-pressed', 'true');
    seqTimer = setInterval(function () {
      if (seqN >= seqTotal()) { seqStop(); return; }
      showStep(seqN + 1);
    }, 900);
  }
  seqBar.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    var mode = b.getAttribute('data-seq-mode');
    if (mode) { if (mode !== seqMode) applySeqMode(mode, true); return; }
    if (b.classList.contains('sw-prev')) { seqStop(); showStep(seqN - 1); }
    else if (b.classList.contains('sw-next')) { seqStop(); showStep(seqN + 1); }
    else if (b.classList.contains('sw-play')) seqPlay();
  });
  seqSteps.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-n]');
    if (!b) return;
    seqStop();
    showStep(Number(b.getAttribute('data-n')));
  });
`;
const SEQ_FIT = `
    var sq = seqInset();
    W -= sq.r;
    H -= sq.t + sq.b;`;
// ←, →는 따라가기 보기가 떠 있을 때만 단계를 넘긴다. 다른 화면에서는 브라우저 기본 동작을 그대로 둔다
const SEQ_KEYS = `    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && seqBase && seqMode === 'walk' && !seqBar.hidden) {
      e.preventDefault();
      seqStop();
      showStep(seqN + (e.key === 'ArrowRight' ? 1 : -1));
      return;
    }
`;

export const THEME_STORAGE_KEY = 'gestalt-architecture-theme';
const HINT_STORAGE_KEY = 'gestalt-architecture-hint';

// 첫 화면을 그리기 전에 저장한 테마를 걸어야 밝은 화면이 한 번 번쩍이지 않는다
export const THEME_BOOT_SCRIPT = `(function () {
  try {
    var t = localStorage.getItem('${THEME_STORAGE_KEY}');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}
})();`;

/**
 * 페이지 동작 전부. 화면 이동, 확대와 이동, 서랍, 검색, 팝오버, 두 항목 화면을 맡는다.
 * 문자열은 전부 textContent로만 넣는다. 근거 문자열은 외부 출처에서 온 값이라 HTML로 해석하면 스크립트가 실행될 수 있다.
 * 템플릿 문자열 안이라 정규식과 문자열의 백슬래시는 두 번 적어야 브라우저에 한 번 남는다.
 */
export function renderClientScript(c: ClientConstants): string {
  return `
(function () {
  var doc = document;
  var root = doc.documentElement;
  var data = JSON.parse(doc.getElementById('ir').textContent);
  var KIND_SHORT = ${JSON.stringify(c.kindShort)};
  var HOST_SHORT = ${JSON.stringify(c.hostShort)};
  var FRAME_PAD = ${FRAME_PAD};
  var BAND_LINE_X = ${BAND_LINE_X}, BAND_LINE_Y = ${BAND_LINE_Y}, BAND_TITLE_X = ${BAND_TITLE_X}, BAND_TITLE_HALF = ${BAND_TITLE_HALF};
  var PRODUCT_COLORS = ${PRODUCT_COLORS};
  var MICRO_HOSTS = {};
  (data.microHosts || []).forEach(function (id) { MICRO_HOSTS[id] = true; });
  var KIND_TEXT = ${JSON.stringify(c.kindText)};
  var KIND_ABOUT = ${JSON.stringify(c.kindAbout)};
  var EVIDENCE_TEXT = ${JSON.stringify(c.evidenceText)};
  var LANE_TITLE = ${JSON.stringify(c.laneTitles)};
  var LANE_ABOUT = ${JSON.stringify(c.laneAbout)};
  var STAGE_LANE_ABOUT = ${JSON.stringify(c.stageLaneAbout)};
  var NODE_DESC_LINE = ${NODE_DESC_LINE};
  var GUESS = ${JSON.stringify(c.inferredBadge)};
  var PLATFORM_CHIP = ${JSON.stringify(c.platformChip)};
  var PLATFORM_NAME = ${JSON.stringify(c.platformName)};
  var WEB_HOSTING_CHIP = ${JSON.stringify(c.webHostingChip)};
  var WEB_HOSTING_NAME = ${JSON.stringify(c.webHostingName)};
  // 서버의 platformChipText, platformName과 같은 규칙이다
  function chipText(p, f) {
    return p === 'web' && f && f.webHosting ? WEB_HOSTING_CHIP[f.webHosting] : PLATFORM_CHIP[p];
  }
  function platName(p, f) {
    return p === 'web' && f && f.webHosting ? WEB_HOSTING_NAME[f.webHosting] : PLATFORM_NAME[p] || p;
  }
  var BACKWARD = ${JSON.stringify(Object.fromEntries(c.backwardKinds.map((k) => [k, true])))};
  var services = data.services || {};
  var THEME_KEY = '${THEME_STORAGE_KEY}';
  var HINT_KEY = '${HINT_STORAGE_KEY}';
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var nodes = {};
  data.nodes.forEach(function (n) { nodes[n.id] = n; });
  var edges = {};
  data.edges.forEach(function (e) { edges[e.id] = e; });
  var drill = !!data.levels;
  var levels = {};
  (data.levels || [{ id: 'root', kind: 'root', title: '전체', trail: ['root'], edges: [] }]).forEach(function (l) {
    l.edgeById = {};
    l.edges.forEach(function (e) { l.edgeById[e.id] = e; });
    levels[l.id] = l;
  });
  var enterMap = data.enter || {};
  // 흐름 단계는 노드가 아니지만 nodes에 같이 넣는다. 강조와 검색, 질문 이동이 nodes와 카드 id만 보고 돌아서다
  var flows = data.flows || [];
  var flowsBySvc = {};
  var stepFlow = {};
  var transitions = {};
  var stepsByRef = {};
  flows.forEach(function (f) {
    (flowsBySvc[f.service] = flowsBySvc[f.service] || []).push(f);
    var actors = {};
    f.actors.forEach(function (a) { actors[a.id] = a; });
    f.steps.forEach(function (st) {
      nodes[st.id] = { id: st.id, kind: 'flow_step', label: st.label, repo: '', evidence: st.evidence, step: st, actor: actors[st.actor] };
      stepFlow[st.id] = f;
      (st.refs || []).forEach(function (r) { (stepsByRef[r] = stepsByRef[r] || []).push(st.id); });
    });
    f.transitions.forEach(function (t) { transitions[t.id] = t; });
  });
  function isStep(id) { return !!stepFlow[id]; }
  function byId(id) { return doc.getElementById(id); }
  var stage = byId('stage');
  var viewport = byId('viewport');
  var drawer = byId('drawer');
  var panel = byId('panel');
  var crumbs = byId('crumbs');
  var pair = byId('pair');
  var focusSec = byId('focus');
  var focusChip = byId('focus-chip');
  var focusName = byId('focus-name');
  var focusBtn = byId('focus-btn');
  var sheet = byId('sheet');
  var sheetTitle = byId('sheet-title');
  var sheetBody = byId('sheet-body');
  var hint = byId('hint');
  var zoomLevel = byId('zoom-level');
  var search = byId('search');
  var searchCount = byId('search-count');
  var themeBtn = byId('theme-btn');
  var sections = Array.prototype.slice.call(doc.querySelectorAll('.level[data-level-id]'));
  var current = 'root';
  var active = null;
  var anchor = null;
  var selectedId = null;
  var focusId = null;
  var pendingSelect = null;
  var returnFocus = null;
  var ready = false;
  var view = { x: 0, y: 0, k: 1 };

${FOCUS_SOURCE}
  function kindText(k) { return KIND_TEXT[k] || k; }
  // MCP 도구는 IR에선 endpoint지만 칩과 색은 따로 단다. types.ts의 displayKindOf와 같은 규칙이다
  function dkind(n) { return !n ? '' : ${c.components ? COMPONENT_DKIND : ''}n.kind === 'endpoint' && n.protocol === 'mcp' ? 'mcp_tool' : n.kind; }
  function evidenceText(t) { return EVIDENCE_TEXT[t] || t; }
  function el(tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function svgEl(tag, attrs) {
    var e = doc.createElementNS(SVG_NS, tag);
    Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }
  function icon(id) {
    var s = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' });
    s.appendChild(svgEl('use', { href: '#' + id }));
    return s;
  }
  function nameOf(n) { return n.displayName || n.label; }
  function label(id) { return nodes[id] ? nameOf(nodes[id]) : id; }
  function store(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }
  function load(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }

  // 테마. 저장한 값이 없으면 시스템 설정을 따른다
  function systemDark() { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); }
  function themeNow() { return root.getAttribute('data-theme') || (systemDark() ? 'dark' : 'light'); }
  function syncTheme() {
    var dark = themeNow() === 'dark';
    var text = dark ? '밝은 화면으로 바꾸기' : '어두운 화면으로 바꾸기';
    themeBtn.setAttribute('data-mode', dark ? 'dark' : 'light');
    themeBtn.setAttribute('aria-label', text);
    themeBtn.title = text;
  }
  themeBtn.addEventListener('click', function () {
    var next = themeNow() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    store(THEME_KEY, next);
    syncTheme();
  });
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', syncTheme);
  }
  syncTheme();

  // 서랍 내용
  function renderEvidence(ev) {
    var li = el('li');
    li.appendChild(el('span', 'badge t-' + ev.type, evidenceText(ev.type)));
    if (ev.location === undefined) {
      li.appendChild(el('span', 'loc', '공유본이라 출처를 가렸어요'));
      if (ev.observedAt) li.appendChild(el('div', 'ev-meta', '조회 시각 ' + ev.observedAt));
      return li;
    }
    if (/^https?:\\/\\//i.test(ev.location)) {
      var a = el('a', 'loc', ev.location);
      a.href = ev.location;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      li.appendChild(a);
    } else {
      li.appendChild(el('span', 'loc', ev.location));
    }
    if (ev.command) li.appendChild(el('code', 'cmd', ev.command));
    if (ev.type === 'live' && ev.observedAt) li.appendChild(el('div', 'ev-meta', '조회 시각 ' + ev.observedAt));
    else if (ev.updatedAt) li.appendChild(el('div', 'ev-meta', '수정일 ' + ev.updatedAt));
    if (ev.excerpt) li.appendChild(el('pre', null, ev.excerpt));
    return li;
  }
  function factRow(list, key, value) {
    var li = el('li');
    li.appendChild(el('span', 'env', key));
    li.appendChild(el('span', 'val', value));
    list.appendChild(li);
  }
  // 환경과 계정, 서비스의 도메인과 플랫폼. 그래프에서 끌어낸 사실이라 출처 목록 앞에 둔다
  function renderFacts(n, body) {
    var basics = el('ul', 'facts');
    if (n.environment) factRow(basics, '환경', n.environment);
    if (n.account) factRow(basics, '계정', label(n.account));
    if (n.mcpServer) factRow(basics, 'MCP 서버', n.mcpServer);
    if (n.actions) factRow(basics, 'action', n.actions.join(', '));
    if (basics.childNodes.length) body.appendChild(basics);
    var f = services[n.id];
    if (!f) return;
    if (f.domains.length) {
      body.appendChild(el('h3', null, '도메인 ' + f.domains.length + '개'));
      var dl = el('ul', 'facts');
      f.domains.forEach(function (d) { factRow(dl, d.environment || '환경 모름', d.label); });
      body.appendChild(dl);
    }
    if (!f.platforms.length) return;
    body.appendChild(el('h3', null, '플랫폼'));
    var pl = el('ul', 'evidence plat');
    f.platforms.forEach(function (p) {
      var li = el('li');
      li.appendChild(el('span', 'badge', platName(p, f)));
      var evs = (n.platformEvidence && n.platformEvidence[p]) || [];
      if (p === 'web' && f.servingBuckets.length) {
        li.appendChild(el('span', 'loc', '서빙 버킷: ' + f.servingBuckets.map(label).join(', ')));
      }
      if (p === 'web' && f.servingTargets && f.servingTargets.length) {
        li.appendChild(el('span', 'loc', '서빙 서버: ' + f.servingTargets.map(label).join(', ')));
      }
      if (evs.length) {
        var inner = el('ul', 'evidence');
        evs.forEach(function (ev) { inner.appendChild(renderEvidence(ev)); });
        li.appendChild(inner);
      }
      pl.appendChild(li);
    });
    body.appendChild(pl);
  }
  function panelHead(chipKind, chipIcon, chipText, sub, title) {
    var head = el('div', 'dr-head');
    var chips = el('div', 'chips');
    var chip = el('span', 'chip ' + chipKind);
    chip.appendChild(icon(chipIcon));
    chip.appendChild(doc.createTextNode(chipText));
    chips.appendChild(chip);
    if (sub) chips.appendChild(el('span', 'repo', sub));
    head.appendChild(chips);
    var h = el('h2', null, title);
    h.id = 'drawer-title';
    h.tabIndex = -1;
    head.appendChild(h);
    return head;
  }
  function evidenceList(body, list) {
    body.appendChild(el('h3', null, '출처 ' + list.length + '개'));
    var ul = el('ul', 'evidence');
    list.forEach(function (ev) { ul.appendChild(renderEvidence(ev)); });
    body.appendChild(ul);
  }
  function questionList(body, list) {
    if (!list || !list.length) return;
    body.appendChild(el('h3', null, '확인할 질문 ' + list.length + '개'));
    var ul = el('ul', 'qlist');
    list.forEach(function (q) { ul.appendChild(el('li', 'q-text', q)); });
    body.appendChild(ul);
  }
  // 단계와 기술 그림을 잇는 단추. 같은 서비스 레벨에 카드가 있으면 그쪽을 먼저 연다. 흐름을 보다 온 사람이 서비스 안에서 이어 보게 하려는 것이다
  function goToRef(id, svc) {
    var lv = 'service:' + svc;
    var sec = sectionOf(lv);
    if (sec && cardMap(sec)[id]) {
      if (current === lv) { focusCard(id); return; }
      pendingSelect = id;
      showLevel(lv);
      return;
    }
    goToNode(id);
  }
  function refButtons(body, ids, onClick, iconOf, textOf) {
    var ul = el('ul', 'refs-list');
    ids.forEach(function (id) {
      var li = el('li');
      var b = el('button');
      b.type = 'button';
      b.appendChild(icon(iconOf(id)));
      b.appendChild(doc.createTextNode(textOf(id)));
      b.addEventListener('click', function () { onClick(id); });
      li.appendChild(b);
      ul.appendChild(li);
    });
    body.appendChild(ul);
  }
  function renderStepPanel(id) {
    var n = nodes[id];
    var st = n.step;
    var f = stepFlow[id];
    panel.textContent = '';
    panel.appendChild(panelHead(st.path === 'side' ? 'flow side' : 'flow', 'u-flow', '흐름 단계', f.title, st.label));
    var body = el('div', 'dr-body');
    var facts = el('ul', 'facts');
    if (n.actor) factRow(facts, '누가', n.actor.label);
    if (st.state) {
      var stateName = f.stateLabels && f.stateLabels[st.state];
      factRow(facts, '상태', stateName ? stateName + ' (' + st.state + ')' : st.state);
    }
    factRow(facts, '갈래', st.path === 'side' ? '옆 흐름' : '정상 흐름');
    if (st.terminal) factRow(facts, '다음', '여기서 흐름이 끝나요');
    body.appendChild(facts);
    if (st.description) body.appendChild(el('p', 'desc', st.description));
    questionList(body, st.questions);
    var refs = (st.refs || []).filter(function (r) { return !!nodes[r]; });
    if (refs.length) {
      var web = refs.every(function (r) { return nodes[r].kind === 'screen' || nodes[r].kind === 'endpoint'; });
      body.appendChild(el('h3', null, (web ? '이어진 화면과 API ' : '이어진 카드 ') + refs.length + '개'));
      refButtons(body, refs, function (r) { goToRef(r, f.service); }, function (r) { return 'i-' + dkind(nodes[r]); }, label);
    }
    evidenceList(body, st.evidence);
    panel.appendChild(body);
  }
  function renderTransitionPanel(t) {
    selectedId = null;
    syncFocusBtn();
    panel.textContent = '';
    var title = label(t.from) + ' → ' + label(t.to);
    panel.appendChild(panelHead(t.path === 'side' ? 'flow side' : 'flow', 'u-flow', '상태 전이', t.label || '', title));
    var body = el('div', 'dr-body');
    var facts = el('ul', 'facts');
    var f = stepFlow[t.from];
    if (t.actors && f) {
      factRow(facts, '누가', t.actors.map(function (a) {
        var actor = f.actors.filter(function (x) { return x.id === a; })[0];
        return actor ? actor.label : a;
      }).join(', '));
    }
    factRow(facts, '갈래', t.path === 'side' ? '옆 흐름' : '정상 흐름');
    factRow(facts, '선', t.lineStyle === 'dashed' ? '점선 (문서나 사람 말로만 확인)' : '실선 (코드나 스펙으로 확인)');
    body.appendChild(facts);
    questionList(body, t.questions);
    refButtons(body, [t.from, t.to], focusCard, function () { return 'u-flow'; }, label);
    evidenceList(body, t.evidence);
    panel.appendChild(body);
    openDrawer();
  }
  // 환경 필터로 숨긴 카드는 화면에 없으니 목록에서도 뺀다
  function connectionList(body, id, incoming) {
    var list = data.edges.filter(function (e) {
      var other = incoming ? e.from : e.to;
      return (incoming ? e.to : e.from) === id && other !== id && !envHidden(other);
    });
    if (!list.length) return;
    body.appendChild(el('h3', null, (incoming ? '들어오는 연결 ' : '나가는 연결 ') + list.length + '개'));
    var otherOf = {};
    list.forEach(function (e) { otherOf[e.id] = incoming ? e.from : e.to; });
    refButtons(body, list.map(function (e) { return e.id; }), function (eid) { goToNode(otherOf[eid]); },
      function (eid) { return 'i-' + dkind(nodes[otherOf[eid]]); },
      function (eid) { return label(otherOf[eid]) + ' (' + kindText(edges[eid].kind) + ')'; });
  }
  // 선은 레벨 엣지에서 먼저 찾는다. 포함 선은 드릴다운이 만든 것이라 IR 엣지 표에 없다
  function edgeOf(id) {
    var level = levels[levelIdOf(active)];
    return (level && level.edgeById[id]) || edges[id] || null;
  }
  function renderEdgePanel(g) {
    var id = g.getAttribute('data-link-id');
    var e = edgeOf(id);
    if (!e) return;
    var ir = edges[id];
    active.querySelectorAll('.node.selected').forEach(function (x) { x.classList.remove('selected'); });
    lightLink(active, g);
    returnFocus = g;
    selectedId = null;
    syncFocusBtn();
    panel.textContent = '';
    panel.appendChild(panelHead('flow', 'u-link', kindText(e.kind), '', label(e.from) + ' → ' + label(e.to)));
    var body = el('div', 'dr-body');
    if (KIND_ABOUT[e.kind]) body.appendChild(el('p', 'desc', KIND_ABOUT[e.kind]));
    var facts = el('ul', 'facts');
    if (e.kind !== 'contains') factRow(facts, '선', e.lineStyle === 'dashed' ? '점선 (문서나 사람 말로만 확인)' : '실선 (코드나 스펙으로 확인)');
    if (g.classList.contains('x-account')) factRow(facts, '계정', '계정을 넘는 연결이에요');
    if (ir && ir.actions && ir.actions.length) factRow(facts, 'action', ir.actions.join(', '));
    if (facts.childNodes.length) body.appendChild(facts);
    body.appendChild(el('h3', null, '양 끝'));
    refButtons(body, [e.from, e.to], goToNode, function (nid) { return 'i-' + dkind(nodes[nid]); }, label);
    if (ir) evidenceList(body, ir.evidence);
    else body.appendChild(el('p', 'desc', 'parent로 정한 포함 관계라 따로 근거가 없어요.'));
    panel.appendChild(body);
    openDrawer();
  }
  // 레인 제목과 rect.lane은 같은 순서로 그려진다. 포커스 화면과 환경 필터가 같은 짝짓기를 쓴다
  function laneCards(t) {
    var sec = t.parentNode;
    var titles = Array.prototype.slice.call(sec.querySelectorAll('.lane-title'));
    var r = sec.querySelectorAll('rect.lane')[titles.indexOf(t)];
    if (!r) return [];
    var x = parseFloat(r.getAttribute('x'));
    var w = parseFloat(r.getAttribute('width'));
    var ids = [];
    sec.querySelectorAll('.node').forEach(function (c) {
      var left = parseFloat(c.style.left);
      if (left >= x && left < x + w && !c.classList.contains('env-off')) ids.push(c.getAttribute('data-node-id'));
    });
    return ids;
  }
  function laneAria(title, count) { return title + ' 레인, 카드 ' + count + '개'; }
  function renderLanePanel(t) {
    var laneId = t.getAttribute('data-lane-id') || '';
    var title = t.firstChild ? t.firstChild.textContent : '';
    var ids = laneCards(t);
    active.querySelectorAll('.node.selected').forEach(function (x) { x.classList.remove('selected'); });
    clearLit(active);
    returnFocus = t;
    selectedId = null;
    syncFocusBtn();
    panel.textContent = '';
    panel.appendChild(panelHead('flow', 'u-legend', '레인', '', title));
    var body = el('div', 'dr-body');
    var about = laneId.indexOf('stage:') === 0 ? STAGE_LANE_ABOUT : LANE_ABOUT[laneId];
    if (about) body.appendChild(el('p', 'desc', about));
    body.appendChild(el('h3', null, '이 칸의 카드 ' + ids.length + '개'));
    if (ids.length) refButtons(body, ids, focusCard, function (nid) { return 'i-' + dkind(nodes[nid]); }, label);
    panel.appendChild(body);
    openDrawer();
  }
  function renderPanel(id) {
    if (isStep(id)) { renderStepPanel(id); return; }
    var n = nodes[id];
    panel.textContent = '';
    var head = el('div', 'dr-head');
    var chips = el('div', 'chips');
    var chip = el('span', 'chip k-' + dkind(n));
    chip.appendChild(icon('i-' + dkind(n)));
    chip.appendChild(doc.createTextNode(${c.components ? COMPONENT_CHIP : ''}kindText(dkind(n))));
    chips.appendChild(chip);
    chips.appendChild(el('span', 'repo', n.repo));
    head.appendChild(chips);
    var h = el('h2', null, nameOf(n));
    h.id = 'drawer-title';
    h.tabIndex = -1;
    if (n.displayName && n.displayNameInferred) h.appendChild(el('span', 'badge guess', GUESS));
    head.appendChild(h);
    if (n.displayName) head.appendChild(el('div', 'tech', n.label));
    if (n.displayName && n.displayNameInferred) {
      head.appendChild(el('p', 'guess-note', GUESS + ': 문서에 정해진 이름이 없어서 설명 문장을 보고 붙인 이름이에요.'));
    }
    panel.appendChild(head);
    var body = el('div', 'dr-body');
    var target = enterMap[id];
    var canEnter = target && target !== current;
    var canFocus = id !== focusId && !!cardMap(sectionOf(current))[id] && pair.hidden;
    if (canEnter || canFocus) {
      var actions = el('div', 'actions');
      if (canEnter) {
        var b = el('button', 'enter');
        b.type = 'button';
        b.appendChild(doc.createTextNode('상세보기'));
        b.addEventListener('click', function () { showLevel(target); });
        actions.appendChild(b);
      }
      if (canFocus) {
        var f = el('button', 'focus');
        f.type = 'button';
        f.title = '이 항목과 이어진 것만 보기 (F)';
        f.appendChild(icon('u-focus'));
        f.appendChild(doc.createTextNode('포커스'));
        f.addEventListener('click', function () { showFocus(id); });
        actions.appendChild(f);
      }
      body.appendChild(actions);
    }
    if (n.description) body.appendChild(el('p', 'desc', n.description));
    var about = KIND_ABOUT[dkind(n)];
    if (about) {
      body.appendChild(el('h3', null, '이 종류는'));
      body.appendChild(el('p', 'desc', about));
    }
    renderFacts(n, body);${c.docs ? '\n    renderDoc(n, body);' : ''}
    if (flowsBySvc[id]) {
      body.appendChild(el('h3', null, '흐름 ' + flowsBySvc[id].length + '개'));
      refButtons(body, flowsBySvc[id].map(function (f) { return f.level; }), showLevel, function () { return 'u-flow'; }, function (lv) { return levels[lv].title; });
    }
    if (stepsByRef[id]) {
      body.appendChild(el('h3', null, '이 항목이 나오는 흐름 단계 ' + stepsByRef[id].length + '개'));
      refButtons(body, stepsByRef[id], goToNode, function () { return 'u-flow'; }, function (sid) { return stepFlow[sid].title + ' › ' + label(sid); });
    }
    connectionList(body, id, true);
    connectionList(body, id, false);
    body.appendChild(el('h3', null, '출처 ' + n.evidence.length + '개'));
    var ul = el('ul', 'evidence');
    n.evidence.forEach(function (ev) { ul.appendChild(renderEvidence(ev)); });
    body.appendChild(ul);
    panel.appendChild(body);
  }
  function drawerOpen() { return drawer.classList.contains('open'); }
  function openDrawer() {
    drawer.classList.add('open');
    drawer.removeAttribute('inert');
    drawer.setAttribute('aria-hidden', 'false');
  }
  function closeDrawer(restore) {
    if (active) active.querySelectorAll('.node.selected').forEach(function (c) { c.classList.remove('selected'); });
    selectedId = null;
    syncFocusBtn();
    restoreLit();
    if (!drawerOpen()) return;
    drawer.classList.remove('open');
    drawer.setAttribute('inert', '');
    drawer.setAttribute('aria-hidden', 'true');
    if (restore && returnFocus && doc.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
  }
  byId('drawer-close').addEventListener('click', function () { closeDrawer(true); });

  // 확대와 이동. 좌표는 전부 레벨 캔버스 기준이고 viewport 하나에 transform으로 건다
  function clampK(k) { return Math.min(2.5, Math.max(0.2, k)); }
  function applyView() {
    closeProducts(false);
    viewport.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.k + ')';
    zoomLevel.textContent = Math.round(view.k * 100) + '%';
  }
  var glideTimer = 0;
  function glide() {
    if (!ready) return;
    viewport.classList.add('glide');
    clearTimeout(glideTimer);
    glideTimer = setTimeout(function () { viewport.classList.remove('glide'); }, 300);
  }
  function stopGlide() { viewport.classList.remove('glide'); }
  function zoomAt(px, py, k) {
    k = clampK(k);
    view.x = px - (px - view.x) * k / view.k;
    view.y = py - (py - view.y) * k / view.k;
    view.k = k;
    applyView();
  }
  function visibleWidth() { return stage.clientWidth - (drawerOpen() ? drawer.offsetWidth : 0); }
  function zoomBy(f) { glide(); zoomAt(visibleWidth() / 2, stage.clientHeight / 2, view.k * f); }
  function dims(sec) { return { w: Number(sec.getAttribute('data-w')) || 1, h: Number(sec.getAttribute('data-h')) || 1 }; }
  function fit(mode) {
    if (!active) return;
    var s = dims(active);
    var W = stage.clientWidth;
    var H = stage.clientHeight - (sheet.hidden ? 0 : sheet.offsetHeight + 16);
    var M = 24;${c.sequences ? SEQ_FIT : ''}
    var kw = (W - M * 2) / s.w;
    var kh = (H - M * 2) / s.h;
    var k = Math.min(kw, kh, 1);
    var top = false;
    // 세로로 긴 레벨을 한 화면에 다 넣으면 글자가 안 읽힌다. 그때는 폭에 맞추고 위에서부터 보여준다
    // 폰처럼 폭도 좁으면 일부만 보이더라도 읽히는 크기를 지킨다
    if (mode === 'smart' && k < 0.5) { k = Math.max(Math.min(kw, 1), 0.45); top = true; }
    k = clampK(k);
    view.k = k;
    view.x = Math.max(M, (W - s.w * k) / 2);
    view.y = ${c.sequences ? 'sq.t + (' : ''}top ? M : Math.max(M, (H - s.h * k) / 2)${c.sequences ? ')' : ''};
    glide();
    applyView();
  }
  function cardCenter(c) { return { x: c.offsetLeft + c.offsetWidth / 2, y: c.offsetTop + c.offsetHeight / 2 }; }
  function centerOn(c, minK) {
    if (minK && view.k < minK) view.k = clampK(minK);
    var p = cardCenter(c);
    view.x = visibleWidth() / 2 - p.x * view.k;
    view.y = stage.clientHeight / 2 - p.y * view.k;
    glide();
    applyView();
  }
  function ensureVisible(c) {
    var W = visibleWidth();
    if (W < 200) return;
    var p = cardCenter(c);
    var sx = view.x + p.x * view.k;
    var sy = view.y + p.y * view.k;
    var M = 60;
    if (sx < M || sx > W - M || sy < M || sy > stage.clientHeight - M) centerOn(c);
  }
  byId('zoom-in').addEventListener('click', function () { zoomBy(1.25); });
  byId('zoom-out').addEventListener('click', function () { zoomBy(0.8); });
  byId('zoom-fit').addEventListener('click', function () { fit('full'); });
  stage.addEventListener('wheel', function (e) {
    e.preventDefault();
    stopGlide();
    var r = stage.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      var d = Math.max(-60, Math.min(60, e.deltaY));
      zoomAt(e.clientX - r.left, e.clientY - r.top, view.k * Math.exp(-d * 0.008));
      return;
    }
    var unit = e.deltaMode === 1 ? 16 : 1;
    view.x -= (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit;
    view.y -= (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * unit;
    applyView();
  }, { passive: false });
  // 포커스가 화면 밖 카드로 가면 브라우저가 stage를 스크롤한다. 스크롤은 되돌리고 화면 이동으로 바꾼다
  stage.addEventListener('scroll', function () { stage.scrollLeft = 0; stage.scrollTop = 0; });
  var drag = null;
  var suppressClick = false;
  stage.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    stopGlide();
    drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, id: e.pointerId };
  });
  stage.addEventListener('pointermove', function (e) {
    if (!drag || drag.id !== e.pointerId) return;
    var dx = e.clientX - drag.x;
    var dy = e.clientY - drag.y;
    if (!drag.moved) {
      if (Math.abs(dx) + Math.abs(dy) < 4) return;
      drag.moved = true;
      stage.classList.add('panning');
      try { stage.setPointerCapture(e.pointerId); } catch (err) {}
    }
    view.x = drag.vx + dx;
    view.y = drag.vy + dy;
    applyView();
  });
  function endDrag(e) {
    if (!drag || drag.id !== e.pointerId) return;
    if (drag.moved) suppressClick = true;
    drag = null;
    stage.classList.remove('panning');
  }
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  // 강조. 카드나 선에 올리면 이웃만 남기고 나머지를 흐린다
  function cardMap(c) {
    if (!c) return {};
    if (!c._cards) {
      c._cards = {};
      c.querySelectorAll('.node').forEach(function (n) { c._cards[n.getAttribute('data-node-id')] = n; });
    }
    return c._cards;
  }
  function linkIndex(c) {
    if (!c._links) {
      c._links = {};
      c.querySelectorAll('.link').forEach(function (l) {
        [l.getAttribute('data-from'), l.getAttribute('data-to')].forEach(function (id) {
          (c._links[id] = c._links[id] || []).push(l);
        });
      });
    }
    return c._links;
  }
  function clearLit(c) {
    if (!c) return;
    c.classList.remove('dimmed');
    c.querySelectorAll('.lit').forEach(function (x) { x.classList.remove('lit'); });
  }
  function lightNode(c, id) {
    if (!c) return;
    clearLit(c);
    var cards = cardMap(c);
    c.classList.add('dimmed');
    if (cards[id]) cards[id].classList.add('lit');
    (linkIndex(c)[id] || []).forEach(function (l) {
      l.classList.add('lit');
      var other = l.getAttribute('data-from') === id ? l.getAttribute('data-to') : l.getAttribute('data-from');
      if (cards[other]) cards[other].classList.add('lit');
    });
  }
  function lightLink(c, l) {
    clearLit(c);
    var cards = cardMap(c);
    c.classList.add('dimmed');
    l.classList.add('lit');
    [l.getAttribute('data-from'), l.getAttribute('data-to')].forEach(function (id) {
      if (cards[id]) cards[id].classList.add('lit');
    });
  }
  function restoreLit() {
    if (!active) return;
    if (selectedId && cardMap(active)[selectedId]) lightNode(active, selectedId);
    else clearLit(active);
  }
  function hoverTarget(t) { return t && t.closest ? t.closest('.node, .link') : null; }
  stage.addEventListener('mouseover', function (e) {
    if (drag && drag.moved) return;
    var t = hoverTarget(e.target);
    if (!t || !active || !active.contains(t)) return;
    if (t.classList.contains('node')) lightNode(active, t.getAttribute('data-node-id'));
    else lightLink(active, t);
  });
  stage.addEventListener('mouseout', function (e) {
    var from = hoverTarget(e.target);
    if (!from) return;
    var to = hoverTarget(e.relatedTarget);
    if (!to) restoreLit();
  });
  stage.addEventListener('focusin', function (e) {
    var t = hoverTarget(e.target);
    if (!t || !active || !active.contains(t)) return;
    if (t.classList.contains('node')) {
      lightNode(active, t.getAttribute('data-node-id'));
      ensureVisible(t);
    } else {
      lightLink(active, t);
    }
  });
  stage.addEventListener('focusout', function (e) {
    if (!hoverTarget(e.relatedTarget)) restoreLit();
  });

  // 선택
  function select(id, focusDrawer) {
    var c = cardMap(active)[id];
    active.querySelectorAll('.node.selected').forEach(function (x) { x.classList.remove('selected'); });
    if (c) c.classList.add('selected');
    selectedId = id;
    syncFocusBtn();
    returnFocus = c || null;
    lightNode(active, id);
    renderPanel(id);
    openDrawer();
    if (c) ensureVisible(c);
    if (focusDrawer) {
      var h = byId('drawer-title');
      if (h) h.focus({ preventScroll: true });
    }
  }
  function focusCard(id) {
    var c = cardMap(active)[id];
    if (!c) return;
    select(id, false);
    centerOn(c, 0.8);
    c.focus({ preventScroll: true });
  }
  function setAnchor(id) {
    active.querySelectorAll('.node.anchor').forEach(function (x) { x.classList.remove('anchor'); });
    anchor = id;
    var c = cardMap(active)[id];
    if (c) c.classList.add('anchor');
  }
  function activateNode(id, ev, viaKeyboard) {
    var pairable = drill && current === 'root' && pair.hidden;
    if (pairable && (ev.shiftKey || ev.metaKey) && anchor && anchor !== id) {
      showPair(anchor, id);
      return;
    }
    if (pairable) setAnchor(id);
    select(id, viaKeyboard);
  }
  function enter(id) {
    var target = enterMap[id];
    if (target && target !== current) showLevel(target);
  }
  function activateBundle(g) {
    var levelId = levelIdOf(active);
    var level = levels[levelId];
    var bundle = level && level.edgeById[g.getAttribute('data-bundle-id')];
    if (!bundle) return;
    if (levelId === 'root') { showPair(bundle.from, bundle.to); return; }
    go('#/bundle/' + enc(levelId) + '/' + enc(bundle.id));
  }
  function activateTransition(g) {
    var t = transitions[g.getAttribute('data-transition-id')];
    if (!t) return;
    active.querySelectorAll('.node.selected').forEach(function (x) { x.classList.remove('selected'); });
    lightLink(active, g);
    returnFocus = g;
    renderTransitionPanel(t);
  }
${c.views ? viewFuncs(!!c.sequences) : ''}${c.sequences ? SEQ_FUNCS : ''}${c.docs ? DOC_FUNCS : ''}  stage.addEventListener('click', function (e) {
    if (suppressClick) { suppressClick = false; return; }
    var more = e.target.closest('.pb.more');
    if (more) { toggleProducts(more); return; }
    // 흐름이 하나면 배지가 바로 그 흐름으로 간다. 여럿이면 카드를 누른 것처럼 패널을 열어 흐름 목록에서 고르게 한다
    var badge = e.target.closest('.flow-badge');
    if (badge) {
      var fl = flowsBySvc[badge.closest('.node').getAttribute('data-node-id')] || [];
      if (fl.length === 1) { showLevel(fl[0].level); return; }
    }
    ${c.views ? VIEW_CLICK : ''}var card = e.target.closest('.node');
    if (card) { activateNode(card.getAttribute('data-node-id'), e, false); return; }
    var link = e.target.closest('.link.bundle');
    if (link) { activateBundle(link); return; }
    var ft = e.target.closest('.link.flow-t');
    if (ft) { activateTransition(ft); return; }
    var edge = e.target.closest('.link[data-link-id]');
    if (edge) { renderEdgePanel(edge); return; }
    var lane = e.target.closest('.lane-title[data-lane-id]');
    if (lane) { renderLanePanel(lane); return; }
    if (drawerOpen()) closeDrawer(false);
  });
  stage.addEventListener('dblclick', function (e) {
    if (e.target.closest('.flow-badge, .pb.more')) return;
    var card = e.target.closest('.node');
    if (card) enter(card.getAttribute('data-node-id'));
  });
  stage.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    // +N 버튼은 브라우저가 Enter와 스페이스를 클릭으로 바꿔 준다. 카드 선택으로 새면 안 된다
    if (e.target.closest('.pb.more')) return;
    ${c.views ? VIEW_KEY : ''}var card = e.target.closest('.node');
    if (card) { e.preventDefault(); activateNode(card.getAttribute('data-node-id'), e, true); return; }
    var link = e.target.closest('.link.bundle');
    if (link) { e.preventDefault(); activateBundle(link); return; }
    var ft = e.target.closest('.link.flow-t');
    if (ft) { e.preventDefault(); activateTransition(ft); return; }
    var edge = e.target.closest('.link[data-link-id]');
    if (edge) { e.preventDefault(); renderEdgePanel(edge); return; }
    var lane = e.target.closest('.lane-title[data-lane-id]');
    if (lane) { e.preventDefault(); renderLanePanel(lane); }
  });

  // 위치 표시
  function renderCrumbs(items) {
    crumbs.textContent = '';
    if (!drill) { crumbs.hidden = true; return; }
    items.forEach(function (it, i) {
      if (i > 0) crumbs.appendChild(el('span', 'sep', '›'));
      if (i === items.length - 1 || !it.level) {
        var here = el('span', 'here', it.label);
        here.setAttribute('aria-current', 'page');
        crumbs.appendChild(here);
        return;
      }
      var b = el('button', null, it.label);
      b.type = 'button';
      b.addEventListener('click', function () { showLevel(it.level); });
      crumbs.appendChild(b);
    });
  }
  function trailItems(levelId) {
    // 흐름 레벨은 서비스 레벨이 없는 서비스에도 붙을 수 있다. 없는 레벨은 건너뛴다
    return levels[levelId].trail.filter(function (t) { return !!levels[t]; }).map(function (t) { return { label: levels[t].title, level: t }; });
  }

  // 레벨 이동과 두 항목 화면은 주소의 해시에 싣는다. 그래야 브라우저 뒤로가기와 새로고침, 링크 공유가 그 화면으로 돌아온다
  function enc(s) { return encodeURIComponent(s); }
  function go(hash) {
    hash += envQuery();
    if (location.hash === hash) { route(); return; }
    location.hash = hash;
  }
  function showLevel(id) {
    if (!levels[id]) return;
    go(id === 'root' ? '#/' : '#/level/' + enc(id));
  }
  // 같이 쓰는 카드의 +N 드롭다운. 메뉴 하나를 body에 두고 누른 버튼마다 내용을 바꿔 띄운다
  var productMenu = el('div', 'pmenu');
  productMenu.hidden = true;
  productMenu.setAttribute('role', 'dialog');
  doc.body.appendChild(productMenu);
  var productBtn = null;
  function closeProducts(restore) {
    // 화면 맞춤이 메뉴를 만들기 전에도 불린다
    if (!productMenu || productMenu.hidden) return;
    productMenu.hidden = true;
    if (productBtn) {
      productBtn.setAttribute('aria-expanded', 'false');
      if (restore) productBtn.focus();
    }
    productBtn = null;
  }
  function toggleProducts(btn) {
    if (productBtn === btn) { closeProducts(false); return; }
    closeProducts(false);
    var card = btn.closest('.node');
    var sec = btn.closest('.level');
    // 포커스 화면은 카드 일부만 남으니 전용 카드 수는 원래 레벨에서 센다
    if (sec === focusSec) sec = sectionOf(focusSec.getAttribute('data-focus-level'));
    if (!card || !sec) return;
    var names = JSON.parse(sec.getAttribute('data-regions') || '[]');
    var ids = (card.getAttribute('data-products') || '').split(' ').filter(Boolean).map(Number);
    productMenu.textContent = '';
    productMenu.appendChild(el('h3', '', josa(label(card.getAttribute('data-node-id'))) + ' 같이 쓰는 제품'));
    var list = el('ul', '');
    ids.forEach(function (i) {
      var li = el('li', '');
      li.appendChild(el('span', 'pb p-' + (i % PRODUCT_COLORS), names[i] || ''));
      li.appendChild(doc.createTextNode(names[i] || ''));
      li.appendChild(el('small', '', '전용 카드 ' + sec.querySelectorAll('.node[data-band="' + (i + 1) + '"]').length + '개'));
      list.appendChild(li);
    });
    productMenu.appendChild(list);
    productMenu.setAttribute('aria-label', productMenu.firstChild.textContent);
    productMenu.hidden = false;
    var r = btn.getBoundingClientRect();
    productMenu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - productMenu.offsetWidth - 8)) + 'px';
    productMenu.style.top = (r.bottom + 4) + 'px';
    btn.setAttribute('aria-expanded', 'true');
    productBtn = btn;
  }
  // 받침이 있으면 '을', 없으면 '를'. 끝의 괄호 설명은 건너뛰고 보고, 한글로 안 끝나면 받침을 모르니 '을(를)'
  function josa(word) {
    var stem = word.replace(/\\s*\\([^()]*\\)$/, '') || word;
    var c = stem.charCodeAt(stem.length - 1) - 0xac00;
    if (c < 0 || c > 11171) return word + '을(를)';
    return word + (c % 28 ? '을' : '를');
  }
  function sectionOf(id) {
    for (var i = 0; i < sections.length; i++) if (sections[i].getAttribute('data-level-id') === id) return sections[i];
    return null;
  }
  function renderLevel(id) {
    closeDrawer(false);
    if (active) clearLit(active);
    current = id;
    anchor = null;
    sections.forEach(function (s) { s.hidden = s.getAttribute('data-level-id') !== id; });
    pair.hidden = true;
    clearFocus();
    sheet.hidden = true;
    active = sectionOf(id);
    if (active) active.querySelectorAll('.node.anchor').forEach(function (x) { x.classList.remove('anchor'); });
    renderCrumbs(trailItems(id));
    syncFlowBtn();
${c.sequences ? '    syncSeqBar(id);\n' : ''}    fit('smart');
    runSearch(false);
  }

  // 두 항목 화면. 쌍마다 미리 그리면 노드 수의 제곱만큼 늘어서 브라우저에서 그린다.
  // elkjs 없이 열 배치만 쓴다. 열 순서가 곧 요청 흐름이라 자동 배치가 없어도 읽힌다
  // 경로 중간에는 게이트웨이와 모듈 하나까지만 둔다. 화면에서 출발해 모듈 하나를 지나 클라이언트로 다른 모듈에 닿는 데까지가 한 요청 흐름이고
  // 그보다 길게 돌아가는 길까지 펼치면 두 노드와 상관없는 엔드포인트가 쏟아진다
  function pathMembers(a, b) {
    var rootLevel = levels.root;
    var out = {};
    rootLevel.edges.forEach(function (e) { (out[e.from] = out[e.from] || []).push(e); });
    function collect(s, t) {
      var picked = {};
      var maxModules = isKind(s, 'app_module') ? 0 : 1;
      var seen = {};
      var path = [];
      seen[s] = true;
      function walk(at, modules) {
        if (at === t) { path.forEach(function (e) { picked[e.id] = e; }); return; }
        (out[at] || []).forEach(function (e) {
          var next = e.to;
          if (seen[next]) return;
          var m = modules;
          if (next !== t) {
            if (isKind(next, 'app_module')) m++;
            else if (!isKind(next, 'gateway')) return;
            if (m > maxModules) return;
          }
          seen[next] = true;
          path.push(e);
          walk(next, m);
          path.pop();
          seen[next] = false;
        });
      }
      walk(s, 0);
      return Object.keys(picked).map(function (k) { return picked[k]; });
    }
    var picked = collect(a, b);
    if (!picked.length) picked = collect(b, a);
    var ids = {};
    picked.forEach(function (e) { e.memberEdgeIds.forEach(function (m) { ids[m] = true; }); });
    return Object.keys(ids).sort();
  }
  function isKind(id, kind) { return nodes[id] && nodes[id].kind === kind; }
  function classify(list) {
    var clientGw = {};
    var receivers = {};
    var fromClient = {};
    list.forEach(function (e) {
      if (e.kind !== 'calls' || !isKind(e.from, 'external_service')) return;
      if (isKind(e.to, 'gateway')) clientGw[e.to] = true;
      else { fromClient[e.to] = true; receivers[e.to] = true; }
    });
    var hops = list.filter(function (e) { return e.kind === 'routes' && isKind(e.from, 'gateway') && isKind(e.to, 'gateway'); });
    var depth = {};
    Object.keys(nodes).forEach(function (id) { if (isKind(id, 'gateway')) depth[id] = 0; });
    // 사슬 단수를 구한다. 고리가 있어도 끝나도록 게이트웨이 수만큼만 돈다
    for (var round = 0; round < hops.length; round++) {
      hops.forEach(function (e) {
        if (depth[e.to] < depth[e.from] + 1) depth[e.to] = depth[e.from] + 1;
        if (clientGw[e.from]) clientGw[e.to] = true;
      });
    }
    list.forEach(function (e) {
      if (e.kind === 'routes' && clientGw[e.from]) {
        if (isKind(e.to, 'app_module')) receivers[e.to] = true;
        if (isKind(e.to, 'endpoint')) fromClient[e.to] = true;
      }
    });
    list.forEach(function (e) {
      if (e.kind === 'handles' && fromClient[e.from]) receivers[e.to] = true;
    });
    return { clientGw: clientGw, receivers: receivers, depth: depth };
  }
  // 열 번호에 틈을 둬서 게이트웨이 사슬이 단마다 한 열씩 끼어든다. 빈 번호는 그릴 때 접힌다
  // 하네스 카드는 화면보다 앞에 둔다. 클라이언트가 스킬을 싣고 스킬이 에이전트를 띄운 뒤 도구를 부르는 순서다
  var COL = { client: -300, skill: -200, agent: -100, screen: 0, gateway: 100, endpoint: 200, mcp_tool: 250, app_module: 300, external_service: 400, clientGateway: 500, receiver: 600, db_table: 700 };
  function columnOf(id, info) {
    var kind = dkind(nodes[id]);
    if (kind === 'gateway') return (info.clientGw[id] ? COL.clientGateway : COL.gateway) + (info.depth[id] || 0);
    if (kind === 'app_module' && info.receivers[id]) return COL.receiver;
    return COL.hasOwnProperty(kind) ? COL[kind] : 800;
  }
  function laneOfColumn(c) {
    if (c < -200) return 'client';
    if (c < -100) return 'skill';
    if (c < 0) return 'agent';
    if (c < 100) return 'screen';
    if (c < 200) return 'gateway';
    if (c < 250) return 'endpoint';
    if (c < 300) return 'tool';
    if (c < 400) return 'app_module';
    if (c < 500) return 'external_service';
    if (c < 700) return 'external';
    if (c < 800) return 'db_table';
    return '';
  }
  // types.ts의 hasCardDescription, layout.ts의 measureNode와 같은 판정이다
  function hasDesc(n) { return !!(n && n.description && n.description.trim()); }
  function cardHeight(id) {
    var f = services[id];
    var base = (nodes[id] && nodes[id].displayName) || (f && (f.prodDomain || f.platforms.length > 0)) ? 60 : 48;
    return base + (hasDesc(nodes[id]) ? NODE_DESC_LINE : 0);
  }
  function platformChips(id, parent) {
    var f = services[id];
    if (!f) return;
    f.platforms.forEach(function (p) {
      var chip = el('span', 'pf pf-' + p);
      chip.setAttribute('role', 'img');
      chip.setAttribute('aria-label', platName(p, f));
      chip.title = platName(p, f);
      chip.appendChild(icon('p-' + p));
      chip.appendChild(doc.createTextNode(chipText(p, f)));
      parent.appendChild(chip);
    });
  }
  function buildCard(id, x, y, w, h) {
    var n = nodes[id];
    var kind = dkind(n);
    var d = el('div', 'node k-' + kind);
    d.setAttribute('data-node-id', id);
    d.setAttribute('role', 'button');
    d.tabIndex = 0;
    d.style.left = x + 'px';
    d.style.top = y + 'px';
    d.style.width = w + 'px';
    d.style.height = h + 'px';
    var kc = el('span', 'kc');
    kc.appendChild(icon('i-' + kind));
    kc.appendChild(doc.createTextNode(MICRO_HOSTS[id] ? HOST_SHORT : ${c.components ? COMPONENT_CHIP : ''}KIND_SHORT[kind] || kind));
    d.appendChild(kc);
    var nm = el('span', 'nm');
    nm.appendChild(el('span', 't', label(id)));
    var guess = n && n.displayName && n.displayNameInferred;
    if (guess) nm.appendChild(el('span', 'guess', GUESS));
    d.appendChild(nm);
    var facts = services[id];
    var sub = null;
    if (facts && facts.prodDomain) sub = el('span', 'tc dom', facts.prodDomain);
    else if (n && n.displayName) sub = el('span', 'tc', n.label);
    if (facts && facts.platforms.length > 0) {
      var l2 = el('span', 'l2');
      if (sub) l2.appendChild(sub);
      platformChips(id, l2);
      d.appendChild(l2);
    } else if (sub) d.appendChild(sub);
    if (hasDesc(n)) d.appendChild(el('span', 'ds', n.description));
    d.title = (n && n.displayName ? n.displayName + (guess ? ' (' + GUESS + ')' : '') + '\\n' + n.label : label(id)) + (hasDesc(n) ? '\\n' + n.description : '');
    d.setAttribute('aria-label', label(id) + ', ' + kindText(kind));
    if (enterMap[id]) {
      var more = el('span', 'go', '›');
      more.setAttribute('aria-hidden', 'true');
      d.appendChild(more);
    }
    return d;
  }
  // 서버 렌더와 같은 굵기 규칙이다. 건수의 제곱근을 따른다
  function edgeWidth(count) {
    return Math.round(Math.min(8, Math.max(1.5, 1.5 + (Math.sqrt(Math.max(count || 1, 1)) - 1) * 1.1)) * 100) / 100;
  }
  // 두 항목 화면과 포커스 화면이 같이 쓰는 캔버스. 카드 자리(pos)와 레인을 받아 곡선을 잇고 그린다.
  // elk 경유점이 없으니 열을 건너뛰는 선은 베지어 하나로 바로 잇는다
  function drawCanvas(host, o) {
    var pos = o.pos;
    var height = o.height;
    var PAD_BOTTOM = 40;
    var drawn = o.edges.filter(function (e) { return pos[e.from] && pos[e.to] && e.from !== e.to; });
    function stacked(e) {
      var a = pos[e.from], b = pos[e.to];
      return b.x < a.x + a.w && b.x + b.w > a.x;
    }
    function ports(side) {
      var groups = {};
      drawn.forEach(function (e) {
        if (side === 'out' && stacked(e)) return;
        var key = side === 'out' ? e.from : e.to;
        (groups[key] = groups[key] || []).push(e);
      });
      var res = {};
      Object.keys(groups).forEach(function (id) {
        var g = groups[id];
        var p = pos[id];
        g.sort(function (a, b) {
          var oa = pos[side === 'out' ? a.to : a.from], ob = pos[side === 'out' ? b.to : b.from];
          return (oa.y + oa.h / 2) - (ob.y + ob.h / 2) || oa.x - ob.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        });
        var n = g.length;
        var step = n > 1 ? Math.min(9, (p.h - 28) / (n - 1)) : 0;
        g.forEach(function (e, i) { res[e.id] = p.y + p.h / 2 + (i - (n - 1) / 2) * step; });
      });
      return res;
    }
    var outY = ports('out');
    var inY = ports('in');
    var paths = drawn.map(function (e) {
      var a = pos[e.from], b = pos[e.to];
      var w = edgeWidth(e.count);
      var len = 7 + w * 0.5, half = 3.5 + w * 0.45;
      var sx = a.x + a.w, sy = outY[e.id], tx = b.x, ty = inY[e.id], ex = tx - len + 1;
      var d, mid;
      if (e.backward && b.x + b.w + 8 <= a.x) {
        var fx = a.x, fy0 = outY[e.id], tipAt = b.x + b.w, toX = tipAt + len - 1, toY = inY[e.id];
        var bdx = Math.max(16, (fx - toX) / 2);
        d = 'M' + fx + ' ' + fy0 + 'C' + (fx - bdx) + ' ' + fy0 + ' ' + (toX + bdx) + ' ' + toY + ' ' + toX + ' ' + toY;
        return { e: e, d: d, w: w, mid: { x: (fx + toX) / 2, y: (fy0 + toY) / 2 },
          tip: 'M' + tipAt + ' ' + toY + 'L' + (tipAt + len) + ' ' + (toY - half) + 'L' + (tipAt + len) + ' ' + (toY + half) + 'Z' };
      }
      if (stacked(e)) {
        var fy = a.y + a.h / 2;
        var bow = Math.min(30, 18 + Math.abs(ty - fy) * 0.2);
        var ox = Math.min(a.x, ex) - bow;
        d = 'M' + a.x + ' ' + fy + 'C' + ox + ' ' + fy + ' ' + ox + ' ' + ty + ' ' + ex + ' ' + ty;
        mid = { x: ox + bow * 0.25, y: (fy + ty) / 2 };
      } else if (b.x >= sx + 8) {
        var dx = Math.max(16, (ex - sx) / 2);
        d = 'M' + sx + ' ' + sy + 'C' + (sx + dx) + ' ' + sy + ' ' + (ex - dx) + ' ' + ty + ' ' + ex + ' ' + ty;
        mid = { x: (sx + ex) / 2, y: (sy + ty) / 2 };
      } else {
        var drop = Math.max(a.y + a.h, b.y + b.h) + 28;
        height = Math.max(height, drop + PAD_BOTTOM);
        var back = ex - 36;
        d = 'M' + sx + ' ' + sy + 'C' + (sx + 36) + ' ' + sy + ' ' + (sx + 36) + ' ' + drop + ' ' + sx + ' ' + drop +
          'L' + ex + ' ' + drop + 'C' + back + ' ' + drop + ' ' + back + ' ' + ty + ' ' + ex + ' ' + ty;
        mid = { x: (sx + ex) / 2, y: drop };
      }
      var tip = 'M' + tx + ' ' + ty + 'L' + (tx - len) + ' ' + (ty - half) + 'L' + (tx - len) + ' ' + (ty + half) + 'Z';
      return { e: e, d: d, tip: tip, mid: mid, w: w };
    });
    host.setAttribute('data-w', o.width);
    host.setAttribute('data-h', height);
    host.style.width = o.width + 'px';
    host.style.height = height + 'px';
    var svg = svgEl('svg', { 'class': 'links', width: o.width, height: height, viewBox: '0 0 ' + o.width + ' ' + height, role: 'group', 'aria-label': o.label });
    var laneLayer = svgEl('g', { 'class': 'lanes' });
    o.lanes.forEach(function (l) {
      laneLayer.appendChild(svgEl('rect', { 'class': 'lane', x: l.x, y: 12, width: l.width, height: height - 24, rx: 14 }));
    });
    svg.appendChild(laneLayer);
    var regionLayer = svgEl('g', { 'class': 'regions' });
    (o.bands || []).forEach(function (b) {
      var ly = b.y + BAND_LINE_Y;
      regionLayer.appendChild(svgEl('line', { 'class': 'band-line', x1: BAND_LINE_X, y1: ly, x2: o.width - BAND_LINE_X, y2: ly }));
    });
    svg.appendChild(regionLayer);
    var frameLayer = svgEl('g', { 'class': 'frames' });
    (o.frames || []).forEach(function (f) {
      frameLayer.appendChild(svgEl('rect', { 'class': 'frame', 'data-frame-id': f.id, x: f.x, y: f.y, width: f.width, height: f.height, rx: 14 }));
    });
    svg.appendChild(frameLayer);
    var linkLayer = svgEl('g', { 'class': 'edges' });
    paths.forEach(function (p) {
      var e = p.e;
      var bundle = e.kind === 'bundle';
      var xa = nodes[e.from] && nodes[e.to] && nodes[e.from].account && nodes[e.to].account && nodes[e.from].account !== nodes[e.to].account;
      var g = svgEl('g', { 'class': (bundle ? 'link bundle' : 'link e-' + e.kind) + (xa ? ' x-account' : ''), 'data-from': e.from, 'data-to': e.to });
      var name = bundle ? label(e.from) + ' → ' + label(e.to) + ' ' + e.count + '개'${c.mixedBundles ? MIXED_NOTE : ''} : kindText(e.kind) + ': ' + label(e.from) + ' → ' + label(e.to);
      g.setAttribute(bundle ? 'data-bundle-id' : 'data-link-id', e.id);
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'button');
      g.setAttribute('aria-label', name);
      var t = svgEl('title', {});
      t.textContent = name;
      g.appendChild(t);
      g.appendChild(svgEl('path', { 'class': 'hit', d: p.d, 'stroke-width': Math.max(12, p.w + 8) }));
      var line = svgEl('path', { 'class': 'edge', d: p.d, 'stroke-width': p.w });
      if (!bundle) line.setAttribute('data-edge-id', e.id);
      if (e.lineStyle === 'dashed') line.setAttribute('stroke-dasharray', '6 4');
      g.appendChild(line);
      g.appendChild(svgEl('path', { 'class': 'tip', d: p.tip }));
      if (bundle) {
        var text = String(e.count);
        var pw = 14 + text.length * 7;
        var pill = svgEl('g', { 'class': 'pill', transform: 'translate(' + p.mid.x + ',' + p.mid.y + ')' });
        pill.appendChild(svgEl('rect', { x: -pw / 2, y: -9, width: pw, height: 18, rx: 9 }));${c.mixedBundles ? MIXED_PILL : ''}
        var pt = svgEl('text', {});
        pt.textContent = text;
        pill.appendChild(pt);
        g.appendChild(pill);
      }
      linkLayer.appendChild(g);
    });
    svg.appendChild(linkLayer);
    host.appendChild(svg);
    o.lanes.forEach(function (l) {
      if (!l.title) return;
      var title = el('div', 'lane-title', l.title);
      title.appendChild(el('span', 'n', String(l.count)));
      if (l.id) {
        title.setAttribute('data-lane-id', l.id);
        title.setAttribute('role', 'button');
        title.tabIndex = 0;
        title.setAttribute('aria-label', laneAria(l.title, l.count));
      }
      title.style.left = l.x + 'px';
      title.style.top = '22px';
      title.style.width = l.width + 'px';
      host.appendChild(title);
    });
    // 서버 렌더와 같은 자리다. 띠 이름은 구분선에 걸쳐 단다
    (o.bands || []).forEach(function (b) {
      var bt = el('div', 'band-title', b.band === 0 ? '같이 쓰는 카드' : '');
      if (b.band > 0) {
        bt.appendChild(el('i', 'sw p-' + ((b.band - 1) % PRODUCT_COLORS)));
        bt.appendChild(doc.createTextNode((o.groups[b.band - 1] || '') + ' 전용'));
      }
      bt.setAttribute('data-band', b.band);
      bt.style.left = BAND_TITLE_X + 'px';
      bt.style.top = (b.y + BAND_LINE_Y - BAND_TITLE_HALF) + 'px';
      host.appendChild(bt);
    });
    Object.keys(pos).sort().forEach(function (id) { host.appendChild(o.card(id, pos[id])); });
  }
  function drawColumns(list, host) {
    var NODE_W = 208, ROW_GAP = 20, COL_GAP = 56, LANE_GAP = 96, PAD_X = 32, PAD_TOP = 60, PAD_BOTTOM = 40, LANE_PAD = 20;
    var info = classify(list);
    var ids = {};
    list.forEach(function (e) { ids[e.from] = true; ids[e.to] = true; });
    var cols = {};
    Object.keys(ids).forEach(function (id) {
      var c = columnOf(id, info);
      (cols[c] = cols[c] || []).push(id);
    });
    var order = Object.keys(cols).map(Number).sort(function (a, b) { return a - b; });
    var colX = {};
    var colH = {};
    var lanes = [];
    var x = PAD_X + LANE_PAD;
    var maxH = 0;
    var prevLane = null;
    order.forEach(function (c, i) {
      var lane = laneOfColumn(c);
      if (i > 0) x += NODE_W + (lane === prevLane ? COL_GAP : LANE_GAP);
      colX[c] = x;
      if (lane !== prevLane) lanes.push({ id: lane, left: x, right: x + NODE_W, count: 0 });
      else lanes[lanes.length - 1].right = x + NODE_W;
      lanes[lanes.length - 1].count += cols[c].length;
      cols[c].sort(function (a, b) {
        var la = label(a), lb = label(b);
        return la < lb ? -1 : la > lb ? 1 : a < b ? -1 : a > b ? 1 : 0;
      });
      var h = 0;
      cols[c].forEach(function (id, ri) { h += cardHeight(id) + (ri ? ROW_GAP : 0); });
      colH[c] = h;
      maxH = Math.max(maxH, h);
      prevLane = lane;
    });
    var pos = {};
    order.forEach(function (c) {
      var y = PAD_TOP + (maxH - colH[c]) / 2;
      cols[c].forEach(function (id) {
        pos[id] = { x: colX[c], y: y, w: NODE_W, h: cardHeight(id) };
        y += cardHeight(id) + ROW_GAP;
      });
    });
    drawCanvas(host, {
      pos: pos,
      edges: list.map(function (e) { return { id: e.id, from: e.from, to: e.to, kind: e.kind, count: 1, lineStyle: e.lineStyle }; }),
      lanes: lanes.map(function (l) {
        return { x: l.left - LANE_PAD, width: l.right - l.left + LANE_PAD * 2, id: l.id, title: LANE_TITLE[l.id] || '', count: l.count };
      }),
      width: x + NODE_W + LANE_PAD + PAD_X,
      height: PAD_TOP + maxH + PAD_BOTTOM,
      label: '두 항목 사이 연결',
      card: function (id, p) { return buildCard(id, p.x, p.y, p.w, p.h); },
    });
  }
  function evidenceCell(list) {
    var td = el('td');
    if (!list.length) { td.textContent = '-'; return td; }
    list.forEach(function (ev) {
      td.appendChild(el('span', 'loc', ev.location === undefined ? evidenceText(ev.type) + ' (공유본이라 가렸어요)' : evidenceText(ev.type) + ' ' + ev.location));
    });
    return td;
  }
  function drawPair(memberIds, title) {
    closeDrawer(false);
    sections.forEach(function (s) { s.hidden = true; });
${c.sequences ? '    seqLeave();\n' : ''}    clearFocus();
    pair.hidden = false;
    pair.textContent = '';
    pair._cards = null;
    pair._links = null;
    active = pair;
    var items = trailItems(current);
    items.push({ label: title });
    renderCrumbs(items);
    var list = memberIds.map(function (id) { return edges[id]; }).filter(Boolean);
    if (!list.length) {
      pair.setAttribute('data-w', '560');
      pair.setAttribute('data-h', '240');
      pair.style.width = '560px';
      pair.style.height = '240px';
      pair.appendChild(el('p', 'empty-state', '두 항목은 서로 이어져 있지 않아요.'));
      sheet.hidden = true;
      fit('smart');
      return;
    }
    drawColumns(list, pair);
    sheetTitle.textContent = '세부 연결 ' + list.length + '개';
    sheetBody.textContent = '';
    var table = el('table');
    var head = el('tr');
    ['연결', '어디서 → 어디로', '출처'].forEach(function (h) { head.appendChild(el('th', null, h)); });
    table.appendChild(head);
    list.forEach(function (e) {
      var tr = el('tr');
      tr.appendChild(el('td', null, kindText(e.kind) + (e.actions ? ' (' + e.actions.join(', ') + ')' : '')));
      tr.appendChild(el('td', null, label(e.from) + ' → ' + label(e.to)));
      tr.appendChild(evidenceCell(e.evidence));
      table.appendChild(tr);
    });
    sheetBody.appendChild(table);
    sheet.open = false;
    sheet.hidden = false;
    fit('smart');
    runSearch(false);
  }
  // 포커스 화면. 레벨에 그려 둔 카드 자리를 그대로 가져와 남는 카드만 레인 안에서 위로 당겨 쌓는다.
  // 레인 x와 순서를 지켜야 원래 그림에서 보던 자리 감각이 이어진다
  function levelIdOf(c) {
    if (!c) return null;
    return c.getAttribute('data-level-id') || c.getAttribute('data-focus-level');
  }
  function levelEdges(levelId) {
    if (!drill) return data.edges.map(function (e) { return { id: e.id, from: e.from, to: e.to, kind: e.kind, count: 1, lineStyle: e.lineStyle, backward: !!BACKWARD[e.kind] }; });
    return levels[levelId].edges;
  }
  function syncFocusBtn() {
    focusBtn.hidden = !(selectedId && !isStep(selectedId) && selectedId !== focusId && pair.hidden && cardMap(sectionOf(current))[selectedId]);
  }
  function clearFocus() {
    focusId = null;
    focusSec.hidden = true;
    focusSec.textContent = '';
    focusSec._cards = null;
    focusSec._links = null;
    focusSec.removeAttribute('data-focus-level');
    focusChip.hidden = true;
    syncFocusBtn();
  }
  function showFocus(id) {
    if (!id) return;
    go('#/focus/' + enc(current) + '/' + enc(id));
  }
  function renderFocus(levelId, nodeId) {
    if (!levels[levelId]) return false;
    var src = sectionOf(levelId);
    if (!src || !cardMap(src)[nodeId]) return false;
    renderLevel(levelId);
    var all = levelEdges(levelId);
    var set = focusSet(all, nodeId);
    var keep = {};
    set.nodes.forEach(function (n) { if (n === nodeId || !envHidden(n)) keep[n] = true; });
    var keptEdge = {};
    set.edges.forEach(function (e) { keptEdge[e] = true; });
    var boxes = [];
    var top = Infinity;
    src.querySelectorAll('.node').forEach(function (c) {
      var b = { id: c.getAttribute('data-node-id'), x: parseFloat(c.style.left), y: parseFloat(c.style.top), w: parseFloat(c.style.width), h: parseFloat(c.style.height) };
      boxes.push(b);
      top = Math.min(top, b.y);
    });
    var names = src.getAttribute('data-regions');
    var banded = null;
    if (names) {
      var bandOf = {};
      var shareOf = {};
      src.querySelectorAll('.node[data-band]').forEach(function (c) {
        var id = c.getAttribute('data-node-id');
        bandOf[id] = Number(c.getAttribute('data-band'));
        var ps = c.getAttribute('data-products');
        if (ps) shareOf[id] = ps.split(' ').length;
      });
      banded = focusBandLayout(boxes, keep, top, 24, bandOf, shareOf);
    }
    var pos = banded ? banded.pos : focusLayout(boxes, keep, top, 24);
    var bottom = top;
    Object.keys(pos).forEach(function (id) { bottom = Math.max(bottom, pos[id].y + pos[id].h); });
    if (banded && banded.bottom) bottom = Math.max(bottom, banded.bottom);
    // 남은 카드가 둘 이상인 테두리만 다시 두른다. 한 장만 남으면 무엇을 묶는지 안 보인다
    var frameCards = {};
    src.querySelectorAll('.node[data-frame]').forEach(function (c) {
      var id = c.getAttribute('data-node-id');
      if (!pos[id]) return;
      var f = c.getAttribute('data-frame');
      (frameCards[f] = frameCards[f] || []).push(pos[id]);
    });
    var frames = Object.keys(frameCards).sort().filter(function (f) { return frameCards[f].length > 1; }).map(function (f) {
      var list = frameCards[f];
      var x0 = Math.min.apply(null, list.map(function (p) { return p.x; })) - FRAME_PAD;
      var y0 = Math.min.apply(null, list.map(function (p) { return p.y; })) - FRAME_PAD;
      var x1 = Math.max.apply(null, list.map(function (p) { return p.x + p.w; })) + FRAME_PAD;
      var y1 = Math.max.apply(null, list.map(function (p) { return p.y + p.h; })) + FRAME_PAD;
      return { id: f, x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    });
    var rects = src.querySelectorAll('rect.lane');
    var titles = src.querySelectorAll('.lane-title');
    var lanes = [];
    Array.prototype.forEach.call(rects, function (r, i) {
      var x = parseFloat(r.getAttribute('x'));
      var w = parseFloat(r.getAttribute('width'));
      var n = 0;
      Object.keys(pos).forEach(function (id) { if (pos[id].x >= x && pos[id].x < x + w) n += 1; });
      if (!n) return;
      var t = titles[i];
      lanes.push({ id: t ? t.getAttribute('data-lane-id') : null, x: x, width: w, title: t ? t.firstChild.textContent : '', count: n });
    });
    var cards = cardMap(src);
    src.hidden = true;
${c.sequences ? '    seqLeave();\n' : ''}    focusSec.textContent = '';
    focusSec._cards = null;
    focusSec._links = null;
    focusSec.setAttribute('data-focus-level', levelId);
    if (names) focusSec.setAttribute('data-regions', names);
    else focusSec.removeAttribute('data-regions');
    focusSec.setAttribute('aria-label', label(nodeId) + ' 포커스');
    drawCanvas(focusSec, {
      pos: pos,
      edges: all.filter(function (e) { return keptEdge[e.id]; }),
      lanes: lanes,
      bands: banded && banded.bands ? banded.bands : null,
      groups: names ? JSON.parse(names) : [],
      frames: frames,
      width: parseFloat(src.getAttribute('data-w')),
      height: bottom + 40,
      label: '이어진 연결: ' + label(nodeId),
      card: function (id, p) {
        var c = cards[id].cloneNode(true);
        c.classList.remove('selected', 'anchor', 'lit', 'hit', 'current');
        var more = c.querySelector('.pb.more');
        if (more) more.setAttribute('aria-expanded', 'false');
        if (id === nodeId) c.classList.add('focus-root');
        c.style.top = p.y + 'px';
        return c;
      },
    });
    focusSec.hidden = false;
    active = focusSec;
    focusId = nodeId;
    focusName.textContent = label(nodeId);
    focusChip.hidden = false;
    syncFocusBtn();
    fit('smart');
    runSearch(false);
    return true;
  }
  function releaseFocus() {
    if (focusId === null) return false;
    showLevel(current);
    return true;
  }
  focusBtn.addEventListener('click', function () { showFocus(selectedId); });
  byId('focus-clear').addEventListener('click', releaseFocus);
  function showPair(a, b) {
    go('#/pair/' + enc(a) + '/' + enc(b));
  }
  function renderPair(a, b) {
    if (!nodes[a] || !nodes[b]) return false;
    renderLevel('root');
    drawPair(pathMembers(a, b), label(a) + ' ↔ ' + label(b));
    return true;
  }
  function renderBundle(levelId, bundleId) {
    var level = levels[levelId];
    var bundle = level && level.edgeById[bundleId];
    if (!bundle) return false;
    renderLevel(levelId);
    drawPair(bundle.memberEdgeIds, label(bundle.from) + ' → ' + label(bundle.to)${c.mixedBundles ? MIXED_PANEL_NOTE : ''});
    return true;
  }
  function route() {
    var raw = location.hash.charAt(0) === '#' ? location.hash.slice(1) : location.hash;
    var q = raw.indexOf('?');
    var query = q >= 0 ? raw.slice(q + 1) : '';
    if (q >= 0) raw = raw.slice(0, q);
    setEnv(envFromQuery(query));
    // 기본값과 같거나 모르는 환경만 적힌 주소는 정리해 둔다. 같은 화면이 주소 두 개로 갈리지 않게 한다
    if ((q >= 0 ? '?' + query : '') !== envQuery()) history.replaceState(null, '', '#' + raw + envQuery());
    if (raw.charAt(0) === '/') raw = raw.slice(1);
    var parts = raw.split('/').map(function (p) {
      try { return decodeURIComponent(p); } catch (e) { return ''; }
    });
    var ok = false;
    if (drill) {
      if (parts[0] === 'level' && parts.length === 2 && levels[parts[1]]) { renderLevel(parts[1]); ok = true; }
      else if (parts[0] === 'pair' && parts.length === 3) ok = renderPair(parts[1], parts[2]);
      else if (parts[0] === 'bundle' && parts.length === 3) ok = renderBundle(parts[1], parts[2]);
    }
    if (parts[0] === 'focus' && parts.length === 3) ok = renderFocus(parts[1], parts[2]);
    if (!ok) {
      renderLevel('root');
      // 모르는 주소는 기록을 남기지 않고 전체로 바꿔 둔다. 남기면 뒤로가기가 같은 자리를 한 번 더 밟는다
      if (location.hash && location.hash !== '#/' + envQuery()) history.replaceState(null, '', '#/' + envQuery());
    }
    if (pendingSelect) {
      var id = pendingSelect;
      pendingSelect = null;
      focusCard(id);
    }
  }

  // 검색. 지금 보이는 화면의 카드만 찾는다
  var hits = [];
  var hitAt = -1;
  function runSearch(move) {
    if (active) {
      active.classList.remove('searching');
      active.querySelectorAll('.node.hit').forEach(function (c) { c.classList.remove('hit'); c.classList.remove('current'); });
    }
    hits = [];
    hitAt = -1;
    var q = search.value.trim().toLowerCase();
    if (!q || !active) { searchCount.textContent = ''; return; }
    active.querySelectorAll('.node').forEach(function (c) {
      var n = nodes[c.getAttribute('data-node-id')];
      if (!n || c.classList.contains('env-off')) return;
      var hay = ((n.displayName || '') + ' ' + n.label${c.docs ? DOC_HAY : ''}).toLowerCase();
      if (hay.indexOf(q) >= 0) hits.push(c);
    });
    hits.sort(function (a, b) { return a.offsetLeft - b.offsetLeft || a.offsetTop - b.offsetTop; });
    active.classList.add('searching');
    hits.forEach(function (c) { c.classList.add('hit'); });
    if (!hits.length) { searchCount.textContent = '없음'; return; }
    if (move) stepSearch(1);
    else searchCount.textContent = hits.length + '개';
  }
  function stepSearch(dir) {
    if (!hits.length) return;
    if (hitAt >= 0) hits[hitAt].classList.remove('current');
    hitAt = (hitAt + dir + hits.length) % hits.length;
    var c = hits[hitAt];
    c.classList.add('current');
    centerOn(c, 0.8);
    searchCount.textContent = (hitAt + 1) + '/' + hits.length;
  }
  search.addEventListener('input', function () { runSearch(true); });
  search.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); stepSearch(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.stopPropagation(); search.value = ''; runSearch(false); search.blur(); }
  });

  // 범례와 질문 팝오버
  var pops = [];
  function placePop(btn, pop) {
    var r = btn.getBoundingClientRect();
    pop.style.top = Math.round(r.bottom + 6) + 'px';
    var left = Math.min(window.innerWidth - pop.offsetWidth - 8, r.right - pop.offsetWidth);
    pop.style.left = Math.max(8, Math.round(left)) + 'px';
  }
  function anyPop() { return pops.some(function (p) { return !p.pop.hidden; }); }
  function closePops(restore) {
    pops.forEach(function (p) {
      if (p.pop.hidden) return;
      p.pop.hidden = true;
      p.btn.setAttribute('aria-expanded', 'false');
      if (restore) p.btn.focus();
    });
  }
  function setupPop(btnId, popId) {
    var btn = byId(btnId);
    var pop = byId(popId);
    if (!btn || !pop) return;
    pops.push({ btn: btn, pop: pop });
    btn.addEventListener('click', function () {
      var willOpen = pop.hidden;
      closePops(false);
      if (!willOpen) return;
      pop.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      placePop(btn, pop);
      pop.focus();
    });
  }
  setupPop('legend-btn', 'legend');
  setupPop('q-btn', 'questions');
${c.views ? VIEW_POP : ''}  // 흐름 단추는 서비스 아래 레벨에서만 보인다. 흐름이 하나면 바로 가고 여럿이면 고르게 한다
  var flowBtn = byId('flow-btn');
  var flowPop = byId('flow-pop');
  function flowsHere() {
    var lv = levels[current];
    var svc = lv && lv.kind !== 'flow' && lv.trail[1] && lv.trail[1].indexOf('service:') === 0 ? lv.trail[1].slice(8) : null;
    return svc ? flowsBySvc[svc] || [] : ${c.rootFlows ? ROOT_FLOWS : '[]'};
  }
  function syncFlowBtn() {
    if (flowBtn) flowBtn.hidden = flowsHere().length === 0;
  }
  if (flowBtn && flowPop) {
    pops.push({ btn: flowBtn, pop: flowPop });
    flowBtn.addEventListener('click', function () {
      var list = flowsHere();
      if (list.length === 1) { closePops(false); showLevel(list[0].level); return; }
      var willOpen = flowPop.hidden;
      closePops(false);
      if (!willOpen) return;
      var ul = flowPop.querySelector('.flow-list');
      ul.textContent = '';
      list.forEach(function (f) {
        var li = el('li');
        var b = el('button', null, f.title);
        b.type = 'button';
        b.addEventListener('click', function () { closePops(false); showLevel(f.level); });
        li.appendChild(b);
        ul.appendChild(li);
      });
      flowPop.hidden = false;
      flowBtn.setAttribute('aria-expanded', 'true');
      placePop(flowBtn, flowPop);
      flowPop.focus();
    });
  }
  doc.addEventListener('pointerdown', function (e) {
    if (!productMenu.hidden && !(e.target.closest && e.target.closest('.pmenu, .pb.more'))) closeProducts(false);
    if (!anyPop()) return;
    if (e.target.closest && (e.target.closest('.pop') || e.target.closest('[aria-controls]'))) return;
    closePops(false);
  });
  window.addEventListener('resize', function () {
    pops.forEach(function (p) { if (!p.pop.hidden) placePop(p.btn, p.pop); });
  });
  function goToNode(id) {
    if (!id) return;
    if (active && cardMap(active)[id]) { focusCard(id); return; }
    var target = null;
    sections.forEach(function (s) { if (!target && cardMap(s)[id]) target = s.getAttribute('data-level-id'); });
    if (!target) return;
    pendingSelect = id;
    showLevel(target);
  }
  byId('questions').addEventListener('click', function (e) {
    var b = e.target.closest('button.q');
    if (!b || b.disabled) return;
    closePops(false);
    goToNode(b.getAttribute('data-node-id'));
  });

  // 처음 쓰는 사람을 위한 안내. 한 번 닫으면 다시 안 띄운다
  if (load(HINT_KEY) === 'off') hint.hidden = true;
  byId('hint-close').addEventListener('click', function () {
    hint.hidden = true;
    store(HINT_KEY, 'off');
  });

  doc.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
${c.sequences ? '      seqStop();\n' : ''}      if (!productMenu.hidden) { closeProducts(true); return; }
      if (anyPop()) { closePops(true); return; }
      if (drawerOpen()) { closeDrawer(true); return; }
      releaseFocus();
      return;
    }
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
${c.sequences ? SEQ_KEYS : ''}    if (e.key === '/') { e.preventDefault(); search.focus(); search.select(); }
    else if (e.key === '+' || e.key === '=') zoomBy(1.25);
    else if (e.key === '-' || e.key === '_') zoomBy(0.8);
    else if (e.key === '0') fit('full');
    else if ((e.key === 'f' || e.key === 'F') && !focusBtn.hidden) showFocus(selectedId);
  });

  // 환경 고르기. 서버가 그린 자리는 그대로 두고 고르지 않은 환경의 카드와 거기 걸린 선만 숨긴다.
  // 환경이 prod부터 위에서 아래로 쌓여 있어서 prod만 남겨도 열 중간에 빈 자리가 안 생긴다
  var envPicker = byId('env-picker');
  var envOn = {};
  function envHidden(id) {
    var n = nodes[id];
    return !!(envPicker && n && n.environment && !envOn[n.environment]);
  }
  function applyEnv(sec) {
    sec.querySelectorAll('.node[data-env]').forEach(function (c) {
      c.classList.toggle('env-off', !envOn[c.getAttribute('data-env')]);
    });
    sec.querySelectorAll('.link').forEach(function (l) {
      l.classList.toggle('env-off', envHidden(l.getAttribute('data-from')) || envHidden(l.getAttribute('data-to')));
    });
    // 레인 제목 숫자는 보이는 카드만 센다. 다 숨으면 빈 레인도 같이 접는다
    var cards = sec.querySelectorAll('.node');
    var titles = sec.querySelectorAll('.lane-title');
    Array.prototype.forEach.call(sec.querySelectorAll('rect.lane'), function (r, i) {
      var t = titles[i];
      var x = parseFloat(r.getAttribute('x'));
      var w = parseFloat(r.getAttribute('width'));
      var n = 0;
      Array.prototype.forEach.call(cards, function (c) {
        var left = parseFloat(c.style.left);
        if (left >= x && left < x + w && !c.classList.contains('env-off')) n += 1;
      });
      r.classList.toggle('env-off', n === 0);
      if (!t) return;
      t.classList.toggle('env-off', n === 0);
      var count = t.querySelector('.n');
      if (count) count.textContent = n;
      if (t.hasAttribute('data-lane-id')) t.setAttribute('aria-label', laneAria(t.firstChild.textContent, n));
    });
  }
  // 고른 환경은 주소 해시 뒤 ?env=prod,dev로 싣는다. 주소를 보내면 받은 사람도 같은 환경으로 본다.
  // 처음 켜진 값(prod만)과 같으면 안 붙여서 환경 버튼이 생기기 전 주소와 같게 둔다
  var envButtons = envPicker ? Array.prototype.slice.call(envPicker.querySelectorAll('button[data-env]')) : [];
  var envDefault = {};
  envButtons.forEach(function (b) {
    var name = b.getAttribute('data-env');
    envDefault[name] = b.getAttribute('aria-pressed') === 'true';
    envOn[name] = envDefault[name];
  });
  function envNames() { return envButtons.map(function (b) { return b.getAttribute('data-env'); }); }
  function envQuery() {
    if (!envButtons.length) return '';
    var names = envNames();
    if (names.every(function (n) { return envOn[n] === envDefault[n]; })) return '';
    return '?env=' + names.filter(function (n) { return envOn[n]; }).map(enc).join(',');
  }
  function envFromQuery(query) {
    var m = /(?:^|&)env=([^&]*)/.exec(query);
    if (!m) return envDefault;
    var want = {};
    var any = false;
    m[1].split(',').forEach(function (p) {
      var name;
      try { name = decodeURIComponent(p); } catch (e) { return; }
      if (Object.prototype.hasOwnProperty.call(envDefault, name)) { want[name] = true; any = true; }
    });
    return any ? want : envDefault;
  }
  function setEnv(next) {
    var changed = false;
    envButtons.forEach(function (b) {
      var name = b.getAttribute('data-env');
      var on = !!next[name];
      if (envOn[name] !== on) changed = true;
      envOn[name] = on;
      b.setAttribute('aria-pressed', String(on));
    });
    if (changed) sections.forEach(applyEnv);
  }
  if (envPicker) {
    sections.forEach(applyEnv);
    envPicker.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-env]') : null;
      if (!b) return;
      var env = b.getAttribute('data-env');
      // 하나는 늘 켜 둔다. 다 끄면 인프라 열이 통째로 비어 무엇을 끈 건지 안 보인다
      if (envOn[env] && envNames().filter(function (n) { return envOn[n]; }).length === 1) return;
      var next = {};
      envNames().forEach(function (n) { next[n] = n === env ? !envOn[n] : envOn[n]; });
      setEnv(next);
      // 환경을 바꾼 건 뒤로가기 기록으로 남기지 않는다. 뒤로가기는 레벨을 오간 길만 되짚는 게 덜 헷갈린다
      var h = location.hash;
      var at = h.indexOf('?');
      history.replaceState(null, '', (at >= 0 ? h.slice(0, at) : h || '#/') + envQuery());
      if (focusId !== null) route();
      else runSearch(false);
    });
  }

  window.addEventListener('hashchange', route);
  route();
  ready = true;
})();
`;
}
