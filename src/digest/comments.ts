import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { writeJsonAtomic } from '../core/json-file.js';
import { commentIdSchema } from './blocks.js';
import { youtubeWatchUrl } from './schema.js';
import { DigestStore, readRaw } from './store.js';
import { runCommand, ytdlp, type RunCommand } from './ytdlp.js';

/**
 * 유튜브 댓글을 받아 comments.json으로 둔다. 댓글 분석 템플릿이 이 파일을 읽는다.
 * 작성자 이름과 채널 id, 프로필 사진은 저장하지 않는다. 분석에 안 쓰는 개인정보를 레포에 남기지 않으려는 것이다
 */

export const COMMENTS_DEFAULT_MAX = 200;
export const COMMENTS_MAX = 1000;
/** 댓글 하나가 이보다 길면 자른다. 분석에는 앞부분이면 충분하다 */
const COMMENT_TEXT_MAX = 2000;

export const storedCommentSchema = z.object({
  id: commentIdSchema,
  text: z.string().min(1).max(COMMENT_TEXT_MAX),
  likes: z.number().int().min(0),
  pinned: z.boolean().optional(),
  byUploader: z.boolean().optional(),
});

export const commentsFileSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  videoId: z.string(),
  fetchedAt: z.string(),
  /** 영상 정보에 적힌 전체 댓글 수. 받은 개수가 아니다 */
  commentCount: z.number().int().min(0).nullable(),
  comments: z.array(storedCommentSchema),
});

export type StoredComment = z.infer<typeof storedCommentSchema>;
export type CommentsFile = z.infer<typeof commentsFileSchema>;

const rawCommentSchema = z.object({
  id: z.unknown(),
  text: z.unknown(),
  parent: z.unknown().optional(),
  like_count: z.unknown().optional(),
  is_pinned: z.unknown().optional(),
  author_is_uploader: z.unknown().optional(),
});

/**
 * yt-dlp -J 결과에서 최상위 댓글만 골라 좋아요 순으로 max개를 남긴다.
 * 답글은 원 댓글 맥락 없이 읽으면 성격을 잘못 묶기 쉬워서 뺀다
 */
export function parseYtComments(
  raw: unknown,
  max: number,
): { comments: StoredComment[]; commentCount: number | null } {
  const obj = (raw ?? {}) as { comments?: unknown; comment_count?: unknown };
  const list = Array.isArray(obj.comments) ? obj.comments : [];
  const out: StoredComment[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const r = rawCommentSchema.safeParse(item);
    if (!r.success) continue;
    const c = r.data;
    if (c.parent !== undefined && c.parent !== 'root') continue;
    if (typeof c.id !== 'string' || !commentIdSchema.safeParse(c.id).success) continue;
    if (seen.has(c.id)) continue;
    const text = typeof c.text === 'string' ? c.text.trim().slice(0, COMMENT_TEXT_MAX) : '';
    if (!text) continue;
    seen.add(c.id);
    const likes =
      typeof c.like_count === 'number' && Number.isFinite(c.like_count)
        ? Math.max(0, Math.floor(c.like_count))
        : 0;
    out.push({
      id: c.id,
      text,
      likes,
      ...(c.is_pinned === true ? { pinned: true } : {}),
      ...(c.author_is_uploader === true ? { byUploader: true } : {}),
    });
  }
  // sort는 안정 정렬이라 좋아요가 같으면 yt-dlp가 준 순서(인기순)를 지킨다
  out.sort((a, b) => b.likes - a.likes);
  const count =
    typeof obj.comment_count === 'number' && Number.isInteger(obj.comment_count)
      ? Math.max(0, obj.comment_count)
      : null;
  return { comments: out.slice(0, max), commentCount: count };
}

export type CommentsRead =
  | { kind: 'missing' }
  | { kind: 'invalid'; message: string }
  | { kind: 'ok'; value: CommentsFile };

export function readComments(store: DigestStore, slug: string): CommentsRead {
  const raw = readRaw(store.commentsPath(slug));
  if (raw.kind === 'missing') return raw;
  if (raw.kind === 'invalid-json') return { kind: 'invalid', message: raw.message };
  const parsed = commentsFileSchema.safeParse(raw.value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    return { kind: 'invalid', message: issues.join('; ') };
  }
  return { kind: 'ok', value: parsed.data };
}

/** lint가 받는 꼴. 파일이 없거나 깨졌으면 null이다 */
export function commentsMap(store: DigestStore, slug: string): Map<string, string> | null {
  const r = readComments(store, slug);
  return r.kind === 'ok' ? new Map(r.value.comments.map((c) => [c.id, c.text])) : null;
}

export interface FetchCommentsOptions {
  repoRoot: string;
  max?: number;
  run?: RunCommand;
}

export interface FetchCommentsResult {
  slug: string;
  path: string;
  fetched: number;
  commentCount: number | null;
}

export async function fetchComments(
  slug: string,
  opts: FetchCommentsOptions,
): Promise<FetchCommentsResult> {
  const max = opts.max ?? COMMENTS_DEFAULT_MAX;
  if (!Number.isInteger(max) || max < 1 || max > COMMENTS_MAX) {
    throw new Error(`--max는 1~${COMMENTS_MAX} 사이 정수여야 해요: ${max}`);
  }
  const store = new DigestStore(opts.repoRoot);
  const t = store.readTranscript(slug);
  if (!t.ok) throw new Error(t.message);
  const { meta } = t.transcript;
  if (meta.source !== 'youtube' || !meta.videoId) {
    throw new Error('댓글은 유튜브 영상만 받을 수 있어요.');
  }
  // 답글은 받지 않는다(max_comments의 세 번째와 네 번째 값이 0). 정렬은 인기순이다
  const args = [
    ...['--skip-download', '--get-comments', '-J'],
    ...['--extractor-args', `youtube:max_comments=${max},${max},0,0;comment_sort=top`],
    youtubeWatchUrl(meta.videoId),
  ];
  // 레포 안을 cwd로 쓰면 그 레포의 yt-dlp.conf를 읽는다. frames와 같은 이유로 임시 폴더에서 돈다
  const cwd = mkdtempSync(join(tmpdir(), 'gestalt-digest-run-'));
  try {
    const { stdout } = await ytdlp(opts.run ?? runCommand, args, args, {
      cwd,
      // 댓글은 20개씩 끊어 받아서 개수에 비례해 오래 걸린다
      timeoutMs: (120 + max * 0.5) * 1000,
    });
    let raw: unknown;
    try {
      raw = JSON.parse(stdout);
    } catch (e) {
      throw new Error(
        `yt-dlp 출력을 JSON으로 못 읽었어요: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
    const { comments, commentCount } = parseYtComments(raw, max);
    const file: CommentsFile = {
      schemaVersion: '1.0.0',
      videoId: meta.videoId,
      fetchedAt: new Date().toISOString(),
      commentCount,
      comments,
    };
    const path = store.commentsPath(slug);
    writeJsonAtomic(path, file);
    return { slug, path, fetched: comments.length, commentCount };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
