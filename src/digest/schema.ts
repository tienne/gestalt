import { z } from 'zod';
import { ValidationError } from '../core/errors.js';
import { err, ok, type Result } from '../core/result.js';
import {
  citeSchema,
  idSchema,
  LANG_TAG_PATTERN,
  sentenceIndex,
  SLUG_PATTERN,
  textSchema,
} from './schema-base.js';
import { extensionSchema } from './blocks.js';
import { diagramSchema } from './diagram-schema.js';
import {
  contextCardSchema,
  doubtSchema,
  glanceSchema,
  knowledgeLinkSchema,
  limitSchema,
  sourceRefSchema,
  type Doubt,
} from './lens-schema.js';

export { DIAGRAM_KINDS, diagramSchema, type Diagram, type DiagramKind } from './diagram-schema.js';

export { citeSchema, LANG_TAG_PATTERN };

export const DIGEST_SCHEMA_VERSION = '1.5.0';
export const TRANSCRIPT_SCHEMA_VERSION = '1.0.0';

/** text는 읽기 렌즈가 PDF나 웹 글에서 뽑은 본문이다 */
export const CAPTION_SOURCES = ['manual', 'auto', 'whisper', 'text'] as const;
export const VIDEO_SOURCES = ['youtube', 'file'] as const;
/** 읽기 렌즈 자료. 문장 번호 자리에 문단 번호(팟캐스트는 문장 번호)가 들어간다 */
export const LENS_SOURCES = ['pdf', 'web', 'podcast'] as const;
export const SOURCE_KINDS = [...VIDEO_SOURCES, ...LENS_SOURCES] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export type LensKind = (typeof LENS_SOURCES)[number];

export const isLensKind = (kind: SourceKind): kind is LensKind =>
  (LENS_SOURCES as readonly string[]).includes(kind);
/** 시각이 없는 글 자료. 문단의 startSec은 0이고 원문 창이 플레이어 자리를 대신한다 */
export const isTextKind = (kind: SourceKind): boolean => kind === 'pdf' || kind === 'web';

/**
 * 본문 문장 안에서 렌더러가 해석하는 마커는 이 둘뿐이다.
 * lint, 렌더, 윤문이 같은 정규식을 써야 서로 다른 걸 마커로 보지 않는다.
 * 전역 플래그라 lastIndex가 남으니 쓸 때마다 새로 만든다.
 */
export const boldPattern = (): RegExp => /\*\*(.+?)\*\*/g;
export const keywordPattern = (): RegExp => /\{\{kw:([A-Za-z0-9][A-Za-z0-9_-]*)\|([^}]+)\}\}/g;

/** PDF 쪽 위의 사각형. 좌표는 pt이고 원점은 왼쪽 위다 */
export const unitRectSchema = z.object({
  page: z.number().int().positive(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
});

export const UNIT_ROLES = ['para', 'heading', 'caption'] as const;

export const segmentSchema = z.object({
  i: sentenceIndex,
  /** 글 자료(pdf, web)는 시각이 없어 0이다 */
  startSec: z.number().nonnegative(),
  text: textSchema,
  speaker: z.string().optional(),
  translation: z.string().optional(),
  /** PDF 문단이 시작하는 쪽 */
  page: z.number().int().positive().optional(),
  role: z.enum(UNIT_ROLES).optional(),
  /** 캡션 문단이면 그 표나 그림의 id */
  ref: z.string().optional(),
  /** 원문 창이 칠할 자리. 단이나 쪽을 넘는 문단은 여러 개다 */
  rects: z.array(unitRectSchema).optional(),
});

export const youtubeWatchUrl = (videoId: string): string =>
  `https://www.youtube.com/watch?v=${videoId}`;

/**
 * url은 yt-dlp 인자와 뷰어 링크로 그대로 나간다. transcript.json을 손으로 고쳐도
 * 옵션이나 javascript: 링크가 끼지 않게 ingest가 쓰는 꼴만 받는다
 */
export const videoMetaSchema = z
  .object({
    source: z.enum(SOURCE_KINDS),
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
    /** segments[].translation의 언어. 뷰어 lang 속성으로 나간다 */
    translationLang: z.string().regex(LANG_TAG_PATTERN).optional(),
    captionSource: z.enum(CAPTION_SOURCES),
    /** 팟캐스트를 내려받은 오디오 파일. serve가 이 파일 하나만 같은 출처로 내준다 */
    media: z.string().optional(),
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
    } else if (m.source === 'file') {
      if (!m.url?.startsWith('file:')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['url'],
          message: '로컬 영상은 url이 file: 주소여야 한다',
        });
      }
    } else if (m.url !== undefined && !/^(https?|file):/.test(m.url)) {
      // 뷰어가 원문 링크로 싣는다. javascript: 같은 주소가 끼지 않게 한다
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'url은 http(s): 또는 file: 주소여야 한다',
      });
    }
    if (m.source === 'podcast' && m.media !== undefined && !m.media.startsWith('file:')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['media'],
        message: '팟캐스트 오디오는 내려받은 file: 주소여야 한다',
      });
    }
  });

export const transcriptSchema = z
  .object({
    schemaVersion: z.string().default(TRANSCRIPT_SCHEMA_VERSION),
    slug: z.string().regex(SLUG_PATTERN, 'slug는 영문 소문자, 숫자, -만 쓴다'),
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
  /** 읽기 렌즈의 의심 표시. 이 불릿의 주장과 원문 표나 다른 문단이 어긋나는 자리다 */
  doubt?: Doubt;
}

// 3단 이상은 스키마가 아니라 lint가 잡는다. 어느 불릿이 깊은지 경로로 알려주려고
export const bulletSchema: z.ZodType<Bullet> = z.lazy(() =>
  z.object({
    text: textSchema,
    cite: citeSchema,
    children: z.array(bulletSchema).optional(),
    doubt: doubtSchema.optional(),
  }),
);

/**
 * 화면 자체가 설명인 장면(슬라이드, 화이트보드, 표, 코드). sec는 scenes.json 후보 가운데
 * 소섹션 구간 안에 있는 것만 받는다. 요약 작성자가 장면을 보지 못하고 시각을 지어내지 않게 하려는 것이다
 */
export const shotSchema = z.object({
  sec: z.number().nonnegative(),
  caption: textSchema,
  cite: citeSchema,
});

export const SHOTS_MAX = 2;

export const subsectionSchema = z.object({
  id: idSchema,
  title: textSchema,
  cite: citeSchema,
  /** 영상 자료만 쓴다. 영상에서 빠지면 lint가 FRAME_SEC_MISSING으로 막는다 */
  frameSec: z.number().nonnegative().optional(),
  bullets: z.array(bulletSchema).min(1),
  // 장면이 없는 소섹션이 대부분이라 빈 배열을 채워 넣지 않게 생략을 받는다
  shots: z.array(shotSchema).max(SHOTS_MAX).optional(),
  /** 읽기 렌즈가 소섹션에 싣는 원문 표와 그림 */
  tables: z.array(sourceRefSchema).max(3).optional(),
  figures: z.array(sourceRefSchema).max(3).optional(),
});

export const sectionSchema = z.object({
  id: idSchema,
  title: textSchema,
  /** 장 도입 한 줄. 읽기 렌즈가 대섹션 머리에 둔다 */
  intro: textSchema.optional(),
  conclusion: textSchema,
  cite: citeSchema,
  subsections: z.array(subsectionSchema).min(1),
  diagram: diagramSchema.optional(),
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

export const REPORT_LENGTHS = ['short', 'default', 'long'] as const;
export const REPORT_DIFFICULTIES = ['normal', 'easy'] as const;

export const reportOptionsSchema = z.object({
  length: z.enum(REPORT_LENGTHS).default('default'),
  difficulty: z.enum(REPORT_DIFFICULTIES).default('normal'),
  /** 요약한 구간. 영상 시각(초)으로 [시작, 끝)이다 */
  // 리포트 키와 slice 파일 이름에 그대로 실려서 초 단위 정수만 받는다
  range: z
    .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
    .refine(([from, to]) => from < to, '구간 시작이 끝보다 앞이어야 한다')
    .optional(),
  lang: z
    .string()
    .regex(LANG_TAG_PATTERN, '언어 태그(ko, en, pt-BR) 꼴이어야 한다')
    // 리포트 키가 -로 이어 붙여서 끝이 구간(-r시작-끝)처럼 생긴 태그는 키 경계를 흐린다.
    // 요청문 해시(p+8자)는 하위 태그 8자 상한에서 이미 막혀서 es-PA 같은 지역 태그까지 거절하지 않는다
    .refine((v) => !/-r\d+-\d+$/i.test(v), '언어 태그 끝이 구간(-r숫자-숫자)처럼 생기면 안 된다')
    .default('ko'),
  prompt: z.string().trim().min(1).max(2000).optional(),
});

export const reportSchema = z.object({
  options: reportOptionsSchema.default({}),
  lead: z.object({
    question: textSchema,
    answer: textSchema,
    takeaway: textSchema,
    /** 읽기 렌즈의 한눈에 보기. 논문은 문제, 방법, 결과, 한계 순이다 */
    glance: z.array(glanceSchema).optional(),
  }),
  sections: z.array(sectionSchema).min(1),
  skipped: z.array(skippedSchema).default([]),
  keywords: z.array(keywordSchema).default([]),
  /** 읽기 렌즈의 검증 안 된 부분. 본문 끝에 늘 펼쳐 둔다 */
  limits: z.array(limitSchema).optional(),
  /** 바깥 맥락 카드. 기본 두 장, 깊게 읽기에서 네 장까지다 */
  cards: z.array(contextCardSchema).max(4).optional(),
  /** 내 지식 연결 카드 */
  links: z.array(knowledgeLinkSchema).max(6).optional(),
});

const digestObjectSchema = z.object({
  schemaVersion: z.string().default(DIGEST_SCHEMA_VERSION),
  slug: z.string().regex(SLUG_PATTERN, 'slug는 영문 소문자, 숫자, -만 쓴다'),
  generatedAt: z.string().optional(),
  /** 자료 종류. merge가 transcript.json에서 옮겨 적는다. 영상과 읽을거리를 한 목록에서 가를 때 쓴다 */
  source: z.object({ kind: z.enum(SOURCE_KINDS) }).optional(),
  reports: z.array(reportSchema).min(1),
  /** 템플릿으로 만든 확장 리포트. 1.1.0 이하에는 없다 */
  extensions: z.array(extensionSchema).default([]),
});

/**
 * 1.0.0은 리포트 한 벌을 `report`에 뒀다. 읽을 때 `reports` 한 칸으로 옮겨서
 * lint와 렌더가 한 꼴만 보게 한다. 저장할 때는 늘 `reports`로 쓴다
 */
export const digestSchema = z.preprocess((input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const { report, ...rest } = input as Record<string, unknown>;
  if (report === undefined || 'reports' in rest) return input;
  return { ...rest, reports: [report] };
}, digestObjectSchema);

export type Cite = z.infer<typeof citeSchema>;
export type Segment = z.infer<typeof segmentSchema>;
export type VideoMeta = z.infer<typeof videoMetaSchema>;
export type Transcript = z.infer<typeof transcriptSchema>;
export type Subsection = z.infer<typeof subsectionSchema>;
export type Shot = z.infer<typeof shotSchema>;
export type Section = z.infer<typeof sectionSchema>;
export type Keyword = z.infer<typeof keywordSchema>;
export type Skipped = z.infer<typeof skippedSchema>;
export type ReportOptions = z.infer<typeof reportOptionsSchema>;
export type Report = z.infer<typeof reportSchema>;
export type Digest = z.infer<typeof digestObjectSchema>;
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
