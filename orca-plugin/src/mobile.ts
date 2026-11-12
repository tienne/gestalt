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

/** 카드가 이미 레포를 알려 주니 PR은 번호만 남긴다 */
export function shortPr(pr: string): string {
  const m = /(?:#|\/pull\/)(\d+)\/?$/.exec(pr)
  return m ? `#${m[1]!}` : pr
}

function orderLine(o: OrderView, gates: number, now: number, depth: number): string {
  const tone = gates > 0 ? 'warning' : (STATUS_TONE[o.status] ?? 'neutral')
  const status = gates > 0 ? `확인 대기 ${gates}` : (STATUS_LABEL[o.status] ?? o.status)
  const meta = [
    `<span class="mono">${esc(o.id)}</span>`,
    o.pr ? esc(shortPr(o.pr)) : '',
    o.issue ? esc(o.issue) : '',
    esc(ago(ms(o.updatedAt), now))
  ].filter(Boolean)
  const kind = isTerminal(o.status) ? ' done' : depth > 0 ? ' child' : ''
  return `<div class="order tone-${tone}${kind}">
<div class="order-title"><span class="dot"></span><span>${esc(o.title || o.id)}</span></div>
<div class="meta">${pill(status, tone)}${meta.map((m) => `<span class="m">${m}</span>`).join('')}</div>
</div>`
}

function tree(nodes: readonly HierarchyNode[], gateCount: Map<string, number>, now: number, depth = 0): string {
  const items = nodes.map((n) => {
    const head =
      n.kind === 'order'
        ? orderLine(n.order, gateCount.get(n.order.id) ?? 0, now, depth)
        : `<div class="worktree"><span class="wt-tag">워크트리</span><span class="wt-name">${esc(n.label)}</span>${n.branch ? `<span class="mono muted">${esc(n.branch)}</span>` : ''}</div>`
    return `<li>${head}${n.children.length > 0 ? tree(n.children, gateCount, now, depth + 1) : ''}</li>`
  })
  return `<ul class="${depth === 0 ? 'tree' : 'branch'}">${items.join('')}</ul>`
}

function gateCard(g: GateView, order: OrderView | undefined, project: string | null, now: number): string {
  const repo = order ? [splitRepo(order.repo).name, project].filter(Boolean).join(' · ') : '주문 없는 게이트'
  return `<article class="gate">
<div class="gate-top">${pill(g.type, 'warning')}<span class="muted xs">${esc(ago(ms(g.openedAt), now))}</span></div>
<div class="gate-repo">${esc(repo)}</div>
${order ? `<div class="gate-title">${esc(order.title || order.id)}</div>` : ''}
<p class="reason">${esc(g.reason)}</p>
<div class="mono muted xs">${esc(g.id)}</div>
</article>`
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
  const sub = [
    s.project ? `<span class="project">${esc(s.project)}</span>` : '',
    owner ? `<span class="owner">${esc(owner)}</span>` : ''
  ].filter(Boolean)
  const shown = finished.slice(0, MAX_FINISHED)
  const rest = finished.length - shown.length
  return `<details class="repo tone-${tone}" data-key="${esc(`repo:${s.repo}`)}"${s.active > 0 || s.needsPerson > 0 ? ' open' : ''}>
<summary class="repo-head">
<div class="repo-name">${esc(name)}</div>
${sub.length > 0 ? `<div class="repo-sub">${sub.join('')}</div>` : ''}
<div class="pills">${pills}</div>
</summary>
<div class="repo-body">
${live.length > 0 ? tree(live, gateCount, now) : '<div class="muted small pad">진행 중인 주문이 없어요</div>'}
${
  shown.length > 0
    ? `<details class="finished" data-key="${esc(`done:${s.repo}`)}"><summary>끝난 주문 ${finished.length}개</summary><div class="finished-list">${shown.map((o) => orderLine(o, 0, now, 0)).join('')}${rest > 0 ? `<div class="muted xs pad">오래된 ${rest}개는 줄였어요</div>` : ''}</div></details>`
    : ''
}
</div>
</details>`
}

const section = (title: string, count: number | null, body: string) =>
  `<section><div class="section-head"><h2>${esc(title)}</h2>${count !== null ? `<span class="count">${count}</span>` : ''}</div>${body}</section>`

const stat = (label: string, value: string, tone: string) =>
  `<div class="stat tone-${tone}"><div class="stat-value">${esc(value)}</div><div class="stat-label">${esc(label)}</div></div>`

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
    `<div class="stats">${stat('확인 대기', String(v.gates.length), v.gates.length > 0 ? 'warning' : 'neutral')}${stat('진행', String(active), active > 0 ? 'accent' : 'neutral')}${stat('마지막 tick', tick !== null ? ago(tick, now) : '없음', 'neutral')}</div>`
  )
  if (v.state === 'error')
    parts.push(`<div class="notice"><b>gestalt CLI가 실패했어요</b><div class="small">${esc(v.error ?? '')}</div></div>`)

  if (v.gates.length > 0) {
    const projectOf = (o: OrderView | undefined) => (o ? (summarizeProject(repos, o.repo) ?? null) : null)
    const cards = v.gates
      .map((g) => {
        const order = v.orders.find((o) => o.id === g.orderId)
        return gateCard(g, order, projectOf(order), now)
      })
      .join('')
    parts.push(
      section('확인 대기', v.gates.length, `<p class="hint">승인과 거절은 컨덕터 세션이나 데스크톱 오르카에서 해요.</p>${cards}`)
    )
  }

  parts.push(
    section(
      '레포',
      repos.length,
      repos.length > 0 ? repos.map((s) => repoCard(s, gateCount, now)).join('') : '<div class="empty">받은 주문이 없어요</div>'
    )
  )
  parts.push(`<div class="foot">${esc(ago(v.refreshedAt, now))} 읽음 · 보기 전용</div>`)
  return parts.join('\n')
}

const summarizeProject = (repos: readonly RepoSummary[], repo: string) => repos.find((r) => r.repo === repo)?.project

// 위계는 세 겹으로 나눈다. 글자는 레포 이름 > 주문 제목 > 하위 주문 > 끝난 주문 > 메타 순으로 작아진다.
// 면은 페이지 바탕 > 레포 카드 > 끝난 주문 안쪽 상자 순이다. 선은 카드 테두리 > 주문 사이 구분선 > 하위 주문 안내선 순으로 옅어진다.
const STYLE = `
:root { color-scheme: light dark;
  --bg: #f4f4f5; --surface: #ffffff; --inset: #f7f7f8; --fg: #18181b; --fg2: #3f3f46; --muted: #71717a;
  --line: #e4e4e7; --line-strong: #d4d4d8;
  --accent: #2563eb; --warn: #c2410c; --ok: #15803d; --danger: #dc2626; --chip: #f1f1f3; }
@media (prefers-color-scheme: dark) { :root {
  --bg: #09090b; --surface: #141417; --inset: #1b1b1f; --fg: #fafafa; --fg2: #d4d4d8; --muted: #8b8b94;
  --line: #26262b; --line-strong: #3a3a41;
  --accent: #60a5fa; --warn: #f59e0b; --ok: #4ade80; --danger: #f87171; --chip: #232328; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.45 -apple-system, system-ui, sans-serif;
  padding: max(14px, env(safe-area-inset-top)) 16px max(28px, env(safe-area-inset-bottom)); -webkit-text-size-adjust: 100%; }
header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
h1 { font-size: 24px; line-height: 1.2; font-weight: 800; letter-spacing: -0.02em; margin: 0; flex: 1; }
.muted { color: var(--muted); }
.small { font-size: 13px; }
.xs { font-size: 12px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
.pad { padding: 8px 0; }

.stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.stat { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; min-width: 0; }
.stat-value { font-size: 20px; font-weight: 700; line-height: 1.2; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stat-label { font-size: 12px; color: var(--muted); margin-top: 2px; }
.stat.tone-warning { border-color: color-mix(in srgb, var(--warn) 45%, var(--line)); }
.stat.tone-warning .stat-value { color: var(--warn); }
.stat.tone-accent .stat-value { color: var(--accent); }

section { margin-top: 24px; }
.section-head { display: flex; align-items: center; gap: 8px; margin: 0 2px 10px; }
h2 { font-size: 13px; font-weight: 700; letter-spacing: 0.02em; color: var(--muted); margin: 0; }
.count { font-size: 12px; font-weight: 600; color: var(--muted); background: var(--chip); border-radius: 999px; padding: 0 7px; }
.section-head::after { content: ''; flex: 1; height: 1px; background: var(--line); }
.hint { font-size: 12px; color: var(--muted); margin: -4px 2px 10px; }

.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11.5px; font-weight: 600; line-height: 18px;
  background: var(--chip); color: var(--muted); white-space: nowrap; }
.pill.tone-accent { color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
.pill.tone-warning { color: var(--warn); background: color-mix(in srgb, var(--warn) 14%, transparent); }
.pill.tone-success { color: var(--ok); background: color-mix(in srgb, var(--ok) 14%, transparent); }
.pill.tone-danger { color: var(--danger); background: color-mix(in srgb, var(--danger) 14%, transparent); }
.pills { display: flex; gap: 6px; flex-wrap: wrap; }

.gate, .repo, .notice { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; margin: 0 0 10px; }
.gate { padding: 12px 14px 12px 16px; box-shadow: inset 3px 0 0 var(--warn); }
.gate-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.gate-repo { font-size: 12px; color: var(--muted); margin-top: 8px; }
.gate-title { font-size: 15px; font-weight: 600; margin-top: 2px; overflow-wrap: anywhere; }
.reason { margin: 8px 0; padding: 8px 10px; background: var(--inset); border-radius: 8px; font-size: 14px; color: var(--fg2);
  white-space: pre-wrap; overflow-wrap: anywhere; }
.notice { padding: 12px 14px; margin-top: 12px; box-shadow: inset 3px 0 0 var(--danger); }

.repo { overflow: hidden; }
.repo.tone-warning { box-shadow: inset 3px 0 0 var(--warn); }
.repo.tone-accent { box-shadow: inset 3px 0 0 var(--accent); }
summary { cursor: pointer; list-style: none; }
summary::-webkit-details-marker { display: none; }
.repo-head { position: relative; padding: 12px 36px 12px 14px; display: grid; gap: 4px; }
.repo-head::after { content: ''; position: absolute; right: 16px; top: 18px; width: 7px; height: 7px;
  border-right: 2px solid var(--muted); border-bottom: 2px solid var(--muted); transform: rotate(-45deg); transition: transform .15s; }
.repo[open] > .repo-head::after { transform: rotate(45deg); top: 15px; }
.repo[open] > .repo-head { border-bottom: 1px solid var(--line); }
.repo-name { font-size: 17px; font-weight: 700; letter-spacing: -0.01em; overflow-wrap: anywhere; }
.repo-sub { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 8px; font-size: 13px; color: var(--muted); }
.project { color: var(--fg2); font-weight: 500; }
.owner { font-size: 12px; }
.repo-head .pills { margin-top: 4px; }
.repo-body { padding: 0 14px 12px; }

.tree, .branch { list-style: none; margin: 0; padding: 0; }
.tree > li + li { border-top: 1px solid var(--line); }
.branch { margin: 0 0 6px 3px; padding-left: 14px; border-left: 2px solid var(--line-strong); }
.order { padding: 12px 0 10px; }
.branch .order { padding: 8px 0; }
.order-title { display: flex; align-items: baseline; gap: 8px; font-size: 15px; font-weight: 600; line-height: 1.4; overflow-wrap: anywhere; }
.order.child .order-title { font-size: 14px; font-weight: 500; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; transform: translateY(-1px); }
.tone-accent > .order-title .dot { background: var(--accent); }
.tone-warning > .order-title .dot { background: var(--warn); }
.tone-success > .order-title .dot { background: var(--ok); }
.tone-danger > .order-title .dot { background: var(--danger); }
.meta { display: flex; align-items: center; flex-wrap: wrap; gap: 3px 10px; margin: 6px 0 0 16px; font-size: 12px; color: var(--muted); }
.meta .m { white-space: nowrap; }
.worktree { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 10px 0 6px; font-size: 13px; }
.wt-tag { font-size: 11px; font-weight: 600; color: var(--muted); border: 1px solid var(--line-strong); border-radius: 6px; padding: 0 6px; }
.wt-name { font-weight: 600; color: var(--fg2); }

.finished { margin-top: 8px; background: var(--inset); border: 1px solid var(--line); border-radius: 10px; }
.finished > summary { padding: 9px 12px; font-size: 13px; font-weight: 600; color: var(--muted); display: flex; justify-content: space-between; }
.finished > summary::after { content: '펼치기'; font-weight: 500; font-size: 12px; }
.finished[open] > summary::after { content: '접기'; }
.finished-list { padding: 0 12px 4px; border-top: 1px solid var(--line); }
.finished-list > .order + .order { border-top: 1px solid var(--line); }
.order.done { padding: 9px 0; }
.order.done .order-title { font-size: 13px; font-weight: 500; color: var(--fg2); }
.order.done .meta { font-size: 11.5px; }

.empty { color: var(--muted); padding: 24px 8px; text-align: center; }
.foot { margin-top: 20px; text-align: center; font-size: 12px; color: var(--muted); }
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
