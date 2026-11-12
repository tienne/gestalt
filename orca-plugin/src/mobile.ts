// 폰에서 보는 보기 전용 페이지. 워커가 들고 있는 상태를 HTML 문자열로 그리기만 하고 버튼은 두지 않는다.
// 주문 제목과 게이트 사유는 지라나 PR에서 온 바깥 텍스트라 전부 이스케이프한다.
import { buildHierarchy, pruneHierarchy, type HierarchyNode } from './hierarchy'
import { ago, isTerminal, ms, splitRepo, STATUS_LABEL, STATUS_TONE, summarize, type RepoSummary } from './model'
import type { ConductorView, GateView, OrderView } from './protocol'

const MAX_FINISHED = 30

export function esc(text: unknown): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const pill = (text: string, tone = 'neutral') => `<span class="pill tone-${tone}">${esc(text)}</span>`

function orderLine(o: OrderView, gates: number, now: number): string {
  const tone = gates > 0 ? 'warning' : (STATUS_TONE[o.status] ?? 'neutral')
  const meta = [o.id, o.pr ? `PR ${o.pr}` : '', o.issue ?? '', ago(ms(o.updatedAt), now)].filter(Boolean)
  return `<div class="order tone-${tone}${isTerminal(o.status) ? ' faded' : ''}">
<div class="order-head"><span class="dot"></span><span class="title">${esc(o.title || o.id)}</span>${pill(gates > 0 ? `확인 대기 ${gates}` : (STATUS_LABEL[o.status] ?? o.status), tone)}</div>
<div class="meta">${meta.map(esc).join(' · ')}</div>
</div>`
}

function tree(nodes: readonly HierarchyNode[], gateCount: Map<string, number>, now: number): string {
  const items = nodes.map((n) => {
    const head =
      n.kind === 'order'
        ? orderLine(n.order, gateCount.get(n.order.id) ?? 0, now)
        : `<div class="worktree">${esc(n.label)}${n.branch ? ` <span class="muted">${esc(n.branch)}</span>` : ''}</div>`
    return `<li>${head}${n.children.length > 0 ? tree(n.children, gateCount, now) : ''}</li>`
  })
  return `<ul class="tree">${items.join('')}</ul>`
}

function gateCard(g: GateView, order: OrderView | undefined, now: number): string {
  const where = order ? `${splitRepo(order.repo).name} / ${order.title || order.id}` : '주문 없는 게이트'
  return `<div class="gate">
<div class="row">${pill(g.type, 'warning')}<span class="muted small">${esc(ago(ms(g.openedAt), now))}</span></div>
<div class="small strong">${esc(where)}</div>
<p>${esc(g.reason)}</p>
<div class="muted small">${esc(g.id)}</div>
</div>`
}

function repoCard(s: RepoSummary, gateCount: Map<string, number>, now: number): string {
  const { name, owner } = splitRepo(s.repo)
  const live = pruneHierarchy(buildHierarchy(s.orders), (o) => !isTerminal(o.status))
  const finished = s.orders
    .filter((o) => isTerminal(o.status))
    .sort((a, b) => (ms(b.updatedAt) ?? 0) - (ms(a.updatedAt) ?? 0))
  const tone = s.needsPerson > 0 ? 'warning' : s.active > 0 ? 'accent' : 'neutral'
  const pills = [
    s.gates.length > 0 ? pill(`확인 대기 ${s.gates.length}`, 'warning') : '',
    s.active > 0 ? pill(`진행 ${s.active}`, 'accent') : '',
    finished.length > 0 ? pill(`끝남 ${finished.length}`) : ''
  ].join('')
  const shown = finished.slice(0, MAX_FINISHED)
  const rest = finished.length - shown.length
  return `<details class="repo tone-${tone}" data-key="${esc(`repo:${s.repo}`)}"${s.active > 0 || s.needsPerson > 0 ? ' open' : ''}>
<summary><span class="repo-title"><span class="repo-name">${esc(name)}</span>${s.project ? `<span class="project">${esc(s.project)}</span>` : ''}${owner ? `<span class="muted small">${esc(owner)}</span>` : ''}</span><span class="pills">${pills}</span></summary>
${live.length > 0 ? tree(live, gateCount, now) : '<div class="muted small pad">진행 중인 주문이 없어요</div>'}
${
  shown.length > 0
    ? `<details class="finished" data-key="${esc(`done:${s.repo}`)}"><summary class="small">끝난 주문 ${finished.length}개</summary>${shown.map((o) => orderLine(o, 0, now)).join('')}${rest > 0 ? `<div class="muted small pad">오래된 ${rest}개는 줄였어요</div>` : ''}</details>`
    : ''
}
</details>`
}

/** 폴링이 갈아 끼우는 본문. 페이지 안팎에서 같은 함수로 그린다 */
export function mobileFragment(v: ConductorView | null, now = Date.now()): string {
  if (!v) return '<div class="empty">불러오는 중이에요</div>'
  if (v.state === 'missing')
    return `<div class="empty">${esc(v.stateDir ?? '상태 폴더')}에 events.jsonl이 아직 없어요.</div>`

  const { repos } = summarize(v)
  const active = v.orders.filter((o) => !isTerminal(o.status)).length
  const gateCount = new Map<string, number>()
  for (const g of v.gates) if (g.orderId) gateCount.set(g.orderId, (gateCount.get(g.orderId) ?? 0) + 1)
  const tick = ms(v.lastTickAt)

  const parts: string[] = []
  parts.push(
    `<div class="summary">${pill(`진행 ${active}`, active > 0 ? 'accent' : 'neutral')}${pill(`확인 대기 ${v.gates.length}`, v.gates.length > 0 ? 'warning' : 'neutral')}<span class="muted small">${tick !== null ? `tick ${esc(ago(tick, now))}` : 'tick 기록 없음'}</span></div>`
  )
  if (v.state === 'error')
    parts.push(`<div class="notice tone-danger"><b>gestalt CLI가 실패했어요</b><div class="small">${esc(v.error ?? '')}</div></div>`)

  if (v.gates.length > 0) {
    parts.push(`<h2>확인 대기 ${v.gates.length}</h2>`)
    parts.push('<div class="muted small">승인과 거절은 컨덕터 세션이나 데스크톱 오르카에서 해요.</div>')
    for (const g of v.gates) parts.push(gateCard(g, v.orders.find((o) => o.id === g.orderId), now))
  }

  parts.push('<h2>레포</h2>')
  parts.push(
    repos.length > 0
      ? repos.map((s) => repoCard(s, gateCount, now)).join('')
      : '<div class="empty">받은 주문이 없어요</div>'
  )
  parts.push(`<div class="muted small foot">${esc(ago(v.refreshedAt, now))} 읽음 · 보기 전용</div>`)
  return parts.join('\n')
}

const STYLE = `
:root { color-scheme: light dark; --bg: #fafafa; --fg: #18181b; --card: #fff; --muted: #71717a; --border: #e4e4e7;
  --accent: #2563eb; --warn: #d97706; --ok: #16a34a; --danger: #dc2626; --chip: #f4f4f5; }
@media (prefers-color-scheme: dark) { :root { --bg: #09090b; --fg: #fafafa; --card: #18181b; --muted: #a1a1aa;
  --border: #27272a; --accent: #60a5fa; --warn: #f59e0b; --ok: #4ade80; --danger: #f87171; --chip: #27272a; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.45 -apple-system, system-ui, sans-serif;
  padding: max(12px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom)); -webkit-text-size-adjust: 100%; }
header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
h1 { font-size: 20px; margin: 0; flex: 1; }
h2 { font-size: 16px; margin: 20px 0 8px; }
.summary, .row, .pills { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; background: var(--chip); color: var(--muted); white-space: nowrap; }
.pill.tone-accent { color: var(--accent); background: color-mix(in srgb, var(--accent) 15%, transparent); }
.pill.tone-warning { color: var(--warn); background: color-mix(in srgb, var(--warn) 15%, transparent); }
.pill.tone-success { color: var(--ok); background: color-mix(in srgb, var(--ok) 15%, transparent); }
.pill.tone-danger { color: var(--danger); background: color-mix(in srgb, var(--danger) 15%, transparent); }
.muted { color: var(--muted); }
.small { font-size: 13px; }
.strong { font-weight: 600; }
.pad { padding: 4px 2px; }
.gate, .repo, .notice { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 10px 12px; margin: 8px 0; }
.gate { border-color: var(--warn); }
.gate p { margin: 6px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.notice.tone-danger { border-color: var(--danger); }
.repo.tone-warning { border-color: var(--warn); }
.repo.tone-accent { border-color: var(--accent); }
summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-height: 32px; }
summary::-webkit-details-marker { display: none; }
.repo > summary::before { content: '▸'; color: var(--muted); }
.repo[open] > summary::before { content: '▾'; }
.repo-title { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; min-width: 0; }
.repo-name { font-weight: 600; }
.project { font-size: 13px; }
.repo > summary .pills { margin-left: auto; }
.finished { margin-top: 8px; border-top: 1px dashed var(--border); padding-top: 4px; }
.finished > summary { color: var(--muted); }
.tree, .tree ul { list-style: none; margin: 0; padding: 0; }
.tree ul { margin-left: 8px; padding-left: 12px; border-left: 1px solid var(--border); }
.tree li { padding: 3px 0; }
.order { padding: 6px 2px; }
.order.faded { opacity: .65; }
.order-head { display: flex; align-items: center; gap: 6px; }
.title { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.meta { font-size: 12px; color: var(--muted); margin-left: 14px; overflow-wrap: anywhere; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
.tone-accent > .order-head .dot { background: var(--accent); }
.tone-warning > .order-head .dot { background: var(--warn); }
.tone-success > .order-head .dot { background: var(--ok); }
.tone-danger > .order-head .dot { background: var(--danger); }
.worktree { font-size: 13px; color: var(--muted); border: 1px dashed var(--border); border-radius: 8px; padding: 4px 8px; }
.empty { color: var(--muted); padding: 24px 8px; text-align: center; }
.foot { margin-top: 16px; text-align: center; }
#offline { display: none; }
body.offline #offline { display: inline-block; }
`

// 같은 주소에 헤더만 붙여 본문을 다시 받는다. 테일스케일이 붙인 경로 접두사를 몰라도 된다.
// 사람이 펼치고 접은 칸은 data-key로 기억했다가 갈아 끼운 뒤 되돌린다.
const SCRIPT = `
(() => {
  const main = document.getElementById('main');
  const INTERVAL = 10000;
  async function pull() {
    if (document.hidden) return;
    try {
      const res = await fetch(location.href, { headers: { 'x-conductor-fragment': '1' }, cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const html = await res.text();
      const open = new Map();
      for (const d of main.querySelectorAll('details[data-key]')) open.set(d.dataset.key, d.open);
      main.innerHTML = html;
      for (const d of main.querySelectorAll('details[data-key]')) if (open.has(d.dataset.key)) d.open = open.get(d.dataset.key);
      document.body.classList.remove('offline');
    } catch { document.body.classList.add('offline'); }
  }
  setInterval(pull, INTERVAL);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(); });
})();
`

export function mobilePage(fragment: string): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="referrer" content="no-referrer">
<title>컨덕터</title>
<style>${STYLE}</style>
</head>
<body>
<header><h1>컨덕터</h1><span id="offline" class="pill tone-danger">연결 끊김</span></header>
<main id="main">${fragment}</main>
<script>${SCRIPT}</script>
</body>
</html>`
}
