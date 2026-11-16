import {
  AUDIENCE_LABEL,
  CLAIM_LABEL,
  KIND_LABEL,
  PHASE_LABEL,
  QUOTE_LABEL,
  ROLE_LABEL,
  TONE_LABEL,
  PRD_COPY as C,
} from './prd-copy.js';
export { AUDIENCE_LABEL } from './prd-copy.js';
import type { LineRange, PrdBlock } from './prd-schema.js';

// research, architecture 렌더러처럼 각자 escape를 둔다. digest 쪽 e는 export되지 않는다
export const esc = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * 원문 마크다운 가운데 굵게, 코드, http(s) 링크만 태그로 바꾼다. 먼저 전부 escape해서 raw HTML은 글자로 남는다.
 * 링크 주소도 escape된 글자에서 꺼내니 따옴표로 속성을 깨지 못한다
 */
export function inlineMd(s: string): string {
  // 링크를 먼저 바꿔 둬야 주소 안 백틱이 code 태그로 href에 끼지 않는다. 바꾼 태그는 자리표시로 빼 두었다가 되돌린다
  const links: string[] = [];
  const held = esc(s.replace(/\uE000/g, '')).replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_, label: string, href: string) => {
      links.push(
        /^https?:\/\//i.test(href)
          ? `<a href="${href}" rel="noopener noreferrer" target="_blank">${inlineFmt(label)}</a>`
          : `<span title="${href}">${inlineFmt(label)}</span>`,
      );
      return `\uE000${links.length - 1}\uE000`;
    },
  );
  return inlineFmt(held).replace(/\uE000(\d+)\uE000/g, (_, i: string) => links[Number(i)]!);
}

function inlineFmt(s: string): string {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\r?\n/g, '<br>');
}

export const fmtSrc = (src: readonly LineRange[]) =>
  src.map(([a, b]) => (a === b ? `L${a}` : `L${a}-${b}`)).join(', ');

/** 렌더러가 블록 id로 앵커를 단다. metric은 metricId로도 찾아야 해서 맵을 받는다 */
export interface BlockContext {
  metricAnchor: ReadonlyMap<string, string>;
}

const lbl = (name: string, value: string | undefined) =>
  value ? `<div class="lbl"><span>${esc(name)}</span><div>${inlineMd(value)}</div></div>` : '';

function body(block: PrdBlock, ctx: BlockContext): { html: string; tags: string[]; cls: string[] } {
  switch (block.kind) {
    case 'claim':
      return {
        html: `<p>${inlineMd(block.text)}</p>`,
        tags: [
          `<span class="badge ${block.status === 'open' ? 'warn' : block.status === 'confirmed' ? 'ok' : ''}">${CLAIM_LABEL[block.status]}</span>`,
        ],
        cls: [`st-${block.status}`],
      };
    case 'risk':
      return {
        html:
          `<p>${inlineMd(block.text)}</p>` +
          (block.response
            ? lbl(C.response, block.response)
            : `<span class="chip warn">${C.responseMissing}</span>`),
        tags: [],
        cls: [],
      };
    case 'requirement': {
      const metrics = (block.metrics ?? [])
        .map((m) => {
          const a = ctx.metricAnchor.get(m);
          return a
            ? `<a class="chip" href="#b-${esc(a)}">${esc(m)}</a>`
            : `<span class="chip">${esc(m)}</span>`;
        })
        .join('');
      return {
        html:
          lbl(C.whyLabel, block.why) +
          lbl(C.boundaryLabel, block.boundary) +
          (block.detail?.length
            ? `<ul>${block.detail.map((d) => `<li>${inlineMd(d)}</li>`).join('')}</ul>`
            : '') +
          (metrics ? `<div class="chips">${metrics}</div>` : ''),
        tags: block.phase ? [`<span class="badge">${PHASE_LABEL[block.phase]}</span>`] : [],
        cls: [],
      };
    }
    case 'metric': {
      const cell = (name: string, v: string | undefined) =>
        v
          ? `<div class="cell"><span>${esc(name)}</span>${inlineMd(v)}</div>`
          : `<div class="cell empty"><span>${esc(name)}</span></div>`;
      return {
        html:
          `<div class="metric-name"><span class="mid">${esc(block.metricId)}</span>${inlineMd(block.name)}</div>` +
          `<div class="cells">${cell(C.denominator, block.denominator)}${cell(C.baseline, block.baseline)}${cell(C.target, block.target)}${cell(C.measure, block.measure)}</div>`,
        tags: block.role ? [`<span class="badge">${ROLE_LABEL[block.role]}</span>`] : [],
        cls: [],
      };
    }
    case 'decision':
      return {
        html:
          `<p><strong>${inlineMd(block.decided)}</strong></p>` +
          lbl(C.reason, block.why) +
          (block.rejected?.length
            ? `<ul class="rej">${block.rejected
                .map(
                  (r) =>
                    `<li><s>${inlineMd(r.option)}</s>${r.reason ? ` — ${inlineMd(r.reason)}` : ''}</li>`,
                )
                .join('')}</ul>`
            : ''),
        tags: [],
        cls: [],
      };
    case 'question': {
      const chips = [
        block.owner ? `<span class="chip">${C.owner} ${esc(block.owner)}</span>` : '',
        block.due ? `<span class="chip">${C.due} ${esc(block.due)}</span>` : '',
      ].join('');
      return {
        html: `<p>${inlineMd(block.item)}</p>${chips ? `<div class="chips">${chips}</div>` : ''}`,
        tags: [],
        cls: [],
      };
    }
    case 'prose':
      return { html: `<p>${inlineMd(block.text)}</p>`, tags: [], cls: [] };
    case 'compare': {
      const td = (v: string | undefined) =>
        v ? `<td>${inlineMd(v)}</td>` : '<td class="empty"></td>';
      const hasLabel = block.rows.some((r) => r.label);
      return {
        html: `<div class="xwrap"><table class="tbl"><thead><tr>${hasLabel ? '<th></th>' : ''}<th scope="col">${inlineMd(block.labels[0])}</th><th scope="col">${inlineMd(block.labels[1])}</th></tr></thead><tbody>${block.rows
          .map(
            (r) =>
              `<tr>${hasLabel ? `<th scope="row">${r.label ? inlineMd(r.label) : ''}</th>` : ''}${td(r.left)}${td(r.right)}</tr>`,
          )
          .join('')}</tbody></table></div>`,
        tags: [],
        cls: [],
      };
    }
    case 'scope':
      return {
        html: `<ul class="out">${block.out.map((o) => `<li>${inlineMd(o)}</li>`).join('')}</ul>`,
        tags: [],
        cls: [],
      };
    case 'quote':
      return {
        html: `<blockquote>${inlineMd(block.text)}</blockquote>${block.by ? `<p class="by">${esc(block.by)}</p>` : ''}`,
        tags: [
          `<span class="badge ${block.origin === 'virtual' ? 'warn' : block.origin === 'voc' ? 'ok' : ''}">${QUOTE_LABEL[block.origin]}</span>`,
        ],
        cls: [`origin-${block.origin}`],
      };
    case 'flow':
      return {
        html: `<ol class="flow">${block.steps.map((x) => `<li>${inlineMd(x)}</li>`).join('')}</ol>`,
        tags: [],
        cls: [],
      };
    case 'stateMatrix':
      return {
        html: `<div class="xwrap"><table class="tbl"><thead><tr><th></th>${block.cols
          .map((c) => `<th scope="col">${inlineMd(c)}</th>`)
          .join('')}</tr></thead><tbody>${block.rows
          .map(
            (r, i) =>
              `<tr><th scope="row">${inlineMd(r)}</th>${(block.cells[i] ?? [])
                .map((c) => (c ? `<td>${inlineMd(c)}</td>` : '<td class="empty"></td>'))
                .join('')}</tr>`,
          )
          .join('')}</tbody></table></div>`,
        tags: [],
        cls: [],
      };
    case 'timeline':
      return {
        html: `<ol class="tl">${block.items
          .map((x) => `<li><span class="date">${esc(x.date)}</span>${inlineMd(x.what)}</li>`)
          .join('')}</ol>`,
        tags: [],
        cls: [],
      };
    case 'glossary':
      return {
        html: `<dl class="gl">${block.terms
          .map((x) => `<dt>${inlineMd(x.term)}</dt><dd>${inlineMd(x.meaning)}</dd>`)
          .join('')}</dl>`,
        tags: [],
        cls: [],
      };
    case 'callout':
      return {
        html: `<p>${inlineMd(block.text)}</p>`,
        tags: [`<span class="badge">${TONE_LABEL[block.tone]}</span>`],
        cls: [`tone-${block.tone}`],
      };
  }
}

export function renderBlock(block: PrdBlock, ctx: BlockContext): string {
  const { html, tags, cls } = body(block, ctx);
  const aud = block.audience ?? [];
  const head = [
    `<span class="badge kind">${KIND_LABEL[block.kind]}</span>`,
    ...tags,
    block.summary ? `<span class="badge sum">${C.summary}</span>` : '',
    ...aud.map((a) => `<span class="badge aud">${AUDIENCE_LABEL[a]}</span>`),
    `<span class="src" title="${C.source}">${fmtSrc(block.src)}</span>`,
  ].join('');
  const classes = ['blk', `blk-${block.kind}`, ...cls].join(' ');
  return `<article class="${classes}" id="b-${esc(block.id)}" data-kind="${block.kind}" data-aud="${aud.join(' ')}"><h3 class="item-title"><span class="ico" aria-hidden="true">${block.kind === 'requirement' ? '▦' : block.kind === 'question' ? '?' : '◇'}</span>${block.kind === 'requirement' ? inlineMd(block.title) : KIND_LABEL[block.kind]}</h3><div class="tags">${head}</div>${html}</article>`;
}

/** 링크 안에 넣을 원문 서식. 중첩 링크는 주소를 title로 옮긴다. */
export function inlineLabel(text: string): string {
  return inlineMd(text).replace(
    /<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
    '<span title="$1">$2</span>',
  );
}
