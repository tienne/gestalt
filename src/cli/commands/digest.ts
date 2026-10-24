import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { extractFrames } from '../../digest/frames.js';
import { ingest } from '../../digest/ingest.js';
import { lintDigest, lintErrors } from '../../digest/lint.js';
import { mergeReport } from '../../digest/merge.js';
import { exportMarkdown, renderToFiles } from '../../digest/render.js';
import { parseDigest } from '../../digest/schema.js';
import { parseRangeArg, sliceFileName, sliceTranscript } from '../../digest/slice.js';
import { DigestServer, findDigestPort, openInBrowser } from '../../digest/server.js';
import { DigestStore } from '../../digest/store.js';

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

const mmss = (sec: number) =>
  `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

export async function digestIngestCommand(
  input: string,
  opts: DigestCommonOptions & {
    lang?: string;
    slug?: string;
    whisper?: boolean;
    whisperModel?: string;
  },
): Promise<void> {
  try {
    const r = await ingest(input, {
      repoRoot: rootOf(opts),
      lang: opts.lang,
      slug: opts.slug,
      whisper: opts.whisper,
      whisperModel: opts.whisperModel,
    });
    emit(r, opts.json, () => {
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
      console.log(`저장: ${r.framesDir}`);
    });
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
    const issues = lintDigest(parsed.value, transcript);
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

export function digestRenderCommand(
  slug: string,
  opts: DigestCommonOptions & { inlineFrames?: boolean },
): void {
  try {
    const r = renderToFiles(slug, { repoRoot: rootOf(opts), inlineFrames: opts.inlineFrames });
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
  opts: DigestCommonOptions,
): void {
  try {
    let input: unknown;
    try {
      input = JSON.parse(readFileSync(resolve(reportFile), 'utf-8'));
    } catch (e) {
      throw new Error(`리포트 파일을 못 읽었어요: ${reportFile}`, { cause: e });
    }
    const r = mergeReport(rootOf(opts), slug, input);
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
    const r = renderToFiles(slug, { repoRoot });
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
