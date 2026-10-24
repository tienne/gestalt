import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeJsonAtomic } from '../core/json-file.js';
import { parseDigest, parseTranscript, type Digest, type Transcript } from './schema.js';

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SLUG_MAX = 64;

export type RawRead =
  | { kind: 'missing' }
  | { kind: 'invalid-json'; message: string }
  | { kind: 'ok'; value: unknown };

export type TranscriptRead =
  | { ok: true; transcript: Transcript }
  | { ok: false; code: 'TRANSCRIPT_NOT_FOUND' | 'TRANSCRIPT_INVALID'; message: string };

export function readRaw(path: string): RawRead {
  if (!existsSync(path)) return { kind: 'missing' };
  try {
    return { kind: 'ok', value: JSON.parse(readFileSync(path, 'utf-8')) };
  } catch (e) {
    return { kind: 'invalid-json', message: e instanceof Error ? e.message : String(e) };
  }
}

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

/**
 * 제목을 ascii 소문자와 하이픈으로 줄이고 videoId를 끝에 붙인다.
 * 한국어 제목은 남는 글자가 없어서 videoId만 남는다. 같은 제목의 다른 영상이 섞이지 않게 id는 항상 붙인다.
 */
export function slugFromMeta(videoIdOrName: string, title: string): string {
  const tail = videoIdOrName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const head = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const room = SLUG_MAX - tail.length - 1;
  const trimmed = room > 0 ? head.slice(0, room).replace(/-+$/, '') : '';
  const slug = trimmed ? `${trimmed}-${tail}` : tail;
  return slug || 'video';
}

/**
 * 영상 요약 저장소: `<repoRoot>/.gestalt/digest/<slug>/`.
 * `.gestalt/`는 gitignore 대상이라 프레임과 영상 캐시가 커밋에 딸려가지 않는다.
 */
export class DigestStore {
  readonly root: string;

  constructor(repoRoot: string) {
    // 외부 명령은 임시 cwd에서 돌아서 상대 경로를 넘기면 프레임 같은 산출물이 그 폴더에 쓰였다가 함께 지워진다
    this.root = join(resolve(repoRoot), '.gestalt', 'digest');
  }

  /** slug는 경로 조각이라 패턴을 통과한 것만 받는다 */
  dir(slug: string): string {
    if (!isValidSlug(slug)) throw new Error(`slug가 올바르지 않다: ${slug}`);
    return join(this.root, slug);
  }

  transcriptPath(slug: string): string {
    return join(this.dir(slug), 'transcript.json');
  }

  digestPath(slug: string): string {
    return join(this.dir(slug), 'digest.json');
  }

  htmlPath(slug: string): string {
    return join(this.dir(slug), 'digest.html');
  }

  mdPath(slug: string): string {
    return join(this.dir(slug), 'digest.md');
  }

  framesDir(slug: string): string {
    return join(this.dir(slug), 'frames');
  }

  /** frames 명령이 받아 두는 저화질 영상. 다시 뽑을 때 또 받지 않으려고 둔다 */
  videoCacheDir(slug: string): string {
    return join(this.dir(slug), 'cache');
  }

  /**
   * 깨진 파일도 옮기지 않는다. validate나 render 같은 읽기 명령이 파일을 치우면
   * 사용자는 왜 사라졌는지 모른다. ingest를 다시 돌리면 어차피 덮어쓴다
   */
  readTranscript(slug: string): TranscriptRead {
    const raw = readRaw(this.transcriptPath(slug));
    const rerun = `gestalt digest ingest를 다시 돌려 주세요: ${slug}`;
    if (raw.kind === 'missing') {
      return {
        ok: false,
        code: 'TRANSCRIPT_NOT_FOUND',
        message: `transcript.json이 없어요. 먼저 gestalt digest ingest를 돌려 주세요: ${slug}`,
      };
    }
    if (raw.kind === 'invalid-json') {
      return {
        ok: false,
        code: 'TRANSCRIPT_INVALID',
        message: `transcript.json을 JSON으로 못 읽었어요(${raw.message}). ${rerun}`,
      };
    }
    const parsed = parseTranscript(raw.value);
    if (!parsed.ok) {
      return {
        ok: false,
        code: 'TRANSCRIPT_INVALID',
        message: `transcript.json 형식이 틀렸어요(${parsed.error.issues.slice(0, 3).join('; ')}). ${rerun}`,
      };
    }
    return { ok: true, transcript: parsed.value };
  }

  /**
   * 요약은 세션이 손으로 쓰는 파일이라 깨져도 옮기지 않는다.
   * 옮겨 버리면 validate 오류를 보고 고치려던 원본이 사라진다.
   */
  readDigestFile(slug: string): RawRead {
    return readRaw(this.digestPath(slug));
  }

  /** 없거나 형식이 틀리면 null. 이유가 필요하면 readDigestFile과 parseDigest를 쓴다 */
  loadDigest(slug: string): Digest | null {
    const raw = this.readDigestFile(slug);
    if (raw.kind !== 'ok') return null;
    const parsed = parseDigest(raw.value);
    return parsed.ok ? parsed.value : null;
  }

  saveTranscript(transcript: Transcript): string {
    const path = this.transcriptPath(transcript.slug);
    writeJsonAtomic(path, transcript);
    return path;
  }

  saveDigest(digest: Digest): string {
    const path = this.digestPath(digest.slug);
    writeJsonAtomic(path, digest);
    return path;
  }

  saveHtml(slug: string, html: string): string {
    return this.writeText(this.htmlPath(slug), slug, html);
  }

  saveMd(slug: string, md: string): string {
    return this.writeText(this.mdPath(slug), slug, md);
  }

  private writeText(path: string, slug: string, content: string): string {
    mkdirSync(this.dir(slug), { recursive: true });
    writeFileSync(path, content, 'utf-8');
    return path;
  }
}
