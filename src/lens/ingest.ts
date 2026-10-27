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
import { basename, join, resolve } from 'node:path';
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
import { detectLensKind, pdfUrlOf } from './kind.js';
import { PDF_EXTRACT_PY } from './pdf-extract-py.js';
import { lensPython, missingModuleHint } from './python.js';

export interface LensIngestOptions {
  repoRoot: string;
  slug?: string;
  /** 판단을 건너뛰고 이 종류로 읽는다 */
  kind?: LensKind;
  run?: RunCommand;
  fetchImpl?: typeof fetch;
  python?: string;
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

const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
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
  if (declared > MAX_DOWNLOAD_BYTES) throw new Error(`파일이 200MB를 넘어요: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error(`파일이 200MB를 넘어요: ${url}`);
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
    throw new Error(`${detected} 자료는 아직 받지 않아요`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
