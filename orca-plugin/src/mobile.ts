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
  // 인증 없는 페이지라 저장소 경로와 CLI 오류 원문은 싣지 않는다. 홈 경로에 사용자 이름이 들어 있다
  if (v.state === 'missing')
    return '<div class="empty">컨덕터 저장소가 아직 없어요. 자세한 건 데스크톱 오르카에서 봐 주세요.</div>'

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
    parts.push(
      '<div class="notice"><b>gestalt CLI가 실패했어요</b><div class="small">이유는 데스크톱 오르카의 패널이나 상태 표시줄에서 봐 주세요.</div></div>'
    )

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

// Linear 디자인 문서(awesome-design-md의 linear.app)를 따른다. 위계는 그림자 대신 면 단계와 가는 테두리로 나눈다.
// 문서에는 다크 값만 있어서 라이트 값은 같은 단계 순서를 지키도록 밝은 쪽으로 뒤집어 맞췄다.
// 단계는 바탕 > 레포 카드(s1) > 확인 대기 카드와 끝난 주문 상자(s2) > 사유 상자와 배지(s3) 순이다.
// 다크에서는 안쪽으로 갈수록 밝아진다. 라이트에서는 카드가 흰색이고 그 안쪽이 한 단계씩 어두워진다.
// 확인 대기 카드(--raised)는 라이트에서 회색이면 바탕에 묻혀서 흰 면에 진한 테두리로 띄운다.
// 상태색은 배지와 점에만 쓰고 카드 면이나 테두리를 칠하지 않는다.
const STYLE = `
:root { color-scheme: light dark;
  --canvas: #f4f5f6; --s1: #ffffff; --s2: #f7f8f9; --s3: #eff1f3; --raised: #ffffff;
  --ink: #08090a; --ink-muted: #3c4149; --ink-subtle: #6b6f76; --ink-3: #6b6f76;
  --line: #e4e6e9; --line-strong: #d3d6db; --line-3: #c6cad0;
  --accent: #5e6ad2; --ok: #1f8f3a; --warn: #c27c0e; --danger: #d63c3c;
  --edge: 0 1px 2px rgba(8, 9, 10, 0.04); }
@media (prefers-color-scheme: dark) { :root {
  --canvas: #010102; --s1: #0f1011; --s2: #141516; --s3: #18191a; --raised: #141516;
  --ink: #f7f8f8; --ink-muted: #d0d6e0; --ink-subtle: #8a8f98; --ink-3: #8a8f98;
  --line: #23252a; --line-strong: #34343a; --line-3: #3e3e44;
  --accent: #5e6ad2; --ok: #27a644; --warn: #e2a33b; --danger: #eb5757;
  --edge: inset 0 1px 0 rgba(255, 255, 255, 0.04); } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--canvas); color: var(--ink);
  font: 400 15px/1.5 "SF Pro Text", -apple-system, system-ui, "Inter", sans-serif; letter-spacing: -0.05px;
  padding: max(16px, env(safe-area-inset-top)) 16px max(32px, env(safe-area-inset-bottom)); -webkit-text-size-adjust: 100%; }
header { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
h1 { font: 600 24px/1.2 "SF Pro Display", -apple-system, system-ui, sans-serif; letter-spacing: -0.5px; margin: 0; flex: 1; }
.muted { color: var(--ink-subtle); }
.small { font-size: 13px; }
.xs { font-size: 12px; }
.mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; letter-spacing: 0; }
.pad { padding: 8px 0; }

.stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.stat { background: var(--s1); border: 1px solid var(--line); border-radius: 12px; padding: 12px; min-width: 0; box-shadow: var(--edge); }
.stat-value { font: 600 22px/1.2 "SF Pro Display", -apple-system, system-ui, sans-serif; letter-spacing: -0.4px; font-variant-numeric: tabular-nums;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stat-label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink-subtle); margin-top: 4px; }
.stat.tone-warning .stat-label::before, .stat.tone-accent .stat-label::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--tone); }

section { margin-top: 32px; }
.section-head { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; }
h2 { font-size: 13px; font-weight: 500; line-height: 1.3; letter-spacing: 0.4px; color: var(--ink-subtle); margin: 0; }
.count { font-size: 12px; font-weight: 500; color: var(--ink-subtle); }
.section-head::after { content: ''; flex: 1; height: 1px; background: var(--line); }
.hint { font-size: 12px; color: var(--ink-3); margin: -4px 0 12px; }

.tone-accent { --tone: var(--accent); }
.tone-warning { --tone: var(--warn); }
.tone-success { --tone: var(--ok); }
.tone-danger { --tone: var(--danger); }
.tone-neutral { --tone: var(--ink-3); }
.pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 9999px; font-size: 12px; font-weight: 500; line-height: 16px;
  background: var(--s3); border: 1px solid var(--line); color: var(--ink-muted); white-space: nowrap; }
.pill::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--tone, var(--ink-3)); }
.pills { display: flex; gap: 6px; flex-wrap: wrap; }

.gate, .repo, .notice { border-radius: 12px; margin: 0 0 8px; box-shadow: var(--edge); }
.repo, .notice { background: var(--s1); border: 1px solid var(--line); }
.gate { background: var(--raised); border: 1px solid var(--line-strong); padding: 16px; }
.gate-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.gate-repo { font-size: 12px; color: var(--ink-subtle); margin-top: 12px; }
.gate-title { font-size: 15px; font-weight: 500; letter-spacing: -0.1px; margin-top: 2px; overflow-wrap: anywhere; }
.reason { margin: 12px 0 8px; padding: 10px 12px; background: var(--s3); border: 1px solid var(--line); border-radius: 8px;
  font-size: 14px; color: var(--ink-muted); white-space: pre-wrap; overflow-wrap: anywhere; }
.gate > .mono { color: var(--ink-3); }
.notice { padding: 12px 16px; margin-top: 16px; border-color: color-mix(in srgb, var(--danger) 40%, var(--line)); }

.repo { overflow: hidden; }
summary { cursor: pointer; list-style: none; }
summary::-webkit-details-marker { display: none; }
.repo-head { position: relative; padding: 16px 40px 16px 16px; display: grid; gap: 4px; }
.repo-head::after { content: ''; position: absolute; right: 18px; top: 22px; width: 6px; height: 6px;
  border-right: 1.5px solid var(--ink-subtle); border-bottom: 1.5px solid var(--ink-subtle); transform: rotate(-45deg); transition: transform .15s; }
.repo[open] > .repo-head::after { transform: rotate(45deg); top: 19px; }
.repo[open] > .repo-head { border-bottom: 1px solid var(--line); }
.repo-name { font: 600 17px/1.3 "SF Pro Display", -apple-system, system-ui, sans-serif; letter-spacing: -0.3px; overflow-wrap: anywhere; }
.repo-sub { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 8px; font-size: 13px; color: var(--ink-subtle); }
.project { color: var(--ink-muted); }
.owner { font-size: 12px; color: var(--ink-3); }
.repo-head .pills { margin-top: 8px; }
.repo-body { padding: 0 16px 12px; }

.tree, .branch { list-style: none; margin: 0; padding: 0; }
.tree > li + li { border-top: 1px solid var(--line); }
.branch { margin: 0 0 8px 3px; padding-left: 14px; border-left: 1px solid var(--line-3); }
.order { padding: 12px 0; }
.branch .order { padding: 8px 0; }
.order-title { display: flex; align-items: baseline; gap: 10px; font-size: 15px; font-weight: 500; line-height: 1.45; letter-spacing: -0.1px; overflow-wrap: anywhere; }
.order.child .order-title { font-size: 14px; color: var(--ink-muted); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--tone, var(--ink-3)); flex: none; transform: translateY(-1px); }
.meta { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; margin: 6px 0 0 17px; font-size: 12px; line-height: 1.4; color: var(--ink-subtle); }
.meta .m { white-space: nowrap; }
.meta .mono { color: var(--ink-3); }
.worktree { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 12px 0 6px; font-size: 13px; }
.wt-tag { font-size: 11px; font-weight: 500; color: var(--ink-subtle); background: var(--s3); border: 1px solid var(--line); border-radius: 4px; padding: 0 6px; }
.wt-name { font-weight: 500; color: var(--ink-muted); }

.finished { margin-top: 4px; background: var(--s2); border: 1px solid var(--line); border-radius: 8px; }
.finished > summary { padding: 10px 12px; font-size: 13px; font-weight: 500; color: var(--ink-subtle); display: flex; justify-content: space-between; }
.finished > summary::after { content: '펼치기'; font-weight: 400; font-size: 12px; color: var(--ink-3); }
.finished[open] > summary::after { content: '접기'; }
.finished-list { padding: 0 12px 4px; border-top: 1px solid var(--line); }
.finished-list > .order + .order { border-top: 1px solid var(--line); }
.order.done { padding: 10px 0; }
.order.done .order-title { font-size: 13px; font-weight: 400; color: var(--ink-subtle); }
.order.done .meta { font-size: 12px; }
.order.done .pill { color: var(--ink-subtle); background: transparent; }

.empty { color: var(--ink-subtle); padding: 32px 8px; text-align: center; }
.foot { margin-top: 32px; text-align: center; font-size: 12px; color: var(--ink-3); }
#offline { display: none; }
body.offline #offline { display: inline-flex; }
`

// 같은 주소에 헤더만 붙여 본문을 다시 받는다. 테일스케일이 붙인 경로 접두사를 몰라도 된다.
// 사람이 펼치고 접은 칸은 data-key로 기억했다가 갈아 끼운 뒤 되돌린다.
export const SCRIPT = `
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
<meta name="theme-color" content="#f4f5f6" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#010102" media="(prefers-color-scheme: dark)">
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
