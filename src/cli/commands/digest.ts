import { resolve } from 'node:path';
import { extractFrames } from '../../digest/frames.js';
import { ingest } from '../../digest/ingest.js';

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
      console.log(`저장: ${r.framesDir}`);
    });
  } catch (e) {
    fail(e);
  }
}
