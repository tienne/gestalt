import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../../core/config.js';
import { COMMENTS_DEFAULT_MAX, commentsMap, fetchComments } from '../../digest/comments.js';
import { extractFrames } from '../../digest/frames.js';
import { ingest } from '../../digest/ingest.js';
import { lintDigest, lintErrors } from '../../digest/lint.js';
import { pickScenes, sceneSecs } from '../../digest/scenes.js';
import { mergeExtension, mergeReport } from '../../digest/merge.js';
import { runOcr, type OcrResult } from '../../digest/ocr.js';
import { exportMarkdown, renderToFiles, type RenderFilesResult } from '../../digest/render.js';
import { parseDigest } from '../../digest/schema.js';
import { parseRangeArg, sliceFileName, sliceTranscript } from '../../digest/slice.js';
import { DigestServer, findDigestPort, openInBrowser } from '../../digest/server.js';
import { DigestStore } from '../../digest/store.js';
import { loadDigestTemplates, templateMap, type TemplateLoad } from '../../digest/templates.js';
import { applyTranslation } from '../../digest/translate.js';

/**
 * `gestalt digest` — 영상 요약 CLI.
 *
 * yt-dlp와 ffmpeg, whisper를 부르는 셸 작업이라 MCP action이 아니라 여기 둔다.
 * research가 slide-extract.mjs를 MCP로 올리지 않은 것과 같은 이유다.
 */

export interface DigestCommonOptions {
  repoRoot?: string;
  json?: boolean;
}

const rootOf = (opts: DigestCommonOptions) => resolve(opts.repoRoot ?? process.cwd());

function emit(value: unknown, json: boolean | undefined, human: () => void): void {
  if (json) console.log(JSON.stringify(value, null, 2));
  else human();
}

function fail(e: unknown): never {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

// 깨진 템플릿 하나가 명령 전체를 막지 않게 경고만 stderr로 알린다. --json이면 결과에 싣는다
function templatesOf(opts: DigestCommonOptions): TemplateLoad {
  const load = loadDigestTemplates(rootOf(opts), loadConfig({}, { skipDotEnv: true }).skillsDir);
  if (!opts.json) for (const w of load.warnings) console.error(`템플릿 경고: ${w}`);
  return load;
}

const mmss = (sec: number) =>
  `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

export async function digestIngestCommand(
  input: string,
  opts: DigestCommonOptions & {
    lang?: string;
    slug?: string;
    whisper?: boolean;
    whisperModel?: string;
    ocr?: boolean;
    ocrInterval?: string;
  },
): Promise<void> {
  try {
    // 간격이 틀렸으면 수집을 다 마친 뒤가 아니라 시작하기 전에 알린다
    const intervalSec = opts.ocr ? parseInterval(opts.ocrInterval) : undefined;
    const r = await ingest(input, {
      repoRoot: rootOf(opts),
      lang: opts.lang,
      slug: opts.slug,
      whisper: opts.whisper,
      whisperModel: opts.whisperModel,
    });
    // OCR이 실패해도 수집 결과는 남아 있어서 slug와 경로를 출력하고 종료 코드로만 알린다
    let ocr: OcrResult | { error: string } | undefined;
    if (opts.ocr) {
      try {
        ocr = await runOcr(r.slug, { repoRoot: rootOf(opts), intervalSec });
      } catch (e) {
        ocr = { error: (e as Error).message };
        process.exitCode = 1;
      }
    }
    emit(ocr ? { ...r, ocr } : r, opts.json, () => {
      console.log(`${r.title} (${mmss(r.durationSec)})`);
      console.log(`자막: ${r.captionSource} [${r.captionTrack}] → 문장 ${r.segmentCount}개`);
      console.log(`slug: ${r.slug}`);
      console.log(`저장: ${r.transcriptPath}`);
      if (r.staleDigest) {
        const before = r.staleDigest.previousSegmentCount ?? '?';
        console.log(
          `문장 번호가 바뀌어 기존 요약을 옮겼어요(문장 ${before}개 → ${r.segmentCount}개): ${r.staleDigest.movedTo}`,
        );
      }
      if (ocr && 'error' in ocr) console.log(`화면 글자를 못 읽었어요: ${ocr.error}`);
      else if (ocr) printOcr(ocr);
    });
  } catch (e) {
    fail(e);
  }
}

export async function digestCommentsCommand(
  slug: string,
  opts: DigestCommonOptions & { max?: string },
): Promise<void> {
  try {
    const max = opts.max === undefined ? COMMENTS_DEFAULT_MAX : Number(opts.max);
    const r = await fetchComments(slug, { repoRoot: rootOf(opts), max });
    emit(r, opts.json, () => {
      const total = r.commentCount === null ? '' : ` (영상 전체 ${r.commentCount}개)`;
      console.log(`댓글 ${r.fetched}개를 받았어요${total}. 작성자 정보는 저장하지 않았어요.`);
      console.log(`저장: ${r.path}`);
    });
  } catch (e) {
    fail(e);
  }
}

export async function digestFramesCommand(
  slug: string,
  opts: DigestCommonOptions & { force?: boolean },
): Promise<void> {
  try {
    const r = await extractFrames(slug, { repoRoot: rootOf(opts), force: opts.force });
    emit(r, opts.json, () => {
      console.log(`프레임 ${r.total}장 중 ${r.extracted}장 새로 뽑음, ${r.skipped}장은 있던 것`);
      if (r.missing.length > 0) console.log(`못 뽑은 시각: ${r.missing.map(mmss).join(', ')}`);
      const { shots } = r;
      if (shots.total > 0) {
        console.log(
          `장면 ${shots.total}장 중 ${shots.extracted}장 새로 뽑음(720p ${shots.hires}장), ${shots.skipped}장은 있던 것`,
        );
        if (shots.missing.length > 0) {
          console.log(`못 뽑은 장면: ${shots.missing.map(mmss).join(', ')}`);
        }
        if (shots.extracted > shots.hires) {
          // 사유 없이 저화질로 뽑았으면 720p 영상은 멀쩡한데 그 시각에서 파일이 안 생긴 것이다
          const why = shots.hiresFailure ?? '720p 영상에서 그 시각을 못 뽑았어요';
          console.log(
            `${why}. ${shots.extracted - shots.hires}장은 낮은 화질로 뽑았어요. 720p로 다시 뽑으려면 --force를 붙여 돌려 주세요.`,
          );
        }
      }
      console.log(`저장: ${r.framesDir}`);
    });
  } catch (e) {
    fail(e);
  }
}

export async function digestScenesCommand(slug: string, opts: DigestCommonOptions): Promise<void> {
  try {
    const r = await pickScenes(slug, { repoRoot: rootOf(opts) });
    emit(r, opts.json, () => {
      const how = r.source === 'ocr' ? '화면 글자(ocr.json)' : 'ffmpeg 장면 전환';
      console.log(`후보 장면 ${r.items}개 (${how})`);
      if (r.truncated) {
        console.log(`후보가 ${r.total}개라 영상 전체에서 고르게 ${r.items}개만 남겼어요.`);
      }
      console.log(`저장: ${r.path}`);
    });
  } catch (e) {
    fail(e);
  }
}

function parseInterval(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value.trim())) throw new Error(`OCR 간격은 초 단위 정수여야 해요: ${value}`);
  return Number(value);
}

export function printOcr(r: OcrResult): void {
  if (r.requestedIntervalSec !== undefined) {
    console.log(
      `프레임이 너무 많아 간격을 ${r.requestedIntervalSec}초에서 ${r.intervalSec}초로 넓혔어요`,
    );
  }
  console.log(`화면 글자: 프레임 ${r.frames}장(${r.intervalSec}초 간격, ${r.lang}) → ${r.items}개`);
  if (r.truncated > 0) console.log(`글자가 길어 줄 단위로 자른 항목: ${r.truncated}개`);
  if (r.loggedTimes !== undefined) {
    console.log(
      `프레임 ${r.frames}장 중 시각 로그가 ${r.loggedTimes}개뿐이라 나머지는 간격으로 시각을 어림했어요`,
    );
  }
  console.log(`저장: ${r.path}`);
}

export async function digestOcrCommand(
  slug: string,
  opts: DigestCommonOptions & { interval?: string; lang?: string },
): Promise<void> {
  try {
    const r = await runOcr(slug, {
      repoRoot: rootOf(opts),
      intervalSec: parseInterval(opts.interval),
      lang: opts.lang,
    });
    emit(r, opts.json, () => printOcr(r));
  } catch (e) {
    fail(e);
  }
}

export function digestValidateCommand(slug: string, opts: DigestCommonOptions): void {
  try {
    const store = new DigestStore(rootOf(opts));
    const t = store.readTranscript(slug);
    if (!t.ok) throw new Error(t.message);
    const transcript = t.transcript;
    const raw = store.readDigestFile(slug);
    if (raw.kind !== 'ok') {
      throw new Error(raw.kind === 'missing' ? `digest.json이 없어요: ${slug}` : raw.message);
    }
    const parsed = parseDigest(raw.value);
    if (!parsed.ok) throw parsed.error;
    const { templates } = templatesOf(opts);
    const issues = lintDigest(parsed.value, transcript, {
      templates: templateMap(templates),
      comments: commentsMap(store, slug) ?? undefined,
      scenes: sceneSecs(store, slug),
    });
    const errors = lintErrors(issues);
    emit({ slug, ok: errors.length === 0, issues }, opts.json, () => {
      for (const i of issues) console.log(`${i.severity} ${i.code} ${i.path}: ${i.message}`);
      console.log(
        errors.length === 0 ? `통과 (경고 ${issues.length}개)` : `오류 ${errors.length}개`,
      );
    });
    if (errors.length > 0) process.exitCode = 1;
  } catch (e) {
    fail(e);
  }
}

// serve도 render와 같은 템플릿 목록으로 그려야 '+ 더 만들기' 메뉴가 사라지지 않는다
export function renderDigestFiles(
  slug: string,
  opts: DigestCommonOptions & { inlineFrames?: boolean },
): RenderFilesResult {
  return renderToFiles(slug, {
    repoRoot: rootOf(opts),
    inlineFrames: opts.inlineFrames,
    templates: templatesOf(opts).templates,
  });
}

export function digestRenderCommand(
  slug: string,
  opts: DigestCommonOptions & { inlineFrames?: boolean },
): void {
  try {
    const r = renderDigestFiles(slug, opts);
    emit(r, opts.json, () => {
      console.log(`HTML: ${r.htmlPath}`);
      console.log(`마크다운: ${r.mdPath}`);
      for (const w of r.warnings) console.log(`경고: ${w}`);
    });
  } catch (e) {
    fail(e);
  }
}

export function digestExportCommand(
  slug: string,
  opts: DigestCommonOptions & { md?: boolean; out?: string; report?: string },
): void {
  try {
    if (!opts.md) throw new Error('지금은 --md 내보내기만 있어요.');
    const r = exportMarkdown(slug, { repoRoot: rootOf(opts), out: opts.out, report: opts.report });
    emit(r, opts.json, () => console.log(`마크다운: ${r.mdPath}`));
  } catch (e) {
    fail(e);
  }
}

export function digestMergeCommand(
  slug: string,
  reportFile: string,
  opts: DigestCommonOptions & { extension?: boolean },
): void {
  try {
    let input: unknown;
    try {
      input = JSON.parse(readFileSync(resolve(reportFile), 'utf-8'));
    } catch (e) {
      throw new Error(`리포트 파일을 못 읽었어요: ${reportFile}`, { cause: e });
    }
    const r = opts.extension
      ? mergeExtension(rootOf(opts), slug, input, {
          templates: templateMap(templatesOf(opts).templates),
        })
      : mergeReport(rootOf(opts), slug, input);
    emit(r, opts.json, () => {
      for (const i of r.issues) console.log(`${i.severity} ${i.code} ${i.path}: ${i.message}`);
      if (r.saved) {
        console.log(`${r.replaced ? '바꿔 끼움' : '추가'}: ${r.key} → ${r.digestPath}`);
      } else {
        console.log(`lint 오류가 있어 저장하지 않았어요: ${r.key}`);
      }
    });
    if (!r.saved) process.exitCode = 1;
  } catch (e) {
    fail(e);
  }
}

export function digestTemplatesCommand(opts: DigestCommonOptions): void {
  try {
    const load = templatesOf(opts);
    const list = load.templates.map(({ prompt: _prompt, ...t }) => t);
    emit({ templates: list, warnings: load.warnings }, opts.json, () => {
      for (const t of list) {
        const tag = t.overridesBuiltin
          ? ' (사용자, 기본 템플릿을 대신함)'
          : t.source === 'user'
            ? ' (사용자)'
            : '';
        console.log(`${t.id}${tag}  ${t.title} — ${t.description}`);
        console.log(
          `  블록: ${t.blocks.join(', ')}${t.needs.length ? ` / 먼저 받을 자료: ${t.needs.join(', ')}` : ''}`,
        );
      }
      if (list.length === 0) console.log('템플릿이 없어요.');
    });
  } catch (e) {
    fail(e);
  }
}

/** 요약 에이전트에게 넘길 템플릿 지시를 출력한다. --json이면 frontmatter까지 함께 준다 */
export function digestTemplateCommand(id: string, opts: DigestCommonOptions): void {
  try {
    const t = templatesOf(opts).templates.find((x) => x.id === id);
    if (!t) throw new Error(`템플릿 ${id}가 없어요. gestalt digest templates로 목록을 보세요.`);
    emit(t, opts.json, () => console.log(t.prompt));
  } catch (e) {
    fail(e);
  }
}

export function digestSliceCommand(
  slug: string,
  opts: DigestCommonOptions & { range: string },
): void {
  try {
    const store = new DigestStore(rootOf(opts));
    const t = store.readTranscript(slug);
    if (!t.ok) throw new Error(t.message);
    const range = parseRangeArg(opts.range);
    const slice = sliceTranscript(t.transcript, range);
    const path = join(store.dir(slug), sliceFileName(range));
    writeFileSync(path, JSON.stringify(slice, null, 2) + '\n');
    const result = {
      path,
      range: slice.range,
      from: slice.from,
      to: slice.to,
      count: slice.segments.length,
    };
    emit(result, opts.json, () => {
      console.log(
        `구간: ${mmss(range[0])}~${mmss(range[1])} → 문장 ${slice.from}~${slice.to} (${result.count}개)`,
      );
      console.log(`저장: ${path}`);
    });
  } catch (e) {
    fail(e);
  }
}

export function digestTranslateApplyCommand(
  slug: string,
  file: string,
  opts: DigestCommonOptions,
): void {
  try {
    let input: unknown;
    try {
      input = JSON.parse(readFileSync(resolve(file), 'utf-8'));
    } catch (e) {
      throw new Error(`번역 파일을 못 읽었어요: ${file}`, { cause: e });
    }
    const store = new DigestStore(rootOf(opts));
    const t = store.readTranscript(slug);
    if (!t.ok) throw new Error(t.message);
    const r = applyTranslation(t.transcript, input);
    const path = store.saveTranscript(r.transcript);
    const result = {
      path,
      lang: r.transcript.meta.translationLang,
      applied: r.applied,
      unknown: r.unknown,
      missing: r.missing,
    };
    emit(result, opts.json, () => {
      console.log(`번역(${result.lang}) ${r.applied}문장 반영 → ${path}`);
      if (r.unknown.length > 0) console.log(`스크립트에 없는 문장 번호: ${r.unknown.join(', ')}`);
      if (r.missing.length > 0) console.log(`번역이 빠진 문장: ${r.missing.length}개`);
    });
  } catch (e) {
    fail(e);
  }
}

export function parsePort(value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value.trim()) || n < 1 || n > 65535) {
    throw new Error(`포트는 1~65535 정수여야 해요: ${value}`);
  }
  return n;
}

export async function digestServeCommand(
  slug: string,
  opts: DigestCommonOptions & { port?: string; browser?: boolean },
): Promise<void> {
  try {
    const repoRoot = rootOf(opts);
    const r = renderDigestFiles(slug, opts);
    const server = new DigestServer(new DigestStore(repoRoot).root);
    const port = opts.port ? parsePort(opts.port) : await findDigestPort();
    try {
      await server.start(port);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        throw new Error(`${port}번은 이미 쓰는 포트예요. --port를 비우면 빈 곳을 찾아요.`, {
          cause: e,
        });
      }
      throw e;
    }
    const url = `http://127.0.0.1:${server.port}/${slug}/`;
    emit({ ...r, url }, opts.json, () => {
      for (const w of r.warnings) console.log(`경고: ${w}`);
      console.log(`뷰어: ${url}`);
      console.log('끝내려면 Ctrl+C');
    });
    if (opts.browser !== false) await openInBrowser(url);
    const stop = () => {
      void server.stop().finally(() => process.exit(0));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (e) {
    fail(e);
  }
}
