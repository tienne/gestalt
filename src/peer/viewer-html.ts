export const VIEWER_WARNING = '비밀값 패턴은 가리지만 전부 잡지는 못해요.';

/**
 * 뷰어 페이지. 바깥 자원을 하나도 안 끌어온다 — CSP가 `default-src 'none'`이라
 * 인라인 스크립트와 스타일도 nonce가 맞는 것만 돈다.
 *
 * 대화 내용은 전부 textContent로 넣는다. 마크다운을 HTML로 그리면 남의 도구 출력에
 * 든 태그가 이 페이지에서 실행될 길이 생긴다. localStorage나 IndexedDB도 안 쓴다.
 */
export function renderViewerHtml(
  nonce: string,
  maxViewers: number,
  canSend = false,
  canAnswer = false,
): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>gestalt peer</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; --muted: #888; --line: #8884; }
  body { font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; }
  header { position: sticky; top: 0; padding: 10px 16px; border-bottom: 1px solid var(--line);
    background: Canvas; z-index: 1; }
  header h1 { font-size: 15px; margin: 0 0 4px; }
  .warn { color: #b45309; font-size: 13px; }
  .meta { color: var(--muted); font-size: 12px; display: flex; gap: 12px; flex-wrap: wrap; }
  main { padding: 12px 16px 48px; max-width: 980px; }
  .ev { margin: 10px 0; }
  .who { font-size: 12px; color: var(--muted); }
  .text { white-space: pre-wrap; word-break: break-word; }
  .prompt .text { border-left: 3px solid #2563eb; padding-left: 8px; }
  details { border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; }
  details pre { white-space: pre-wrap; word-break: break-word; font-size: 12px; margin: 6px 0 2px; }
  summary { cursor: pointer; font-size: 13px; }
  .error summary { color: #dc2626; }
  .note { color: var(--muted); font-style: italic; font-size: 13px; }
  .peer_message .text { border-left: 3px solid #059669; padding-left: 8px; }
  .peer_answer .text { border-left: 3px solid #7c3aed; padding-left: 8px; }
  .ask { border: 1px solid #7c3aed88; border-radius: 6px; padding: 8px 10px; }
  .ask form { display: flex; gap: 8px; margin-top: 6px; }
  .ask form[hidden] { display: none; }
  .ask textarea { flex: 1; min-height: 38px; font: inherit; }
  .ask .state.rejected { color: #dc2626; }
  footer { position: sticky; bottom: 0; padding: 8px 16px; border-top: 1px solid var(--line);
    background: Canvas; }
  footer form { display: flex; gap: 8px; max-width: 980px; }
  footer textarea { flex: 1; min-height: 38px; font: inherit; }
  #mine { list-style: none; margin: 0 0 6px; padding: 0; font-size: 12px; color: var(--muted);
    max-width: 980px; max-height: 120px; overflow: auto; }
  #mine .rejected { color: #dc2626; }
</style>
</head>
<body>
<header>
  <h1 id="title">gestalt peer</h1>
  <div class="warn">${VIEWER_WARNING}</div>
  <div class="meta">
    <span id="status">연결 중</span>
    <span id="unknown"></span>
  </div>
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

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const time = (at) => (at ? new Date(at).toLocaleTimeString() : '');
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

  function render(ev) {
    const box = el('div', 'ev ' + ev.kind);
    if (ev.kind === 'prompt' || ev.kind === 'reply') {
      box.append(el('div', 'who', (ev.kind === 'prompt' ? '주인' : '모델') + ' ' + time(ev.at)));
      box.append(el('div', 'text', ev.text));
    } else if (ev.kind === 'tool_call') {
      const d = el('details');
      d.append(el('summary', '', '도구 ' + ev.name + ' ' + time(ev.at)));
      if (ev.input !== undefined) d.append(el('pre', '', ev.input));
      const slot = el('div');
      d.append(slot);
      if (ev.id) results.set(ev.id, slot);
      box.append(d);
    } else if (ev.kind === 'tool_result') {
      const d = el('details', ev.isError ? 'error' : '');
      const label = ev.hidden ? '결과 (주인이 숨김)' : ev.isError ? '결과 (에러)' : '결과';
      d.append(el('summary', '', label + (ev.truncated ? ' · 앞부분만' : '')));
      if (!ev.hidden) d.append(el('pre', '', ev.text || ''));
      const slot = ev.toolUseId ? results.get(ev.toolUseId) : undefined;
      if (slot) { slot.append(d); return; }
      box.append(d);
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
      box.append(el('div', 'who', '팀원 ' + ev.from + who + ' 넣은 메시지 ' + time(ev.at)));
      box.append(el('div', 'text', ev.text));
    } else if (ev.kind === 'peer_answer') {
      box.append(el('div', 'who', '팀원 ' + ev.from + ' 님이 질문에 단 답 (서명 확인) ' + time(ev.at)));
      box.append(el('div', 'text', ev.text));
    } else {
      return;
    }
    log.append(box);
  }

  const eventsUrl = base + '/events?t=' + encodeURIComponent(token);
  const es = new EventSource(eventsUrl);
  es.addEventListener('line', (m) => {
    const stick = atBottom();
    render(JSON.parse(m.data));
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
    statusEl.textContent = STATUS[JSON.parse(m.data).status] || '';
  });
  es.addEventListener('closed', (m) => {
    const closed = JSON.parse(m.data);
    // 원격 공유의 reason은 주인 데몬이 보낸 글자다. 프로토타입 이름이 들어와도 안 걸리게 자기 키만 본다
    statusEl.textContent = Object.hasOwn(CLOSED, closed.reason) ? CLOSED[closed.reason] : '공유가 종료됐어요';
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
      return;
    }
    statusEl.textContent = '연결이 끊겼어요';
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
</body>
</html>
`;
}
