import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeJsonAtomic } from '../core/json-file.js';
import {
  LENS_SOURCE_SCHEMA_VERSION,
  lensSourcePath,
  lensSourceSchema,
  type LensSource,
} from '../digest/lens-source.js';
import { moveStaleDigest } from '../digest/ingest.js';
import { parseTranscript, type LensKind, type Transcript } from '../digest/schema.js';
import { DigestStore, isValidSlug, slugFromMeta } from '../digest/store.js';
import { CommandError, runCommand, type RunCommand } from '../digest/ytdlp.js';
import { AUDIO_EXTS, detectLensKind, pdfUrlOf } from './kind.js';
import { PDF_EXTRACT_PY } from './pdf-extract-py.js';
import { audioExt, pickEpisode, PODCAST_WHISPER_PY } from './podcast.js';
import { WEB_EXTRACT_PY } from './web-extract-py.js';
import { lensPython, missingModuleHint } from './python.js';

export interface LensIngestOptions {
  repoRoot: string;
  slug?: string;
  /** 판단을 건너뛰고 이 종류로 읽는다 */
  kind?: LensKind;
  run?: RunCommand;
  fetchImpl?: typeof fetch;
  python?: string;
  /** 팟캐스트 피드에서 고를 에피소드. 0이 최신이다 */
  episode?: number;
  /** 팟캐스트 받아쓰기 모델. 기본 small */
  whisperModel?: string;
}

export interface LensIngestResult {
  slug: string;
  kind: LensKind;
  title: string;
  transcriptPath: string;
  sourcePath: string;
  units: number;
  pages: number;
  tables: Array<{ id: string; grid: 'ok' | 'loose' }>;
  figures: Array<{ id: string; cropped: boolean }>;
  warnings: string[];
  /** 문단 번호가 바뀌어 옛 digest.json을 옮긴 자리 */
  staleDigest?: { movedTo: string; previousSegmentCount: number | null };
}

/** 추출 스크립트가 stdout 마지막 줄로 내는 꼴 */
interface PdfExtract {
  title: string;
  pageCount: number;
  pages: LensSource['pages'];
  units: Array<{
    i: number;
    page: number;
    role: 'para' | 'heading' | 'caption';
    ref?: string;
    text: string;
    rects: Array<{ page: number; bbox: [number, number, number, number] }>;
  }>;
  tables: LensSource['tables'];
  figures: LensSource['figures'];
}

const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const EXTRACT_TIMEOUT_MS = 600_000;

export const shortHash = (s: string): string =>
  createHash('sha256').update(s).digest('hex').slice(0, 8);

/** 한글이 본문 글자의 20%를 넘으면 ko, 아니면 en으로 본다. 요약 언어가 아니라 원문 언어다 */
export function guessLang(texts: string[]): string {
  const all = texts.join(' ');
  const letters = all.match(/[\p{L}]/gu)?.length ?? 0;
  const hangul = all.match(/[가-힣]/g)?.length ?? 0;
  return letters > 0 && hangul / letters > 0.2 ? 'ko' : 'en';
}

/** 주소를 받아 파일로 저장한다. 크기 상한을 넘으면 멈춘다 */
export async function download(
  url: string,
  dest: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ contentType: string }> {
  const res = await fetchImpl(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: { 'User-Agent': 'gestalt-lens/1.0 (+https://github.com/tienne/gestalt)' },
  });
  if (!res.ok) throw new Error(`내려받기 실패(${res.status}): ${url}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_DOWNLOAD_BYTES) throw new Error(`파일이 300MB를 넘어요: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error(`파일이 300MB를 넘어요: ${url}`);
  writeFileSync(dest, buf);
  return { contentType: res.headers.get('content-type') ?? '' };
}

async function runPython(
  run: RunCommand,
  python: string,
  script: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  try {
    // -I는 cwd와 사용자 site 경로를 import 경로에서 뺀다. 남의 레포 안 같은 이름 모듈이 대신 돌지 않게 한다
    const { stdout } = await run(python, ['-I', '-c', script, ...args], { cwd, timeoutMs });
    return stdout;
  } catch (e) {
    const hint = e instanceof CommandError ? missingModuleHint(e.stderr) : null;
    if (hint) throw new Error(hint, { cause: e });
    throw e;
  }
}

function lastJsonLine<T>(stdout: string, what: string): T {
  const last = stdout.trim().split('\n').pop() ?? '';
  try {
    return JSON.parse(last) as T;
  } catch {
    throw new Error(`${what} 결과를 JSON으로 못 읽었어요: ${stdout.trim().slice(0, 200)}`);
  }
}

/** 쪽 그림과 크롭 폴더를 새로 갈아 끼운다. 다시 수집할 때 지난 크롭이 남지 않게 한다 */
function replaceAssets(from: string, to: string, dirs: string[]): void {
  for (const d of dirs) {
    rmSync(join(to, d), { recursive: true, force: true });
    if (existsSync(join(from, d))) cpSync(join(from, d), join(to, d), { recursive: true });
  }
}

function saveAll(
  store: DigestStore,
  transcript: unknown,
  source: unknown,
): {
  transcriptPath: string;
  sourcePath: string;
  transcript: Transcript;
  source: LensSource;
  staleDigest?: LensIngestResult['staleDigest'];
} {
  const t = parseTranscript(transcript);
  if (!t.ok) throw t.error;
  const s = lensSourceSchema.safeParse(source);
  if (!s.success) {
    throw new Error(
      `source.json 형식 오류: ${s.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const staleDigest = moveStaleDigest(store, t.value);
  const transcriptPath = store.saveTranscript(t.value);
  const sourcePath = lensSourcePath(store, t.value.slug);
  writeJsonAtomic(sourcePath, s.data);
  return {
    transcriptPath,
    sourcePath,
    transcript: t.value,
    source: s.data,
    ...(staleDigest ? { staleDigest } : {}),
  };
}

async function ingestPdf(
  input: string,
  opts: LensIngestOptions,
  work: string,
): Promise<LensIngestResult> {
  const run = opts.run ?? runCommand;
  const remote = /^https?:\/\//i.test(input);
  const url = remote ? pdfUrlOf(input) : pathToFileURL(resolve(input)).href;
  const pdfPath = join(work, 'source.pdf');
  if (remote) {
    await download(url, pdfPath, opts.fetchImpl);
  } else {
    if (!existsSync(resolve(input))) throw new Error(`파일이 없어요: ${input}`);
    cpSync(resolve(input), pdfPath);
  }
  if (readFileSync(pdfPath).subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error(`PDF가 아니에요. 웹 글이면 --kind web으로 다시 돌려 주세요: ${input}`);
  }
  const out = join(work, 'out');
  mkdirSync(out, { recursive: true });
  const stdout = await runPython(
    run,
    opts.python ?? lensPython(),
    PDF_EXTRACT_PY,
    [pdfPath, out],
    work,
    EXTRACT_TIMEOUT_MS,
  );
  const x = lastJsonLine<PdfExtract>(stdout, 'PDF 추출');
  if (x.units.length === 0) {
    throw new Error(
      'PDF에서 글자를 하나도 못 뽑았어요. 스캔한 PDF면 OCR을 거친 파일로 다시 돌려 주세요.',
    );
  }
  const firstHeading = x.units.find((u) => u.page === 1 && u.role === 'heading')?.text;
  const title = (x.title || firstHeading || basename(input, '.pdf')).trim().slice(0, 200);
  const slug = opts.slug ?? slugFromMeta(shortHash(url), title);
  if (!isValidSlug(slug)) throw new Error(`slug가 올바르지 않아요: ${slug}`);
  const store = new DigestStore(opts.repoRoot);
  const dir = store.dir(slug);
  mkdirSync(join(dir, 'cache'), { recursive: true });
  replaceAssets(out, dir, ['pages', 'figures', 'tables']);
  cpSync(pdfPath, join(dir, 'cache', 'source.pdf'));

  const warnings: string[] = [];
  const loose = x.tables.filter((t) => t.grid === 'loose').map((t) => t.id);
  if (loose.length > 0) {
    warnings.push(`칸 경계를 못 믿을 표: ${loose.join(', ')}. 뷰어가 원문 크롭을 앞에 둬요`);
  }
  const noCrop = x.figures.filter((f) => !f.image).map((f) => f.id);
  if (noCrop.length > 0) warnings.push(`그림 자리를 못 찾은 그림: ${noCrop.join(', ')}`);

  const saved = saveAll(
    store,
    {
      slug,
      meta: {
        source: 'pdf',
        url,
        title,
        durationSec: 0,
        lang: guessLang(x.units.map((u) => u.text)),
        captionSource: 'text',
      },
      segments: x.units.map((u) => ({
        i: u.i,
        startSec: 0,
        text: u.text,
        page: u.page,
        role: u.role,
        ...(u.ref ? { ref: u.ref } : {}),
        rects: u.rects,
      })),
    },
    {
      schemaVersion: LENS_SOURCE_SCHEMA_VERSION,
      slug,
      kind: 'pdf',
      pages: x.pages,
      tables: x.tables,
      figures: x.figures,
    },
  );
  return {
    slug,
    kind: 'pdf',
    title,
    transcriptPath: saved.transcriptPath,
    sourcePath: saved.sourcePath,
    units: saved.transcript.segments.length,
    pages: saved.source.pages.length,
    tables: saved.source.tables.map((t) => ({ id: t.id, grid: t.grid })),
    figures: saved.source.figures.map((f) => ({ id: f.id, cropped: Boolean(f.image) })),
    warnings,
    ...(saved.staleDigest ? { staleDigest: saved.staleDigest } : {}),
  };
}

interface WebExtract {
  title: string;
  author: string;
  date: string;
  site: string;
  lang: string;
  units: Array<{
    i: number;
    role: 'para' | 'heading' | 'caption';
    ref?: string;
    text: string;
    /** trafilatura가 버린 링크 목록을 원문 HTML에서 되살린 문단 */
    rescued?: boolean;
  }>;
  tables: LensSource['tables'];
}

const isoDate = (s: string | undefined): string | undefined => {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

async function ingestWeb(
  input: string,
  opts: LensIngestOptions,
  work: string,
): Promise<LensIngestResult> {
  const run = opts.run ?? runCommand;
  const remote = /^https?:\/\//i.test(input);
  const url = remote ? input : pathToFileURL(resolve(input)).href;
  const htmlPath = join(work, 'page.html');
  if (remote) {
    const { contentType } = await download(url, htmlPath, opts.fetchImpl);
    if (/application\/pdf/i.test(contentType)) {
      throw new Error(`PDF를 돌려주는 주소예요. --kind pdf로 다시 돌려 주세요: ${input}`);
    }
  } else {
    if (!existsSync(resolve(input))) throw new Error(`파일이 없어요: ${input}`);
    cpSync(resolve(input), htmlPath);
  }
  const stdout = await runPython(
    run,
    opts.python ?? lensPython(),
    WEB_EXTRACT_PY,
    [htmlPath, remote ? url : ''],
    work,
    EXTRACT_TIMEOUT_MS,
  );
  const x = lastJsonLine<WebExtract>(stdout, '웹 글 추출');
  if (x.units.length === 0) {
    throw new Error(
      '본문을 못 찾았어요. 로그인이 필요한 페이지거나 스크립트로 그리는 페이지일 수 있어요.',
    );
  }
  const title = (x.title || x.units.find((u) => u.role === 'heading')?.text || hostOf(url) || 'web')
    .trim()
    .slice(0, 200);
  const slug = opts.slug ?? slugFromMeta(shortHash(url), title);
  if (!isValidSlug(slug)) throw new Error(`slug가 올바르지 않아요: ${slug}`);
  const store = new DigestStore(opts.repoRoot);
  mkdirSync(join(store.dir(slug), 'cache'), { recursive: true });
  cpSync(htmlPath, join(store.dir(slug), 'cache', 'page.html'));
  const rescued = x.units.filter((u) => u.rescued).length;
  const by = x.author || x.site || hostOf(url);
  const published = isoDate(x.date);
  const saved = saveAll(
    store,
    {
      slug,
      meta: {
        source: 'web',
        url,
        title,
        ...(by ? { channel: by } : {}),
        ...(published ? { publishedAt: published } : {}),
        durationSec: 0,
        lang: /^[a-z]{2}$/i.test(x.lang)
          ? x.lang.toLowerCase()
          : guessLang(x.units.map((u) => u.text)),
        captionSource: 'text',
      },
      segments: x.units.map((u) => ({
        i: u.i,
        startSec: 0,
        text: u.text,
        role: u.role,
        ...(u.ref ? { ref: u.ref } : {}),
      })),
    },
    { schemaVersion: LENS_SOURCE_SCHEMA_VERSION, slug, kind: 'web', tables: x.tables },
  );
  return {
    slug,
    kind: 'web',
    title,
    transcriptPath: saved.transcriptPath,
    sourcePath: saved.sourcePath,
    units: saved.transcript.segments.length,
    pages: 0,
    tables: saved.source.tables.map((t) => ({ id: t.id, grid: t.grid })),
    figures: [],
    warnings: rescued > 0 ? [`링크만으로 된 목록 ${rescued}개를 원문 HTML에서 되살렸어요`] : [],
    ...(saved.staleDigest ? { staleDigest: saved.staleDigest } : {}),
  };
}

interface WhisperOut {
  language: string;
  duration: number;
  segments: Array<{ start: number; text: string }>;
}

export const DEFAULT_PODCAST_MODEL = 'small';

/**
 * 팟캐스트는 오디오를 받아 faster-whisper로 받아쓴다. 화자 구분은 하지 않는다.
 * pyannote가 필요한데 Hugging Face 토큰과 torch를 따로 깔아야 해서 출처는 시각으로만 단다
 */
async function ingestPodcast(
  input: string,
  opts: LensIngestOptions,
  work: string,
): Promise<LensIngestResult> {
  const run = opts.run ?? runCommand;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const remote = /^https?:\/\//i.test(input);
  let audioUrl = input;
  let title = '';
  let show = '';
  let pubDate: string | undefined;
  // 오디오 확장자로 끝나는 주소는 바로 받고 나머지 주소는 피드로 읽는다
  const isAudioUrl = remote && AUDIO_EXTS.includes(extname(new URL(input).pathname).toLowerCase());
  if (remote && !isAudioUrl) {
    const res = await fetchImpl(input, {
      redirect: 'follow',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`피드를 못 받았어요(${res.status}): ${input}`);
    const ep = pickEpisode(await res.text(), opts.episode ?? 0);
    audioUrl = ep.audioUrl;
    title = ep.title;
    show = ep.show;
    pubDate = ep.pubDate;
  }
  const ext = audioExt(remote ? audioUrl : input);
  const audioPath = join(work, `audio${ext}`);
  if (remote) await download(audioUrl, audioPath, fetchImpl);
  else {
    if (!existsSync(resolve(input))) throw new Error(`파일이 없어요: ${input}`);
    cpSync(resolve(input), audioPath);
  }
  const model = opts.whisperModel ?? DEFAULT_PODCAST_MODEL;
  const stdout = await runPython(
    run,
    opts.python ?? lensPython(),
    PODCAST_WHISPER_PY,
    [audioPath, model, ''],
    work,
    // CPU로 돌리면 오디오 길이보다 오래 걸릴 수 있다. 멈춘 프로세스만 끊을 만큼 넉넉히 둔다
    3 * 60 * 60 * 1000,
  );
  const w = lastJsonLine<WhisperOut>(stdout, '받아쓰기');
  if (w.segments.length === 0)
    throw new Error('받아쓴 문장이 없어요. 말소리가 없는 오디오일 수 있어요.');
  const name = title || basename(input).replace(/\.[^.]+$/, '');
  const slug = opts.slug ?? slugFromMeta(shortHash(audioUrl), name);
  if (!isValidSlug(slug)) throw new Error(`slug가 올바르지 않아요: ${slug}`);
  const store = new DigestStore(opts.repoRoot);
  const cacheDir = join(store.dir(slug), 'cache');
  mkdirSync(cacheDir, { recursive: true });
  const kept = join(cacheDir, `audio${ext}`);
  cpSync(audioPath, kept);
  let prev = 0;
  const published = isoDate(pubDate);
  const saved = saveAll(
    store,
    {
      slug,
      meta: {
        source: 'podcast',
        url: remote ? input : pathToFileURL(resolve(input)).href,
        media: pathToFileURL(kept).href,
        title: name.slice(0, 200) || 'podcast',
        ...(show ? { channel: show } : {}),
        ...(published ? { publishedAt: published } : {}),
        durationSec: Math.round(w.duration * 100) / 100,
        lang: w.language || 'und',
        captionSource: 'whisper',
      },
      segments: w.segments.map((s, i) => {
        // VAD로 잘린 조각이 앞 시각보다 이르게 나오는 일이 있어 앞 문장에 맞춘다
        prev = Math.max(prev, Math.round(s.start * 100) / 100);
        return { i, startSec: prev, text: s.text };
      }),
    },
    { schemaVersion: LENS_SOURCE_SCHEMA_VERSION, slug, kind: 'podcast' },
  );
  return {
    slug,
    kind: 'podcast',
    title: saved.transcript.meta.title,
    transcriptPath: saved.transcriptPath,
    sourcePath: saved.sourcePath,
    units: saved.transcript.segments.length,
    pages: 0,
    tables: [],
    figures: [],
    warnings: [`화자 구분 없이 시각만 출처로 달았어요(faster-whisper ${model})`],
    ...(saved.staleDigest ? { staleDigest: saved.staleDigest } : {}),
  };
}

/**
 * 읽을거리 하나를 문단 단위 원문으로 받아 `.gestalt/digest/<slug>/`에 둔다.
 * transcript.json의 문장 자리에 문단이 들어가서 digest의 merge와 render, serve를 그대로 쓴다
 */
export async function ingestLens(
  input: string,
  opts: LensIngestOptions,
): Promise<LensIngestResult> {
  const detected = opts.kind ?? detectLensKind(input);
  if (detected === 'youtube') {
    throw new Error('유튜브 영상은 렌즈가 아니라 video-digest로 요약해요: gestalt digest ingest');
  }
  if (detected === null) {
    throw new Error(`자료 종류를 모르겠어요. --kind pdf|web|podcast로 알려 주세요: ${input}`);
  }
  // 외부 명령은 레포 밖 새 임시 폴더에서 돌린다. 파이썬이 cwd의 모듈을 먼저 읽지 않게 하려는 것이다
  const work = mkdtempSync(join(tmpdir(), 'gestalt-lens-'));
  try {
    if (detected === 'pdf') return await ingestPdf(input, opts, work);
    if (detected === 'web') return await ingestWeb(input, opts, work);
    return await ingestPodcast(input, opts, work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
