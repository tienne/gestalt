import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

/** `src/review/snippet-reader.ts`의 MAX_FILE_BYTES와 같은 기준 */
const MAX_FILE_BYTES = 2_000_000;
const DEFAULT_WINDOW = 200;
const MAX_CANDIDATES = 3;

/** 한 번의 검증 동안 파일 내용을 기억한다. 읽지 못한 파일은 null */
export type SourceFileCache = Map<string, string[] | null>;

export function resolveInsideRoot(
  root: string,
  relPath: string,
): { ok: true; abs: string } | { ok: false; reason: 'absolute' | 'outside_root' } {
  if (isAbsolute(relPath)) return { ok: false, reason: 'absolute' };
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, relPath);
  const rel = relative(rootAbs, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, reason: 'outside_root' };
  }
  return { ok: true, abs };
}

// 마지막 개행 뒤의 빈 조각은 줄이 아니다
function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 파일을 줄 배열로 읽는다. 없거나 파일이 아니거나 2MB를 넘으면 null */
export function readSourceLines(abs: string, cache: SourceFileCache): string[] | null {
  if (cache.has(abs)) return cache.get(abs)!;
  let lines: string[] | null = null;
  try {
    const stat = statSync(abs);
    if (stat.isFile() && stat.size <= MAX_FILE_BYTES) {
      lines = splitLines(readFileSync(abs, 'utf-8'));
    }
  } catch {
    lines = null;
  }
  cache.set(abs, lines);
  return lines;
}

export type LocationCheck =
  | { status: 'match' }
  | { status: 'moved'; candidates: number[] } // 가까운 순, 최대 3개
  | { status: 'mismatch' } // 근처에서도 못 찾았다
  | { status: 'out_of_range'; lineCount: number }
  | { status: 'missing_file' };

// 줄이 excerpt로 시작하면 맞다. excerpt는 줄 앞부분만 잘라 적는 일이 많다
function matchesAt(lines: string[], start: number, excerptLines: string[]): boolean {
  for (let i = 0; i < excerptLines.length; i++) {
    const actual = lines[start - 1 + i];
    if (actual === undefined || !actual.trim().startsWith(excerptLines[i]!)) return false;
  }
  return true;
}

/**
 * `line`(1부터)이 가리키는 줄이 excerpt와 맞는지 본다.
 * excerpt가 없거나 걷어 낸 뒤 비어 있으면 범위만 본다.
 */
export function checkLineExcerpt(
  lines: string[] | null,
  line: number,
  excerpt: string | undefined,
  opts: { window?: number } = {},
): LocationCheck {
  if (lines === null) return { status: 'missing_file' };
  if (!Number.isInteger(line) || line < 1 || line > lines.length) {
    return { status: 'out_of_range', lineCount: lines.length };
  }
  const excerptLines = (excerpt ?? '').split('\n').map((l) => l.trim());
  // 앞뒤 빈 줄은 걷고 가운데 빈 줄은 빈 줄과 맞춘다
  while (excerptLines[0] === '') excerptLines.shift();
  while (excerptLines[excerptLines.length - 1] === '') excerptLines.pop();
  if (excerptLines.length === 0) return { status: 'match' };

  if (matchesAt(lines, line, excerptLines)) return { status: 'match' };

  const window = opts.window ?? DEFAULT_WINDOW;
  const candidates: number[] = [];
  for (let d = 1; d <= window && candidates.length < MAX_CANDIDATES; d++) {
    for (const cand of [line - d, line + d]) {
      if (cand < 1 || cand > lines.length) continue;
      if (candidates.length >= MAX_CANDIDATES) break;
      if (matchesAt(lines, cand, excerptLines)) candidates.push(cand);
    }
  }
  return candidates.length > 0 ? { status: 'moved', candidates } : { status: 'mismatch' };
}
