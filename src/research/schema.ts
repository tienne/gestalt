import { z } from 'zod';
import { ValidationError } from '../core/errors.js';
import { err, ok, type Result } from '../core/result.js';

export const RESEARCH_SCHEMA_VERSION = '1.0.0';

/** design.md 2.1절의 경우 4개 */
export const RESEARCH_KINDS = [
  'ux-research',
  'screens-only',
  'reverse-plan',
  'market-scan',
] as const;
export const PRODUCT_AXES = ['same-market', 'same-problem'] as const;
export const SCREEN_SOURCES = [
  'app-explore',
  'uibowl',
  'site-search',
  'youtube',
  'store-screenshot',
  'tech-blog',
  'none',
] as const;
export const CAPTURE_STATES = [
  'captured',
  'reference-image',
  'stopped-before-payment',
  'not-captured',
] as const;
export const CAPTURE_KINDS = ['direct', 'reference-db', 'video-frame', 'store'] as const;
/** replaced: 탐지기가 돌아 가짜 값으로 바꿨다. none: 탐지기가 돌았고 0건이었다. unchecked: 돌리지 못했다 */
export const PII_STATES = ['replaced', 'none', 'unchecked'] as const;
export const EVIDENCE_KINDS = ['observation', 'company-statement', 'interpretation'] as const;
export const SCALE_KINDS = [
  'store-rating-count',
  'download-estimate',
  'active-users',
  'company-statement',
  'other',
] as const;
export const COMPARISON_SYMBOLS = ['◎', '○', '△'] as const;
export const COMPARISON_ROW_KINDS = ['graded', 'burden', 'risk'] as const;
export const CONFIDENCE_LEVELS = ['likely', 'trial', 'hold', 'out'] as const;
export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'] as const;

const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/, 'id는 영문, 숫자, -, _만 쓴다');
const textSchema = z.string().min(1);

/** 리서치 폴더 밖으로 나가는 경로를 막는다. 공유용 HTML에 임의 파일이 실리는 길이기도 하다 */
export function isSafeRelativePath(path: string): boolean {
  if (path.includes('\0') || path.includes('\\')) return false;
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  return !path.split('/').some((part) => part === '..' || part === '');
}

const relativePathSchema = z
  .string()
  .refine(isSafeRelativePath, '리서치 폴더 안의 상대 경로만 쓴다 (절대 경로, .. 불가)');

const httpsUrlSchema = z
  .string()
  .url()
  .refine((u) => u.startsWith('https://'), 'https 주소만 쓴다');

const foundViaSchema = z.object({
  source: textSchema,
  query: z.string().optional(),
  reviewMentions: z.number().int().nonnegative().optional(),
  url: httpsUrlSchema.optional(),
});

const scaleSchema = z.object({
  value: textSchema,
  kind: z.enum(SCALE_KINDS),
  source: textSchema,
  evidence: z.enum(EVIDENCE_KINDS),
});

export const productCandidateSchema = z.object({
  id: idSchema,
  name: textSchema,
  axis: z.enum(PRODUCT_AXES),
  reason: textSchema,
  foundVia: z.array(foundViaSchema).default([]),
  scale: scaleSchema.optional(),
  platformIds: z.record(z.string(), z.string()).optional(),
});

export const screenMapItemSchema = z.object({
  id: idSchema,
  productId: idSchema,
  screen: textSchema,
  entryPath: z.array(textSchema).default([]),
  source: z.enum(SCREEN_SOURCES),
  capture: z.enum(CAPTURE_STATES),
});

export const captureSchema = z.object({
  id: idSchema,
  productId: idSchema,
  screenMapId: idSchema.optional(),
  path: relativePathSchema.refine(
    (p) => IMAGE_EXTENSIONS.some((ext) => p.toLowerCase().endsWith(ext)),
    'jpg, png, webp 이미지만 쓴다',
  ),
  kind: z.enum(CAPTURE_KINDS),
  pii: z.enum(PII_STATES),
  /** 예: 유아이볼 수집 시점을 확인 못함 */
  sourceNote: z.string().optional(),
  label: z.string().optional(),
});

const premiseSchema = z.object({
  goalMetric: textSchema,
  scaleAssumption: z.string().optional(),
  structureConstraints: z.array(textSchema).default([]),
  pendingInputs: z.array(textSchema).default([]),
  evidenceLimits: z.array(textSchema).default([]),
  symbolLegend: z.string().default('◎ 강함, ○ 보통, △ 약함'),
});

const planSchema = z.object({
  /** 사용자가 조합을 확인한 시각. 확인 전에 캡처가 있으면 warnings에 오른다 */
  confirmedAt: z.string().datetime({ offset: true }).optional(),
  note: z.string().optional(),
});

const referenceSchema = z.object({
  id: idSchema,
  symbol: z.string().regex(/^[A-Z]$/, '기호는 대문자 한 글자'),
  typeName: textSchema,
  productIds: z.array(idSchema).min(1),
  /** 어떤 해법을 대표해서 골랐는지 한 줄 */
  reason: textSchema,
});

const mockupSchema = z.object({
  referenceId: idSchema,
  url: httpsUrlSchema.optional(),
  note: z.string().optional(),
});

const comparisonCellSchema = z.object({
  referenceId: idSchema,
  symbol: z.enum(COMPARISON_SYMBOLS).optional(),
  text: textSchema,
});

const comparisonRowSchema = z
  .object({
    phase: textSchema,
    criterion: textSchema,
    kind: z.enum(COMPARISON_ROW_KINDS).default('graded'),
    cells: z.array(comparisonCellSchema).min(1),
  })
  .superRefine((row, ctx) => {
    row.cells.forEach((cell, i) => {
      if (row.kind === 'graded' && !cell.symbol) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cells', i, 'symbol'],
          message: '기준 행의 칸에는 기호(◎○△)가 필요하다',
        });
      }
      if (row.kind !== 'graded' && cell.symbol) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cells', i, 'symbol'],
          message: '구현 부담과 위험 행에는 기호를 쓰지 않는다',
        });
      }
    });
  });

const bulletsSchema = z.array(textSchema).default([]);

const wowPainSchema = z.object({
  referenceId: idSchema,
  userWow: bulletsSchema,
  userPain: bulletsSchema,
  bizWow: bulletsSchema,
  bizPain: bulletsSchema,
});

const reasonSchema = z.object({
  referenceId: idSchema,
  business: textSchema,
  screens: textSchema,
  difference: textSchema,
  take: z.array(textSchema).default([]),
  skip: z.array(textSchema).default([]),
});

const judgmentSchema = z
  .object({
    area: textSchema,
    conclusion: textSchema,
    confidence: z.enum(CONFIDENCE_LEVELS),
    rationale: textSchema,
    /** 보류일 때 무엇이 정해지면 결정할 수 있는지 */
    holdUntil: z.string().optional(),
  })
  .superRefine((j, ctx) => {
    if (j.confidence === 'hold' && !j.holdUntil?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['holdUntil'],
        message: '보류에는 무엇이 정해지면 결정할 수 있는지(holdUntil)를 함께 쓴다',
      });
    }
  });

const verificationSchema = z.object({
  hypothesis: textSchema,
  metric: textSchema,
  splitBy: textSchema,
  caveat: z.string().optional(),
});

const openQuestionsSchema = z.object({
  recipient: textSchema,
  intro: textSchema,
  items: z
    .array(
      z.object({
        question: textSchema,
        temporary: textSchema,
        /** 답에 따라 바뀌는 시안이나 화면. 비면 우선순위를 못 매긴다 */
        affects: textSchema,
      }),
    )
    .default([]),
});

export const researchSchema = z
  .object({
    schemaVersion: z.literal(RESEARCH_SCHEMA_VERSION).default(RESEARCH_SCHEMA_VERSION),
    meta: z.object({
      slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'slug는 소문자, 숫자, -만 쓴다'),
      title: textSchema,
      task: textSchema,
      kind: z.enum(RESEARCH_KINDS),
    }),
    plan: planSchema.default({}),
    premise: premiseSchema,
    productCandidates: z.array(productCandidateSchema).default([]),
    screenMap: z.array(screenMapItemSchema).default([]),
    captures: z.array(captureSchema).default([]),
    references: z.array(referenceSchema).default([]),
    mockups: z.array(mockupSchema).default([]),
    comparison: z.array(comparisonRowSchema).default([]),
    wowPain: z
      .object({
        userViewpoint: z.string().default(''),
        bizViewpoint: z.string().default(''),
        items: z.array(wowPainSchema).default([]),
      })
      .default({}),
    reasons: z.array(reasonSchema).default([]),
    judgment: z.array(judgmentSchema).default([]),
    verification: z.array(verificationSchema).default([]),
    openQuestions: openQuestionsSchema.optional(),
  })
  .superRefine((r, ctx) => {
    const issue = (path: (string | number)[], message: string): void =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

    const checkUnique = (key: string, ids: string[]): void => {
      const seen = new Set<string>();
      ids.forEach((id, i) => {
        if (seen.has(id)) issue([key, i, 'id'], `id가 겹친다: ${id}`);
        seen.add(id);
      });
    };
    checkUnique(
      'productCandidates',
      r.productCandidates.map((p) => p.id),
    );
    checkUnique(
      'screenMap',
      r.screenMap.map((s) => s.id),
    );
    checkUnique(
      'captures',
      r.captures.map((c) => c.id),
    );
    checkUnique(
      'references',
      r.references.map((x) => x.id),
    );

    const products = new Set(r.productCandidates.map((p) => p.id));
    const screens = new Set(r.screenMap.map((s) => s.id));
    const refs = new Set(r.references.map((x) => x.id));

    r.screenMap.forEach((s, i) => {
      if (!products.has(s.productId))
        issue(['screenMap', i, 'productId'], `없는 제품: ${s.productId}`);
    });
    r.captures.forEach((c, i) => {
      if (!products.has(c.productId))
        issue(['captures', i, 'productId'], `없는 제품: ${c.productId}`);
      if (c.screenMapId && !screens.has(c.screenMapId)) {
        issue(['captures', i, 'screenMapId'], `없는 화면: ${c.screenMapId}`);
      }
    });
    r.references.forEach((x, i) => {
      x.productIds.forEach((pid, j) => {
        if (!products.has(pid)) issue(['references', i, 'productIds', j], `없는 제품: ${pid}`);
      });
    });
    const checkRef = (key: string, i: number, id: string): void => {
      if (!refs.has(id)) issue([key, i, 'referenceId'], `없는 레퍼런스: ${id}`);
    };
    r.mockups.forEach((m, i) => checkRef('mockups', i, m.referenceId));
    r.wowPain.items.forEach((w, i) => checkRef('wowPain.items', i, w.referenceId));
    r.reasons.forEach((x, i) => checkRef('reasons', i, x.referenceId));
    r.comparison.forEach((row, i) =>
      row.cells.forEach((cell, j) => {
        if (!refs.has(cell.referenceId)) {
          issue(['comparison', i, 'cells', j, 'referenceId'], `없는 레퍼런스: ${cell.referenceId}`);
        }
      }),
    );
  });

export type Research = z.infer<typeof researchSchema>;
export type ResearchInput = z.input<typeof researchSchema>;
export type ProductCandidate = z.infer<typeof productCandidateSchema>;
export type ScreenMapItem = z.infer<typeof screenMapItemSchema>;
export type Capture = z.infer<typeof captureSchema>;

export function parseResearch(input: unknown): Result<Research, ValidationError> {
  const parsed = researchSchema.safeParse(input);
  if (parsed.success) return ok(parsed.data);
  const issues = parsed.error.issues.map(
    (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
  return err(new ValidationError(`research.json 형식 오류: ${issues.join('; ')}`, issues));
}

export interface ResearchWarning {
  path: string;
  message: string;
}

/** 효과나 의도를 말하는 문장의 낌새 */
const EFFECT_PATTERN =
  /늘어|줄어|올라|높아|낮아|돌려|이탈|전환|효과|할 수 있|때문에|해서 .*(했|한다|하다)|려고|위해/;
/** 근거 표기. 해석, 회사 발언, 관찰 출처 중 하나가 문장 안에 있으면 통과 */
const EVIDENCE_TAG = /\(해석\)|\(회사 [^)]+\)|\((화면|영상|프레임) [^)]+\)|https?:\/\//;

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?。다요])\s+(?!\()|\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function lintEffectSentences(text: string, path: string, warnings: ResearchWarning[]): void {
  for (const sentence of sentencesOf(text)) {
    if (EFFECT_PATTERN.test(sentence) && !EVIDENCE_TAG.test(sentence)) {
      warnings.push({
        path,
        message: `효과나 의도를 말하는 문장에 (해석)이나 출처 표기가 없다: "${sentence.slice(0, 40)}"`,
      });
    }
  }
}

/**
 * 스키마로 못 잡는 의미 검사. 막지는 않고 경고만 돌려준다.
 * 효과 문장의 근거 표기, 레퍼런스 개수, 캡처 상태, 조합 확인 여부를 본다.
 */
export function lintResearch(research: Research): ResearchWarning[] {
  const warnings: ResearchWarning[] = [];

  if (
    research.references.length > 0 &&
    (research.references.length < 3 || research.references.length > 5)
  ) {
    warnings.push({
      path: 'references',
      message: `레퍼런스 유형은 3~5개를 권한다 (지금 ${research.references.length}개)`,
    });
  }

  if (research.captures.length > 0 && !research.plan.confirmedAt) {
    warnings.push({
      path: 'plan.confirmedAt',
      message: '조합을 확인받기 전에 캡처가 쌓였다',
    });
  }

  research.captures.forEach((c, i) => {
    if (c.pii === 'unchecked') {
      warnings.push({
        path: `captures.${i}.pii`,
        message: `개인정보 확인을 못 한 캡처다 (${c.id}). 공유용 렌더가 막힌다`,
      });
    }
  });

  const captured = new Set(research.captures.map((c) => c.screenMapId).filter(Boolean));
  research.screenMap.forEach((s, i) => {
    if ((s.capture === 'captured' || s.capture === 'reference-image') && !captured.has(s.id)) {
      warnings.push({
        path: `screenMap.${i}.capture`,
        message: `캡처 상태가 ${s.capture}인데 연결된 캡처가 없다 (${s.id})`,
      });
    }
  });

  research.reasons.forEach((r, i) => {
    for (const key of ['business', 'screens', 'difference'] as const) {
      lintEffectSentences(r[key], `reasons.${i}.${key}`, warnings);
    }
    const flat = [...r.take, ...r.skip];
    flat.forEach((t, j) => lintEffectSentences(t, `reasons.${i}.take_skip.${j}`, warnings));
  });
  research.judgment.forEach((j, i) => {
    lintEffectSentences(j.rationale, `judgment.${i}.rationale`, warnings);
  });
  research.wowPain.items.forEach((w, i) => {
    [...w.bizWow, ...w.bizPain].forEach((b, j) =>
      lintEffectSentences(b, `wowPain.items.${i}.biz.${j}`, warnings),
    );
    (['userWow', 'userPain', 'bizWow', 'bizPain'] as const).forEach((key) => {
      if (w[key].length !== 2) {
        warnings.push({
          path: `wowPain.items.${i}.${key}`,
          message: `칸마다 불릿 2개를 쓴다 (지금 ${w[key].length}개)`,
        });
      }
    });
  });
  research.comparison.forEach((row, i) => {
    if (row.kind !== 'risk') return;
    row.cells.forEach((cell, j) =>
      lintEffectSentences(cell.text, `comparison.${i}.cells.${j}`, warnings),
    );
  });

  if (!research.openQuestions || research.openQuestions.items.length === 0) {
    warnings.push({
      path: 'openQuestions',
      message: '열린 질문 섹션이 비어 있다. 마지막 섹션이라 꼭 둔다',
    });
  }
  return warnings;
}
