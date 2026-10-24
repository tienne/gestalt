import { extensionKey, type Block, type Extension, type ListItem } from './blocks.js';
import { boldPattern, keywordPattern, type Cite } from './schema.js';

/**
 * 확장 리포트 블록을 HTML과 마크다운으로 그린다. 블록 타입을 더하면 여기와 lint-extension.ts의
 * blockFields 두 곳에 case를 넣는다. 둘 다 never로 빠진 타입을 컴파일 때 잡는다
 */

export interface BlockHtmlContext {
  escape: (s: string) => string;
  cite: (c: Cite) => string;
  /** cite.key 문장의 시작 시각 링크. 누르면 영상이 그 자리로 간다 */
  time: (c: Cite) => string;
}

export interface BlockMdContext {
  cite: (c: Cite) => string;
  time: (c: Cite) => string;
}

// 확장 리포트는 키워드 목록이 없어 lint가 마커를 막는다. 그래도 들어오면 표시 글자만 남긴다
const stripKeywords = (text: string) =>
  text.replace(keywordPattern(), (_m, _id, label: string) => label);

const htmlInline = (text: string, ctx: BlockHtmlContext) =>
  ctx
    .escape(stripKeywords(text))
    .replace(boldPattern(), (_m, inner: string) => `<strong>${inner}</strong>`);

const htmlCite = (c: Cite | undefined, ctx: BlockHtmlContext) => (c ? ctx.cite(c) : '');
const mdCite = (c: Cite | undefined, ctx: BlockMdContext) => (c ? ctx.cite(c) : '');

function listHtml(items: ListItem[], ctx: BlockHtmlContext): string {
  return `<ul>${items
    .map(
      (it) =>
        `<li>${htmlInline(it.text, ctx)}${htmlCite(it.cite, ctx)}${it.children?.length ? listHtml(it.children, ctx) : ''}</li>`,
    )
    .join('')}</ul>`;
}

function listMd(items: ListItem[], ctx: BlockMdContext, depth = 0): string[] {
  return items.flatMap((it) => [
    `${'  '.repeat(depth)}- ${stripKeywords(it.text)}${mdCite(it.cite, ctx)}`,
    ...(it.children ? listMd(it.children, ctx, depth + 1) : []),
  ]);
}

export function blockHtml(block: Block, ctx: BlockHtmlContext): string {
  switch (block.type) {
    case 'heading':
      return `<h3>${ctx.escape(block.text)}</h3>`;
    case 'text':
      return `<p>${htmlInline(block.text, ctx)}${htmlCite(block.cite, ctx)}</p>`;
    case 'list':
      return `${block.title ? `<h4>${ctx.escape(block.title)}</h4>` : ''}${listHtml(block.items, ctx)}`;
    case 'quote':
      return `<figure class="quote"><blockquote>${ctx.escape(block.text)}${ctx.cite(block.cite)}</blockquote>${
        block.translation ? `<p class="quote-tr">${htmlInline(block.translation, ctx)}</p>` : ''
      }${
        block.speaker || block.note
          ? `<figcaption>${block.speaker ? `<b>${ctx.escape(block.speaker)}</b>` : ''}${
              block.note ? `<span>${htmlInline(block.note, ctx)}</span>` : ''
            }</figcaption>`
          : ''
      }</figure>`;
    case 'timestamps':
      return `<ol class="toc">${block.items
        .map(
          (it) =>
            `<li>${ctx.time(it.cite)}<div><b>${ctx.escape(it.title)}</b>${
              it.summary ? `<p>${htmlInline(it.summary, ctx)}</p>` : ''
            }</div></li>`,
        )
        .join('')}</ol>`;
    case 'actions':
      return `<ul class="actions">${block.items
        .map((it) => {
          const meta = [
            it.owner ? `<span>담당 ${ctx.escape(it.owner)}</span>` : '',
            it.due ? `<span>기한 ${ctx.escape(it.due)}</span>` : '',
          ].join('');
          return `<li><span class="box" aria-hidden="true"></span><div>${htmlInline(it.task, ctx)}${htmlCite(it.cite, ctx)}${
            meta ? `<small>${meta}</small>` : ''
          }</div></li>`;
        })
        .join('')}</ul>`;
    case 'qa':
      return `<dl class="qa">${block.items
        .map(
          (it) =>
            `<dt>${htmlInline(it.question, ctx)}</dt><dd>${htmlInline(it.answer, ctx)}${htmlCite(it.cite, ctx)}</dd>`,
        )
        .join('')}</dl>`;
    default: {
      const never: never = block;
      throw new Error(`모르는 블록: ${JSON.stringify(never)}`);
    }
  }
}

export function blockMarkdown(block: Block, ctx: BlockMdContext): string[] {
  switch (block.type) {
    case 'heading':
      return [`## ${block.text}`, ''];
    case 'text':
      return [`${stripKeywords(block.text)}${mdCite(block.cite, ctx)}`, ''];
    case 'list':
      return [...(block.title ? [`**${block.title}**`, ''] : []), ...listMd(block.items, ctx), ''];
    case 'quote': {
      const by = [
        block.speaker ? `— ${block.speaker}` : '',
        block.note ? stripKeywords(block.note) : '',
      ]
        .filter(Boolean)
        .join(', ');
      return [
        `> ${block.text}${ctx.cite(block.cite)}`,
        ...(block.translation ? ['>', `> ${stripKeywords(block.translation)}`] : []),
        ...(by ? ['>', `> ${by}`] : []),
        '',
      ];
    }
    case 'timestamps':
      return [
        ...block.items.map(
          (it) =>
            `- ${ctx.time(it.cite)} **${it.title}**${it.summary ? ` ${stripKeywords(it.summary)}` : ''}`,
        ),
        '',
      ];
    case 'actions':
      return [
        ...block.items.map((it) => {
          const meta = [it.owner ? `담당 ${it.owner}` : '', it.due ? `기한 ${it.due}` : '']
            .filter(Boolean)
            .join(', ');
          return `- [ ] ${stripKeywords(it.task)}${meta ? ` (${meta})` : ''}${mdCite(it.cite, ctx)}`;
        }),
        '',
      ];
    case 'qa':
      return block.items.flatMap((it) => [
        `**Q. ${stripKeywords(it.question)}**`,
        '',
        `${stripKeywords(it.answer)}${mdCite(it.cite, ctx)}`,
        '',
      ]);
    default: {
      const never: never = block;
      throw new Error(`모르는 블록: ${JSON.stringify(never)}`);
    }
  }
}

/** 탭 id와 패널 id. 키에 들어가는 글자(영숫자, -, .)는 id에 그대로 써도 된다 */
export const extensionPanelId = (ext: Pick<Extension, 'template' | 'lang'>) =>
  `ext-${extensionKey(ext)}`;

export function extensionHtml(ext: Extension, ctx: BlockHtmlContext): string {
  const id = extensionPanelId(ext);
  return `<section class="ext" id="${ctx.escape(id)}" role="tabpanel" aria-labelledby="tab-${ctx.escape(id)}" lang="${ctx.escape(ext.lang)}" hidden><h2>${ctx.escape(ext.title)}</h2>${ext.blocks
    .map((b) => blockHtml(b, ctx))
    .join('')}</section>`;
}
