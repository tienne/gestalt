import { THEME_BOOT_JS, THEME_SWITCH_JS, digestThemeCss } from '../digest/theme-color.js';
import { THEME_POP_CSS, graphThemePicker } from '../graph-viz/theme.js';

export const VIEWER_WARNING = '비밀값 패턴은 가리지만 전부 잡지는 못해요.';

/** 뷰어 화면에 그릴 입력. 원격 공유를 볼 때만 켜진다 */
export interface ViewerAbilities {
  /** 주인 세션에 메시지 넣기 */
  canSend?: boolean;
  /** 주인 세션 모델의 질문에 답하기 */
  canAnswer?: boolean;
  /** 고른 줄을 내 세션에 발췌로 넘기기 */
  canExcerpt?: boolean;
}

/**
 * 뷰어 페이지. 바깥 자원을 하나도 안 끌어온다 — CSP가 `default-src 'none'`이라
 * 인라인 스크립트와 스타일도 nonce가 맞는 것만 돈다.
 *
 * 대화 내용은 전부 textContent로 넣는다. 마크다운을 HTML로 그리면 남의 도구 출력에
 * 든 태그가 이 페이지에서 실행될 길이 생긴다. 대화 내용은 localStorage나 IndexedDB에 안 남긴다.
 * localStorage에는 테마 선택(배경, 강조색 id)만 들어간다.
 *
 * 발췌는 고른 줄의 번호와 펼쳤는지만 보낸다. 글자는 보는 쪽 데몬이 들고 있는 이벤트에서 다시 만든다.
 * 32KB 검사는 여기서 한 번 하고 데몬이 정리한 본문으로 한 번 더 한다.
 */
export function renderViewerHtml(
  nonce: string,
  maxViewers: number,
  { canSend = false, canAnswer = false, canExcerpt = false }: ViewerAbilities = {},
): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>gestalt peer</title>
<style nonce="${nonce}">${digestThemeCss()}${THEME_POP_CSS}</style>
<style nonce="${nonce}">
  body { font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0;
    background: var(--bg); color: var(--fg); }
  header { position: sticky; top: 0; padding: 10px 16px; border-bottom: 1px solid var(--line);
    background: var(--bg); z-index: 1; }
  .head-row { display: flex; align-items: flex-start; gap: 12px; }
  header h1 { font-size: 15px; margin: 0 0 4px; flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .warn { color: var(--gestalt-color-warning-text); font-size: 13px; }
  .meta { color: var(--muted); font-size: 12px; display: flex; gap: 12px; flex-wrap: wrap; align-items: center;
    min-height: 20px; }
  /* 연결 상태는 글자가 먼저고 점은 거든다. 색을 못 구분해도 문구로 읽힌다 */
  #status::before { content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    margin-right: 6px; vertical-align: 1px; background: var(--muted); }
  #status[data-state="live"]::before { background: var(--gestalt-color-success-text); }
  #status[data-state="waiting"]::before { background: var(--gestalt-color-info-text); }
  #status[data-state="missing"]::before, #status[data-state="truncated"]::before,
  #status[data-state="offline"]::before, #status[data-state="retry"]::before {
    background: var(--gestalt-color-warning-text); }
  #status[data-state="closed"]::before, #status[data-state="lost"]::before {
    background: var(--gestalt-color-danger-text); }
  #fresh { font: inherit; font-size: 12px; color: var(--accent); background: var(--card);
    border: 1px solid currentColor; border-radius: 999px; padding: 0 8px; line-height: 18px;
    cursor: pointer; }
  #fresh[hidden] { display: none; }
  time { font-variant-numeric: tabular-nums; }
  textarea, select, button { font: inherit; color: var(--fg); background: var(--bg);
    border: 1px solid var(--line); border-radius: 6px; }
  button { padding: 4px 10px; cursor: pointer; }
  :focus-visible { outline: 2px solid var(--gestalt-color-focus); outline-offset: 2px; }
  main { padding: 12px 16px 48px; max-width: 980px; }
  .ev { margin: 10px 0; }
  .who { font-size: 12px; color: var(--muted); }
  .text { white-space: pre-wrap; word-break: break-word; }
  .prompt .text { border-left: 3px solid var(--gestalt-color-series-2); padding-left: 8px; }
  details:not(.theme-pop) { border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; }
  details pre { white-space: pre-wrap; word-break: break-word; font-size: 12px; margin: 6px 0 2px; }
  summary { cursor: pointer; font-size: 13px; }
  .error summary { color: var(--gestalt-color-danger-text); }
  .note { color: var(--muted); font-style: italic; font-size: 13px; }
  .peer_message .text { border-left: 3px solid var(--gestalt-color-series-3); padding-left: 8px; }
  .peer_answer .text { border-left: 3px solid var(--gestalt-color-series-4); padding-left: 8px; }
  .ask { border: 1px solid var(--gestalt-color-series-4); border-radius: 6px; padding: 8px 10px; }
  .ask form { display: flex; gap: 8px; margin-top: 6px; }
  .ask form[hidden] { display: none; }
  .ask textarea { flex: 1; min-height: 38px; font: inherit; }
  .ask .state.rejected { color: var(--gestalt-color-danger-text); }
  footer { position: sticky; bottom: 0; padding: 8px 16px; border-top: 1px solid var(--line);
    background: var(--bg); }
  footer form { display: flex; gap: 8px; max-width: 980px; }
  footer textarea { flex: 1; min-height: 38px; font: inherit; }
  #mine { list-style: none; margin: 0 0 6px; padding: 0; font-size: 12px; color: var(--muted);
    max-width: 980px; max-height: 120px; overflow: auto; }
  #mine .rejected { color: var(--gestalt-color-danger-text); }
  .pick { float: left; margin: 3px 8px 0 0; }
  /* 옅은 강조 바탕 위에서는 글자 대비가 보장되지 않아서 표면색 바탕에 왼쪽 선으로 고른 줄을 표시한다 */
  .ev.picked { background: var(--card); box-shadow: inset 3px 0 0 var(--accent); }
  #pickbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 13px;
    margin-top: 6px; }
  #pickbar[hidden] { display: none; }
  #pickbar .over { color: var(--gestalt-color-danger-text); }
  .ev.fresh { animation: peer-live 900ms ease-out; }
  @keyframes peer-live { from { background: color-mix(in srgb, var(--accent) 14%, transparent); } }
  @media (prefers-reduced-motion: reduce) { .ev.fresh { animation: none; } }
  @media (max-width: 640px) {
    header, main, footer { padding-left: 12px; padding-right: 12px; }
    footer form, .ask form { flex-direction: column; }
  }
</style>
<script nonce="${nonce}">${THEME_BOOT_JS}</script>
</head>
<body>
<header>
  <div class="head-row">
    <h1 id="title">gestalt peer</h1>
    ${graphThemePicker()}
  </div>
  <div class="warn">${VIEWER_WARNING}</div>
  <div class="meta">
    <span id="status" data-state="connecting">연결 중</span>
    <span id="unknown"></span>
    <button type="button" id="fresh" aria-live="polite" hidden></button>
  </div>
${
  canExcerpt
    ? `  <div id="pickbar" hidden>
    <span id="picked"></span>
    <select id="dest"><option value="">보낼 내 세션 고르기</option></select>
    <button type="button" id="pick-send">내 세션으로 보내기</button>
    <button type="button" id="pick-clear">고르기 해제</button>
    <span id="pick-msg"></span>
  </div>`
    : ''
}
</header>
<main id="log"></main>
${
  canSend
    ? `<footer>
  <ul id="mine"></ul>
  <form id="send">
    <textarea id="body" maxlength="16000" placeholder="주인 세션에 메시지 넣기. 참고할 정보로 들어가요 (16KB까지, 한글은 5천 자쯤)"></textarea>
    <button type="submit">보내기</button>
  </form>
</footer>`
    : ''
}
<script nonce="${nonce}">
(() => {
  const log = document.getElementById('log');
  const statusEl = document.getElementById('status');
  const unknownEl = document.getElementById('unknown');
  const titleEl = document.getElementById('title');
  const params = new URLSearchParams(location.search);
  const token = params.get('t') || '';
  const base = location.pathname.replace(/\\/$/, '');
  const results = new Map();
  // 발췌 고르기. 번호(seq)마다 그 줄의 상자와 펼침 상태를 들고 있는다
  const CAN_EXCERPT = ${canExcerpt ? 'true' : 'false'};
  const MAX_EXCERPT = 32 * 1024;
  const picks = new Map();
  const calls = new Map();

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const time = (at) => (at ? new Date(at).toLocaleTimeString() : '');
  // 시각은 기계가 읽는 원래 값을 datetime에 같이 둔다. 보이는 글자는 예전과 같다
  const stamp = (tag, cls, label, at) => {
    const n = el(tag, cls, label + ' ');
    if (at) {
      const t = el('time', '', time(at));
      t.dateTime = at;
      n.append(t);
    }
    return n;
  };
  const atBottom = () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 40;

  const STATUS = {
    live: '실시간',
    missing: '대화 기록 파일이 안 보여요',
    truncated: '대화 기록이 줄어들어서 멈췄어요',
    offline: '주인 데몬이 오프라인이에요',
    waiting: '주인 승인을 기다리는 중이에요. 받아 주면 대화가 보여요',
  };
  const CLOSED = {
    removed: '명단에서 빠져 공유가 끊겼어요',
    owner_removed: '주인이 명단에서 빠져 공유가 끊겼어요',
    expired: '공유가 만료됐어요',
    kicked: '주인이 이 공유에서 끊었어요',
    denied: '주인이 거절했어요',
    approval_timeout: '주인이 승인하지 않아 기다리다 끝났어요',
  };

  // 줄 상자 앞에 고르기 칸을 붙인다. entry는 그 줄을 발췌로 만들 때 볼 것들이다
  function pickable(box, seq, entry) {
    if (!CAN_EXCERPT || !seq) return;
    const c = el('input', 'pick');
    c.type = 'checkbox';
    c.title = '발췌로 고르기';
    c.addEventListener('change', () => {
      if (c.checked) picks.set(seq, entry);
      else picks.delete(seq);
      box.classList.toggle('picked', c.checked);
      updatePicks();
    });
    entry.check = c;
    entry.box = box;
    box.prepend(c);
  }

  // 접속하자마자 몰려오는 지난 기록에는 하이라이트를 안 건다. 한 번 조용해진 뒤 붙는 줄만 새 줄이다
  let primed = false;
  let quiet = 0;
  let unseen = 0;
  const freshBtn = document.getElementById('fresh');
  function add(box) {
    log.append(box);
    clearTimeout(quiet);
    quiet = setTimeout(() => (primed = true), 300);
    if (!primed) return;
    box.classList.add('fresh');
    box.addEventListener('animationend', () => box.classList.remove('fresh'), { once: true });
    if (!atBottom()) {
      unseen++;
      freshBtn.textContent = '새 항목 ' + unseen + '개';
      freshBtn.hidden = false;
    }
  }
  function seen() {
    unseen = 0;
    freshBtn.hidden = true;
  }
  freshBtn.addEventListener('click', () => {
    window.scrollTo(0, document.body.scrollHeight);
    seen();
  });
  window.addEventListener('scroll', () => unseen && atBottom() && seen(), { passive: true });

  function render(ev, seq) {
    const box = el('div', 'ev ' + ev.kind);
    if (ev.kind === 'prompt' || ev.kind === 'reply') {
      box.append(stamp('div', 'who', ev.kind === 'prompt' ? '주인' : '모델', ev.at));
      box.append(el('div', 'text', ev.text));
    } else if (ev.kind === 'tool_call') {
      const d = el('details');
      d.append(stamp('summary', '', '도구 ' + ev.name, ev.at));
      if (ev.input !== undefined) d.append(el('pre', '', ev.input));
      const slot = el('div');
      d.append(slot);
      if (ev.id) results.set(ev.id, slot);
      box.append(d);
      const entry = { seq, details: d, name: ev.name, input: ev.input || '', results: [] };
      if (ev.id) calls.set(ev.id, entry);
      pickable(box, seq, entry);
      add(box);
      return;
    } else if (ev.kind === 'tool_result') {
      const d = el('details', ev.isError ? 'error' : '');
      const label = ev.hidden ? '결과 (주인이 숨김)' : ev.isError ? '결과 (에러)' : '결과';
      d.append(el('summary', '', label + (ev.truncated ? ' · 앞부분만' : '')));
      if (!ev.hidden) d.append(el('pre', '', ev.text || ''));
      const slot = ev.toolUseId ? results.get(ev.toolUseId) : undefined;
      // 호출 상자 안에 든 결과는 호출을 고르면 같이 간다. 펼쳐 둔 것만 본문이 들어간다
      if (slot) {
        slot.append(d);
        const call = calls.get(ev.toolUseId);
        if (call) call.results.push({ seq, details: d, text: ev.hidden ? '' : ev.text || '' });
        return;
      }
      box.append(d);
      pickable(box, seq, { seq, details: d, results: [], text: ev.hidden ? '' : ev.text || '' });
      add(box);
      return;
    } else if (ev.kind === 'title') {
      titleEl.textContent = ev.text;
      document.title = ev.text + ' · gestalt peer';
      return;
    } else if (ev.kind === 'sidechain') {
      box.append(el('div', 'note', '서브에이전트 실행 중'));
    } else if (ev.kind === 'compacted') {
      box.append(el('div', 'note', '이전 대화가 압축됐어요'));
    } else if (ev.kind === 'peer_message') {
      const who = ev.origin === 'agent' ? ' 님의 에이전트가' : ' 님이';
      box.append(stamp('div', 'who', '팀원 ' + ev.from + who + ' 넣은 메시지', ev.at));
      box.append(el('div', 'text', ev.text));
    } else if (ev.kind === 'peer_answer') {
      box.append(stamp('div', 'who', '팀원 ' + ev.from + ' 님이 질문에 단 답 (서명 확인)', ev.at));
      box.append(el('div', 'text', ev.text));
    } else {
      return;
    }
    pickable(box, seq, { seq, text: ev.text || '' });
    add(box);
  }

  const pickbar = document.getElementById('pickbar');
  const pickedEl = document.getElementById('picked');
  const dest = document.getElementById('dest');
  const pickMsg = document.getElementById('pick-msg');

  // 데몬에 보낼 고른 줄. 도구 호출은 펼쳐 둔 채 골랐을 때만 입력이 들어가고 그 안의 결과는 호출과 결과를
  // 다 펼쳤을 때만 본문이 들어간다
  // 줄마다 바이트 수는 처음 잴 때 한 번만 센다. 고르거나 접고 펼 때마다 다시 인코딩하지 않는다
  const encoder = new TextEncoder();
  const sizeOf = (o, key) => {
    const k = key + 'Bytes';
    if (o[k] === undefined) o[k] = encoder.encode(o[key] || '').length;
    return o[k];
  };
  function pickedItems() {
    const items = [];
    let bytes = 0;
    for (const seq of [...picks.keys()].sort((a, b) => a - b)) {
      const e = picks.get(seq);
      const open = e.details ? e.details.open : true;
      items.push({ seq, open });
      if (e.name !== undefined) bytes += sizeOf(e, 'name') + (open ? sizeOf(e, 'input') : 0);
      else if (open) bytes += sizeOf(e, 'text');
      for (const r of e.results || []) {
        const ropen = open && r.details.open;
        items.push({ seq: r.seq, open: ropen });
        if (ropen) bytes += sizeOf(r, 'text');
      }
    }
    return { items, bytes };
  }

  let overShown = false;
  function updatePicks() {
    if (!pickbar) return;
    pickbar.hidden = picks.size === 0;
    const { bytes } = pickedItems();
    const over = bytes > MAX_EXCERPT;
    pickedEl.textContent = picks.size + '줄 고름 · ' + Math.ceil(bytes / 1024) + 'KB';
    pickedEl.className = over ? 'over' : '';
    if (over) pickMsg.textContent = '발췌가 32KB를 넘어요. 더 좁게 골라 주세요';
    else if (overShown) pickMsg.textContent = '';
    overShown = over;
    // 세션 목록은 처음 고를 때 한 번 읽고 그 뒤로는 목록을 열 때만 다시 읽는다
    if (picks.size > 0 && !sessionsAsked) loadSessions();
  }

  let sessionsAsked = false;
  let sessionsLoading = false;
  function loadSessions() {
    sessionsAsked = true;
    if (sessionsLoading) return;
    sessionsLoading = true;
    fetch(base + '/sessions?t=' + encodeURIComponent(token), { cache: 'no-store' })
      .finally(() => (sessionsLoading = false))
      .then((r) => r.json())
      .then((j) => {
        const keep = dest.value;
        while (dest.options.length > 1) dest.remove(1);
        for (const s of j.sessions || []) {
          const o = el('option', '', s.cwd + ' · ' + s.sessionId.slice(0, 8));
          o.value = s.sessionId;
          dest.append(o);
        }
        if (keep) dest.value = keep;
        if ((j.sessions || []).length === 0) pickMsg.textContent = '발췌를 받을 내 세션이 안 보여요';
      })
      .catch(() => (pickMsg.textContent = '내 세션 목록을 못 읽었어요'));
  }

  function clearPicks() {
    for (const e of picks.values()) {
      e.check.checked = false;
      e.box.classList.remove('picked');
    }
    picks.clear();
    updatePicks();
  }

  if (pickbar) {
    // 고른 줄 안의 상자를 접고 펼 때만 크기를 다시 잰다. toggle은 거품이 안 올라와서 캡처로 받는다.
    // 고른 뒤에 도착한 결과도 그 줄 상자 안에 붙으므로 closest로 거른다
    document.addEventListener(
      'toggle',
      (ev) => ev.target.closest && ev.target.closest('.picked') && updatePicks(),
      true,
    );
    dest.addEventListener('focus', loadSessions);
    document.getElementById('pick-clear').addEventListener('click', clearPicks);
    document.getElementById('pick-send').addEventListener('click', () => {
      const { items, bytes } = pickedItems();
      if (items.length === 0) return;
      if (bytes > MAX_EXCERPT) {
        pickMsg.textContent = '발췌가 32KB를 넘어요. 더 좁게 골라 주세요';
        return;
      }
      if (!dest.value) {
        pickMsg.textContent = '보낼 내 세션을 골라 주세요';
        return;
      }
      fetch(base + '/excerpts?t=' + encodeURIComponent(token), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: dest.value, items }),
        cache: 'no-store',
      })
        .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
        .then(({ ok, j }) => {
          if (!ok) {
            pickMsg.textContent = '못 보냈어요: ' + (j.error || '');
            return;
          }
          clearPicks();
          pickMsg.textContent = '내 세션에 넣었어요. 그 세션의 수신 규칙에 따라 승인을 기다릴 수 있어요';
        })
        .catch(() => (pickMsg.textContent = '못 보냈어요'));
    });
  }

  const eventsUrl = base + '/events?t=' + encodeURIComponent(token);
  const es = new EventSource(eventsUrl);
  es.addEventListener('line', (m) => {
    const stick = atBottom();
    render(JSON.parse(m.data), Number(m.lastEventId) || 0);
    if (stick) window.scrollTo(0, document.body.scrollHeight);
  });
  es.addEventListener('trimmed', (m) => {
    const n = JSON.parse(m.data).dropped;
    log.append(el('div', 'ev note', '메모리 상한에 걸려 앞부분 ' + n + '개를 생략했어요'));
  });
  es.addEventListener('stats', (m) => {
    const n = JSON.parse(m.data).unknownLines;
    unknownEl.textContent = n > 0 ? '모르는 줄 ' + n + '개 건너뜀' : '';
  });
  es.addEventListener('state', (m) => {
    const st = JSON.parse(m.data).status;
    statusEl.textContent = STATUS[st] || '';
    statusEl.dataset.state = Object.hasOwn(STATUS, st) ? st : '';
  });
  es.addEventListener('closed', (m) => {
    const closed = JSON.parse(m.data);
    // 원격 공유의 reason은 주인 데몬이 보낸 글자다. 프로토타입 이름이 들어와도 안 걸리게 자기 키만 본다
    statusEl.textContent = Object.hasOwn(CLOSED, closed.reason) ? CLOSED[closed.reason] : '공유가 종료됐어요';
    statusEl.dataset.state = 'closed';
    const missed = closed.missed;
    if (missed > 0) {
      log.append(el('div', 'ev note', '공유가 종료돼 뒤쪽 ' + missed + '개는 못 받았어요'));
    }
    es.close();
  });
  const MSG = {
    queued: '주인 오프라인이라 릴레이가 들고 있어요',
    sent: '주인 데몬에 보냈어요',
    arrived: '주인 데몬이 받았어요',
    inserted: '주인 세션에 넣었어요. 주인이 보류했으면 여기서 멈춰요',
    delivered: '주인 세션에 들어갔어요',
    rejected: '거절됐어요',
  };
  const mine = document.getElementById('mine');
  const rows = new Map();
  es.addEventListener('msg', (m) => {
    if (!mine) return;
    const d = JSON.parse(m.data);
    let li = rows.get(d.id);
    if (!li) {
      li = el('li');
      rows.set(d.id, li);
      mine.append(li);
    }
    li.className = d.status;
    const label = Object.hasOwn(MSG, d.status) ? MSG[d.status] : d.status;
    li.textContent = label + (d.reason ? ' (' + d.reason + ')' : '') + ' · ' + d.text.slice(0, 60);
    mine.scrollTop = mine.scrollHeight;
  });
  // 주인 세션 모델이 나에게 물은 질문. 답하면 보는 쪽 데몬이 기기 키로 서명해 보낸다
  const ASK = {
    open: '답을 기다려요',
    queued: '답을 보냈어요. 주인 오프라인이라 릴레이가 들고 있어요',
    sent: '답을 주인 데몬에 보냈어요',
    inserted: '답을 주인 세션에 넣었어요',
    delivered: '답이 주인 세션에 들어갔어요',
    rejected: '답이 거절됐어요',
    closed: '질문이 끝났어요',
  };
  const CLOSED_ASK = { answered: '다른 사람이 먼저 답했어요', expired: '시한이 지났어요' };
  const asks = new Map();
  es.addEventListener('ask', (m) => {
    const d = JSON.parse(m.data);
    let a = asks.get(d.id);
    if (!a) {
      const box = el('div', 'ev ask');
      box.append(el('div', 'who', '주인 세션 모델의 질문 · ' + new Date(d.expiresAt).toLocaleTimeString() + '까지'));
      box.append(el('div', 'text', d.text));
      const state = el('div', 'state');
      box.append(state);
      let form = null;
      if (${canAnswer ? 'true' : 'false'}) {
        form = el('form');
        const input = el('textarea');
        input.maxLength = 16000;
        input.placeholder = '답 쓰기. 내 기기 키로 서명해서 보내요';
        const button = el('button', '', '답하기');
        button.type = 'submit';
        form.append(input, button);
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          const text = input.value.trim();
          if (!text) return;
          if (new TextEncoder().encode(text).length > 16 * 1024) {
            state.textContent = '답이 16KB를 넘어요. 줄여서 보내 주세요';
            return;
          }
          fetch(base + '/answers?t=' + encodeURIComponent(token), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question: d.id, text }),
            cache: 'no-store',
          })
            .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
            .then(({ ok, j }) => {
              if (!ok) state.textContent = '답을 못 보냈어요: ' + (j.error || '');
            })
            .catch(() => (state.textContent = '답을 못 보냈어요'));
        });
        box.append(form);
      }
      a = { state, form };
      asks.set(d.id, a);
      const stick = atBottom();
      log.append(box);
      if (stick) window.scrollTo(0, document.body.scrollHeight);
    }
    a.state.className = 'state ' + d.state;
    let label = Object.hasOwn(ASK, d.state) ? ASK[d.state] : d.state;
    if (d.state === 'closed' && d.reason && Object.hasOwn(CLOSED_ASK, d.reason)) label = CLOSED_ASK[d.reason];
    else if (d.reason) label += ' (' + d.reason + ')';
    a.state.textContent = label;
    // 주인이 답을 못 넣어 질문을 다시 열면 open으로 돌아온다. 그때 입력을 다시 보인다
    if (a.form) a.form.hidden = d.state !== 'open';
  });
  const form = document.getElementById('send');
  if (form) {
    const bodyEl = document.getElementById('body');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = bodyEl.value.trim();
      if (!text) return;
      // maxlength는 글자 수라 한글이면 16KB를 넘긴다. 서버에 보내기 전에 바이트로 한 번 본다
      if (new TextEncoder().encode(text).length > 16 * 1024) {
        statusEl.textContent = '메시지가 16KB를 넘어요. 줄여서 보내 주세요';
        return;
      }
      fetch(base + '/messages?t=' + encodeURIComponent(token), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        cache: 'no-store',
      })
        .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
        .then(({ ok, j }) => {
          if (ok) bodyEl.value = '';
          else statusEl.textContent = '메시지를 못 보냈어요: ' + (j.error || '');
        })
        .catch(() => (statusEl.textContent = '메시지를 못 보냈어요'));
    });
  }
  // EventSource는 응답 코드를 안 알려 준다. 끊긴 이유가 뷰어 상한(429)인지 한 번 물어본다
  es.onerror = () => {
    if (es.readyState !== EventSource.CLOSED) {
      statusEl.textContent = '다시 연결 중';
      statusEl.dataset.state = 'retry';
      return;
    }
    statusEl.textContent = '연결이 끊겼어요';
    statusEl.dataset.state = 'lost';
    const ctl = new AbortController();
    fetch(eventsUrl, { signal: ctl.signal, cache: 'no-store' })
      .then((r) => {
        ctl.abort();
        if (r.status === 429) {
          statusEl.textContent = '보는 사람 수 상한(${maxViewers}명)에 걸려 못 붙었어요';
        }
      })
      .catch(() => {});
  };
})();
</script>
<script nonce="${nonce}">${THEME_SWITCH_JS}</script>
</body>
</html>
`;
}
