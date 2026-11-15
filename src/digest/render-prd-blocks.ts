import type { Audience, BlockKind, BlockOf, LineRange, PrdBlock } from './prd-schema.js';

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
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>',
    );
}

export const KIND_LABEL: Record<BlockKind, string> = {
  claim: '주장',
  requirement: '요구사항',
  metric: '지표',
  decision: '결정',
  question: '질문',
  prose: '본문',
};

const CLAIM_LABEL: Record<BlockOf<'claim'>['status'], string> = {
  confirmed: '확정',
  assumed: '가정',
  open: '미정',
};
const PHASE_LABEL: Record<NonNullable<BlockOf<'requirement'>['phase']>, string> = {
  mvp: 'MVP',
  later: '이후',
};
const ROLE_LABEL: Record<NonNullable<BlockOf<'metric'>['role']>, string> = {
  primary: '주 지표',
  secondary: '보조 지표',
  guardrail: '가드레일',
};
export const AUDIENCE_LABEL: Record<Audience, string> = {
  pm: 'PM',
  dev: '개발',
  design: '디자인',
  qa: 'QA',
  data: '데이터',
};

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
          `<h3>${inlineMd(block.title)}</h3>` +
          lbl('가설', block.why) +
          lbl('안 하는 것', block.boundary) +
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
          `<div class="cells">${cell('분모', block.denominator)}${cell('베이스라인', block.baseline)}${cell('목표', block.target)}${cell('측정', block.measure)}</div>`,
        tags: block.role ? [`<span class="badge">${ROLE_LABEL[block.role]}</span>`] : [],
        cls: [],
      };
    }
    case 'decision':
      return {
        html:
          `<p><strong>${inlineMd(block.decided)}</strong></p>` +
          lbl('이유', block.why) +
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
        block.owner ? `<span class="chip">담당 ${esc(block.owner)}</span>` : '',
        block.due ? `<span class="chip">기한 ${esc(block.due)}</span>` : '',
      ].join('');
      return {
        html: `<p>${inlineMd(block.item)}</p>${chips ? `<div class="chips">${chips}</div>` : ''}`,
        tags: [],
        cls: [],
      };
    }
    case 'prose':
      return { html: `<p>${inlineMd(block.text)}</p>`, tags: [], cls: [] };
  }
}

export function renderBlock(block: PrdBlock, ctx: BlockContext): string {
  const { html, tags, cls } = body(block, ctx);
  const aud = block.audience ?? [];
  const head = [
    `<span class="badge kind">${KIND_LABEL[block.kind]}</span>`,
    ...tags,
    block.summary ? '<span class="badge sum">요약</span>' : '',
    ...aud.map((a) => `<span class="badge aud">${AUDIENCE_LABEL[a]}</span>`),
    `<span class="src" title="원문 줄">${fmtSrc(block.src)}</span>`,
  ].join('');
  const classes = ['blk', `blk-${block.kind}`, ...cls].join(' ');
  return `<article class="${classes}" id="b-${esc(block.id)}" data-kind="${block.kind}" data-aud="${aud.join(' ')}"><div class="tags">${head}</div>${html}</article>`;
}
