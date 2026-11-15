import type { PrdCoverage } from './lint-prd.js';
import { PRD_CSS } from './prd-css.js';
import { allBlocks, type PrdView } from './prd-schema.js';
import { PRD_HTML_MARKER } from './prd-store.js';
import { PRD_VIEWER_JS, PRD_VIEWER_JS_SHA256 } from './prd-viewer-js.js';
import { esc, fmtSrc, inlineMd, renderBlock, type BlockContext } from './render-prd-blocks.js';
import { THEME_BOOT_JS, THEME_BOOT_JS_SHA256 } from './viewer-js.js';

export interface RenderPrdOptions {
  sourceSha256: string;
  coverage: PrdCoverage;
}

const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  `script-src 'sha256-${THEME_BOOT_JS_SHA256}' 'sha256-${PRD_VIEWER_JS_SHA256}'`,
  'img-src data:',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function blockContext(view: PrdView): BlockContext {
  const metricAnchor = new Map<string, string>();
  for (const { block } of allBlocks(view)) {
    if (block.kind === 'metric') metricAnchor.set(block.metricId, block.id);
  }
  return { metricAnchor };
}

/**
 * PRD 뷰를 HTML 한 장으로 그린다. LLM을 부르지 않는다.
 * 렌더 시각은 넣지 않는다. 같은 입력이면 같은 바이트가 나와야 다시 렌더해도 diff가 안 생긴다
 */
export function renderPrdHtml(view: PrdView, opts: RenderPrdOptions): string {
  const ctx = blockContext(view);
  const sections = view.sections
    .map(
      (s) =>
        `<section class="sec" id="s-${esc(s.id)}"><h2>${inlineMd(s.title)}</h2>${s.blocks
          .map((b) => renderBlock(b, ctx))
          .join('')}</section>`,
    )
    .join('\n');
  const toc = view.sections
    .map((s) => `<li><a href="#s-${esc(s.id)}">${esc(s.title)}</a></li>`)
    .join('');
  const rows = view.meta.rows
    .map(
      (r) =>
        `<span class="row" title="원문 ${fmtSrc(r.src)}"><b>${esc(r.key)}</b>${inlineMd(r.value)}</span>`,
    )
    .join('');
  const cov = opts.coverage;
  const covText =
    cov.contentLines === 0
      ? '내용 줄 없음'
      : `원문 내용 줄 ${cov.contentLines}줄 중 ${cov.coveredLines}줄 옮김, 생략 선언 ${cov.omittedLines}줄, 빠진 줄 ${cov.uncoveredLines}줄`;
  const omitted = view.omitted.length
    ? `<p>일부러 옮기지 않은 구간: ${view.omitted
        .map((o) => `${fmtSrc(o.src)} (${esc(o.reason)})`)
        .join(', ')}</p>`
    : '';

  return `${PRD_HTML_MARKER}
<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="referrer" content="no-referrer">
<title>${esc(view.meta.title)}</title>
<script>${THEME_BOOT_JS}</script>
<style>${PRD_CSS}</style>
<noscript><style>.theme-switch{display:none!important}</style></noscript>
</head>
<body>
<div class="layout">
<nav class="toc" aria-label="목차"><p class="toc-h">목차</p><ol>${toc}</ol></nav>
<main>
<header class="head"><span class="theme-switch" role="group" aria-label="테마"><button type="button" data-theme-set="auto" aria-pressed="true">자동</button><button type="button" data-theme-set="light" aria-pressed="false">라이트</button><button type="button" data-theme-set="dark" aria-pressed="false">다크</button></span>
<h1>${inlineMd(view.meta.title)}</h1>
${rows ? `<div class="meta">${rows}</div>` : ''}
<p class="src-path">원문 ${esc(view.meta.source)} · ${esc(opts.sourceSha256.slice(0, 8))}</p>
</header>
${sections}
<footer class="foot"><p>${covText}</p>${omitted}<p>원문 sha256 ${esc(opts.sourceSha256)}</p></footer>
</main>
</div>
<script>${PRD_VIEWER_JS}</script>
</body>
</html>
`;
}
