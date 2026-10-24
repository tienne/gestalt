import { extensionKey, type Block, type Extension, type ListItem } from './blocks.js';
import type { DigestIssue } from './lint.js';
import { boldPattern, keywordPattern, type Cite, type Transcript } from './schema.js';
import type { DigestTemplate } from './templates.js';

/**
 * 확장 리포트의 문자열 한 칸.
 * title은 탭과 소제목처럼 이름으로 쓰여 윤문하지 않는다. verbatim은 대사나 댓글 원문이라 손대지 않는다
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
}

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
    checkTemplate(ext, p, opts.templates, issues);
  });
}
