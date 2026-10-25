import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { extensionKey } from './blocks.js';
import { commentsMap } from './comments.js';
import { sceneSecs } from './scenes.js';
import { lintDigest, lintErrors, type DigestIssue } from './lint.js';
import { renderDigestHtml } from './render-html.js';
import { renderDigestMarkdown, renderExtensionMarkdown } from './render-md.js';
import { findReport, reportKey } from './reports.js';
import { parseDigest, type Digest, type Transcript } from './schema.js';
import { DigestStore } from './store.js';
import { templateMap, type DigestTemplate } from './templates.js';

export interface RenderFilesOptions {
  repoRoot: string;
  inlineFrames?: boolean;
  /** 아는 템플릿. lint가 확장의 블록을 대조하고 뷰어의 "+ 더 만들기" 메뉴가 이 목록을 띄운다 */
  templates?: DigestTemplate[];
}

export interface RenderFilesResult {
  slug: string;
  htmlPath: string;
  mdPath: string;
  warnings: string[];
}

/** 렌더할 파일을 못 읽었다. code는 ges_digest validate가 내는 코드와 같다 */
export class DigestLoadError extends Error {
  constructor(
    readonly code:
      | 'TRANSCRIPT_NOT_FOUND'
      | 'TRANSCRIPT_INVALID'
      | 'DIGEST_NOT_FOUND'
      | 'DIGEST_NOT_JSON'
      | 'INVALID_DIGEST'
      | 'REPORT_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'DigestLoadError';
  }
}

/** lint 오류가 남아 렌더를 막았다. 호출하는 쪽이 오류 전체를 구조로 받게 issues를 싣는다 */
export class DigestLintError extends Error {
  constructor(readonly issues: DigestIssue[]) {
    super(
      `validate 오류 ${issues.length}개가 남아 있어 렌더하지 않았어요.\n` +
        issues.map((i) => `${i.code} ${i.path}: ${i.message}`).join('\n'),
    );
    this.name = 'DigestLintError';
  }
}

/** lint 오류가 남은 요약은 출처가 엉뚱한 문장을 가리킬 수 있어 렌더하지 않는다 */
export function loadForRender(
  store: DigestStore,
  slug: string,
  templates?: DigestTemplate[],
): { transcript: Transcript; digest: Digest } {
  const t = store.readTranscript(slug);
  if (!t.ok) throw new DigestLoadError(t.code, t.message);
  const raw = store.readDigestFile(slug);
  if (raw.kind === 'missing') {
    throw new DigestLoadError(
      'DIGEST_NOT_FOUND',
      `digest.json이 없어요. 먼저 요약을 써 주세요: ${slug}`,
    );
  }
  if (raw.kind === 'invalid-json') {
    throw new DigestLoadError(
      'DIGEST_NOT_JSON',
      `digest.json을 JSON으로 못 읽었어요: ${raw.message}`,
    );
  }
  const parsed = parseDigest(raw.value);
  if (!parsed.ok) throw new DigestLoadError('INVALID_DIGEST', parsed.error.message);
  const errors = lintErrors(
    lintDigest(parsed.value, t.transcript, {
      templates: templates ? templateMap(templates) : undefined,
      // 댓글이나 후보 장면 파일을 나중에 지웠거나 깨졌어도 이미 합친 리포트는 그린다.
      // 있을 때만 대조하고 없을 때 막는 일은 merge와 validate가 맡는다
      comments: commentsMap(store, slug) ?? undefined,
      scenes: sceneSecs(store, slug) ?? undefined,
    }),
  );
  if (errors.length > 0) throw new DigestLintError(errors);
  return { transcript: t.transcript, digest: parsed.value };
}

/** digest.html과 digest.md를 한 번에 쓴다. 둘 다 같은 digest.json에서 나온다 */
export function renderToFiles(slug: string, opts: RenderFilesOptions): RenderFilesResult {
  const store = new DigestStore(opts.repoRoot);
  const { transcript, digest } = loadForRender(store, slug, opts.templates);
  const framesDir = store.framesDir(slug);
  const frameExists = (file: string) => existsSync(join(framesDir, file));
  const { html, warnings } = renderDigestHtml(digest, transcript, {
    frameExists,
    inlineFrames: opts.inlineFrames,
    templates: opts.templates,
    loadFrame: (file) => (frameExists(file) ? readFileSync(join(framesDir, file)) : null),
  });
  return {
    slug,
    htmlPath: store.saveHtml(slug, html),
    mdPath: store.saveMd(slug, renderDigestMarkdown(digest, transcript, { frameExists })),
    warnings,
  };
}

/**
 * 마크다운만 원하는 자리에 쓴다. out이 없으면 저장 폴더에 쓴다.
 * 첫 리포트는 digest.md, 다른 리포트와 확장은 digest.<key>.md다. render가 digest.md를 덮어쓰니 이름을 나눈다.
 * 확장 키에는 늘 .이 들어가고 리포트 키에는 없어서 report 하나로 둘 다 받는다
 */
export function exportMarkdown(
  slug: string,
  opts: { repoRoot: string; out?: string; report?: string },
): { slug: string; mdPath: string } {
  const store = new DigestStore(opts.repoRoot);
  const { transcript, digest } = loadForRender(store, slug);
  const ext = opts.report
    ? digest.extensions.find((x) => extensionKey(x) === opts.report)
    : undefined;
  if (ext) {
    const md = renderExtensionMarkdown(ext, transcript);
    const mdPath = opts.out
      ? resolve(opts.out)
      : join(store.dir(slug), `digest.${extensionKey(ext)}.md`);
    mkdirSync(dirname(mdPath), { recursive: true });
    writeFileSync(mdPath, md);
    return { slug, mdPath };
  }
  const report = opts.report ? findReport(digest, opts.report) : digest.reports[0]!;
  if (!report) {
    const keys = [
      ...digest.reports.map((r) => reportKey(r.options)),
      ...digest.extensions.map(extensionKey),
    ];
    throw new DigestLoadError(
      'REPORT_NOT_FOUND',
      `리포트 ${opts.report}가 없어요. 있는 리포트: ${keys.join(', ')}`,
    );
  }
  const framesDir = store.framesDir(slug);
  const frameExists = (file: string) => existsSync(join(framesDir, file));
  if (!opts.out) {
    const md = renderDigestMarkdown(digest, transcript, { frameExists, report });
    if (report === digest.reports[0]) return { slug, mdPath: store.saveMd(slug, md) };
    const mdPath = join(store.dir(slug), `digest.${reportKey(report.options)}.md`);
    writeFileSync(mdPath, md);
    return { slug, mdPath };
  }
  const mdPath = resolve(opts.out);
  // 다른 폴더에 쓰면 frames/ 상대 경로가 깨지니 그 파일 기준으로 다시 잡는다
  const framesHref = relative(dirname(mdPath), framesDir)
    .split(sep)
    .map(encodeURIComponent)
    .join('/');
  const md = renderDigestMarkdown(digest, transcript, { frameExists, framesHref, report });
  mkdirSync(dirname(mdPath), { recursive: true });
  writeFileSync(mdPath, md);
  return { slug, mdPath };
}
