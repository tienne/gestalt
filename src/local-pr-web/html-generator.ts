import { unresolvedCount } from '../local-pr/policy.js';
import type { Comment, PullRequest, Review } from '../local-pr/types.js';

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
export function toEmbeddableJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function pageShell(title: string, body: string, extraHead = ''): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0d1117;
      color: #e6edf3;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      line-height: 1.5;
      padding: 24px 32px 64px;
    }
    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    h1 { font-size: 20px; margin-bottom: 16px; }
    h2 { font-size: 15px; color: #8b949e; margin: 28px 0 10px; text-transform: uppercase; letter-spacing: 0.04em; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #30363d; font-size: 14px; }
    th { color: #8b949e; font-weight: 600; font-size: 12px; text-transform: uppercase; }
    tr:hover td { background: #161b22; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .badge-open { background: #1f6feb33; color: #58a6ff; }
    .badge-changes_requested { background: #f8514933; color: #ff7b72; }
    .badge-merged { background: #23863633; color: #3fb950; }
    .badge-closed { background: #30363d; color: #8b949e; }
    .badge-approve { background: #23863633; color: #3fb950; }
    .badge-request_changes { background: #f8514933; color: #ff7b72; }
    .badge-comment { background: #30363d; color: #8b949e; }
    .meta { color: #8b949e; font-size: 13px; }
    .empty { color: #484f58; padding: 40px 0; text-align: center; }
    .card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 16px 18px;
      margin-bottom: 12px;
    }
    .card-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
    .body-text { white-space: pre-wrap; word-break: break-word; font-size: 13px; }
    .thread { border-left: 2px solid #30363d; padding-left: 14px; margin-bottom: 18px; }
    .comment + .comment { margin-top: 10px; padding-top: 10px; border-top: 1px dashed #30363d; }
    .path { font-family: 'JetBrains Mono', 'Fira Code', monospace; color: #8b949e; font-size: 12px; }
    #diff-container { margin-top: 8px; }
  </style>
  ${extraHead}
</head>
<body>
${body}
</body>
</html>`;
}

function statusBadge(status: string): string {
  return `<span class="badge badge-${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

function verdictBadge(verdict: string): string {
  return `<span class="badge badge-${escapeHtml(verdict)}">${escapeHtml(verdict)}</span>`;
}

/** `GET /` — PR 목록 페이지 */
export function generatePrListHtml(prs: PullRequest[]): string {
  const rows = prs
    .map((pr) => {
      const round = pr.rounds[pr.rounds.length - 1]!;
      const unresolved = unresolvedCount(pr);
      return `<tr>
        <td><a href="/prs/${encodeURIComponent(pr.id)}">${escapeHtml(pr.id)}</a></td>
        <td><a href="/prs/${encodeURIComponent(pr.id)}">${escapeHtml(pr.title)}</a></td>
        <td>${statusBadge(pr.status)}</td>
        <td>${round.number}</td>
        <td>${unresolved}</td>
        <td class="meta">${escapeHtml(pr.author)}</td>
      </tr>`;
    })
    .join('\n');

  const body = `
  <h1>로컬 PR</h1>
  ${
    prs.length === 0
      ? '<p class="empty">PR이 없다</p>'
      : `<table>
    <thead>
      <tr><th>ID</th><th>제목</th><th>상태</th><th>라운드</th><th>미해결</th><th>작성자</th></tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>`
  }`;

  return pageShell('로컬 PR 목록', body);
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

function renderThreads(comments: Comment[]): string {
  if (comments.length === 0) return '<p class="empty">코멘트가 없다</p>';

  const threads = new Map<string, Comment[]>();
  for (const c of comments) {
    const list = threads.get(c.threadId) ?? [];
    list.push(c);
    threads.set(c.threadId, list);
  }

  return Array.from(threads.values())
    .map((thread) => {
      const root = thread[0]!;
      const at = root.line === null ? root.path : `${root.path}:${root.line}`;
      const resolved = root.resolved ? '해결' : '열림';
      const items = thread
        .map(
          (c) => `<div class="comment">
        <div class="card-header">
          <strong>${escapeHtml(c.author)}</strong>
          <span class="meta">${escapeHtml(c.createdAt)}</span>
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
export function generatePrDetailHtml(pr: PullRequest, diff: string): string {
  const extraHead = `
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/diff2html/bundles/css/diff2html.min.css" />
  <script src="https://cdn.jsdelivr.net/npm/diff2html/bundles/js/diff2html-ui.min.js"></script>`;

  const body = `
  <p><a href="/">&larr; PR 목록</a></p>
  <h1>${escapeHtml(pr.title)} <span class="meta">#${escapeHtml(pr.id)}</span></h1>
  <p class="meta">
    ${statusBadge(pr.status)} 작성 ${escapeHtml(pr.author)} ·
    base ${escapeHtml(pr.baseRef ?? pr.baseSha.slice(0, 8))} &rarr;
    head ${escapeHtml(pr.headRef ?? pr.headSha.slice(0, 8))}
  </p>
  ${pr.body ? `<div class="card body-text">${escapeHtml(pr.body)}</div>` : ''}

  <h2>Diff</h2>
  <div id="diff-container"></div>

  <h2>라운드</h2>
  ${renderRounds(pr)}

  <h2>코멘트</h2>
  ${renderThreads(pr.comments)}

  <script>
    (function () {
      var diffString = ${toEmbeddableJson(diff)};
      var target = document.getElementById('diff-container');
      if (!diffString) {
        target.innerHTML = '<p class="empty">변경 없음</p>';
        return;
      }
      var ui = new Diff2HtmlUI(target, diffString, {
        drawFileList: true,
        matching: 'lines',
        outputFormat: 'line-by-line',
      });
      ui.draw();
      ui.highlightCode();
    })();
  </script>`;

  return pageShell(pr.title, body, extraHead);
}
