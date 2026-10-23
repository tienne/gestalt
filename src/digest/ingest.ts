import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { log } from '../core/log.js';
import { captionsToSentences, cuesToWords, mergeSentences, type Cue } from './captions.js';
import {
  TRANSCRIPT_SCHEMA_VERSION,
  youtubeWatchUrl,
  type CaptionSource,
  type Transcript,
} from './schema.js';
import { DigestStore, isValidSlug, slugFromMeta } from './store.js';
import {
  CommandError,
  QUICK_TIMEOUT_MS,
  runCommand,
  timeoutFor,
  ytdlp,
  type RunCommand,
} from './ytdlp.js';

export interface IngestOptions {
  repoRoot: string;
  /** 자막 언어 우선순위. 없으면 영상 원어를 쓴다 */
  lang?: string;
  slug?: string;
  /** 자막이 있어도 whisper로 받아쓴다 */
  whisper?: boolean;
  whisperModel?: string;
  run?: RunCommand;
}

export interface IngestResult {
  slug: string;
  transcriptPath: string;
  title: string;
  durationSec: number;
  captionSource: CaptionSource;
  /** 실제로 쓴 자막 트랙 이름(en-orig 같은). whisper면 모델 이름 */
  captionTrack: string;
  segmentCount: number;
  /**
   * 같은 slug를 다시 받아 문장이 바뀌면 기존 digest.json의 cite가 엉뚱한 문장을 가리킨다.
   * 그래서 옮겨 두고 그 경로와 이전 문장 수를 싣는다
   */
  staleDigest?: { movedTo: string; previousSegmentCount: number | null };
}

const DEFAULT_WHISPER_MODEL = 'large-v3';

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/** watch?v=, youtu.be/, shorts/, embed/, live/ 꼴에서 영상 id를 꺼낸다. 유튜브 주소가 아니면 null */
export function parseYoutubeId(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0] ?? null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else {
      const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/);
      id = m ? m[1]! : null;
    }
  }
  return id && YOUTUBE_ID.test(id) ? id : null;
}

interface YtTrack {
  ext?: string;
}
interface YtMeta {
  id: string;
  title?: string;
  channel?: string;
  uploader?: string;
  duration?: number;
  upload_date?: string;
  language?: string | null;
  webpage_url?: string;
  subtitles?: Record<string, YtTrack[]>;
  automatic_captions?: Record<string, YtTrack[]>;
}

export interface CaptionPick {
  kind: 'manual' | 'auto';
  key: string;
  lang: string;
}

const langOf = (key: string) => key.replace(/-orig$/, '');
const matches = (key: string, pref: string) =>
  key === pref || key.startsWith(`${pref}-`) || langOf(key) === pref;

/**
 * 수동 자막 → 자동 자막 순으로 고른다. 자동 자막은 157개 언어가 기계 번역으로 딸려 오는데
 * 영상 원어 트랙만 `-orig`가 붙어서 그걸 먼저 잡는다. 번역 자막은 문장 시각이 어긋나 쓰지 않는다.
 */
export function pickCaption(meta: YtMeta, prefLang?: string): CaptionPick | null {
  const prefs = [prefLang, meta.language ?? undefined].filter((p): p is string => !!p);
  const manual = Object.keys(meta.subtitles ?? {}).filter((k) => k !== 'live_chat');
  const auto = Object.keys(meta.automatic_captions ?? {});

  for (const p of prefs) {
    const k = manual.find((m) => matches(m, p));
    if (k) return { kind: 'manual', key: k, lang: langOf(k) };
  }
  if (prefs.length === 0 && manual.length === 1) {
    return { kind: 'manual', key: manual[0]!, lang: langOf(manual[0]!) };
  }
  const orig = auto.find((k) => k.endsWith('-orig'));
  if (orig) return { kind: 'auto', key: orig, lang: langOf(orig) };
  for (const p of prefs) {
    if (auto.includes(p)) return { kind: 'auto', key: p, lang: p };
  }
  return null;
}

const toIsoDate = (yyyymmdd?: string) =>
  yyyymmdd && /^\d{8}$/.test(yyyymmdd)
    ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
    : undefined;

const round2 = (n: number) => Math.round(n * 100) / 100;

function toSegments(cues: Cue[]): Transcript['segments'] {
  let prev = 0;
  return cues.map((c, i) => {
    // 수동 자막은 큐가 겹치기도 해서 시각이 뒤로 가는 경우만 앞 문장에 맞춘다
    prev = Math.max(prev, round2(c.startSec));
    return { i, startSec: prev, text: c.text };
  });
}

function findFile(dir: string, prefix: string, exts: string[]): string | null {
  const hit = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && exts.includes(extname(f).toLowerCase()))
    .sort();
  return hit.length > 0 ? join(dir, hit[0]!) : null;
}

// 모델을 받을 때 진행 로그가 stdout에 섞일 수 있어서 결과는 마지막 줄 한 줄로만 낸다
const WHISPER_SCRIPT = `
import json, sys
from faster_whisper import WhisperModel
audio, model_name, lang = sys.argv[1], sys.argv[2], sys.argv[3] or None
model = WhisperModel(model_name, device="auto", compute_type="auto")
segments, info = model.transcribe(audio, language=lang, vad_filter=True)
out = [{"start": s.start, "text": s.text.strip()} for s in segments if s.text.strip()]
sys.stdout.write("\\n" + json.dumps({"language": info.language, "segments": out}) + "\\n")
`;

const mmss = (sec: number) =>
  `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

async function transcribeWithWhisper(
  run: RunCommand,
  cwd: string,
  audioPath: string,
  model: string,
  durationSec: number,
  lang?: string,
): Promise<{ lang: string; cues: Cue[] }> {
  log(
    `faster-whisper ${model} 모델로 ${mmss(durationSec)} 분량을 받아써요. ` +
      'GPU가 없으면 영상 길이보다 오래 걸릴 수 있어요.',
  );
  let stdout: string;
  try {
    ({ stdout } = await run('python3', ['-c', WHISPER_SCRIPT, audioPath, model, lang ?? ''], {
      cwd,
      // CPU로 큰 모델을 돌리면 영상 길이의 몇 배가 걸린다. 멈춘 프로세스만 끊을 만큼 넉넉히 둔다
      timeoutMs: timeoutFor(durationSec, 20, 600),
    }));
  } catch (e) {
    // faster-whisper 의존 모듈(ctranslate2, av)이 빠진 경우는 설치 안내가 틀려서 원래 오류를 그대로 올린다
    if (e instanceof CommandError && /No module named ['"]faster_whisper/.test(e.stderr)) {
      throw new Error(
        '자막이 없어서 faster-whisper로 받아쓰려 했는데 설치돼 있지 않아요. ' +
          '`python3 -m pip install faster-whisper`로 설치한 뒤 다시 돌려 주세요.',
        { cause: e },
      );
    }
    throw e;
  }
  const last = stdout.trim().split('\n').pop() ?? '';
  let parsed: { language: string; segments: Array<{ start: number; text: string }> };
  try {
    parsed = JSON.parse(last) as typeof parsed;
  } catch {
    throw new Error(`받아쓰기 결과를 JSON으로 못 읽었어요: ${stdout.trim().slice(0, 200)}`);
  }
  return {
    lang: parsed.language,
    cues: parsed.segments.map((s) => ({ startSec: s.start, text: s.text })),
  };
}

async function probeDuration(run: RunCommand, cwd: string, file: string): Promise<number> {
  const { stdout } = await run(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { cwd, timeoutMs: QUICK_TIMEOUT_MS },
  );
  const sec = Number(stdout.trim());
  if (!Number.isFinite(sec) || sec <= 0) throw new Error(`영상 길이를 못 읽었어요: ${file}`);
  return sec;
}

interface Collected {
  slug: string;
  meta: Transcript['meta'];
  cues: Cue[];
  track: string;
}

async function collectYoutube(
  videoId: string,
  opts: IngestOptions,
  run: RunCommand,
  work: string,
): Promise<Collected> {
  const watchUrl = youtubeWatchUrl(videoId);
  const quick = { cwd: work, timeoutMs: QUICK_TIMEOUT_MS };
  const { stdout } = await ytdlp(run, ['-J', '--skip-download', watchUrl], undefined, quick);
  const meta = JSON.parse(stdout) as YtMeta;
  const title = meta.title?.trim() || videoId;
  const base = {
    source: 'youtube' as const,
    videoId,
    url: watchUrl,
    title,
    ...(meta.channel || meta.uploader ? { channel: meta.channel ?? meta.uploader } : {}),
    durationSec: meta.duration ?? 0,
    ...(toIsoDate(meta.upload_date) ? { publishedAt: toIsoDate(meta.upload_date) } : {}),
  };
  const slug = opts.slug ?? slugFromMeta(videoId, title);

  const pick = opts.whisper ? null : pickCaption(meta, opts.lang);
  if (pick) {
    const flag = pick.kind === 'manual' ? '--write-subs' : '--write-auto-subs';
    const subArgs = [
      ...['--skip-download', flag, '--sub-langs', pick.key, '--sub-format', 'vtt/srt/best'],
      ...['-o', join(work, 'sub.%(ext)s'), watchUrl],
    ];
    await ytdlp(run, subArgs, undefined, quick);
    const file = findFile(work, 'sub.', ['.vtt', '.srt']);
    const cues = file ? captionsToSentences(readFileSync(file, 'utf-8')) : [];
    if (cues.length > 0) {
      return {
        slug,
        meta: { ...base, lang: pick.lang, captionSource: pick.kind },
        cues,
        track: pick.key,
      };
    }
  }

  const model = opts.whisperModel ?? DEFAULT_WHISPER_MODEL;
  await ytdlp(
    run,
    ['-f', 'bestaudio/best', '-o', join(work, 'audio.%(ext)s'), watchUrl],
    undefined,
    { cwd: work, timeoutMs: timeoutFor(base.durationSec, 1) },
  );
  const audio = findFile(work, 'audio.', ['.m4a', '.webm', '.mp4', '.opus', '.mp3', '.ogg']);
  if (!audio) throw new Error('오디오를 받지 못했어요.');
  const w = await transcribeWithWhisper(
    run,
    work,
    audio,
    model,
    base.durationSec,
    opts.lang ?? meta.language ?? undefined,
  );
  return {
    slug,
    meta: { ...base, lang: w.lang, captionSource: 'whisper' },
    cues: mergeSentences(cuesToWords(w.cues)),
    track: model,
  };
}

async function collectFile(
  file: string,
  opts: IngestOptions,
  run: RunCommand,
  work: string,
): Promise<Collected> {
  const stem = basename(file, extname(file));
  const durationSec = await probeDuration(run, work, file);
  // 같은 이름의 영상이 다른 폴더에 있어도 섞이지 않게 경로 해시를 slug 끝에 붙인다
  const hash = createHash('sha1').update(file).digest('hex').slice(0, 8);
  const slug = opts.slug ?? slugFromMeta(hash, stem);
  const base = {
    source: 'file' as const,
    url: pathToFileURL(file).href,
    title: stem,
    durationSec: round2(durationSec),
  };

  const sidecar = opts.whisper ? null : findFile(dirname(file), `${stem}.`, ['.vtt', '.srt']);
  if (sidecar) {
    const cues = captionsToSentences(readFileSync(sidecar, 'utf-8'));
    if (cues.length > 0) {
      return {
        slug,
        meta: { ...base, lang: opts.lang ?? 'und', captionSource: 'manual' },
        cues,
        track: basename(sidecar),
      };
    }
  }
  const model = opts.whisperModel ?? DEFAULT_WHISPER_MODEL;
  const w = await transcribeWithWhisper(run, work, file, model, base.durationSec, opts.lang);
  return {
    slug,
    meta: { ...base, lang: w.lang, captionSource: 'whisper' },
    cues: mergeSentences(cuesToWords(w.cues)),
    track: model,
  };
}

const sameSegments = (a: Transcript['segments'], b: Transcript['segments']) =>
  a.length === b.length &&
  a.every((s, i) => s.startSec === b[i]!.startSec && s.text === b[i]!.text);

/**
 * 문장이 바뀌었는데 digest.json을 두면 cite가 옛 번호로 엉뚱한 장면을 가리킨다.
 * 지우지 않고 옮겨 두면 다음 validate가 DIGEST_NOT_FOUND로 요약을 새로 쓰게 이끈다
 */
function moveStaleDigest(
  store: DigestStore,
  next: Transcript,
): IngestResult['staleDigest'] | undefined {
  const digestPath = store.digestPath(next.slug);
  if (!existsSync(digestPath)) return undefined;
  const prev = store.readTranscript(next.slug);
  if (prev.ok && sameSegments(prev.transcript.segments, next.segments)) return undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const movedTo = join(store.dir(next.slug), `digest.stale-${stamp}.json`);
  renameSync(digestPath, movedTo);
  return { movedTo, previousSegmentCount: prev.ok ? prev.transcript.segments.length : null };
}

function restoreStaleDigest(
  store: DigestStore,
  slug: string,
  movedTo: string,
  cause: unknown,
): void {
  let why: string;
  try {
    renameSync(movedTo, store.digestPath(slug));
    return;
  } catch (restoreErr) {
    why = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
  }
  // catch 밖에서 던져야 cause에 되돌리기 오류가 아닌 저장 오류를 둘 수 있다.
  // CLI는 message만 찍어서 저장이 왜 실패했는지와 digest가 어디 남았는지, 왜 못 되돌렸는지를 message에 다 넣는다
  const reason = cause instanceof Error ? cause.message : String(cause);
  throw new Error(
    `${reason} (옮겨 둔 digest.json을 되돌리지 못해 ${movedTo}에 남아 있어요: ${why})`,
    { cause },
  );
}

/**
 * 유튜브 주소나 로컬 영상 파일에서 문장 단위 스크립트를 만들어 transcript.json으로 저장한다.
 * 자막 순서는 수동 자막 → 자동 자막(문장 병합) → faster-whisper다.
 */
export async function ingest(input: string, opts: IngestOptions): Promise<IngestResult> {
  const run = opts.run ?? runCommand;
  if (opts.slug !== undefined && !isValidSlug(opts.slug)) {
    throw new Error(`slug는 소문자, 숫자, 하이픈만 쓸 수 있어요: ${opts.slug}`);
  }
  const videoId = parseYoutubeId(input);
  const filePath = videoId ? null : resolve(input);
  if (!videoId && !(filePath && existsSync(filePath) && statSync(filePath).isFile())) {
    throw new Error(`유튜브 주소도 아니고 파일도 찾지 못했어요: ${input}`);
  }

  const work = mkdtempSync(join(tmpdir(), 'gestalt-digest-'));
  try {
    const c = videoId
      ? await collectYoutube(videoId, opts, run, work)
      : await collectFile(filePath!, opts, run, work);
    if (c.cues.length === 0) throw new Error('스크립트 문장이 하나도 안 나왔어요.');
    const transcript: Transcript = {
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      slug: c.slug,
      meta: c.meta,
      segments: toSegments(c.cues),
    };
    const store = new DigestStore(opts.repoRoot);
    const staleDigest = moveStaleDigest(store, transcript);
    let transcriptPath: string;
    try {
      transcriptPath = store.saveTranscript(transcript);
    } catch (e) {
      // 저장 뒤에 옮기면 rename 실패 때 새 transcript 옆에 옛 digest가 남는다. 옮긴 걸 되돌려 옛 짝을 지킨다
      if (staleDigest) restoreStaleDigest(store, c.slug, staleDigest.movedTo, e);
      throw e;
    }
    return {
      slug: c.slug,
      transcriptPath,
      title: c.meta.title,
      durationSec: c.meta.durationSec,
      captionSource: c.meta.captionSource,
      captionTrack: c.track,
      segmentCount: transcript.segments.length,
      ...(staleDigest ? { staleDigest } : {}),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
