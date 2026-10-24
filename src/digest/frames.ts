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
}

/** 프레임 파일 이름. 렌더러가 frameSec으로 같은 이름을 찾는다 */
export function frameFileName(sec: number): string {
  return `t${String(Math.round(sec * 1000)).padStart(8, '0')}.jpg`;
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

// yt-dlp가 중단되면 video.mp4.part나 video.mp4.ytdl 같은 보조 파일이 남는다. 완성본 확장자만 캐시로 본다
const CACHED_VIDEO = /^video\.(mp4|webm|mkv)$/;

function findCachedVideo(cacheDir: string): string | null {
  if (!existsSync(cacheDir)) return null;
  const hit = readdirSync(cacheDir).find((f) => CACHED_VIDEO.test(f));
  return hit ? join(cacheDir, hit) : null;
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
  const cached = findCachedVideo(cacheDir);
  if (cached) return cached;

  if (!meta.videoId) throw new Error('transcript에 videoId가 없어요.');
  mkdirSync(cacheDir, { recursive: true });
  // url 필드 대신 검증된 videoId로 주소를 다시 만들고 '--' 뒤에 둬서 옵션으로 읽히지 않게 한다
  const out = ['-o', join(cacheDir, 'video.%(ext)s'), '--', youtubeWatchUrl(meta.videoId)];
  await ytdlp(run, ['-f', FORMAT, ...out], ['-f', FORMAT_RETRY, ...out], {
    cwd,
    timeoutMs: timeoutFor(meta.durationSec, 1),
  });
  const got = findCachedVideo(cacheDir);
  if (!got) throw new Error('영상을 받지 못했어요.');
  return got;
}

/**
 * digest.json의 소섹션 frameSec마다 한 장씩 뽑아 frames/에 둔다.
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

  const secs = collectFrameSecs(digest);
  const framesDir = store.framesDir(slug);
  mkdirSync(framesDir, { recursive: true });
  const todo = secs.filter((sec) => {
    const p = join(framesDir, frameFileName(sec));
    return opts.force || !existsSync(p) || statSync(p).size === 0;
  });
  if (todo.length === 0) {
    return { framesDir, extracted: 0, skipped: secs.length, total: secs.length, missing: [] };
  }

  // cacheDir는 레포 안이라 cwd로 쓰면 그 레포가 커밋한 yt-dlp.conf를 읽는다
  const cwd = mkdtempSync(join(tmpdir(), 'gestalt-digest-run-'));
  try {
    const video = await ensureVideo(run, transcript, store.videoCacheDir(slug), cwd);
    // 긴 영상일수록 뒤쪽 시각을 찾는 데 오래 걸려서 상한을 길이에 비례시킨다
    const frameTimeout = timeoutFor(transcript.meta.durationSec, 0.05, 60);
    const missing: number[] = [];
    for (const sec of todo) {
      const file = join(framesDir, frameFileName(sec));
      await run(
        'ffmpeg',
        [
          ...['-v', 'error', '-y', '-ss', String(sec), '-i', video],
          ...['-frames:v', '1', '-vf', "scale='min(960,iw)':-2", '-q:v', '5'],
          file,
        ],
        { cwd, timeoutMs: frameTimeout },
      );
      // 영상 끝을 넘긴 시각이면 ffmpeg가 파일 없이 0으로 끝나기도 한다
      if (!existsSync(file) || statSync(file).size === 0) missing.push(sec);
    }
    return {
      framesDir,
      extracted: todo.length - missing.length,
      skipped: secs.length - todo.length,
      total: secs.length,
      missing,
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
