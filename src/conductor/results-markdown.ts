import { escapeHtml } from '../local-pr-web/html-generator.js';

/**
 * 결과 뷰어용 마크다운 렌더러. 워커가 쓴 refs 파일을 웹 뷰어에서 읽기 좋게 그린다.
 *
 * 입력은 신뢰하지 않는다. 원문을 블록으로 나눈 뒤 모든 글자를 escapeHtml로 바꾸고
 * 아래 화이트리스트 문법만 태그로 만든다. 원시 HTML은 언제나 글자로 보인다.
 * 링크는 http와 https만 걸고 이미지는 불러오지 않고 링크로만 보여준다.
 * 서버가 이 결과만 innerHTML로 넣으니 여기서 새는 문법이 있으면 바로 스크립트 실행이 된다.
 */

/** 인용과 목록이 겹칠 수 있는 깊이. 넘으면 글자로 둔다 */
const MAX_DEPTH = 6;

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const HR_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE_RE = /^ {0,3}> ?(.*)$/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const LANG_RE = /^[\w+#.-]{1,32}$/;

export function renderMarkdown(src: string): string {
  return renderBlocks(src.replace(/\r\n?/g, '\n').split('\n'), 0);
}

function renderBlocks(lines: string[], depth: number): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const mark = fence[1]!;
      const lang = fence[2]!.trim().split(/\s/)[0] ?? '';
      const body: string[] = [];
      i++;
      while (i < lines.length && !isFenceClose(lines[i]!, mark)) body.push(lines[i++]!);
      i++;
      const cls = LANG_RE.test(lang) ? ` class="language-${escapeHtml(lang)}"` : '';
      out.push(`<pre><code${cls}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      out.push(`<h${level}>${renderInline(heading[2] ?? '')}</h${level}>`);
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.trim()) {
        const q = QUOTE_RE.exec(lines[i]!);
        body.push(q ? q[1]! : lines[i]!);
        i++;
      }
      out.push(
        depth < MAX_DEPTH
          ? `<blockquote>${renderBlocks(body, depth + 1)}</blockquote>`
          : `<blockquote><p>${renderInline(body.join('\n'))}</p></blockquote>`,
      );
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]!)) {
      const rows: string[] = [line];
      const sep = lines[i + 1]!;
      i += 2;
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes('|'))
        rows.push(lines[i++]!);
      out.push(renderTable(rows, sep));
      continue;
    }

    const listHead = LIST_RE.exec(line);
    if (listHead) {
      const items: string[] = [];
      const baseIndent = listHead[1]!.length;
      const ordered = /\d/.test(listHead[2]!);
      while (i < lines.length) {
        const l = lines[i]!;
        const item = LIST_RE.exec(l);
        // 같은 깊이에서 번호 목록과 글머리 목록이 바뀌면 새 목록이다
        if (
          items.length > 0 &&
          item &&
          item[1]!.length <= baseIndent + 1 &&
          /\d/.test(item[2]!) !== ordered
        ) {
          break;
        }
        if (!l.trim()) {
          // 빈 줄 뒤에 목록이나 들여쓴 줄이 이어지면 같은 목록이다
          const next = lines[i + 1];
          if (next !== undefined && (LIST_RE.test(next) || /^\s{2,}\S/.test(next))) {
            i++;
            continue;
          }
          break;
        }
        if (!LIST_RE.test(l) && !/^\s/.test(l) && items.length > 0 && startsBlock(l)) break;
        items.push(l);
        i++;
      }
      out.push(renderList(items, depth));
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && (para.length === 0 || !startsBlock(lines[i]!))) {
      para.push(lines[i++]!.trim());
    }
    out.push(`<p>${renderInline(para.join('\n'))}</p>`);
  }
  return out.join('\n');
}

function isFenceClose(line: string, mark: string): boolean {
  const t = line.trim();
  return t.length >= mark.length && t[0] === mark[0] && /^(`+|~+)$/.test(t);
}

function startsBlock(line: string): boolean {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    QUOTE_RE.test(line) ||
    LIST_RE.test(line)
  );
}

interface ListItem {
  indent: number;
  ordered: boolean;
  text: string;
  children: string[];
}

/** 들여쓰기가 첫 항목보다 깊은 줄은 직전 항목의 하위 목록이나 이어지는 글로 본다 */
function renderList(lines: string[], depth: number): string {
  const first = LIST_RE.exec(lines[0]!)!;
  const baseIndent = first[1]!.length;
  const ordered = /\d/.test(first[2]!);
  const items: ListItem[] = [];
  for (const line of lines) {
    const m = LIST_RE.exec(line);
    const indent = m ? m[1]!.length : (/^\s*/.exec(line)?.[0].length ?? 0);
    const last = items[items.length - 1];
    if (m && indent <= baseIndent + 1) {
      items.push({ indent, ordered: /\d/.test(m[2]!), text: m[3]!, children: [] });
    } else if (last && depth < MAX_DEPTH && (m || last.children.length > 0)) {
      last.children.push(line.slice(Math.min(indent, baseIndent + 2)));
    } else if (last) {
      last.text += '\n' + line.trim();
    } else {
      items.push({ indent, ordered, text: line.trim(), children: [] });
    }
  }
  const tag = ordered ? 'ol' : 'ul';
  const body = items
    .map((it) => {
      const sub = it.children.length > 0 ? renderList(dedent(it.children), depth + 1) : '';
      return `<li>${renderInline(it.text)}${sub}</li>`;
    })
    .join('');
  return `<${tag}>${body}</${tag}>`;
}

function dedent(lines: string[]): string[] {
  const min = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length));
  return lines.map((l) => l.slice(Number.isFinite(min) ? min : 0));
}

function splitRow(row: string): string[] {
  let t = row.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (ch === '\\' && t[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function renderTable(rows: string[], sep: string): string {
  const aligns = splitRow(sep).map((c) => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return '';
  });
  const cell = (tag: 'th' | 'td', text: string, i: number) => {
    const a = aligns[i];
    return `<${tag}${a ? ` style="text-align:${a}"` : ''}>${renderInline(text)}</${tag}>`;
  };
  const [head, ...body] = rows.map(splitRow);
  const width = head!.length;
  const headHtml = `<tr>${head!.map((c, i) => cell('th', c, i)).join('')}</tr>`;
  const bodyHtml = body
    .map(
      (r) =>
        `<tr>${Array.from({ length: width }, (_, i) => cell('td', r[i] ?? '', i)).join('')}</tr>`,
    )
    .join('');
  return `<table><thead>${headHtml}</thead><tbody>${bodyHtml}</tbody></table>`;
}

const CODE_RE = /(`+)([\s\S]*?[^`])\1(?!`)/y;
// 주소에 괄호를 안 받는다. 닫는 괄호 없는 `[a](`가 줄마다 끝까지 훑어 제곱으로 느려지지 않게 한다
const LINK_RE = /(!?)\[([^[\]\n]*)\]\(\s*<?([^\s<>()]*)>?(?:\s+"[^"\n]*")?\s*\)/y;
const AUTOLINK_RE = /<(https?:\/\/[^\s<>]+)>/iy;
const BARE_URL_RE = /https?:\/\/[^\s<>"'`]+/iy;

/** http, https 주소만 링크로 건다. 그 밖은 null */
export function safeHref(raw: string): string | null {
  const t = raw.trim();
  if (!/^https?:\/\//i.test(t)) return null;
  try {
    const url = new URL(t);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function anchor(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" rel="noreferrer noopener" target="_blank">${label}</a>`;
}

/** 줄 안 문법. 코드와 링크를 먼저 떼어 내고 나머지 글자는 이스케이프한 뒤 강조만 태그로 바꾼다 */
export function renderInline(src: string): string {
  let out = '';
  let text = '';
  const flush = () => {
    out += emphasis(escapeHtml(text)).replace(/\n/g, '<br>');
    text = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '`') {
      CODE_RE.lastIndex = i;
      const m = CODE_RE.exec(src);
      if (m) {
        flush();
        out += `<code>${escapeHtml(m[2]!)}</code>`;
        i = CODE_RE.lastIndex;
        continue;
      }
    }
    if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
      LINK_RE.lastIndex = i;
      const m = LINK_RE.exec(src);
      if (m) {
        flush();
        const image = m[1] === '!';
        const label = m[2]!;
        const href = safeHref(m[3]!);
        if (href) {
          const shown = image ? `이미지: ${label || href}` : label || href;
          out += anchor(href, emphasis(escapeHtml(shown)));
        } else {
          out += escapeHtml(m[0]);
        }
        i = LINK_RE.lastIndex;
        continue;
      }
    }
    if (ch === '<') {
      AUTOLINK_RE.lastIndex = i;
      const m = AUTOLINK_RE.exec(src);
      const href = m ? safeHref(m[1]!) : null;
      if (m && href) {
        flush();
        out += anchor(href, escapeHtml(m[1]!));
        i = AUTOLINK_RE.lastIndex;
        continue;
      }
    }
    if ((ch === 'h' || ch === 'H') && !/[\w/]/.test(src[i - 1] ?? '')) {
      BARE_URL_RE.lastIndex = i;
      const m = BARE_URL_RE.exec(src);
      if (m) {
        // 문장 끝 문장부호와 짝 없는 닫는 괄호는 주소에서 뺀다
        let url = m[0];
        while (/[.,;:!?)\]]$/.test(url) && !(url.endsWith(')') && url.includes('('))) {
          url = url.slice(0, -1);
        }
        const href = safeHref(url);
        if (href) {
          flush();
          out += anchor(href, escapeHtml(url));
          i += url.length;
          continue;
        }
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

/** 강조를 찾는 줄 길이 상한. 닫는 표시 없는 `**`가 많은 긴 줄에서 정규식이 제곱으로 느려지는 걸 막는다 */
const MAX_EMPHASIS_LINE = 10_000;

/** 이스케이프를 마친 글자에만 쓴다. 꺾쇠가 이미 엔티티라 여기서 넣는 태그 말고는 태그가 생기지 않는다 */
function emphasis(escaped: string): string {
  return escaped
    .split('\n')
    .map((line) => (line.length > MAX_EMPHASIS_LINE ? line : emphasisLine(line)))
    .join('\n');
}

function emphasisLine(line: string): string {
  return line
    .replace(/\*\*(?=\S)(.*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=\S)(.*?\S)__(?=[^\w]|$)/g, '$1<strong>$2</strong>')
    .replace(/~~(?=\S)(.*?\S)~~/g, '<del>$1</del>')
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?=[^\w]|$)/g, '$1<em>$2</em>');
}
