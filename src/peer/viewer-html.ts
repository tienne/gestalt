export const VIEWER_WARNING = '비밀값 패턴은 가리지만 전부 잡지는 못해요.';

/**
 * 뷰어 페이지. 바깥 자원을 하나도 안 끌어온다 — CSP가 `default-src 'none'`이라
 * 인라인 스크립트와 스타일도 nonce가 맞는 것만 돈다.
 *
 * 대화 내용은 전부 textContent로 넣는다. 마크다운을 HTML로 그리면 남의 도구 출력에
 * 든 태그가 이 페이지에서 실행될 길이 생긴다. localStorage나 IndexedDB도 안 쓴다.
 */
export function renderViewerHtml(nonce: string, maxViewers: number): string {
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
    log.append(el('div', 'ev note', '앞부분 ' + n + '개 생략 (데몬 메모리 상한)'));
  });
  es.addEventListener('stats', (m) => {
    const n = JSON.parse(m.data).unknownLines;
    unknownEl.textContent = n > 0 ? '모르는 줄 ' + n + '개 건너뜀' : '';
  });
  es.addEventListener('state', (m) => {
    statusEl.textContent = STATUS[JSON.parse(m.data).status] || '';
  });
  es.addEventListener('closed', () => {
    statusEl.textContent = '공유가 종료됐어요';
    es.close();
  });
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
