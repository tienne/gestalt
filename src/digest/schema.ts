import { z } from 'zod';
import { ValidationError } from '../core/errors.js';
import { err, ok, type Result } from '../core/result.js';
import { idSchema, textSchema } from './schema-base.js';

export const DIGEST_SCHEMA_VERSION = '1.0.0';
export const TRANSCRIPT_SCHEMA_VERSION = '1.0.0';

export const CAPTION_SOURCES = ['manual', 'auto', 'whisper'] as const;
export const VIDEO_SOURCES = ['youtube', 'file'] as const;

/**
 * 본문 문장 안에서 렌더러가 해석하는 마커는 이 둘뿐이다.
 * lint, 렌더, 윤문이 같은 정규식을 써야 서로 다른 걸 마커로 보지 않는다.
 * 전역 플래그라 lastIndex가 남으니 쓸 때마다 새로 만든다.
 */
export const boldPattern = (): RegExp => /\*\*(.+?)\*\*/g;
export const keywordPattern = (): RegExp => /\{\{kw:([A-Za-z0-9][A-Za-z0-9_-]*)\|([^}]+)\}\}/g;

const sentenceIndex = z.number().int().nonnegative();

export const citeSchema = z
  .object({
    key: sentenceIndex,
    from: sentenceIndex,
    to: sentenceIndex,
  })
  .refine((c) => c.from <= c.to, 'from이 to보다 크다');

export const segmentSchema = z.object({
  i: sentenceIndex,
  startSec: z.number().nonnegative(),
  text: textSchema,
  speaker: z.string().optional(),
  translation: z.string().optional(),
});

export const youtubeWatchUrl = (videoId: string): string =>
  `https://www.youtube.com/watch?v=${videoId}`;

/**
 * url은 yt-dlp 인자와 뷰어 링크로 그대로 나간다. transcript.json을 손으로 고쳐도
 * 옵션이나 javascript: 링크가 끼지 않게 ingest가 쓰는 꼴만 받는다
 */
export const videoMetaSchema = z
  .object({
    source: z.enum(VIDEO_SOURCES),
    videoId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{11}$/)
      .optional(),
    url: z.string().optional(),
    title: textSchema,
    channel: z.string().optional(),
    durationSec: z.number().nonnegative(),
    publishedAt: z.string().optional(),
    lang: z.string().min(1),
    captionSource: z.enum(CAPTION_SOURCES),
  })
  .superRefine((m, ctx) => {
    if (m.source === 'youtube') {
      if (!m.videoId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['videoId'],
          message: '유튜브 영상은 videoId가 있어야 한다',
        });
      } else if (m.url !== undefined && m.url !== youtubeWatchUrl(m.videoId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['url'],
          message: `url은 ${youtubeWatchUrl(m.videoId)}여야 한다`,
        });
      }
    } else if (!m.url?.startsWith('file:')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: '로컬 영상은 url이 file: 주소여야 한다',
      });
    }
  });

export const transcriptSchema = z
  .object({
    schemaVersion: z.string().default(TRANSCRIPT_SCHEMA_VERSION),
    slug: z.string().min(1),
    meta: videoMetaSchema,
    segments: z.array(segmentSchema).min(1),
  })
  .superRefine((t, ctx) => {
    // Cite가 문장 번호로 배열을 바로 찾아가서 i가 자리 번호와 어긋나면 출처가 엇나간다
    t.segments.forEach((s, idx) => {
      if (s.i !== idx) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['segments', idx, 'i'],
          message: `i는 ${idx}여야 한다`,
        });
      }
      const prev = t.segments[idx - 1];
      if (prev && s.startSec < prev.startSec) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['segments', idx, 'startSec'],
          message: '시작 시각이 앞 문장보다 이르다',
        });
      }
    });
  });

export interface Bullet {
  text: string;
  cite: z.infer<typeof citeSchema>;
  children?: Bullet[];
}

// 3단 이상은 스키마가 아니라 lint가 잡는다. 어느 불릿이 깊은지 경로로 알려주려고
export const bulletSchema: z.ZodType<Bullet> = z.lazy(() =>
  z.object({
    text: textSchema,
    cite: citeSchema,
    children: z.array(bulletSchema).optional(),
  }),
);

export const subsectionSchema = z.object({
  id: idSchema,
  title: textSchema,
  cite: citeSchema,
  frameSec: z.number().nonnegative(),
  bullets: z.array(bulletSchema).min(1),
});

export const sectionSchema = z.object({
  id: idSchema,
  title: textSchema,
  conclusion: textSchema,
  cite: citeSchema,
  subsections: z.array(subsectionSchema).min(1),
});

export const keywordSchema = z.object({
  id: idSchema,
  term: textSchema,
  explanation: textSchema,
  firstCite: citeSchema,
});

export const skippedSchema = z
  .object({
    from: sentenceIndex,
    to: sentenceIndex,
    reason: textSchema,
  })
  .refine((s) => s.from <= s.to, 'from이 to보다 크다');

export const reportOptionsSchema = z.object({
  length: z.enum(['short', 'default', 'long']).default('default'),
  difficulty: z.enum(['normal', 'easy']).default('normal'),
  range: z.tuple([z.number().nonnegative(), z.number().nonnegative()]).optional(),
  lang: z.string().min(1).default('ko'),
  prompt: z.string().optional(),
});

export const reportSchema = z.object({
  options: reportOptionsSchema.default({}),
  lead: z.object({
    question: textSchema,
    answer: textSchema,
    takeaway: textSchema,
  }),
  sections: z.array(sectionSchema).min(1),
  skipped: z.array(skippedSchema).default([]),
  keywords: z.array(keywordSchema).default([]),
});

/** 1차는 리포트 한 벌만 둔다. 분량과 난이도별 reports[]는 2-1에서 붙인다 */
export const digestSchema = z.object({
  schemaVersion: z.string().default(DIGEST_SCHEMA_VERSION),
  slug: z.string().min(1),
  generatedAt: z.string().optional(),
  report: reportSchema,
});

export type Cite = z.infer<typeof citeSchema>;
export type Segment = z.infer<typeof segmentSchema>;
export type VideoMeta = z.infer<typeof videoMetaSchema>;
export type Transcript = z.infer<typeof transcriptSchema>;
export type Subsection = z.infer<typeof subsectionSchema>;
export type Section = z.infer<typeof sectionSchema>;
export type Keyword = z.infer<typeof keywordSchema>;
export type Skipped = z.infer<typeof skippedSchema>;
export type ReportOptions = z.infer<typeof reportOptionsSchema>;
export type Report = z.infer<typeof reportSchema>;
export type Digest = z.infer<typeof digestSchema>;
export type CaptionSource = (typeof CAPTION_SOURCES)[number];

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}

export function parseTranscript(input: unknown): Result<Transcript, ValidationError> {
  const parsed = transcriptSchema.safeParse(input);
  if (parsed.success) return ok(parsed.data);
  const issues = issuesOf(parsed.error);
  return err(new ValidationError(`transcript.json 형식 오류: ${issues.join('; ')}`, issues));
}

export function parseDigest(input: unknown): Result<Digest, ValidationError> {
  const parsed = digestSchema.safeParse(input);
  if (parsed.success) return ok(parsed.data);
  const issues = issuesOf(parsed.error);
  return err(new ValidationError(`digest.json 형식 오류: ${issues.join('; ')}`, issues));
}
