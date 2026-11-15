import type { PrdCoverage } from './lint-prd.js';
import { GAP_TITLE, PRD_GAP_CODES, type PrdGap } from './lint-prd-gaps.js';
import { PRD_CSS } from './prd-css.js';
import { allBlocks, type PrdView } from './prd-schema.js';
import { PRD_HTML_MARKER } from './prd-store.js';
import { PRD_VIEWER_JS, PRD_VIEWER_JS_SHA256 } from './prd-viewer-js.js';
import {
  AUDIENCE_LABEL,
  esc,
  fmtSrc,
  inlineMd,
  renderBlock,
  type BlockContext,
} from './render-prd-blocks.js';
import { renderOverview, usedAudiences } from './render-prd-views.js';
import { THEME_BOOT_JS, THEME_BOOT_JS_SHA256 } from './viewer-js.js';

export interface RenderPrdOptions {
  sourceSha256: string;
  coverage: PrdCoverage;
  /** 원문 빈칸. 주면 본문 앞에 패널로 그린다 */
  gaps?: readonly PrdGap[];
}

/** 빈칸 패널. 코드별로 묶고 걸린 카드로 링크한다 */
function renderGaps(gaps: readonly PrdGap[]): string {
  if (gaps.length === 0) return '';
  const groups = PRD_GAP_CODES.map((code) => ({
    code,
    items: gaps.filter((g) => g.code === code),
  })).filter((g) => g.items.length);
  return `<section class="sec gaps" id="gaps"><h2>원문 빈칸 ${gaps.length}</h2>${groups
    .map(
      (g) =>
        `<h3>${esc(GAP_TITLE[g.code])}</h3><ul class="xlist">${g.items
          .map(
            (i) =>
              `<li>${i.blockIds.map((id) => `<a href="#b-${esc(id)}">${esc(id)}</a>`).join(', ')} <span class="where">${esc(i.message)}</span></li>`,
          )
          .join('')}</ul>`,
    )
    .join('')}</section>`;
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
  const overview = renderOverview(view);
  const gapsHtml = renderGaps(opts.gaps ?? []);
  const xToc = [
    ...(gapsHtml ? [{ id: 'gaps', title: `원문 빈칸 ${opts.gaps!.length}` }] : []),
    ...overview.toc,
  ];
  const overviewToc = xToc.length
    ? `<p class="toc-h">모아 보기</p><ol>${xToc
        .map((t) => `<li><a href="#${t.id}">${esc(t.title)}</a></li>`)
        .join('')}</ol>`
    : '';
  const audiences = usedAudiences(view);
  // 대상이 하나뿐이면 걸러도 달라지는 게 거의 없어서 버튼을 안 낸다
  const audFilter =
    audiences.length > 1
      ? `<div class="aud-filter" role="group" aria-label="대상별 보기"><p class="toc-h">대상별 보기</p><button type="button" data-aud-filter="" aria-pressed="true">전체</button>${audiences
          .map(
            (a) =>
              `<button type="button" data-aud-filter="${a}" aria-pressed="false">${AUDIENCE_LABEL[a]}</button>`,
          )
          .join('')}</div>`
      : '';
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
<noscript><style>.theme-switch,.aud-filter{display:none!important}</style></noscript>
</head>
<body>
<div class="layout">
<nav class="toc" aria-label="목차">${audFilter}${overviewToc}<p class="toc-h">목차</p><ol>${toc}</ol></nav>
<main>
<header class="head"><span class="theme-switch" role="group" aria-label="테마"><button type="button" data-theme-set="auto" aria-pressed="true">자동</button><button type="button" data-theme-set="light" aria-pressed="false">라이트</button><button type="button" data-theme-set="dark" aria-pressed="false">다크</button></span>
<h1>${inlineMd(view.meta.title)}</h1>
${rows ? `<div class="meta">${rows}</div>` : ''}
<p class="src-path">원문 ${esc(view.meta.source)} · ${esc(opts.sourceSha256.slice(0, 8))}</p>
</header>
${gapsHtml}
${overview.html}
${sections}
<footer class="foot"><p>${covText}</p>${omitted}<p>원문 sha256 ${esc(opts.sourceSha256)}</p></footer>
</main>
</div>
<script>${PRD_VIEWER_JS}</script>
</body>
</html>
`;
}
