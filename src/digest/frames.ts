import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { youtubeWatchUrl, type Digest, type Transcript } from './schema.js';
import { DigestStore } from './store.js';
import { runCommand, timeoutFor, ytdlp, type RunCommand } from './ytdlp.js';

export interface FramesOptions {
  repoRoot: string;
  /** 이미 뽑아 둔 프레임도 다시 뽑는다 */
  force?: boolean;
  run?: RunCommand;
}

export interface FramesResult {
  framesDir: string;
  extracted: number;
  skipped: number;
  total: number;
  /** ffmpeg가 오류 없이 끝났는데 파일이 안 생긴 frameSec. 영상 끝을 넘긴 시각이 주로 여기 온다 */
  missing: number[];
  shots: ShotFramesResult;
}

export interface ShotFramesResult {
  total: number;
  extracted: number;
  skipped: number;
  /** 720p 영상에서 뽑은 장 수. 나머지는 프레임용 저화질 영상에서 뽑았다 */
  hires: number;
  missing: number[];
}

/** 프레임 파일 이름. 렌더러가 frameSec으로 같은 이름을 찾는다 */
export function frameFileName(sec: number): string {
  return `t${String(Math.round(sec * 1000)).padStart(8, '0')}.jpg`;
}

/** shots 장면 파일 이름. 소섹션 프레임과 화질이 달라 이름을 따로 둔다 */
export function shotFileName(sec: number): string {
  return `s${String(Math.round(sec * 1000)).padStart(8, '0')}.jpg`;
}

/** 소섹션 shots의 시각. 소섹션 프레임과 같은 시각이어도 720p로 따로 뽑는다 */
export function collectShotSecs(digest: Digest): number[] {
  const secs = digest.reports.flatMap((r) =>
    r.sections.flatMap((s) => s.subsections.flatMap((sub) => (sub.shots ?? []).map((x) => x.sec))),
  );
  return [...new Set(secs)].sort((a, b) => a - b);
}

export function collectFrameSecs(digest: Digest): number[] {
  const secs = digest.reports.flatMap((r) =>
    r.sections.flatMap((s) => s.subsections.map((sub) => sub.frameSec)),
  );
  return [...new Set(secs)].sort((a, b) => a - b);
}

/**
 * 프레임만 뽑으면 되니 소리 없는 낮은 화질 영상을 받는다.
 * 403이 나면 web_embedded로 다시 받는데, 그 클라이언트는 480p 이하 포맷이 빠지는 경우가 있어 136(720p)과 18(360p)까지 넓힌다.
 */
const FORMAT = 'bv*[height<=480][ext=mp4]/b[height<=480][ext=mp4]/18';
const FORMAT_RETRY = '135/134/136/18';
/**
 * shots는 슬라이드 글자가 읽혀야 해서 720p 영상을 따로 받는다. 디코딩이 가벼운 H.264를 먼저 고른다.
 * 스트림 주소만 받아 ffmpeg로 그 시각을 읽으면 유튜브가 403을 내서 영상 전체를 받는다
 */
const HIRES_FORMAT =
  'bv*[height<=720][height>=600][vcodec^=avc1]/bv*[height<=720][height>=600][ext=mp4]/136/22';
const HIRES_RETRY = '136/22';
const LOWRES_BASE = 'video';
const HIRES_BASE = 'video-720';

// yt-dlp가 중단되면 video.mp4.part나 video.mp4.ytdl 같은 보조 파일이 남는다. 완성본 확장자만 캐시로 본다
const VIDEO_EXT = /\.(mp4|webm|mkv)$/;

function findCachedVideo(cacheDir: string, base: string): string | null {
  if (!existsSync(cacheDir)) return null;
  const hit = readdirSync(cacheDir).find(
    (f) => VIDEO_EXT.test(f) && f.slice(0, f.lastIndexOf('.')) === base,
  );
  return hit ? join(cacheDir, hit) : null;
}

async function downloadVideo(
  run: RunCommand,
  transcript: Transcript,
  cacheDir: string,
  cwd: string,
  base: string,
  formats: [string, string],
): Promise<string> {
  const { meta } = transcript;
  const cached = findCachedVideo(cacheDir, base);
  if (cached) return cached;

  if (!meta.videoId) throw new Error('transcript에 videoId가 없어요.');
  mkdirSync(cacheDir, { recursive: true });
  // url 필드 대신 검증된 videoId로 주소를 다시 만들고 '--' 뒤에 둬서 옵션으로 읽히지 않게 한다
  const out = ['-o', join(cacheDir, `${base}.%(ext)s`), '--', youtubeWatchUrl(meta.videoId)];
  await ytdlp(run, ['-f', formats[0], ...out], ['-f', formats[1], ...out], {
    cwd,
    timeoutMs: timeoutFor(meta.durationSec, 1),
  });
  const got = findCachedVideo(cacheDir, base);
  if (!got) throw new Error('영상을 받지 못했어요.');
  return got;
}

export async function ensureVideo(
  run: RunCommand,
  transcript: Transcript,
  cacheDir: string,
  cwd: string,
): Promise<string> {
  const { meta } = transcript;
  if (meta.source === 'file') {
    if (!meta.url) throw new Error('transcript에 원본 영상 경로가 없어요.');
    return fileURLToPath(meta.url);
  }
  return downloadVideo(run, transcript, cacheDir, cwd, LOWRES_BASE, [FORMAT, FORMAT_RETRY]);
}

/**
 * shots 장면을 읽을 영상. 로컬 파일이면 원본을 그대로 쓰고 유튜브면 720p를 받아 캐시에 둔다.
 * 못 받으면 null이고 그때는 저화질 영상에서 뽑는다
 */
async function hiresVideo(
  run: RunCommand,
  transcript: Transcript,
  cacheDir: string,
  cwd: string,
): Promise<string | null> {
  const { meta } = transcript;
  if (meta.source === 'file') return meta.url ? fileURLToPath(meta.url) : null;
  try {
    return await downloadVideo(run, transcript, cacheDir, cwd, HIRES_BASE, [
      HIRES_FORMAT,
      HIRES_RETRY,
    ]);
  } catch {
    return null;
  }
}

/**
 * digest.json의 소섹션 frameSec마다 한 장씩 뽑아 frames/에 둔다. shots 장면도 720p로 함께 뽑는다.
 * 요약이 끝나야 시각이 정해져서 ingest와 따로 돈다.
 */
export async function extractFrames(slug: string, opts: FramesOptions): Promise<FramesResult> {
  const run = opts.run ?? runCommand;
  const store = new DigestStore(opts.repoRoot);
  const t = store.readTranscript(slug);
  if (!t.ok) throw new Error(t.message);
  const transcript = t.transcript;
  const digest = store.loadDigest(slug);
  if (!digest) {
    throw new Error(
      `digest.json이 없거나 형식이 틀렸어요. 먼저 요약을 쓰고 validate를 통과시켜 주세요: ${slug}`,
    );
  }

  const framesDir = store.framesDir(slug);
  mkdirSync(framesDir, { recursive: true });
  const pending = (file: string) => {
    const p = join(framesDir, file);
    return opts.force || !existsSync(p) || statSync(p).size === 0;
  };
  const secs = collectFrameSecs(digest);
  const todo = secs.filter((sec) => pending(frameFileName(sec)));
  const shotSecs = collectShotSecs(digest);
  const shotTodo = shotSecs.filter((sec) => pending(shotFileName(sec)));
  const shots: ShotFramesResult = {
    total: shotSecs.length,
    extracted: 0,
    skipped: shotSecs.length - shotTodo.length,
    hires: 0,
    missing: [],
  };
  if (todo.length === 0 && shotTodo.length === 0) {
    return {
      framesDir,
      extracted: 0,
      skipped: secs.length,
      total: secs.length,
      missing: [],
      shots,
    };
  }

  // cacheDir는 레포 안이라 cwd로 쓰면 그 레포가 커밋한 yt-dlp.conf를 읽는다
  const cwd = mkdtempSync(join(tmpdir(), 'gestalt-digest-run-'));
  try {
    let video: string | undefined;
    const lowres = async () =>
      (video ??= await ensureVideo(run, transcript, store.videoCacheDir(slug), cwd));
    // 긴 영상일수록 뒤쪽 시각을 찾는 데 오래 걸려서 상한을 길이에 비례시킨다
    const frameTimeout = timeoutFor(transcript.meta.durationSec, 0.05, 60);
    const grab = async (input: string, sec: number, file: string, width: number, q: number) => {
      await run(
        'ffmpeg',
        [
          ...['-v', 'error', '-y', '-ss', String(sec), '-i', input],
          ...['-frames:v', '1', '-vf', `scale='min(${width},iw)':-2`, '-q:v', String(q)],
          file,
        ],
        { cwd, timeoutMs: frameTimeout },
      );
      // 영상 끝을 넘긴 시각이면 ffmpeg가 파일 없이 0으로 끝나기도 한다
      return existsSync(file) && statSync(file).size > 0;
    };

    const missing: number[] = [];
    for (const sec of todo) {
      if (!(await grab(await lowres(), sec, join(framesDir, frameFileName(sec)), 960, 5))) {
        missing.push(sec);
      }
    }

    const hires =
      shotTodo.length > 0
        ? await hiresVideo(run, transcript, store.videoCacheDir(slug), cwd)
        : null;
    for (const sec of shotTodo) {
      const file = join(framesDir, shotFileName(sec));
      let ok = false;
      if (hires) {
        // 720p 영상을 못 읽으면 저화질 영상으로 물러난다. 흐려도 장면은 보인다
        ok = await grab(hires, sec, file, 1280, 3).catch(() => false);
        if (ok) shots.hires += 1;
      }
      if (!ok) ok = await grab(await lowres(), sec, file, 960, 3);
      if (ok) shots.extracted += 1;
      else shots.missing.push(sec);
    }
    return {
      framesDir,
      extracted: todo.length - missing.length,
      skipped: secs.length - todo.length,
      total: secs.length,
      missing,
      shots,
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
