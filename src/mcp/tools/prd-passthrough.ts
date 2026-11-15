import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { lintPrdView, prdLintErrors, prdLintWarnings } from '../../digest/lint-prd.js';
import { prdGuide } from '../../digest/prd-guide.js';
import { parsePrdView, type PrdView } from '../../digest/prd-schema.js';
import {
  classifyLines,
  numberedText,
  readPrdSource,
  type PrdSource,
} from '../../digest/prd-source.js';
import {
  isValidPrdSlug,
  PrdViewStore,
  resolveOutDir,
  slugFromSource,
  writeHtmlTo,
} from '../../digest/prd-store.js';
import { renderPrdHtml } from '../../digest/render-prd.js';
import { log } from '../../core/log.js';
import type { PrdInput } from '../schemas.js';

interface PrdFailure {
  ok: false;
  errors: Array<{ code: string; message: string }>;
}

function fail(code: string, message: string): PrdFailure {
  return { ok: false, errors: [{ code, message }] };
}

const MAX_VIEW_BYTES = 5 * 1024 * 1024;

const abs = (repoRoot: string, p: string) => (isAbsolute(p) ? p : resolve(repoRoot, p));

function loadSource(repoRoot: string, path: string | undefined): PrdSource | PrdFailure {
  if (!path) return fail('SOURCE_REQUIRED', 'sourcePath가 필요하다');
  const r = readPrdSource(abs(repoRoot, path));
  return r.ok ? r.source : fail(r.code, r.message);
}

interface LoadedView {
  view: PrdView;
  fromFile: boolean;
}

/** viewPath가 있으면 그 파일을, 없으면 slug 저장본을 읽어 검증한다 */
function loadView(input: PrdInput, repoRoot: string): LoadedView | PrdFailure {
  let path: string;
  if (input.viewPath) {
    path = abs(repoRoot, input.viewPath);
  } else {
    if (!isValidPrdSlug(input.slug))
      return fail('INVALID_SLUG', 'viewPath나 올바른 slug가 필요하다');
    path = new PrdViewStore(repoRoot).jsonPath(input.slug);
  }
  if (!existsSync(path) || !statSync(path).isFile()) {
    return fail('VIEW_NOT_FOUND', `prd-view.json이 없다: ${path}`);
  }
  if (statSync(path).size > MAX_VIEW_BYTES)
    return fail('VIEW_TOO_LARGE', 'prd-view.json이 5MB를 넘는다');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    return fail(
      'VIEW_NOT_JSON',
      `JSON을 읽지 못했다: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = parsePrdView(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      errors: parsed.issues.map((m) => ({ code: 'INVALID_PRD_VIEW', message: m })),
    };
  }
  if (input.slug && input.slug !== parsed.value.slug) {
    return fail('SLUG_MISMATCH', `slug(${input.slug})와 view.slug(${parsed.value.slug})가 다르다`);
  }
  return { view: parsed.value, fromFile: Boolean(input.viewPath) };
}

function handleSource(input: PrdInput, repoRoot: string): object {
  const source = loadSource(repoRoot, input.sourcePath);
  if ('ok' in source) return source;
  const total = source.lines.length;
  const from = input.from ?? 1;
  const to = input.to ?? total;
  if (total === 0 || from > total || from > to) {
    return fail('RANGE_OUT_OF_BOUNDS', `from(${from})과 to(${to})가 원문 줄 수(${total}) 밖이다`);
  }
  const page = numberedText(source.lines, from, to);
  return {
    ok: true,
    action: 'source',
    path: source.path,
    totalLines: total,
    contentLines: classifyLines(source.lines).filter((c) => c === 'content').length,
    sha256: source.sha256,
    suggestedSlug: slugFromSource(source.path),
    ...page,
  };
}

interface Checked {
  view: PrdView;
  fromFile: boolean;
  source: PrdSource;
  lint: ReturnType<typeof lintPrdView>;
}

function check(input: PrdInput, repoRoot: string): Checked | PrdFailure {
  const loaded = loadView(input, repoRoot);
  if ('ok' in loaded) return loaded;
  const source = loadSource(repoRoot, input.sourcePath ?? loaded.view.meta.source);
  if ('ok' in source) return source;
  return { ...loaded, source, lint: lintPrdView(loaded.view, source) };
}

function handleValidate(input: PrdInput, repoRoot: string): object {
  const c = check(input, repoRoot);
  if ('ok' in c) return c;
  const errors = prdLintErrors(c.lint.issues);
  return {
    ok: errors.length === 0,
    action: 'validate',
    slug: c.view.slug,
    errors,
    warnings: prdLintWarnings(c.lint.issues),
    coverage: c.lint.coverage,
    sourceSha256: c.source.sha256,
  };
}

function handleRender(input: PrdInput, repoRoot: string): object {
  const c = check(input, repoRoot);
  if ('ok' in c) return c;
  const errors = prdLintErrors(c.lint.issues);
  if (errors.length > 0) {
    return {
      ...fail('RENDER_BLOCKED', `validate 오류 ${errors.length}개가 남아 있어 렌더하지 않았다`),
      lintErrors: errors,
    };
  }
  // 출력 폴더 검사를 먼저 해서 막힐 때 저장소에 아무것도 안 남긴다
  let outDir: string | undefined;
  if (input.outDir !== undefined) {
    const r = resolveOutDir(repoRoot, input.outDir);
    if (!r.ok) return fail(r.code, r.message);
    outDir = r.dir;
  }
  try {
    const store = new PrdViewStore(repoRoot);
    const html = renderPrdHtml(c.view, {
      sourceSha256: c.source.sha256,
      coverage: c.lint.coverage,
    });
    const written = writeHtmlTo(outDir ?? store.dir(c.view.slug), html, {
      // 저장소 안의 index.html은 우리가 쓴 파일이라 표시가 없어도 덮는다
      overwrite: outDir ? input.overwrite : true,
    });
    if (!written.ok) return fail(written.code, written.message);
    // viewPath로 받은 뷰는 저장소에 복사해 둔다. 다음 render를 slug만으로 부를 수 있게
    const jsonPath = c.fromFile ? store.saveJson(c.view.slug, c.view) : store.jsonPath(c.view.slug);
    return {
      ok: true,
      action: 'render',
      slug: c.view.slug,
      htmlPath: written.path,
      jsonPath,
      warnings: prdLintWarnings(c.lint.issues),
      coverage: c.lint.coverage,
    };
  } catch (e) {
    log(`ges_prd render 실패: ${e instanceof Error ? e.message : String(e)}`);
    return fail('RENDER_FAILED', e instanceof Error ? e.message : String(e));
  }
}

export function handlePrdPassthrough(input: PrdInput, cwd: string = process.cwd()): object {
  const repoRoot = resolve(cwd, input.repoRoot ?? '.');
  switch (input.action) {
    case 'guide':
      return prdGuide();
    case 'source':
      return handleSource(input, repoRoot);
    case 'validate':
      return handleValidate(input, repoRoot);
    case 'render':
      return handleRender(input, repoRoot);
  }
}
