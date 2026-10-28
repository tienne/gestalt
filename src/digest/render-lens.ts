import {
  isCellRef,
  type ContextCard,
  type KnowledgeLink,
  type CellRef,
  type Doubt,
  type Evidence,
  type Glance,
  type Limit,
} from './lens-schema.js';
import { GLANCE_REQUIRED } from './lint-lens.js';
import type { LensSource, SourceFigure, SourceTable } from './lens-source.js';
import type { Cite, LensKind, Report, Transcript } from './schema.js';

/**
 * 읽기 렌즈가 video-digest 뷰어에 더하는 조각. 뷰어를 두 벌 두지 않으려고 render-html이 이 조각을 끼워 넣는다.
 * 모델이 쓴 HTML은 받지 않는다. 글자는 전부 escape하고 굵게와 키워드 마커만 inline이 태그로 바꾼다
 */
export interface LensHtmlContext {
  escape: (s: string) => string;
  /** 본문 마커(굵게, 키워드)를 해석한 HTML */
  inline: (s: string) => string;
  cite: (c: Cite) => string;
  /** 문단 번호 하나를 원문 창에서 여는 칩 */
  loc: (i: number) => string;
  source: LensSource | null;
  transcript: Transcript;
  /** 리포트가 여럿일 때 카드 id가 겹치지 않게 붙이는 접두 */
  pfx?: string;
  /** 공유용. 원문 쪽 그림과 표, 그림 크롭을 싣지 않는다. 노트 경로와 인용이 남에게 가지 않게 노트 연결 카드도 뺀다 */
  omitCrops?: boolean;
}

/** 크롭을 뺐을 때 그 자리에 두는 한 줄 */
export const CROP_OMITTED =
  '공유용으로 원문에서 잘라낸 그림을 뺐어요. 쪽 번호를 누르거나 원문에서 보세요.';

export const GLANCE_LABEL: Record<Glance['kind'], string> = {
  problem: '문제',
  method: '방법',
  result: '결과',
  limit: '한계',
  claim: '주장',
  evidence: '근거',
  topic: '주제',
};

/** 문단 칩 글자. PDF는 쪽, 웹 글은 문단 번호, 팟캐스트는 render-html이 시각 링크를 쓴다 */
export function unitLabel(transcript: Transcript, i: number): string {
  const seg = transcript.segments[i];
  if (transcript.meta.source === 'pdf' && seg?.page) return `p.${seg.page}`;
  return `¶${i + 1}`;
}

export function glanceHtml(glance: Glance[], kind: LensKind, ctx: LensHtmlContext): string {
  // 정한 순서를 먼저 그리고 그 밖의 칸은 뒤에 붙인다
  const order = GLANCE_REQUIRED[kind];
  const sorted = [...glance].sort((a, b) => {
    const ia = order.indexOf(a.kind);
    const ib = order.indexOf(b.kind);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return `<section class="glance" aria-label="한눈에 보기"><h2>한눈에 보기</h2><dl>${sorted
    .map(
      (g) =>
        `<div class="glance-${g.kind}"><dt>${GLANCE_LABEL[g.kind]}</dt><dd>${ctx.inline(g.text)}${ctx.cite(g.cite)}</dd></div>`,
    )
    .join('')}</dl></section>`;
}

/**
 * 원문 커버 배지. 대섹션이 덮은 문단 수와 출처 칩 수를 lint가 확인한 구조에서 센다.
 * 뺀 구간이 있으면 그 목록으로 가는 링크를 단다
 */
export function coverageHtml(report: Report, transcript: Transcript, skippedId: string): string {
  const total = transcript.segments.length;
  const covered = report.sections.reduce((n, s) => n + (s.cite.to - s.cite.from + 1), 0);
  const unit = transcript.meta.source === 'podcast' ? '문장' : '문단';
  let cites = 0;
  const countBullets = (list: { children?: unknown[] }[]): void => {
    for (const b of list) {
      cites++;
      if (b.children) countBullets(b.children as { children?: unknown[] }[]);
    }
  };
  for (const s of report.sections) {
    cites++;
    for (const sub of s.subsections) countBullets(sub.bullets);
  }
  const skipped = report.skipped.reduce((n, s) => n + (s.to - s.from + 1), 0);
  const head =
    skipped === 0
      ? `원문 ${total}${unit}을 모두 다뤘고 ${cites}곳에 출처를 달았어요.`
      : `원문 ${total}${unit} 중 ${covered}${unit}을 다뤘고 ${cites}곳에 출처를 달았어요.`;
  const tail = skipped === 0 ? '' : ` <a href="#${skippedId}">뺀 ${skipped}${unit} 보기</a>`;
  return `<p class="coverage">${head}${tail}</p>`;
}

function cellLabel(table: SourceTable | undefined, ref: CellRef): string {
  const name = table ? `표 ${table.number}` : ref.table;
  return `${name} ${ref.row + 1}행 ${ref.col + 1}열`;
}

/** 근거 칩. 표 칸이면 그 칸 글자를 함께 보여 주고 누르면 원문 창이 표가 있는 쪽을 연다 */
export function evidenceHtml(ev: Evidence, ctx: LensHtmlContext): string {
  if (!isCellRef(ev)) {
    return `<span class="ev">${ctx.loc(ev.cite.key)}${ctx.cite(ev.cite)}</span>`;
  }
  const table = ctx.source?.tables.find((t) => t.id === ev.table);
  const value = table?.rows[ev.row]?.[ev.col] ?? '';
  const unit = table ? ` data-unit="${table.unit}"` : '';
  return `<button type="button" class="loc ev cell-ref"${unit} data-cell="${ctx.escape(`${ev.table}:${ev.row}:${ev.col}`)}">${ctx.escape(cellLabel(table, ev))} <b>${ctx.escape(value)}</b></button>`;
}

/** 의심 표시는 접지 않고 그 불릿 바로 아래에 둔다. 카드에 넣으면 본문만 읽는 사람이 못 본다 */
export function doubtHtml(doubt: Doubt, ctx: LensHtmlContext): string {
  return `<div class="doubt" role="note"><span class="doubt-badge">원문과 어긋남</span> ${ctx.inline(doubt.note)}<span class="ev-list">${doubt.evidence
    .map((ev) => evidenceHtml(ev, ctx))
    .join('')}</span></div>`;
}

export function limitsHtml(limits: Limit[], id: string, ctx: LensHtmlContext): string {
  return `<section class="limits" id="${id}"><h2>검증 안 된 부분</h2><ul>${limits
    .map(
      (l) =>
        `<li>${ctx.inline(l.text)}<span class="ev-list">${l.evidence
          .map((ev) => evidenceHtml(ev, ctx))
          .join(
            '',
          )}${l.card ? `<a class="ev card-ref" href="#${ctx.pfx ?? ''}card-${ctx.escape(l.card)}">맥락 카드</a>` : ''}</span></li>`,
    )
    .join('')}</ul></section>`;
}

function tableGridHtml(table: SourceTable, ctx: LensHtmlContext): string {
  const [head, ...body] = table.rows;
  const row = (cells: string[], tag: 'th' | 'td', r: number) =>
    `<tr>${cells
      .map(
        (c, k) =>
          `<${tag} data-cell="${ctx.escape(`${table.id}:${r}:${k}`)}">${ctx.escape(c)}</${tag}>`,
      )
      .join('')}</tr>`;
  return `<div class="src-grid"><table><thead>${head ? row(head, 'th', 0) : ''}</thead><tbody>${body
    .map((cells, k) => row(cells, 'td', k + 1))
    .join('')}</tbody></table></div>`;
}

/**
 * 원문 표 블록. 칸 글자는 source.json에서 그대로 옮긴다. 모델은 표 id만 고른다.
 * 칸 경계를 잘못 읽었을 수 있는 표(loose)는 원문 크롭을 먼저 보이고 옮긴 칸은 접어 둔다
 */
export function sourceTableHtml(
  table: SourceTable,
  note: string | undefined,
  ctx: LensHtmlContext,
): string {
  const caption = `<figcaption><b>표 ${ctx.escape(table.number)}</b> ${ctx.escape(table.caption.replace(/^Table\s*\d+\s*[:.]\s*/i, ''))} ${ctx.loc(table.unit)}</figcaption>`;
  const crop =
    table.image && !ctx.omitCrops
      ? `<img class="src-crop" src="${ctx.escape(table.image)}" alt="표 ${ctx.escape(table.number)} 원문" loading="lazy">`
      : '';
  const noteHtml = note ? `<p class="src-note">${ctx.inline(note)}</p>` : '';
  if (table.grid === 'loose') {
    return `<figure class="src-table is-loose" id="src-${ctx.escape(table.id)}">${caption}${crop}<details><summary>옮긴 칸 보기(칸 경계가 틀렸을 수 있어요)</summary>${tableGridHtml(table, ctx)}</details>${noteHtml}</figure>`;
  }
  const original = crop
    ? `<details class="src-original"><summary>원문 표 보기</summary>${crop}</details>`
    : '';
  return `<figure class="src-table" id="src-${ctx.escape(table.id)}">${caption}${tableGridHtml(table, ctx)}${original}${noteHtml}</figure>`;
}

/**
 * 원문 그림 크롭과 원래 쪽 썸네일을 나란히 둔다. 썸네일에 그림 자리를 칠해 캡션이 맞는 그림인지 바로 견주게 한다
 */
export function sourceFigureHtml(
  fig: SourceFigure,
  note: string | undefined,
  ctx: LensHtmlContext,
): string {
  const page = ctx.omitCrops ? undefined : ctx.source?.pages.find((p) => p.n === fig.page);
  const thumb =
    page && fig.bbox
      ? `<button type="button" class="page-thumb" data-unit="${fig.unit}" aria-label="${fig.page}쪽에서 보기"><img src="${ctx.escape(page.image)}" alt="" loading="lazy"><span class="thumb-hl" style="left:${pct(fig.bbox[0], page.width)};top:${pct(fig.bbox[1], page.height)};width:${pct(fig.bbox[2] - fig.bbox[0], page.width)};height:${pct(fig.bbox[3] - fig.bbox[1], page.height)}"></span></button>`
      : '';
  const crop = ctx.omitCrops
    ? `<p class="src-note">${CROP_OMITTED}</p>`
    : fig.image
      ? `<img class="src-crop" src="${ctx.escape(fig.image)}" alt="그림 ${ctx.escape(fig.number)} 원문" loading="lazy">`
      : '<p class="src-note">그림 자리를 못 찾아 원문에서 잘라낸 그림이 없어요. 쪽 번호를 눌러 원문에서 보세요.</p>';
  const noteHtml = note ? `<p class="src-note">${ctx.inline(note)}</p>` : '';
  return `<figure class="src-figure" id="src-${ctx.escape(fig.id)}"><div class="fig-pair">${crop}${thumb}</div><figcaption><b>그림 ${ctx.escape(fig.number)}</b> ${ctx.escape(fig.caption.replace(/^(Figure|Fig\.)\s*\d+\s*[:.]\s*/i, ''))} ${ctx.loc(fig.unit)}</figcaption>${noteHtml}</figure>`;
}

const pct = (v: number, of: number) => `${Math.max(0, Math.min(100, (v / of) * 100)).toFixed(2)}%`;

/** 원문 창. PDF는 쪽 그림과 추출 텍스트를 오가고 웹 글은 추출한 문단 목록 하나다 */
export function docPaneHtml(transcript: Transcript, ctx: LensHtmlContext): string {
  const { meta, segments } = transcript;
  const textList = `<ol id="script-list">${segments
    .map(
      (s) =>
        `<li data-i="${s.i}"${s.role ? ` class="u-${s.role}"` : ''}>${ctx.loc(s.i)}<span class="txt"><span class="src">${ctx.escape(s.text)}</span></span></li>`,
    )
    .join('')}</ol>`;
  const link =
    meta.url && /^https?:/.test(meta.url)
      ? `<a class="doc-link" href="${ctx.escape(meta.url)}" target="_blank" rel="noopener noreferrer">원문 열기</a>`
      : '';
  // 크롭을 빼면 쪽 그림도 원문 그대로라 함께 빼고 추출 텍스트만 둔다
  const pages = ctx.omitCrops ? [] : (ctx.source?.pages ?? []);
  if (meta.source === 'pdf' && pages.length > 0) {
    return `<div class="doc-pane" id="doc-pane"><div class="doc-bar" role="group" aria-label="원문 보기"><button type="button" data-view="pages" aria-pressed="true">원문 쪽</button><button type="button" data-view="text" aria-pressed="false">추출 텍스트</button>${link}</div><div id="doc-pages" class="doc-pages" tabindex="0" role="region" aria-label="원문 쪽">${pages
      .map(
        (p) =>
          `<div class="doc-page" data-page="${p.n}" style="aspect-ratio:${p.width}/${p.height}"><img src="${ctx.escape(p.image)}" alt="${p.n}쪽" loading="lazy"><span class="page-no">${p.n}</span></div>`,
      )
      .join(
        '',
      )}</div><div id="script-body" class="script-body" tabindex="0" role="region" aria-label="추출 텍스트" hidden>${textList}</div></div>`;
  }
  return `<div class="doc-pane" id="doc-pane"><div class="doc-bar"><span>본문 ${segments.length}문단</span>${link}</div><div id="script-body" class="script-body" tabindex="0" role="region" aria-label="추출한 본문">${textList}</div></div>`;
}

/** 원문 창이 칠할 자리. PDF 문단의 사각형을 [쪽, x0, top, x1, bottom]으로 줄여 싣는다 */
export function docUnitsData(
  transcript: Transcript,
): Array<Array<[number, number, number, number, number]>> {
  return transcript.segments.map((s) =>
    (s.rects ?? []).map((r) => [r.page, r.bbox[0], r.bbox[1], r.bbox[2], r.bbox[3]]),
  );
}

export const CARD_KIND_LABEL: Record<ContextCard['kind'], string> = {
  lineage: '연구 계보',
  interpretation: '결과 해석',
  counter: '반론',
  unverified: '검증 안 된 부분',
};

const LINEAGE_ROLE_LABEL = {
  foundation: '토대',
  component: '구성 요소',
  baseline: '비교 대상',
} as const;

/**
 * 바깥 맥락 카드. 대섹션 끝에 접어 둔다. 줄마다 바깥 출처 번호를 달고 출처는 새 탭 링크다.
 * 원문 안의 어긋남은 의심 표시가 본문에 펼쳐 보이니 카드는 바깥 자료만 담는다
 */
export function contextCardHtml(card: ContextCard, ctx: LensHtmlContext): string {
  const order = card.sources.map((s) => s.id);
  const ref = (id: string) => {
    const n = order.indexOf(id) + 1;
    return n > 0 ? `<sup class="ctx-ref">[${n}]</sup>` : '';
  };
  const source = (id: string) => card.sources.find((s) => s.id === id);
  const lineage = card.lineage?.length
    ? `<table class="ctx-lineage"><thead><tr><th>연도</th><th>연구</th><th>관계</th><th>가져온 것</th><th>바꾼 것</th></tr></thead><tbody>${card.lineage
        .map((l) => {
          const s = source(l.source);
          const title = s
            ? `<a href="${ctx.escape(s.url)}" target="_blank" rel="noopener noreferrer">${ctx.escape(l.title)}</a>`
            : ctx.escape(l.title);
          return `<tr><td>${ctx.escape(l.year)}</td><td>${title}${ref(l.source)}</td><td>${LINEAGE_ROLE_LABEL[l.role]}</td><td>${l.took ? ctx.inline(l.took) : ''}</td><td>${l.changed ? ctx.inline(l.changed) : ''}</td></tr>`;
        })
        .join('')}</tbody></table>`
    : '';
  const points = `<ul class="ctx-points">${card.points
    .map((pt) => `<li>${ctx.inline(pt.text)}${pt.sources.map(ref).join('')}</li>`)
    .join('')}</ul>`;
  const sources = `<ol class="ctx-sources">${card.sources
    .map(
      (s) =>
        `<li><a href="${ctx.escape(s.url)}" target="_blank" rel="noopener noreferrer">${ctx.escape(s.title)}</a>${[s.publisher, s.year].filter(Boolean).length ? ` <small>${ctx.escape([s.publisher, s.year].filter(Boolean).join(', '))}</small>` : ''}</li>`,
    )
    .join('')}</ol>`;
  return `<details class="ctx-card ctx-${card.kind}" id="${ctx.pfx ?? ''}card-${ctx.escape(card.id)}"><summary><span class="ctx-kind">${CARD_KIND_LABEL[card.kind]}</span> ${ctx.escape(card.title)}</summary><p class="ctx-anchor">원문 자리 ${ctx.loc(card.anchor.key)}${ctx.cite(card.anchor)} <small>바깥 자료로 쓴 카드예요. 원문 안의 어긋남은 본문 의심 표시에 있어요.</small></p>${lineage}${points}${sources}</details>`;
}

/** 노트 경로는 홈 폴더를 ~로 줄여 보인다. 뷰어가 http로 열려서 file 링크는 걸지 않는다 */
const shortPath = (p: string) => p.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, '~');

export function knowledgeLinkHtml(link: KnowledgeLink, ctx: LensHtmlContext): string {
  return `<div class="kn-card" id="${ctx.pfx ?? ''}link-${ctx.escape(link.id)}"><p class="kn-head"><span class="ctx-kind">내 지식과 잇기</span> <b>${ctx.escape(link.title)}</b> ${ctx.loc(link.anchor.key)}${ctx.cite(link.anchor)}</p><p>${ctx.inline(link.note)}</p><blockquote>${ctx.escape(link.quote)}</blockquote><p class="kn-path">${link.url ? `<a href="${ctx.escape(link.url)}" target="_blank" rel="noopener noreferrer">원래 노트 열기</a> ` : ''}<code>${ctx.escape(shortPath(link.path))}${link.line ? `:${link.line}` : ''}</code></p></div>`;
}

/** 대섹션 끝에 붙는 카드 묶음. 카드가 없으면 빈 문자열이다. 공유용(omitCrops)이면 노트 연결 카드는 싣지 않는다 */
export function sectionContextHtml(
  sectionId: string,
  cards: ContextCard[] = [],
  links: KnowledgeLink[] = [],
  ctx: LensHtmlContext,
): string {
  const mine = cards.filter((c) => c.section === sectionId);
  const linked = ctx.omitCrops ? [] : links.filter((l) => l.section === sectionId);
  if (mine.length === 0 && linked.length === 0) return '';
  return `<aside class="ctx" aria-label="바깥 맥락과 내 지식">${mine.map((c) => contextCardHtml(c, ctx)).join('')}${linked.map((l) => knowledgeLinkHtml(l, ctx)).join('')}</aside>`;
}

export const LENS_CSS = `
.doc-pane{display:flex;flex-direction:column;min-height:0;flex:1;border:1px solid var(--line);border-radius:8px;background:var(--card)}
.doc-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px 10px;border-bottom:1px solid var(--line);font-size:.85em;color:var(--muted)}
.doc-bar button{border:1px solid var(--line);background:var(--card);border-radius:999px;padding:2px 10px;cursor:pointer}
.doc-bar button[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.doc-link{margin-left:auto}
.doc-pages{position:relative;overflow:auto;flex:1;padding:8px;display:flex;flex-direction:column;gap:10px;background:var(--chip)}
.doc-page{position:relative;width:100%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2)}
.doc-page img{display:block;width:100%;height:100%}
.page-no{position:absolute;right:6px;bottom:4px;font-size:11px;color:#57534e;background:rgba(255,255,255,.8);padding:0 4px;border-radius:3px}
.doc-hl{position:absolute;background:rgba(250,204,21,.28);outline:2px solid rgba(217,119,6,.85);border-radius:2px;pointer-events:none}
.doc-hl.is-key{background:rgba(250,204,21,.45)}
#script-list li.is-cited{background:var(--hl)}
#script-list li.u-heading .src{font-weight:700}
#script-list li.u-caption .src{font-style:italic;color:var(--muted)}
.loc{border:0;background:var(--chip);color:var(--accent);border-radius:4px;padding:0 5px;font-size:.78em;cursor:pointer;white-space:nowrap;font-variant-numeric:tabular-nums}
.loc:hover{text-decoration:underline}
.glance{border:1px solid var(--line);border-radius:10px;background:var(--card);padding:6px 16px;margin:16px 0}
.glance h2{font-size:1em;margin:8px 0}
.glance dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin:0 0 8px}
.glance dl>div{border-top:2px solid var(--accent);padding-top:4px}
.glance .glance-limit{border-top-color:var(--warn)}
.glance dt{font-weight:700;font-size:.9em;color:var(--muted)}
.glance dd{margin:2px 0 0}
.coverage{display:inline-block;margin:8px 0 0;padding:3px 12px;border-radius:999px;background:var(--chip);font-size:.85em;color:var(--muted)}
.sec-intro{color:var(--muted);margin:4px 0 8px;font-size:.95em}
.doubt{margin:6px 0 8px;padding:6px 10px;border-left:3px solid var(--warn);background:var(--hl);border-radius:0 6px 6px 0;font-size:.93em}
.doubt-badge{display:inline-block;font-size:.78em;font-weight:700;color:var(--warn);border:1px solid var(--warn);border-radius:999px;padding:0 8px;margin-right:4px}
.ev-list{display:inline-flex;flex-wrap:wrap;gap:4px;margin-left:6px;vertical-align:baseline}
.ev{font-size:.85em}
.cell-ref b{color:var(--fg)}
.limits{border:1px solid var(--warn);border-radius:10px;padding:4px 16px 8px;margin:24px 0;background:var(--card)}
.limits h2{font-size:1.1em;color:var(--warn)}
.limits li{margin:4px 0}
.src-table,.src-figure{margin:12px 0;border:1px solid var(--line);border-radius:10px;background:var(--card);padding:10px 12px}
.src-table figcaption,.src-figure figcaption{font-size:.9em;margin-bottom:6px}
.src-grid{overflow-x:auto}
.src-grid table{border-collapse:collapse;font-size:.86em;font-variant-numeric:tabular-nums}
.src-grid th,.src-grid td{border-bottom:1px solid var(--line);padding:3px 10px;text-align:left;white-space:nowrap}
.src-grid td.is-ref{background:var(--hl);outline:2px solid var(--warn)}
.src-crop{display:block;max-width:100%;height:auto;border:1px solid var(--line);border-radius:6px;background:#fff}
.src-original summary,.src-table details summary{cursor:pointer;color:var(--muted);font-size:.88em;margin-top:6px}
.src-note{color:var(--muted);font-size:.9em;margin:6px 0 0}
.fig-pair{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,1fr);gap:10px;align-items:start}
.page-thumb{position:relative;padding:0;border:1px solid var(--line);border-radius:4px;background:#fff;cursor:pointer;display:block}
.page-thumb img{display:block;width:100%;height:auto}
.thumb-hl{position:absolute;outline:2px solid var(--warn);background:rgba(250,204,21,.25)}
.player-audio .player{background:var(--card)}
.ctx{display:flex;flex-direction:column;gap:8px;margin:16px 0}
.ctx-card{border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:8px;background:var(--card);padding:6px 12px}
.ctx-card summary{cursor:pointer;font-weight:600}
.ctx-kind{display:inline-block;font-size:.75em;font-weight:700;border-radius:999px;padding:0 8px;background:var(--chip);color:var(--muted);margin-right:4px}
.ctx-counter{border-left-color:var(--warn)}
.ctx-anchor{font-size:.88em;color:var(--muted)}
.ctx-lineage{border-collapse:collapse;font-size:.86em;margin:6px 0;width:100%}
.ctx-lineage th,.ctx-lineage td{border-bottom:1px solid var(--line);padding:3px 6px;text-align:left;vertical-align:top}
.ctx-ref{color:var(--muted);font-size:.75em}
.ctx-sources{font-size:.85em;color:var(--muted)}
.kn-card{border:1px dashed var(--accent);border-radius:8px;background:var(--card);padding:6px 12px}
.kn-card blockquote{margin:6px 0;padding-left:10px;border-left:3px solid var(--line);color:var(--muted)}
.kn-path{font-size:.8em;margin:0}
.player-audio .player-local video,.player-audio audio{display:none;width:100%}
.player-audio .player-local.is-live audio{display:block}
.player-audio .player.is-floating{width:min(360px,80vw)}
`;
