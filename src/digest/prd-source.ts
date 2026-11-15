import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';

/** PRD 원문. 읽기만 하고 고치지 않는다 */
export interface PrdSource {
  path: string;
  /** 줄 끝 문자를 뗀 줄들. lines[0]이 1번 줄이다 */
  lines: string[];
  sha256: string;
  bytes: number;
}

export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

export type SourceRead =
  | { ok: true; source: PrdSource }
  | {
      ok: false;
      code: 'SOURCE_NOT_FOUND' | 'SOURCE_TOO_LARGE' | 'SOURCE_NOT_TEXT';
      message: string;
    };

export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  // 파일 끝 줄바꿈이 빈 줄 하나로 세지면 줄 수가 편집기와 하나 어긋난다
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function sourceFromText(path: string, text: string): PrdSource {
  // 해시는 줄 끝 문자와 무관하게 내용으로만 잡는다. CRLF로 저장만 바꿔도 stale로 뜨지 않게
  const lines = splitLines(text);
  const sha256 = createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
  return { path, lines, sha256, bytes: Buffer.byteLength(text, 'utf8') };
}

export function readPrdSource(path: string): SourceRead {
  if (!existsSync(path) || !statSync(path).isFile()) {
    return { ok: false, code: 'SOURCE_NOT_FOUND', message: `원문 파일이 없다: ${path}` };
  }
  if (statSync(path).size > MAX_SOURCE_BYTES) {
    return { ok: false, code: 'SOURCE_TOO_LARGE', message: '원문이 2MB를 넘는다' };
  }
  const buf = readFileSync(path);
  if (buf.includes(0)) {
    return {
      ok: false,
      code: 'SOURCE_NOT_TEXT',
      message: '원문에 NUL 바이트가 있어 텍스트로 안 본다',
    };
  }
  return { ok: true, source: sourceFromText(path, buf.toString('utf8')) };
}

export type LineClass =
  | 'content'
  | 'blank'
  | 'frontmatter'
  | 'tableSep'
  | 'tableEmptyHead'
  | 'headingOnly'
  | 'rule'
  | 'htmlOnly'
  | 'fence';

const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const TABLE_EMPTY = /^\s*\|(\s*\|)+\s*$/;
const HEADING = /^\s{0,3}#{1,6}\s+\S/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s{0,3}(```|~~~)/;

/**
 * 줄마다 내용 줄인지 가른다. coverage는 내용 줄만 센다.
 * 헤딩은 섹션 제목으로 옮겨지니 내용 줄에서 뺀다. 펜스 경계는 빼고 펜스 안은 내용이다
 */
export function classifyLines(lines: readonly string[]): LineClass[] {
  const out: LineClass[] = [];
  let i = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, k) => k > 0 && l.trim() === '---');
    if (end > 0) {
      for (; i <= end; i++) out.push('frontmatter');
    }
  }
  let inFence = false;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE.test(line)) {
      inFence = !inFence;
      out.push('fence');
      continue;
    }
    if (inFence) {
      out.push(line.trim() === '' ? 'blank' : 'content');
      continue;
    }
    if (line.trim() === '') out.push('blank');
    else if (TABLE_SEP.test(line)) out.push('tableSep');
    else if (TABLE_EMPTY.test(line)) out.push('tableEmptyHead');
    else if (HEADING.test(line)) out.push('headingOnly');
    else if (RULE.test(line)) out.push('rule');
    else if (line.replace(/<[^>]*>/g, '').trim() === '') out.push('htmlOnly');
    else out.push('content');
  }
  return out;
}

export const MAX_LINE_CHARS = 600;
export const MAX_SOURCE_PAGE = 400;

export interface NumberedPage {
  from: number;
  to: number;
  nextFrom: number | null;
  text: string;
  truncatedLines: number[];
}

/** 줄 번호를 붙인 원문 한 쪽. 번호 폭을 맞춰 세션이 src를 달기 쉽게 한다 */
export function numberedText(
  lines: readonly string[],
  from: number,
  to: number,
  maxChars = MAX_LINE_CHARS,
): NumberedPage {
  const last = Math.min(to, lines.length, from + MAX_SOURCE_PAGE - 1);
  const width = String(lines.length).length;
  const truncatedLines: number[] = [];
  const out: string[] = [];
  for (let n = from; n <= last; n++) {
    let line = lines[n - 1]!;
    if (line.length > maxChars) {
      line = `${line.slice(0, maxChars)}…`;
      truncatedLines.push(n);
    }
    out.push(`${String(n).padStart(width, ' ')}: ${line}`);
  }
  const end = Math.min(to, lines.length);
  return {
    from,
    to: last,
    nextFrom: last < end ? last + 1 : null,
    text: out.join('\n'),
    truncatedLines,
  };
}

/** 원문 헤딩 글자. 섹션 제목 대조에 쓴다 */
export function headingTexts(lines: readonly string[], classes: readonly LineClass[]): string[] {
  const out: string[] = [];
  for (const [k, c] of classes.entries()) {
    if (c === 'headingOnly')
      out.push(lines[k]!.replace(/^\s*#{1,6}\s+/, '').replace(/\s+#+\s*$/, ''));
  }
  return out;
}
