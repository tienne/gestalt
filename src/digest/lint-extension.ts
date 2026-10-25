import {
  extensionKey,
  type Block,
  type Extension,
  type ListItem,
  type MindmapNode,
} from './blocks.js';
import type { DigestIssue } from './lint.js';
import { boldPattern, keywordPattern, type Cite, type Diagram, type Transcript } from './schema.js';
import type { DigestTemplate } from './templates.js';

/**
 * 확장 리포트의 문자열 한 칸.
 * title은 탭과 소제목처럼 이름으로 쓰여 본문 윤문에서 빠진다. 그림 안 글자는 prose.ts가 라벨로 따로 모은다. verbatim은 대사나 댓글 원문이라 손대지 않는다
 */
export interface ExtensionText {
  path: string;
  text: string;
  role: 'title' | 'body' | 'verbatim';
}

export interface ExtensionCite {
  path: string;
  cite: Cite;
}

export interface ExtensionLintOptions {
  /** 아는 템플릿. 있으면 템플릿에 없는 블록 타입과 모르는 템플릿을 경고한다 */
  templates?: ReadonlyMap<string, Pick<DigestTemplate, 'id' | 'blocks'>>;
  /**
   * comments.json의 id → 본문. 있으면 댓글 예시를 대조한다.
   * null은 찾아봤는데 없다는 뜻이라 댓글 블록이 있으면 오류다. 안 주면 대조를 건너뛴다
   */
  comments?: ReadonlyMap<string, string> | null;
  /** 댓글 본문 불일치를 오류로 올린다. 저장을 막아야 하는 merge만 켠다 */
  strictVerbatim?: boolean;
}

/** 마인드맵 상한. 루트가 0단이다. 이보다 크면 한 화면에 안 들어온다 */
export const MINDMAP_MAX_DEPTH = 3;
export const MINDMAP_MAX_NODES = 60;

function* walkList(
  items: ListItem[],
  prefix: string,
  depth = 0,
): Generator<{ item: ListItem; path: string; depth: number }> {
  for (const [k, item] of items.entries()) {
    const path = `${prefix}.${k}`;
    yield { item, path, depth };
    if (item.children) yield* walkList(item.children, `${path}.children`, depth + 1);
  }
}

export function* walkMindmap(
  node: MindmapNode,
  path: string,
  depth = 0,
): Generator<{ node: MindmapNode; path: string; depth: number }> {
  yield { node, path, depth };
  for (const [k, child] of (node.children ?? []).entries()) {
    yield* walkMindmap(child, `${path}.children.${k}`, depth + 1);
  }
}

/** 도식에서 라벨 칸을 경로와 함께 돈다. 열 제목과 축 이름, 시점 글자는 출처가 없어서 cite도 없다 */
export function* walkDiagram(
  d: Diagram,
  prefix: string,
): Generator<{ label: string; cite?: Cite; path: string; labelPath: string }> {
  const node = (n: { label: string; cite?: Cite }, path: string) => ({
    label: n.label,
    cite: n.cite,
    path,
    labelPath: `${path}.label`,
  });
  switch (d.kind) {
    case 'flow':
    case 'cycle':
      for (const [k, step] of d.steps.entries()) yield node(step, `${prefix}.steps.${k}`);
      return;
    case 'compare':
      for (const [c, col] of d.columns.entries()) {
        const cp = `${prefix}.columns.${c}`;
        yield { label: col.title, path: cp, labelPath: `${cp}.title` };
        for (const [k, item] of col.items.entries()) yield node(item, `${cp}.items.${k}`);
      }
      return;
    case 'tree':
      for (const w of walkMindmap(d.root, `${prefix}.root`)) yield node(w.node, w.path);
      return;
    case 'timeline':
      for (const [k, ev] of d.events.entries()) {
        const ep = `${prefix}.events.${k}`;
        yield { label: ev.when, path: ep, labelPath: `${ep}.when` };
        yield node(ev, ep);
      }
      return;
    case 'matrix':
      for (const axis of ['x', 'y'] as const) {
        for (const end of ['low', 'high'] as const) {
          const ap = `${prefix}.${axis}.${end}`;
          yield { label: d[axis][end], path: ap, labelPath: ap };
        }
      }
      for (const [c, cell] of d.cells.entries()) {
        for (const [k, item] of cell.entries()) yield node(item, `${prefix}.cells.${c}.${k}`);
      }
      return;
    case 'causal':
      for (const [k, n] of d.inputs.entries()) yield node(n, `${prefix}.inputs.${k}`);
      yield node(d.center, `${prefix}.center`);
      for (const [k, n] of d.outputs.entries()) yield node(n, `${prefix}.outputs.${k}`);
      return;
    case 'beforeAfter':
      for (const side of ['before', 'after'] as const) {
        const sp = `${prefix}.${side}`;
        const { title, items } = d[side];
        if (title) yield { label: title, path: sp, labelPath: `${sp}.title` };
        for (const [k, item] of items.entries()) yield node(item, `${sp}.items.${k}`);
      }
      return;
    default: {
      const never: never = d;
      throw new Error(`알 수 없는 도식: ${String(never)}`);
    }
  }
}

/** 블록 하나에서 글자와 출처를 경로와 함께 뽑는다. lint와 윤문이 같은 경로를 쓴다 */
export function blockFields(
  block: Block,
  p: string,
): { texts: ExtensionText[]; cites: ExtensionCite[] } {
  const texts: ExtensionText[] = [];
  const cites: ExtensionCite[] = [];
  const cite = (path: string, c: Cite | undefined) => {
    if (c) cites.push({ path, cite: c });
  };
  switch (block.type) {
    case 'heading':
      texts.push({ path: `${p}.text`, text: block.text, role: 'title' });
      break;
    case 'text':
      texts.push({ path: `${p}.text`, text: block.text, role: 'body' });
      cite(`${p}.cite`, block.cite);
      break;
    case 'list':
      if (block.title) texts.push({ path: `${p}.title`, text: block.title, role: 'title' });
      for (const { item, path } of walkList(block.items, `${p}.items`)) {
        texts.push({ path: `${path}.text`, text: item.text, role: 'body' });
        cite(`${path}.cite`, item.cite);
      }
      break;
    case 'quote':
      texts.push({ path: `${p}.text`, text: block.text, role: 'verbatim' });
      if (block.translation) {
        texts.push({ path: `${p}.translation`, text: block.translation, role: 'body' });
      }
      if (block.speaker) texts.push({ path: `${p}.speaker`, text: block.speaker, role: 'title' });
      if (block.note) texts.push({ path: `${p}.note`, text: block.note, role: 'body' });
      cite(`${p}.cite`, block.cite);
      break;
    case 'timestamps':
      block.items.forEach((it, k) => {
        texts.push({ path: `${p}.items.${k}.title`, text: it.title, role: 'title' });
        if (it.summary) {
          texts.push({ path: `${p}.items.${k}.summary`, text: it.summary, role: 'body' });
        }
        cite(`${p}.items.${k}.cite`, it.cite);
      });
      break;
    case 'actions':
      block.items.forEach((it, k) => {
        texts.push({ path: `${p}.items.${k}.task`, text: it.task, role: 'body' });
        if (it.owner) texts.push({ path: `${p}.items.${k}.owner`, text: it.owner, role: 'title' });
        if (it.due) texts.push({ path: `${p}.items.${k}.due`, text: it.due, role: 'title' });
        cite(`${p}.items.${k}.cite`, it.cite);
      });
      break;
    case 'qa':
      block.items.forEach((it, k) => {
        texts.push({ path: `${p}.items.${k}.question`, text: it.question, role: 'body' });
        texts.push({ path: `${p}.items.${k}.answer`, text: it.answer, role: 'body' });
        cite(`${p}.items.${k}.cite`, it.cite);
      });
      break;
    case 'flashcards':
      block.cards.forEach((it, k) => {
        texts.push({ path: `${p}.cards.${k}.front`, text: it.front, role: 'body' });
        texts.push({ path: `${p}.cards.${k}.back`, text: it.back, role: 'body' });
        cite(`${p}.cards.${k}.cite`, it.cite);
      });
      break;
    case 'quiz':
      block.questions.forEach((it, k) => {
        const q = `${p}.questions.${k}`;
        texts.push({ path: `${q}.question`, text: it.question, role: 'body' });
        it.choices.forEach((c, ci) => {
          texts.push({ path: `${q}.choices.${ci}`, text: c, role: 'body' });
        });
        texts.push({ path: `${q}.explanation`, text: it.explanation, role: 'body' });
        cite(`${q}.cite`, it.cite);
      });
      break;
    case 'mindmap':
      // 라벨은 그림 안 글자라 굵게를 못 그린다. 이름 칸으로 둔다
      for (const { node, path } of walkMindmap(block.root, `${p}.root`)) {
        texts.push({ path: `${path}.label`, text: node.label, role: 'title' });
        cite(`${path}.cite`, node.cite);
      }
      break;
    case 'figure':
      texts.push({ path: `${p}.title`, text: block.title, role: 'title' });
      if (block.diagram.caption) {
        texts.push({ path: `${p}.diagram.caption`, text: block.diagram.caption, role: 'title' });
      }
      // 도식 라벨도 그림 안 글자라 마인드맵처럼 이름 칸으로 둔다
      for (const node of walkDiagram(block.diagram, `${p}.diagram`)) {
        texts.push({ path: node.labelPath, text: node.label, role: 'title' });
        if (node.cite) cite(`${node.path}.cite`, node.cite);
      }
      texts.push({ path: `${p}.explanation`, text: block.explanation, role: 'body' });
      cite(`${p}.cite`, block.cite);
      break;
    case 'comments':
      texts.push({ path: `${p}.overview`, text: block.overview, role: 'body' });
      block.groups.forEach((g, k) => {
        const gp = `${p}.groups.${k}`;
        texts.push({ path: `${gp}.title`, text: g.title, role: 'title' });
        texts.push({ path: `${gp}.summary`, text: g.summary, role: 'body' });
        g.examples.forEach((ex, ei) => {
          texts.push({ path: `${gp}.examples.${ei}.text`, text: ex.text, role: 'verbatim' });
        });
      });
      break;
    default: {
      const never: never = block;
      throw new Error(`모르는 블록: ${JSON.stringify(never)}`);
    }
  }
  return { texts, cites };
}

export function extensionFields(ext: Extension, p: string) {
  const texts: ExtensionText[] = [{ path: `${p}.title`, text: ext.title, role: 'title' }];
  const cites: ExtensionCite[] = [];
  ext.blocks.forEach((block, bi) => {
    const f = blockFields(block, `${p}.blocks.${bi}`);
    texts.push(...f.texts);
    cites.push(...f.cites);
  });
  return { texts, cites };
}

function checkListDepth(ext: Extension, p: string, issues: DigestIssue[]): void {
  ext.blocks.forEach((block, bi) => {
    if (block.type !== 'list') return;
    for (const { item, path, depth } of walkList(block.items, `${p}.blocks.${bi}.items`)) {
      if (depth === 1 && item.children && item.children.length > 0) {
        issues.push({
          path: `${path}.children`,
          severity: 'error',
          code: 'LIST_DEPTH',
          message: '목록은 2단까지다',
        });
      }
    }
  });
}

/**
 * 확장 리포트는 키워드 목록이 없어서 키워드 마커를 받지 않는다. 이름 칸에는 굵게도 안 받는다.
 * 원문 칸은 대사를 그대로 옮긴 것이라 마커가 끼면 원문이 아니게 된다
 */
function checkMarkers(texts: ExtensionText[], issues: DigestIssue[]): void {
  for (const t of texts) {
    if (keywordPattern().test(t.text)) {
      issues.push({
        path: t.path,
        severity: 'error',
        code: 'EXTENSION_KEYWORD',
        message: '확장 리포트에는 키워드 마커({{kw:}})를 쓰지 않는다',
      });
    } else if (t.role !== 'body' && boldPattern().test(t.text)) {
      issues.push({
        path: t.path,
        severity: 'error',
        code: t.role === 'title' ? 'TITLE_MARKER' : 'VERBATIM_MARKER',
        message:
          t.role === 'title'
            ? '제목에는 굵게(**)를 쓰지 않는다'
            : '원문 칸에는 굵게(**)를 쓰지 않는다',
      });
    }
  }
}

function checkCites(cites: ExtensionCite[], total: number, issues: DigestIssue[]): void {
  for (const { path, cite } of cites) {
    if (cite.to >= total) {
      issues.push({
        path,
        severity: 'error',
        code: 'CITE_OUT_OF_RANGE',
        message: `${cite.to}번 문장이 없다. 스크립트는 0~${total - 1}번이다`,
      });
    }
    if (cite.key < cite.from || cite.key > cite.to) {
      issues.push({
        path: `${path}.key`,
        severity: 'error',
        code: 'KEY_OUT_OF_RANGE',
        message: `key(${cite.key})가 ${cite.from}~${cite.to}번 문장 밖이다`,
      });
    }
  }
}

// 자동 자막은 문장부호와 대소문자가 흔들려서 글자와 숫자만 남겨 비교한다
const normalizeQuote = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * 인용은 원문이어야 한다. 출처 문장들을 이어 붙인 글에 인용문이 그대로 없으면 경고한다.
 * 고쳐 쓴 문장을 원문처럼 보이게 두지 않으려는 것이다. 자막 오인식을 바로잡은 인용도 있어 오류로 막지는 않는다
 */
function checkQuotes(
  ext: Extension,
  p: string,
  transcript: Transcript,
  issues: DigestIssue[],
): void {
  ext.blocks.forEach((block, bi) => {
    if (block.type !== 'quote') return;
    const { from, to } = block.cite;
    const source = transcript.segments
      .slice(from, to + 1)
      .map((s) => s.text)
      .join(' ');
    const quote = normalizeQuote(block.text);
    if (quote && !normalizeQuote(source).includes(quote)) {
      issues.push({
        path: `${p}.blocks.${bi}.text`,
        severity: 'warning',
        code: 'QUOTE_NOT_IN_SOURCE',
        message: `인용문이 ${from}~${to}번 문장에 그대로 없다. 원문을 옮기고 번역은 translation에 둔다`,
      });
    }
  });
}

function checkQuiz(ext: Extension, p: string, issues: DigestIssue[]): void {
  ext.blocks.forEach((block, bi) => {
    if (block.type !== 'quiz') return;
    block.questions.forEach((q, k) => {
      if (q.answer >= q.choices.length) {
        issues.push({
          path: `${p}.blocks.${bi}.questions.${k}.answer`,
          severity: 'error',
          code: 'QUIZ_ANSWER_OUT_OF_RANGE',
          message: `answer(${q.answer})는 0~${q.choices.length - 1} 중 하나여야 한다`,
        });
      }
    });
  });
}

export interface TreeLimit {
  maxNodes: number;
  depthCode: string;
  sizeCode: string;
  /** 메시지에 쓰는 이름. topic은 조사까지 붙인 꼴이다 (마인드맵은, 도식 트리는) */
  name: string;
  topic: string;
}

/** 마인드맵과 대섹션 도식 트리가 같은 깊이 규칙을 쓴다. 노드 상한과 코드만 다르다 */
export function checkTree(
  root: MindmapNode,
  rootPath: string,
  limit: TreeLimit,
  issues: DigestIssue[],
): void {
  let count = 0;
  for (const { node, path, depth } of walkMindmap(root, rootPath)) {
    count += 1;
    if (depth === MINDMAP_MAX_DEPTH && node.children && node.children.length > 0) {
      issues.push({
        path: `${path}.children`,
        severity: 'error',
        code: limit.depthCode,
        message: `${limit.topic} 루트 아래 ${MINDMAP_MAX_DEPTH}단까지다`,
      });
    }
  }
  if (count > limit.maxNodes) {
    issues.push({
      path: rootPath,
      severity: 'error',
      code: limit.sizeCode,
      message: `${limit.name} 노드가 ${count}개다. ${limit.maxNodes}개까지 쓴다`,
    });
  }
}

/** 대섹션 도식의 트리는 마인드맵보다 작게 둔다. 본문 사이에 끼는 그림이라서다 */
export const DIAGRAM_TREE_MAX_NODES = 30;

const DIAGRAM_TREE_LIMIT: TreeLimit = {
  maxNodes: DIAGRAM_TREE_MAX_NODES,
  depthCode: 'DIAGRAM_DEPTH',
  sizeCode: 'DIAGRAM_SIZE',
  name: '도식 트리',
  topic: '도식 트리는',
};

/**
 * 스키마로는 못 잡는 도식 모양을 본다. 트리 깊이와 크기, 상자 하나만 남는 인과도와 빈 매트릭스다.
 * 확장 리포트의 figure 블록도 같은 검사를 쓴다
 */
export function checkDiagramShape(d: Diagram, dp: string, issues: DigestIssue[]): void {
  if (d.kind === 'tree') checkTree(d.root, `${dp}.root`, DIAGRAM_TREE_LIMIT, issues);
  if (d.kind === 'causal' && d.inputs.length === 0 && d.outputs.length === 0) {
    issues.push({
      path: dp,
      severity: 'error',
      code: 'DIAGRAM_EMPTY',
      message:
        '인과도는 inputs와 outputs 중 하나는 채운다. 원인도 결과도 없으면 상자 하나만 남는다',
    });
  }
  if (d.kind === 'matrix' && d.cells.every((c) => c.length === 0)) {
    issues.push({
      path: `${dp}.cells`,
      severity: 'error',
      code: 'DIAGRAM_EMPTY',
      message: '매트릭스 네 칸이 다 비었다. 칸마다 노드를 0~4개 둔다',
    });
  }
}

const MINDMAP_LIMIT: TreeLimit = {
  maxNodes: MINDMAP_MAX_NODES,
  depthCode: 'MINDMAP_DEPTH',
  sizeCode: 'MINDMAP_SIZE',
  name: '마인드맵',
  topic: '마인드맵은',
};

function checkShapes(ext: Extension, p: string, issues: DigestIssue[]): void {
  ext.blocks.forEach((block, bi) => {
    const bp = `${p}.blocks.${bi}`;
    if (block.type === 'mindmap') checkTree(block.root, `${bp}.root`, MINDMAP_LIMIT, issues);
    if (block.type === 'figure') checkDiagramShape(block.diagram, `${bp}.diagram`, issues);
  });
}

// 정규화하면 빈 문자열이 되는 이모지 댓글이나 한두 글자 조각은 부분 일치로 넘기면 어느 원문에나 맞는다
function matchesComment(text: string, source: string): boolean {
  if (text.trim() === source.trim()) return true;
  const needle = normalizeQuote(text);
  const hay = normalizeQuote(source);
  if (needle !== '' && needle === hay) return true;
  return needle.length >= 4 && hay.includes(needle);
}

/**
 * 댓글 예시는 원문이어야 한다. 없는 댓글을 지어내거나 고쳐 쓴 문장을 원문처럼 보이게 두지 않는다.
 * id가 없으면 오류다. 본문이 다르면 merge에서는 오류, validate와 render에서는 경고다. 긴 댓글의 일부를 4자 이상 옮긴 예시는 통과시킨다
 */
function checkComments(
  ext: Extension,
  p: string,
  comments: ExtensionLintOptions['comments'],
  strictVerbatim: boolean,
  issues: DigestIssue[],
): void {
  ext.blocks.forEach((block, bi) => {
    if (block.type !== 'comments') return;
    const bp = `${p}.blocks.${bi}`;
    const counted = block.groups.reduce((sum, g) => sum + g.count, 0);
    if (counted > block.total) {
      issues.push({
        path: `${bp}.total`,
        severity: 'warning',
        code: 'COMMENT_COUNT_EXCEEDS',
        message: `묶음 개수 합(${counted})이 total(${block.total})보다 크다`,
      });
    }
    if (comments === undefined) return;
    if (comments === null) {
      issues.push({
        path: bp,
        severity: 'error',
        code: 'COMMENTS_SOURCE_MISSING',
        message: 'comments.json이 없다. gestalt digest comments로 댓글을 먼저 받는다',
      });
      return;
    }
    block.groups.forEach((g, k) => {
      g.examples.forEach((ex, ei) => {
        const path = `${bp}.groups.${k}.examples.${ei}`;
        const source = comments.get(ex.id);
        if (source === undefined) {
          issues.push({
            path: `${path}.id`,
            severity: 'error',
            code: 'COMMENT_NOT_FOUND',
            message: `comments.json에 ${ex.id} 댓글이 없다`,
          });
        } else if (!matchesComment(ex.text, source)) {
          issues.push({
            path: `${path}.text`,
            severity: strictVerbatim ? 'error' : 'warning',
            code: 'COMMENT_TEXT_MISMATCH',
            message: `${ex.id} 댓글 원문과 다르다. 번역하거나 고쳐 쓰지 말고 원문을 옮긴다`,
          });
        }
      });
    });
  });
}

function checkTemplate(
  ext: Extension,
  p: string,
  templates: ExtensionLintOptions['templates'],
  issues: DigestIssue[],
): void {
  if (!templates) return;
  const t = templates.get(ext.template);
  if (!t) {
    issues.push({
      path: `${p}.template`,
      severity: 'warning',
      code: 'UNKNOWN_TEMPLATE',
      message: `템플릿 ${ext.template}를 못 찾았다. 렌더는 되지만 다시 만들 수 없다`,
    });
    return;
  }
  const allowed = new Set<string>(t.blocks);
  ext.blocks.forEach((block, bi) => {
    if (!allowed.has(block.type)) {
      issues.push({
        path: `${p}.blocks.${bi}.type`,
        severity: 'warning',
        code: 'BLOCK_NOT_IN_TEMPLATE',
        message: `템플릿 ${t.id}는 ${block.type} 블록을 쓰지 않는다(${t.blocks.join(', ')})`,
      });
    }
  });
}

export function lintExtensions(
  extensions: Extension[],
  transcript: Transcript,
  issues: DigestIssue[],
  opts: ExtensionLintOptions = {},
): void {
  const total = transcript.segments.length;
  const seen = new Map<string, number>();
  extensions.forEach((ext, xi) => {
    const p = `extensions.${xi}`;
    const key = extensionKey(ext);
    const before = seen.get(key);
    if (before !== undefined) {
      issues.push({
        path: `${p}.template`,
        severity: 'error',
        code: 'DUPLICATE_EXTENSION',
        message: `extensions.${before}와 템플릿과 언어가 같다(${key}). 탭이 둘 중 하나만 연다`,
      });
    } else {
      seen.set(key, xi);
    }
    const { texts, cites } = extensionFields(ext, p);
    checkMarkers(texts, issues);
    checkCites(cites, total, issues);
    checkListDepth(ext, p, issues);
    checkQuotes(ext, p, transcript, issues);
    checkQuiz(ext, p, issues);
    checkShapes(ext, p, issues);
    checkComments(ext, p, opts.comments, opts.strictVerbatim ?? false, issues);
    checkTemplate(ext, p, opts.templates, issues);
  });
}
