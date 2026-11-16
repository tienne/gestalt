import { basename, isAbsolute, relative, resolve, win32 } from 'node:path';
import type { PrdCoverage, PrdIssue } from './lint-prd.js';
import type { PrdGap } from './lint-prd-gaps.js';
import type { PrdProseGroup } from './lint-prd-prose.js';
import { PRD_COPY as C, PRD_TABS } from './prd-copy.js';
import { PRD_CSS } from './prd-css.js';
import { allBlocks, type PrdView } from './prd-schema.js';
import { PRD_HTML_MARKER } from './prd-store.js';
import {
  PRD_VIEWER_JS,
  PRD_VIEWER_JS_SHA256,
  PRD_THEME_BOOT_JS,
  PRD_THEME_BOOT_JS_SHA256,
} from './prd-viewer-js.js';
import {
  AUDIENCE_LABEL,
  esc,
  fmtSrc,
  inlineMd,
  inlineLabel,
  type BlockContext,
} from './render-prd-blocks.js';
import { usedAudiences } from './render-prd-views.js';
import {
  renderDecisions,
  renderMetrics,
  renderPrdSections,
  renderPrdToc,
  renderReview,
  renderSpec,
  reviewCount,
} from './render-prd-tabs.js';

export interface RenderPrdOptions {
  sourceSha256: string;
  repoRoot?: string;
  coverage: PrdCoverage;
  gaps?: readonly PrdGap[];
  prose?: readonly PrdProseGroup[];
  issues?: readonly PrdIssue[];
}

const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  `script-src 'sha256-${PRD_THEME_BOOT_JS_SHA256}' 'sha256-${PRD_VIEWER_JS_SHA256}'`,
  'img-src data:',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** 원문 기반 PRD를 외부 요청 없는 HTML 한 장으로 그린다. 같은 입력에는 같은 바이트를 반환한다. */
export function renderPrdHtml(view: PrdView, opts: RenderPrdOptions): string {
  const metricAnchor = new Map<string, string>();
  for (const { block } of allBlocks(view))
    if (block.kind === 'metric') metricAnchor.set(block.metricId, block.id);
  const ctx: BlockContext = { metricAnchor };
  const sourcePath = view.meta.source;
  const foreignAbsolute = win32.isAbsolute(sourcePath) && !isAbsolute(sourcePath);
  const rel =
    opts.repoRoot && !foreignAbsolute
      ? relative(resolve(opts.repoRoot), resolve(opts.repoRoot, sourcePath))
      : undefined;
  const displaySource =
    rel && !rel.startsWith('..') && !isAbsolute(rel)
      ? rel
      : basename(sourcePath.replace(/\\/g, '/'));
  const review = {
    gaps: opts.gaps ?? [],
    prose: opts.prose ?? [],
    issues: opts.issues ?? [],
    coverage: opts.coverage,
  };
  const count = reviewCount(review);
  const spec = renderSpec(view, review);
  const audiences = usedAudiences(view);
  const audience =
    audiences.length > 1
      ? `<div class="aud-filter" role="group" aria-label="${C.audience}"><span>${C.audience}</span><button type="button" data-aud-filter="" aria-pressed="true">${C.all}</button>${audiences.map((a) => `<button type="button" data-aud-filter="${a}" aria-pressed="false">${AUDIENCE_LABEL[a]}</button>`).join('')}</div>`
      : '';
  const cov = opts.coverage;
  const covText =
    cov.contentLines === 0
      ? C.coverageEmpty
      : `원문 내용 줄 ${cov.contentLines}줄 중 ${cov.coveredLines}줄 옮김, 생략 선언 ${cov.omittedLines}줄, 빠진 줄 ${cov.uncoveredLines}줄`;
  const coverage = cov.contentLines ? Math.round((cov.coveredLines / cov.contentLines) * 100) : 0;
  const rows = view.meta.rows
    .map(
      (r) =>
        `<div class="meta-row"><b>${esc(r.key)}</b><div>${inlineMd(r.value)}<span class="src">${fmtSrc(r.src)}</span></div></div>`,
    )
    .join('');
  const meta = `<section class="card" id="document-info"><h2>${C.document}</h2>${rows}${view.meta.roles?.length ? `<div class="meta-row"><b>${C.roles}</b><div>${view.meta.roles.map((r) => `${inlineMd(r.text)}<span class="src">${fmtSrc(r.src)}</span>`).join(', ')}</div></div>` : ''}${view.meta.platforms?.length ? `<div class="meta-row"><b>${C.platforms}</b><div>${view.meta.platforms.map((r) => `${inlineMd(r.text)}<span class="src">${fmtSrc(r.src)}</span>`).join(', ')}</div></div>` : ''}<p class="src-path">${C.line} ${esc(displaySource)} · ${esc(opts.sourceSha256.slice(0, 8))}</p></section>`;
  const totals = [...allBlocks(view)].map(({ block }) => block);
  const chips = `<div class="toc-foot">${[
    [
      C.features,
      totals.filter(
        (b) =>
          b.kind === 'requirement' &&
          !totals.some((child) => child.kind === 'requirement' && child.parent === b.id),
      ).length,
    ],
    [C.metrics, totals.filter((b) => b.kind === 'metric').length],
    [C.gaps, review.gaps.length],
  ]
    .map(([label, n]) => `<span class="chipbox">${label} <b>${n}</b></span>`)
    .join('')}</div>`;
  const nav = (rail: boolean) =>
    PRD_TABS.map(
      ([id, label, icon]) =>
        `<button type="button" data-go="${id}"${rail ? '' : ` role="tab" id="tab-${id}" aria-controls="panel-${id}" aria-selected="${id === 'prd'}" tabindex="${id === 'prd' ? '0' : '-1'}"`} class="${rail ? 'rail-tab' : 'tab'}${id === 'prd' ? ' on' : ''}">${rail ? `<span class="ic" aria-hidden="true">${icon}</span>` : ''}${rail && id === 'spec' ? C.features : rail && id === 'decisions' ? C.decision : label}${!rail && id === 'review' ? `<span class="badge review-count">${count}</span>` : ''}</button>`,
    ).join('');
  const panel = (id: string, toc: string, html: string) =>
    `<section class="tab-panel body" id="panel-${id}" data-panel="${id}" role="tabpanel" aria-labelledby="tab-${id}"${id !== 'prd' ? ' hidden' : ''}><nav class="toc" aria-label="${C.toc}"><h2>${C.toc}</h2><div class="toc-scroll">${toc}</div>${chips}</nav><div class="content">${html}</div></section>`;
  const omitted = view.omitted.length
    ? `<p>${C.omitted}: ${view.omitted.map((o) => `${fmtSrc(o.src)} (${esc(o.reason)})`).join(', ')}</p>`
    : '';
  return `${PRD_HTML_MARKER}
<!doctype html>
<html lang="ko" data-theme="dark">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="referrer" content="no-referrer"><title>${esc(view.meta.title)}</title><script>${PRD_THEME_BOOT_JS}</script><style>${PRD_CSS}</style><noscript><style>.rail,.tabs,.aud-filter{display:none!important}.tab-panel[hidden],.spec-directory{display:grid!important}.app{grid-template-columns:1fr;height:auto;min-height:100vh}.main{display:block;overflow:visible}.body{height:auto}.content{overflow:visible}.req-detail{display:block!important}</style></noscript></head>
<body><div class="app"><nav class="rail" aria-label="PRD"><div class="logo" aria-hidden="true">G</div>${nav(true)}<div class="sp"></div><button type="button" data-source-toggle aria-pressed="false"><span class="ic" aria-hidden="true">≡</span>${C.source}</button><button type="button" data-theme-toggle aria-label="${C.theme}"><span class="ic" aria-hidden="true">◐</span><span data-theme-label>${C.light}</span></button></nav><main class="main"><header class="top"><h1 class="title">${inlineMd(view.meta.title)}</h1><div class="tabs" role="tablist" aria-label="PRD">${nav(false)}</div><div class="sp"></div>${audience}</header>
${panel('prd', renderPrdToc(view), `<div class="progress"><span>${C.coverage}</span><progress max="100" value="${coverage}" aria-label="${C.coverage}"></progress><span>${coverage}%</span><a href="#panel-review" class="warn">${C.gaps} ${review.gaps.length}</a></div><div class="doc">${meta}${renderPrdSections(view, ctx)}<footer class="foot" id="source-coverage"><p>${covText}</p>${omitted}<p>원문 sha256 ${esc(opts.sourceSha256)}</p></footer></div>`)}
${panel('spec', spec.toc, spec.html)}
${panel(
  'metrics',
  [
    ['primary', C.primary],
    ['secondary', C.secondary],
    ['guardrail', C.guardrail],
    ['', C.unclassified],
  ]
    .filter(([role]) => totals.some((b) => b.kind === 'metric' && (b.role ?? '') === role))
    .map(
      ([role, label]) =>
        `<a data-section-nav="metrics-${role || 'other'}" href="#metrics-${role || 'other'}">${label}</a>`,
    )
    .join(''),
  `<div class="doc metrics-doc">${renderMetrics(view)}</div>`,
)}
${panel(
  'decisions',
  totals
    .filter(
      (b) =>
        b.kind === 'decision' ||
        b.kind === 'question' ||
        (b.kind === 'claim' && b.status === 'open'),
    )
    .map(
      (b) =>
        `<a data-block-nav="b-${esc(b.id)}" href="#d-${esc(b.id)}">${inlineLabel('decided' in b ? b.decided : 'item' in b ? b.item : 'text' in b ? b.text : '')}</a>`,
    )
    .join(''),
  `<div class="doc">${renderDecisions(view, ctx, review.gaps)}</div>`,
)}
${panel('review', [C.blockers, C.needed, C.reference, C.prose].map((label, i) => `<a href="#review-${i}">${label}</a>`).join(''), `<div class="doc">${renderReview(view, review)}</div>`)}
</main></div><script>${PRD_VIEWER_JS}</script></body></html>
`;
}
