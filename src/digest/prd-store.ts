import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync, type Stats } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { writeJsonAtomic } from '../core/json-file.js';
import { SLUG_PATTERN } from './schema-base.js';

/** 렌더한 HTML 첫 줄에 넣는 표시. 이 표시가 없는 index.html은 남의 파일로 보고 덮어쓰지 않는다 */
export const PRD_HTML_MARKER = '<!-- gestalt-prd-view v1 -->';

export const isValidPrdSlug = (slug: string | undefined): slug is string =>
  typeof slug === 'string' && SLUG_PATTERN.test(slug);

/** 원문 파일 이름을 영문 소문자와 하이픈으로 줄이고 경로 해시 6자를 붙인다. 같은 이름 PRD.md가 여럿이어도 안 겹친다 */
export function slugFromSource(sourcePath: string): string {
  const abs = resolve(sourcePath);
  const stem = basename(abs, extname(abs))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  const hash = createHash('sha256').update(abs).digest('hex').slice(0, 6);
  return stem ? `${stem}-${hash}` : `prd-${hash}`;
}

export class PrdViewStore {
  readonly root: string;

  constructor(repoRoot: string) {
    this.root = join(resolve(repoRoot), '.gestalt', 'prd-view');
  }

  dir(slug: string): string {
    if (!isValidPrdSlug(slug)) throw new Error(`slug가 올바르지 않다: ${slug}`);
    return join(this.root, slug);
  }

  jsonPath(slug: string): string {
    return join(this.dir(slug), 'prd-view.json');
  }

  htmlPath(slug: string): string {
    return join(this.dir(slug), 'index.html');
  }

  saveJson(slug: string, value: unknown): string {
    const path = this.jsonPath(slug);
    writeJsonAtomic(path, value);
    return path;
  }
}

export type OutDirResult =
  | { ok: true; dir: string }
  | { ok: false; code: 'INVALID_OUT_DIR' | 'OUT_DIR_NOT_DIRECTORY'; message: string };

/** 상대 경로는 repoRoot 기준으로 푼다. 없으면 만든다. 마지막 폴더가 심볼릭 링크면 거절한다 */
export function resolveOutDir(repoRoot: string, outDir: string): OutDirResult {
  if (outDir.trim() === '' || outDir.includes('\0')) {
    return { ok: false, code: 'INVALID_OUT_DIR', message: 'outDir이 비었거나 NUL 문자가 있다' };
  }
  const dir = isAbsolute(outDir) ? outDir : resolve(repoRoot, outDir);
  const st = lstatOrNull(dir);
  // index.html 링크만 막고 폴더 링크를 따라가면 링크 대상에 쓰게 되니 폴더도 같이 막는다
  if (st?.isSymbolicLink()) {
    return {
      ok: false,
      code: 'INVALID_OUT_DIR',
      message: `심볼릭 링크 폴더에는 쓰지 않는다: ${dir}`,
    };
  }
  if (st && !st.isDirectory()) {
    return { ok: false, code: 'OUT_DIR_NOT_DIRECTORY', message: `디렉토리가 아니다: ${dir}` };
  }
  mkdirSync(dir, { recursive: true });
  return { ok: true, dir };
}

export type WriteHtmlResult =
  | { ok: true; path: string }
  | { ok: false; code: 'OUT_FILE_EXISTS'; message: string };

/**
 * outDir에 index.html을 쓴다. 사용자가 앱 폴더를 주면 실제 index.html을 날릴 수 있어서
 * 우리 표시가 없는 파일은 overwrite일 때만 덮는다. 심볼릭 링크는 overwrite여도 안 따라간다
 */
export function writeHtmlTo(
  dir: string,
  html: string,
  opts: { overwrite?: boolean } = {},
): WriteHtmlResult {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'index.html');
  const st = lstatOrNull(path);
  if (st) {
    if (st.isSymbolicLink()) {
      return {
        ok: false,
        code: 'OUT_FILE_EXISTS',
        message: `${path}가 심볼릭 링크라 쓰지 않는다`,
      };
    }
    if (!st.isFile()) {
      return { ok: false, code: 'OUT_FILE_EXISTS', message: `${path}가 파일이 아니다` };
    }
    if (!opts.overwrite && !readFileSync(path, 'utf8').startsWith(PRD_HTML_MARKER)) {
      return {
        ok: false,
        code: 'OUT_FILE_EXISTS',
        message: `${path}가 이미 있고 PRD 뷰가 만든 파일이 아니다. 덮으려면 overwrite: true를 준다`,
      };
    }
  }
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, html, 'utf8');
  renameSync(tmp, path);
  return { ok: true, path };
}

// existsSync는 링크를 따라가서 대상이 없는 링크를 못 본다
function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}
