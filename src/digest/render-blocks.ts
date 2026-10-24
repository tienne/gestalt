import {
  extensionKey,
  type Block,
  type CommentsBlock,
  type Extension,
  type ListItem,
  type MindmapNode,
} from './blocks.js';
import { boldPattern, keywordPattern, type Cite } from './schema.js';
import { treeSvg } from './svg.js';

/**
 * 확장 리포트 블록을 HTML과 마크다운으로 그린다. 블록 타입을 더하면 여기와 lint-extension.ts의
 * blockFields 두 곳에 case를 넣는다. 둘 다 never로 빠진 타입을 컴파일 때 잡는다
 */

export interface BlockHtmlContext {
  escape: (s: string) => string;
  cite: (c: Cite) => string;
  /** cite.key 문장의 시작 시각 링크. 누르면 영상이 그 자리로 간다 */
  time: (c: Cite) => string;
  /** cite.key 문장의 시작 초. SVG 노드에 data-sec으로 단다 */
  sec: (c: Cite) => number;
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

const TONE_LABEL: Record<CommentsBlock['groups'][number]['tone'], string> = {
  positive: '긍정',
  negative: '부정',
  neutral: '중립',
  question: '질문',
};

function outlineHtml(node: MindmapNode, ctx: BlockHtmlContext): string {
  const kids = node.children?.length
    ? `<ul>${node.children.map((c) => outlineHtml(c, ctx)).join('')}</ul>`
    : '';
  return `<li>${ctx.escape(node.label)}${node.cite ? ` ${ctx.time(node.cite)}` : ''}${kids}</li>`;
}

function outlineMd(node: MindmapNode, ctx: BlockMdContext, depth = 0): string[] {
  return [
    `${'  '.repeat(depth)}- ${node.label}${node.cite ? ` ${ctx.time(node.cite)}` : ''}`,
    ...(node.children ?? []).flatMap((c) => outlineMd(c, ctx, depth + 1)),
  ];
}

/** 그림 하나와 확대 버튼, 스크립트 없이도 읽히는 목록. 대섹션 도식도 이 틀을 쓴다 */
export function diagramFigure(svg: string, outline: string, caption?: string): string {
  return `<figure class="diagram"><div class="dg-scroll">${svg}</div><div class="dg-bar">${
    caption ? `<span>${caption}</span>` : ''
  }<button type="button" class="zoom-btn" data-zoom>크게 보기</button></div><details class="dg-outline"><summary>목록으로 보기</summary>${outline}</details></figure>`;
}

// 댓글은 남이 쓴 글이라 마크다운 문법으로 읽히면 링크나 HTML이 끼어든다. 문법 글자를 무력화한다
const mdVerbatim = (text: string) => text.replace(/[\\`*_[\]<>#|]/g, (ch) => `\\${ch}`);

function listMd(items: ListItem[], ctx: BlockMdContext, depth = 0): string[] {
  return items.flatMap((it) => [
    `${'  '.repeat(depth)}- ${stripKeywords(it.text)}${mdCite(it.cite, ctx)}`,
    ...(it.children ? listMd(it.children, ctx, depth + 1) : []),
  ]);
}

/** id는 블록마다 겹치지 않는 접두어다. 퀴즈 라디오 그룹 이름에 쓴다 */
export function blockHtml(block: Block, ctx: BlockHtmlContext, id = 'b'): string {
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
      return `<ol class="ext-toc">${block.items
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
    case 'flashcards':
      return `<div class="cards">${block.cards
        .map(
          (c) =>
            `<details class="card"><summary>${htmlInline(c.front, ctx)}</summary><div class="card-back">${htmlInline(c.back, ctx)}${htmlCite(c.cite, ctx)}</div></details>`,
        )
        .join('')}</div>`;
    case 'quiz':
      return `<ol class="quiz">${block.questions
        .map((q, k) => {
          const name = ctx.escape(`${id}-q${k}`);
          const choices = q.choices
            .map(
              (c, ci) =>
                `<label class="quiz-choice"><input type="radio" name="${name}" value="${ci}"> <span>${htmlInline(c, ctx)}</span></label>`,
            )
            .join('');
          const right = q.choices[q.answer] ?? '';
          return `<li><fieldset class="quiz-q" data-answer="${q.answer}"><legend>${htmlInline(q.question, ctx)}</legend>${choices}<button type="button" class="quiz-check">정답 확인</button><div class="quiz-exp" hidden><p class="quiz-result"></p><p><b>정답 ${q.answer + 1}번</b> ${htmlInline(right, ctx)}</p><p>${htmlInline(q.explanation, ctx)}${htmlCite(q.cite, ctx)}</p></div></fieldset></li>`;
        })
        .join('')}</ol>`;
    case 'mindmap':
      return diagramFigure(
        treeSvg(block.root, { sec: ctx.sec }, `${block.root.label} 마인드맵`),
        `<ul>${outlineHtml(block.root, ctx)}</ul>`,
      );
    case 'comments': {
      const groups = block.groups
        .map((g) => {
          const pct =
            block.total > 0 ? Math.min(100, Math.round((g.count / block.total) * 100)) : 0;
          const examples = g.examples.length
            ? `<ul class="cm-ex">${g.examples.map((x) => `<li><q>${ctx.escape(x.text)}</q></li>`).join('')}</ul>`
            : '';
          return `<li class="cm-group cm-${g.tone}"><div class="cm-head"><b>${ctx.escape(g.title)}</b><span class="cm-tone">${TONE_LABEL[g.tone]}</span><span class="cm-count">${g.count}개</span></div><div class="cm-bar" aria-hidden="true"><i style="width:${pct}%"></i></div><p>${htmlInline(g.summary, ctx)}</p>${examples}</li>`;
        })
        .join('');
      return `<div class="comments"><p class="cm-overview">${htmlInline(block.overview, ctx)}</p><p class="cm-meta">분석한 댓글 ${block.total}개</p><ul class="cm-groups">${groups}</ul></div>`;
    }
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
    case 'flashcards':
      return [
        ...block.cards.flatMap((c) => [
          `- Q. ${stripKeywords(c.front)}`,
          `  - A. ${stripKeywords(c.back)}${mdCite(c.cite, ctx)}`,
        ]),
        '',
      ];
    case 'quiz':
      return block.questions.flatMap((q, k) => [
        `**${k + 1}. ${stripKeywords(q.question)}**`,
        '',
        ...q.choices.map((c, ci) => `- (${ci + 1}) ${stripKeywords(c)}`),
        '',
        `> 정답 (${q.answer + 1}) ${stripKeywords(q.choices[q.answer] ?? '')}. ${stripKeywords(q.explanation)}${mdCite(q.cite, ctx)}`,
        '',
      ]);
    case 'mindmap':
      return [...outlineMd(block.root, ctx), ''];
    case 'comments':
      return [
        stripKeywords(block.overview),
        '',
        `분석한 댓글 ${block.total}개`,
        '',
        ...block.groups.flatMap((g) => [
          `**${g.title}** (${TONE_LABEL[g.tone]}, ${g.count}개)`,
          '',
          stripKeywords(g.summary),
          '',
          ...g.examples.flatMap((x) => [
            ...x.text.split(/\r?\n/).map((line) => `> ${mdVerbatim(line)}`.trimEnd()),
            '',
          ]),
        ]),
      ];
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
    .map((b, bi) => blockHtml(b, ctx, `${id}-b${bi}`))
    .join('')}</section>`;
}
