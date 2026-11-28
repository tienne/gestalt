import { threadsOf, unresolvedCount } from '../local-pr/policy.js';
import type { PullRequest, Review } from '../local-pr/types.js';
import { THEME_BOOT_JS, THEME_SWITCH_JS, digestThemeCss } from '../digest/theme-color.js';
import { THEME_POP_CSS, graphThemePicker } from '../graph-viz/theme.js';

/**
 * 로컬 PR 웹 UI의 HTML을 만드는 순수 함수 모음.
 *
 * graph-viz/html-generator.ts와 같은 자리다 — 프레임워크 없이 문자열을 이어 붙여
 * 자기완결적인 HTML을 만든다. 다른 점은 여기 들어가는 텍스트(제목, 코멘트 본문)는
 * 전부 리뷰어가 입력한 신뢰할 수 없는 값이라는 것이다. escapeHtml을 거치지 않은
 * 텍스트를 그대로 꽂으면 코멘트에 심은 `<script>`가 브라우저에서 그대로 실행된다.
 */

/** HTML 텍스트 노드/속성에 안전하게 꽂도록 이스케이프한다 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * `<script>` 태그 안에 JSON을 꽂을 때 쓴다.
 *
 * JSON.stringify는 `<`, `>`를 이스케이프하지 않는다. diff나 코멘트 본문에
 * `</script><script>...` 가 들어 있으면 JSON.stringify만으로는 스크립트 태그를
 * 조기 종료시켜 뒤에 오는 문자열이 그대로 코드로 실행된다. 유니코드 이스케이프로
 * 그 시퀀스를 깨서 막는다.
 */
const SCRIPT_UNSAFE: Record<string, string> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
};

export function toEmbeddableJson(value: unknown): string {
  // 한 번만 훑는다. 패스마다 새 문자열이 생겨서 diff처럼 큰 값이면 원본의 몇 배를
  // 순간적으로 잡는다
  return JSON.stringify(value).replace(/[<>&]/g, (c) => SCRIPT_UNSAFE[c]!);
}

/** CSP를 붙이면 인라인 스크립트가 nonce 없이는 안 돈다. nonce를 안 주면 속성도 안 붙는다 */
function nonceAttrOf(nonce: string): string {
  return nonce ? ` nonce="${escapeHtml(nonce)}"` : '';
}

function pageShell(title: string, body: string, extraHead = '', nonce = ''): string {
  const nonceAttr = nonceAttrOf(nonce);
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>${digestThemeCss()}${THEME_POP_CSS}</style>
  <script${nonceAttr}>${THEME_BOOT_JS}</script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--fg);
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      line-height: 1.5;
      padding: 24px 32px 64px;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    /* 어두운 배경 위 브라우저 기본 포커스 링은 거의 안 보인다. 키보드로 훑는 사람이
       지금 어디 있는지 알아야 한다 */
    a:focus-visible { outline: 2px solid var(--gestalt-color-focus); outline-offset: 2px; text-decoration: underline; }
    .topbar { display: flex; justify-content: flex-end; margin-bottom: 8px; }
    h1 { font-size: 20px; margin-bottom: 16px; }
    h2 { font-size: 15px; color: var(--muted); margin: 28px 0 10px; text-transform: uppercase; letter-spacing: 0.04em; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); font-size: 14px; }
    th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; }
    tr:hover td, tr:focus-within td { background: var(--card); }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      background: var(--card);
      box-shadow: inset 0 0 0 1px currentColor;
    }
    /* 상태 글자색은 background와 surface 위에서만 대비가 보장돼서 옅은 상태색 바탕 대신 테두리로 구분한다 */
    .badge-open { color: var(--gestalt-color-info-text); }
    .badge-changes_requested { color: var(--gestalt-color-danger-text); }
    .badge-merged { color: var(--gestalt-color-success-text); }
    .badge-closed { color: var(--muted); }
    .badge-approve { color: var(--gestalt-color-success-text); }
    .badge-request_changes { color: var(--gestalt-color-danger-text); }
    .badge-comment { color: var(--muted); }
    .meta { color: var(--muted); font-size: 13px; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
    /* 빈 상태를 알리는 유일한 문구라 흐린 장식색 말고 대비가 보장되는 보조 글자색을 쓴다 */
    .empty { color: var(--muted); padding: 40px 0; text-align: center; }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px 18px;
      margin-bottom: 12px;
    }
    .card-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
    .body-text { white-space: pre-wrap; word-break: break-word; font-size: 13px; }
    .thread { border-left: 2px solid var(--line); padding-left: 14px; margin-bottom: 18px; }
    .comment + .comment { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--line); }
    .path { font-family: 'JetBrains Mono', 'Fira Code', monospace; color: var(--muted); font-size: 12px; }
    #diff-container { margin-top: 8px; }
    ul.repos { list-style: none; padding: 0; margin: 0 0 16px; display: flex; gap: 12px; flex-wrap: wrap; }
    ul.repos li { font-size: 13px; }
    @media (max-width: 640px) {
      body { padding: 16px 14px 48px; }
      table { display: block; overflow-x: auto; }
    }
  </style>
  ${extraHead}
</head>
<body>
<main>
<div class="topbar">${graphThemePicker()}</div>
${body}
</main>
<script${nonceAttr}>${THEME_SWITCH_JS}</script>
</body>
</html>`;
}

/**
 * 배지 클래스는 아는 값에서만 고른다.
 *
 * escapeHtml은 공백을 안 건드리므로 값에 공백이 섞이면 class 자리에 다른 클래스가
 * 함께 들어간다. 지금은 타입이 유니온이라 안 나지만 이 값은 디스크의 이벤트를
 * 되감아 만든 것이고 타입은 런타임 보증이 아니다.
 */
const STATUS_CLASS: Record<string, string> = {
  open: 'badge-open',
  changes_requested: 'badge-changes_requested',
  merged: 'badge-merged',
  closed: 'badge-closed',
};

const VERDICT_CLASS: Record<string, string> = {
  approve: 'badge-approve',
  request_changes: 'badge-request_changes',
  comment: 'badge-comment',
};

/** ISO 원문은 읽기 부담이 크다. datetime 속성에 원본을 남기고 화면에는 짧게 보인다 */
function formatTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toISOString().replace('T', ' ').slice(0, 16);
}

function statusBadge(status: string): string {
  const cls = STATUS_CLASS[status] ?? 'badge-closed';
  return `<span class="badge ${cls}">${escapeHtml(status)}</span>`;
}

function verdictBadge(verdict: string): string {
  const cls = VERDICT_CLASS[verdict] ?? 'badge-comment';
  return `<span class="badge ${cls}">${escapeHtml(verdict)}</span>`;
}

/**
 * diff 렌더러는 CDN에서 받는다. 버전을 고정하고 SRI를 붙인다.
 *
 * 이 스크립트는 로컬 PR 서버와 같은 오리진에서 돌아 PR 본문 전체에 닿는다. 버전을
 * 안 묶으면 CDN이 오염되거나 새 major가 나가는 순간 리뷰 중인 비공개 소스가 남의
 * 코드 손에 들어간다. integrity가 안 맞으면 브라우저가 실행을 막는다. 그때는 아래
 * 부트스트랩이 원본 diff를 그대로 보여준다.
 */
const DIFF2HTML_VERSION = '3.4.51';
const DIFF2HTML_CSS = `https://cdn.jsdelivr.net/npm/diff2html@${DIFF2HTML_VERSION}/bundles/css/diff2html.min.css`;
const DIFF2HTML_CSS_SRI = 'sha384-iBvSlI3tNrrSIy7s6mvLg+5B2Z/QXbR4L0Pzg1nRf8zkXrz5JF316MLm2igMIpi2';
const DIFF2HTML_JS = `https://cdn.jsdelivr.net/npm/diff2html@${DIFF2HTML_VERSION}/bundles/js/diff2html-ui.min.js`;
const DIFF2HTML_JS_SRI = 'sha384-ZfUgCQ5nDmqyzTrOvgM5FJEYXzdtWqL4LcBa1/+07S5i9JnJDmrrZfIoJQN5uWSh';
/**
 * 코드 하이라이트 토큰 색.
 *
 * highlightCode가 붙이는 hljs 클래스에 짝이 되는 CSS가 없으면 토큰이 색 없이 상속된다.
 * 예전에는 GitHub 다크 테마 CSS를 받았는데 그 원색은 밝은 테마와 추가, 삭제 줄 바탕에서
 * 기준을 못 넘었다. diff 바탕 위에서 대비가 보장되는 역할은 본문 글자색뿐이라 상태 역할을
 * 본문 글자색에 65%만 섞는다. 204개 테마의 surface와 diff 바탕 위에서 4.6:1 넘게 남는다.
 */
const tok = (role: string) =>
  `color-mix(in srgb, var(--gestalt-color-${role}) 65%, var(--gestalt-color-text))`;
const HLJS_TOKEN_CSS = [
  `.hljs-keyword,.hljs-selector-tag,.hljs-template-tag,.hljs-template-variable,.hljs-type,.hljs-variable.language_{color:${tok('danger-text')}}`,
  `.hljs-title,.hljs-title.class_,.hljs-title.function_{color:${tok('accent-text')}}`,
  `.hljs-attr,.hljs-attribute,.hljs-literal,.hljs-meta,.hljs-number,.hljs-operator,.hljs-variable,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-id,.hljs-built_in{color:${tok('info-text')}}`,
  `.hljs-string,.hljs-regexp,.hljs-name,.hljs-quote,.hljs-selector-pseudo{color:${tok('success-text')}}`,
  `.hljs-symbol,.hljs-bullet{color:${tok('warning-text')}}`,
  `.hljs-comment,.hljs-code,.hljs-formula{color:${tok('text-muted')};font-style:italic}`,
  `.hljs-section{color:${tok('info-text')};font-weight:700}`,
  '.hljs-subst{color:var(--fg)}',
  '.hljs-emphasis{font-style:italic}',
  '.hljs-strong{font-weight:700}',
].join('\n');

/**
 * diff2html 색 변수를 역할 값으로 덮는다.
 *
 * 라이브러리는 밝은 쪽(--d2h-*)과 어두운 쪽(--d2h-dark-*) 변수를 :root에 따로 두고 wrapper의
 * 색 구성 클래스로 고른다. 둘 다 같은 역할로 덮어서 어느 쪽이 켜져도 테마를 따른다.
 * 링크 CSS가 이 블록 앞에 오지만 같은 :root라 선택자를 html:root로 높여 둔다.
 */
const D2H_ROLES: Record<string, string> = {
  'bg-color': 'var(--gestalt-color-surface)',
  'border-color': 'var(--gestalt-color-border)',
  'dim-color': 'var(--gestalt-color-text-muted)',
  'line-border-color': 'var(--gestalt-color-border)',
  'file-header-bg-color': 'var(--gestalt-color-background)',
  'file-header-border-color': 'var(--gestalt-color-border)',
  'empty-placeholder-bg-color': 'var(--gestalt-color-background)',
  'empty-placeholder-border-color': 'var(--gestalt-color-border)',
  'selected-color': 'var(--gestalt-color-highlight)',
  'ins-bg-color': 'var(--gestalt-color-diff-added-bg)',
  'ins-border-color': 'var(--gestalt-color-diff-added-text)',
  'ins-highlight-bg-color': 'var(--gestalt-color-diff-added-bg)',
  'ins-label-color': 'var(--gestalt-color-diff-added-text)',
  'del-bg-color': 'var(--gestalt-color-diff-removed-bg)',
  'del-border-color': 'var(--gestalt-color-diff-removed-text)',
  'del-highlight-bg-color': 'var(--gestalt-color-diff-removed-bg)',
  'del-label-color': 'var(--gestalt-color-diff-removed-text)',
  'change-del-color': 'var(--gestalt-color-diff-changed-bg)',
  'change-ins-color': 'var(--gestalt-color-diff-changed-bg)',
  'change-label-color': 'var(--gestalt-color-diff-changed-text)',
  'moved-label-color': 'var(--gestalt-color-diff-changed-text)',
  'info-bg-color': 'var(--gestalt-color-background)',
  'info-border-color': 'var(--gestalt-color-border)',
};

const DIFF_THEME_CSS = `html:root{${Object.entries(D2H_ROLES)
  .map(([k, v]) => `--d2h-${k}:${v};--d2h-dark-${k}:${v};`)
  .join('')}--d2h-dark-color:var(--gestalt-color-text);}
.d2h-wrapper .hljs{background:transparent;color:var(--fg)}
.d2h-wrapper{color:var(--fg)}
.d2h-file-name,.d2h-info{color:var(--fg)}
/* 줄 앞 +, - 기호는 색이 아니라 모양으로 추가와 삭제를 알리는 자리라 diff 바탕 위 대비가 보장되는 본문 글자색으로 둔다 */
.d2h-code-line-prefix,.d2h-code-linenumber,.d2h-code-side-linenumber{color:var(--fg)}
.d2h-ins .d2h-code-line-prefix,.d2h-del .d2h-code-line-prefix{font-weight:700}
.d2h-file-list-wrapper a{color:var(--accent)}`;

/**
 * HTML에 인라인으로 심을 diff의 상한.
 *
 * 문서 크기가 diff 크기를 그대로 따라간다. 브라우저가 그 전체를 한 번에 파싱해
 * 메인 스레드를 잡는다. 넘는 만큼은 잘라내고 전체를 보는 법을 안내한다.
 */
const MAX_INLINE_DIFF_BYTES = 512 * 1024;

/**
 * diff를 상한까지 자른다.
 *
 * 바이트로 잰다. `diff.length`는 UTF-16 코드 유닛이라 한글 diff에서는 문자당 2바이트가
 * 넘어 실제 페이로드가 상한의 두 배를 넘긴다. Buffer로 자르면 멀티바이트 시퀀스가
 * 중간에서 갈릴 수 있다. `toString`이 그 자리를 접어주고 남는 고아 서로게이트는
 * 뒤에서 걷어낸다.
 *
 * 자를 때는 마지막 파일 경계까지만 준다. diff2html은 관대해서 잘린 hunk에도 예외를
 * 안 내고 그냥 헤더가 약속한 줄 수보다 적게 그린다 — 리뷰어가 없는 변경을 봤다고
 * 판단하는 자리라 파싱이 성립하는 자리에서 끊는다.
 */
function clipDiff(diff: string): { shownDiff: string; truncated: boolean } {
  // byteLength는 할당 없이 센다. Buffer.from으로 재면 자를 필요가 없는 대다수 경우에도
  // diff 길이만큼 힙을 잡는다 — git 쪽 maxBuffer가 64MB라 그만큼까지 커진다
  if (Buffer.byteLength(diff, 'utf-8') <= MAX_INLINE_DIFF_BYTES) {
    return { shownDiff: diff, truncated: false };
  }

  let shown = Buffer.from(diff, 'utf-8')
    .subarray(0, MAX_INLINE_DIFF_BYTES)
    .toString('utf-8')
    .replace(/[\uD800-\uDBFF]$/, '');
  const lastFile = shown.lastIndexOf('\ndiff --git ');
  if (lastFile > 0) shown = shown.slice(0, lastFile + 1);

  return { shownDiff: shown, truncated: true };
}

export interface RepoTab {
  key: string;
  name: string;
  active: boolean;
  /** 아직 안 닫힌 PR 수. 어디에 일이 쌓였는지 한눈에 보이라고 함께 그린다 */
  openCount: number;
}

/**
 * 레포 사이를 옮겨 다니는 줄.
 *
 * 레포가 하나뿐이어도 안내 한 줄은 남긴다. PR을 만들기만 하고 `pr serve`를 안 돌린
 * 레포는 목록에 안 뜨는데, 아무 표시가 없으면 왜 없는지 알 길이 없다.
 */
function repoNavHtml(repos: RepoTab[]): string {
  const hint =
    '<p class="meta">여기 목록은 <code>gestalt pr serve</code>를 한 번이라도 돌린 레포만 보여요</p>';
  if (repos.length <= 1) return hint;
  const items = repos
    .map((r) => {
      const label = `${escapeHtml(r.name)} <span class="meta">${r.openCount}</span>`;
      return `<li>${
        r.active ? `<strong>${label}</strong>` : `<a href="/r/${escapeHtml(r.key)}">${label}</a>`
      }</li>`;
    })
    .join('\n      ');
  return `<nav aria-label="레포"><ul class="repos">\n      ${items}\n    </ul>\n    ${hint}</nav>`;
}

/** `GET /r/:key` — PR 목록 페이지 */
export function generatePrListHtml(prs: PullRequest[], repos: RepoTab[] = [], nonce = ''): string {
  const base = repos.find((r) => r.active)?.key ?? '';
  const rows = prs
    .map((pr) => {
      const round = pr.rounds[pr.rounds.length - 1]!;
      const unresolved = unresolvedCount(pr);
      return `<tr>
        <td><a href="/r/${escapeHtml(base)}/prs/${encodeURIComponent(pr.id)}">${escapeHtml(pr.id)}</a></td>
        <td><a href="/r/${escapeHtml(base)}/prs/${encodeURIComponent(pr.id)}">${escapeHtml(pr.title)}</a></td>
        <td>${statusBadge(pr.status)}</td>
        <td>${round.number}</td>
        <td>${unresolved}</td>
        <td class="meta">${escapeHtml(pr.author)}</td>
      </tr>`;
    })
    .join('\n');

  const body = `
  ${repoNavHtml(repos)}
  <h1>로컬 PR</h1>
  ${
    prs.length === 0
      ? '<p class="empty">아직 PR이 없어요</p>'
      : `<table>
    <caption class="sr-only">로컬 PR 목록</caption>
    <thead>
      <tr><th scope="col">ID</th><th scope="col">제목</th><th scope="col">상태</th><th scope="col">라운드</th><th scope="col">미해결</th><th scope="col">작성자</th></tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>`
  }`;

  return pageShell('로컬 PR 목록', body, '', nonce);
}

function renderRounds(pr: PullRequest): string {
  return pr.rounds
    .map((round) => {
      const reviews = pr.reviews.filter((r) => r.round === round.number);
      const reviewItems =
        reviews.length === 0
          ? '<div class="meta">판정 없음</div>'
          : reviews
              .map(
                (r: Review) => `<div class="card">
        <div class="card-header">
          <strong>${escapeHtml(r.reviewer)}</strong>
          ${verdictBadge(r.verdict)}
        </div>
        <div class="body-text">${escapeHtml(r.summary)}</div>
      </div>`,
              )
              .join('\n');

      return `<h2>라운드 ${round.number} — ${round.verdict ? escapeHtml(round.verdict) : '진행 중'} (코멘트 ${round.commentCount})</h2>
      ${reviewItems}`;
    })
    .join('\n');
}

function renderThreads(pr: PullRequest): string {
  const threads = threadsOf(pr);
  if (threads.length === 0) return '<p class="empty">코멘트가 없어요</p>';

  return threads
    .map((thread) => {
      // 배지는 policy의 open으로 찍는다. 첫 코멘트의 resolved로 찍으면 뿌리가 닫히고
      // 답글이 열린 스레드에서 목록 페이지의 미해결 수와 갈린다
      const resolved = thread.open ? '열림' : '해결';
      // 자리는 스레드가 처음 붙은 코멘트에서 가져온다. 답글은 라인을 안 갖는다
      const anchor = thread.all[0]!;
      const at = anchor.line === null ? anchor.path : `${anchor.path}:${anchor.line}`;
      const items = thread.all
        .map(
          (c) => `<div class="comment">
        <div class="card-header">
          <strong>${escapeHtml(c.author)}</strong>
          <time class="meta" datetime="${escapeHtml(c.createdAt)}">${escapeHtml(
            formatTime(c.createdAt),
          )}</time>
        </div>
        <div class="body-text">${escapeHtml(c.body)}</div>
      </div>`,
        )
        .join('\n');

      return `<div class="thread">
        <div class="meta"><span class="path">${escapeHtml(at)}</span> — ${resolved}</div>
        ${items}
      </div>`;
    })
    .join('\n');
}

/** `GET /prs/:id` — diff와 코멘트 스레드, 라운드별 판정 이력 */
export function generatePrDetailHtml(
  pr: PullRequest,
  diff: string,
  repoKey = '',
  repoName = '',
  nonce = '',
): string {
  const nonceAttr = nonceAttrOf(nonce);
  const extraHead = `
  <link rel="stylesheet" href="${DIFF2HTML_CSS}" integrity="${DIFF2HTML_CSS_SRI}" crossorigin="anonymous" />
  <style>${DIFF_THEME_CSS}
${HLJS_TOKEN_CSS}</style>
  <script src="${DIFF2HTML_JS}" integrity="${DIFF2HTML_JS_SRI}" crossorigin="anonymous"></script>
`;

  const { shownDiff, truncated } = clipDiff(diff);

  const body = `
  <nav aria-label="브레드크럼"><a href="/r/${escapeHtml(repoKey)}">&larr; ${
    repoName ? `${escapeHtml(repoName)}의 PR 목록` : 'PR 목록'
  }</a></nav>
  <h1>${escapeHtml(pr.title)} <span class="meta">#${escapeHtml(pr.id)}</span></h1>
  <p class="meta">
    ${statusBadge(pr.status)} 작성 ${escapeHtml(pr.author)} ·
    base ${escapeHtml(pr.baseRef ?? pr.baseSha.slice(0, 8))} &rarr;
    head ${escapeHtml(pr.headRef ?? pr.headSha.slice(0, 8))}
  </p>
  ${pr.body ? `<div class="card body-text">${escapeHtml(pr.body)}</div>` : ''}

  <h2>Diff</h2>
  <section id="diff-container" role="region" aria-label="변경 내용" aria-busy="true"></section>

  <h2>라운드</h2>
  ${renderRounds(pr)}

  <h2>코멘트</h2>
  ${renderThreads(pr)}

  <script${nonceAttr}>
    (function () {
      var diffString = ${toEmbeddableJson(shownDiff)};
      var truncated = ${truncated};
      var target = document.getElementById('diff-container');
      var root = document.documentElement;
      var tone = function () {
        return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
      };
      // 다른 화면에서 테마를 바꾸면 diff2html 색 구성 클래스도 새 밝기로 맞춘다
      var syncTone = function () {
        var t = tone();
        target.querySelectorAll('.d2h-dark-color-scheme, .d2h-light-color-scheme').forEach(function (el) {
          el.classList.toggle('d2h-dark-color-scheme', t === 'dark');
          el.classList.toggle('d2h-light-color-scheme', t === 'light');
        });
      };
      document.addEventListener('gestalt-theme', syncTone);
      var addNote = function () {
        if (!truncated) return;
        var note = document.createElement('p');
        note.className = 'empty';
        note.setAttribute('role', 'status');
        note.textContent = 'diff가 커서 앞부분만 보여드려요. 전체는 gestalt pr diff로 봐주세요.';
        target.insertBefore(note, target.firstChild);
      };
      var done = function () {
        addNote();
        target.setAttribute('aria-busy', 'false');
      };

      if (!diffString) {
        target.innerHTML = '<p class="empty">변경 없음</p>';
        done();
        return;
      }

      // 스크립트를 못 받아오면(오프라인, 막힌 사내망) 아무 말 없이 빈 상자가 남는다.
      // 원본 diff라도 보여줘야 "변경이 없다"와 구분된다
      if (typeof Diff2HtmlUI === 'undefined') {
        var pre = document.createElement('pre');
        pre.className = 'path';
        pre.textContent = diffString;
        target.innerHTML = '<p class="empty">diff 렌더러를 못 불러왔어요 — 원본을 그대로 보여드려요</p>';
        target.appendChild(pre);
        done();
        return;
      }

      try {
        var ui = new Diff2HtmlUI(target, diffString, {
          drawFileList: true,
          matching: 'lines',
          outputFormat: 'line-by-line',
          // 변수는 위 DIFF_THEME_CSS가 양쪽 다 역할 값으로 덮는다. 색 구성은 변수 말고
          // 직접 칠하는 규칙이 남아 있어서 지금 테마의 밝기를 넘긴다
          colorScheme: tone(),
        });
        ui.draw();
        ui.highlightCode();
      } catch (e) {
        var raw = document.createElement('pre');
        raw.className = 'path';
        raw.textContent = diffString;
        target.innerHTML = '';
        target.appendChild(raw);
      }

      done();
    })();
  </script>`;

  return pageShell(pr.title, body, extraHead, nonce);
}
