import { z } from 'zod';
import { ValidationError } from '../core/errors.js';
import { err, ok, type Result } from '../core/result.js';
import { basisFields, checkBasis, evidenceListSchema, type EvidenceRef } from './evidence.js';
import { httpsUrlSchema, idSchema, textSchema } from './schema-base.js';
import { hasUsableBaseline, lintTarget, targetSchema } from './target.js';

/** 새 필드는 전부 선택이라 1.0.0 문서가 그대로 읽힌다 */
export const RESEARCH_SCHEMA_VERSION = '1.0.0';

/** design.md 2.1절의 경우 5개. video-analysis는 영상 블록만 채우는 단독 문서다 */
export const RESEARCH_KINDS = [
  'ux-research',
  'screens-only',
  'reverse-plan',
  'market-scan',
  'video-analysis',
] as const;
/** own-service: 조사하는 쪽 우리 서비스. 비교표에는 열로 들어가지만 레퍼런스처럼 가져올 대상은 아니다 */
export const PRODUCT_AXES = ['same-market', 'same-problem', 'own-service'] as const;
export const SCREEN_SOURCES = [
  'app-explore',
  'uibowl',
  'site-search',
  'youtube',
  'store-screenshot',
  'tech-blog',
  'own-app',
  'own-web',
  'figma',
  'none',
] as const;
export const CAPTURE_STATES = [
  'captured',
  'reference-image',
  'stopped-before-payment',
  'not-captured',
] as const;
export const CAPTURE_KINDS = [
  'direct',
  'reference-db',
  'video-frame',
  'store',
  'own-app',
  'own-web',
  'figma',
] as const;
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
export const VIDEO_KINDS = ['screen-recording', 'seminar', 'mixed'] as const;
/** public: 공개된 영상. recorded: 직접 화면을 녹화한 영상 */
export const VIDEO_ORIGINS = ['public', 'recorded'] as const;
/** 제품별 흐름, 구좌별, 유형별, 종합. design.md 8.2절의 묶음 순서다 */
export const VIDEO_GROUPS = ['flow', 'slot', 'type', 'summary'] as const;
export const VIDEO_NATURES = ['direction', 'convention'] as const;
export const VIDEO_CADENCES = ['always', 'seasonal', 'exclusive'] as const;
export const COMPARISON_SYMBOLS = ['◎', '○', '△'] as const;
export const COMPARISON_ROW_KINDS = ['graded', 'burden', 'risk'] as const;
/** 구좌 행이 5사에서 같은 방식인지(common), 갈리는지(split), 한 곳만 하는지(unique) */
export const COMPARISON_PATTERNS = ['common', 'split', 'unique'] as const;
export const FINDING_KINDS = ['wow', 'pain', 'insight', 'design'] as const;
export const FINDING_VIEWPOINTS = ['user', 'biz'] as const;
/** immediate: 지금 정할 수 있다. data: 데이터를 봐야 한다. other-team: 다른 직군이 확인한다 */
export const QUESTION_OWNERS = ['immediate', 'data', 'other-team'] as const;
export const ADOPTION_STATUSES = ['adopted', 'candidate', 'rejected'] as const;
export const SCREEN_PLATFORMS = ['ios', 'aos', 'web'] as const;
/** 화면 사이 전이를 일으키는 사용자 행동 */
export const GESTURES = ['tap', 'swipe', 'drag', 'scroll', 'press', 'pan', 'input'] as const;
/** found: 찾음. partial: 일부만 찾음. not-found: 못 찾음. too-many: 너무 많아 고르지 못함 */
export const ATTEMPT_RESULTS = ['found', 'partial', 'not-found', 'too-many'] as const;
export const CONFIDENCE_LEVELS = ['likely', 'trial', 'hold', 'out'] as const;
export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'] as const;

/** 리서치 폴더 밖으로 나가는 경로를 막는다. 공유용 HTML에 임의 파일이 실리는 길이기도 하다 */
export function isSafeRelativePath(path: string): boolean {
  if (path.includes('\0') || path.includes('\\')) return false;
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  return !path.split('/').some((part) => part === '..' || part === '');
}

const relativePathSchema = z
  .string()
  .refine(isSafeRelativePath, '리서치 폴더 안의 상대 경로만 쓴다 (절대 경로, .. 불가)');

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
  platform: z.enum(SCREEN_PLATFORMS).optional(),
  /** 흐름 표에서 화면이 나오는 순서. 없으면 screenMap 배열 순서 */
  order: z.number().int().nonnegative().optional(),
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
  /** 캡처 아래에 붙는 한 줄. "번호. 제목 — 요소 나열" 꼴 */
  caption: z.string().optional(),
  /** 영상이나 스토어 원본에서 몇 번째 프레임인지. 근거 표기 "(프레임 08)"에 쓴다 */
  frameNo: z.string().optional(),
  /** kind가 figma일 때 화면을 읽어 온 노드 링크. 근거를 되짚을 때 쓴다 */
  figmaUrl: httpsUrlSchema
    .refine((u) => /(^|\.)figma\.com$/.test(new URL(u).hostname), 'figma.com 링크만 쓴다')
    .optional(),
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

const comparisonCellSchema = z
  .object({
    referenceId: idSchema,
    symbol: z.enum(COMPARISON_SYMBOLS).optional(),
    text: textSchema,
    ...basisFields,
    /** 근거 상태는 선택이다. 없으면 lint가 한 번 알린다 */
    basis: basisFields.basis.optional(),
    /** 이 칸의 대표 화면. 썸네일로 그려진다 */
    captureIds: z.array(idSchema).default([]),
  })
  .superRefine(checkBasis);

const comparisonRowSchema = z
  .object({
    phase: textSchema,
    criterion: textSchema,
    /** 구좌 한 줄 정의. 격자의 회색 글자 */
    definition: z.string().optional(),
    pattern: z.enum(COMPARISON_PATTERNS).optional(),
    kind: z.enum(COMPARISON_ROW_KINDS).default('graded'),
    cells: z.array(comparisonCellSchema).min(1),
  })
  .superRefine((row, ctx) => {
    row.cells.forEach((cell, i) => {
      const ungraded = cell.basis === 'unconfirmed' || cell.basis === 'absent';
      if (row.kind === 'graded' && !cell.symbol && !ungraded) {
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

/** 화면이나 구좌에 걸린 발견 하나. 2×2 불릿과 달리 근거와 조작 구체값을 단다 */
export const findingSchema = z
  .object({
    id: idSchema,
    referenceId: idSchema,
    kind: z.enum(FINDING_KINDS),
    viewpoint: z.enum(FINDING_VIEWPOINTS),
    text: textSchema,
    /** 비교표의 구좌 이름이나 시나리오 단계 */
    slot: z.string().optional(),
    captureId: idSchema.optional(),
    screenMapId: idSchema.optional(),
    /** 조작 횟수나 수치. 예: "20명 입력하려면 19번 터치" */
    concrete: z.string().optional(),
    /** 이번 시안에서 다루지 않는 페인이면 그 이유. 적으면 안 풀린 페인 경고에서 빠진다 */
    excludedReason: z.string().optional(),
    ...basisFields,
  })
  .superRefine(checkBasis);

const adoptionSchema = z
  .object({
    id: idSchema,
    /** 시안 이름. 예: "A" */
    variant: textSchema,
    referenceIds: z.array(idSchema).default([]),
    status: z.enum(ADOPTION_STATUSES),
    /** 시안이 얹히는 자리. 레퍼런스에서 가져온 시안이 아니라 어디에 넣을지를 고르는 안이면 여기에 적는다 */
    placement: z.string().optional(),
    /** 가져온 것과 덜어낸 것. 시안 카드에 그대로 오른다 */
    adopted: z.array(textSchema).default([]),
    mitigated: z.array(textSchema).default([]),
    /** 가져오는 와우(findings)와 푸는 페인(findings) */
    takesFindingIds: z.array(idSchema).default([]),
    solvesFindingIds: z.array(idSchema).default([]),
    /** 채택하지 않은 이유. rejected면 필수 */
    reason: z.string().optional(),
  })
  .superRefine((a, ctx) => {
    if (a.status === 'rejected' && !a.reason?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: '채택하지 않은 항목에는 이유(reason)를 적는다',
      });
    }
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
    /** 우선순위. 1이 가장 먼저 */
    rank: z.number().int().positive().optional(),
    /** 이 판단 뒤에 할 일 */
    todo: z.string().optional(),
    evidence: evidenceListSchema,
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

/** 다른 회사가 공개한 지표 사례. 성공 기준과 표본 가정을 정할 때 근거로 쓴다 */
export const metricCaseSchema = z
  .object({
    id: idSchema,
    /** 회사나 서비스 이름 */
    company: textSchema,
    /** 제품 후보에 있는 회사면 그 id */
    productId: idSchema.optional(),
    metric: textSchema,
    /** 무엇 대비 비율인지. 비율 값인데 비어 있으면 경고한다 */
    denominator: z.string().optional(),
    /** 값이나 변화. 예: "12%에서 18%로" */
    value: textSchema,
    /** 무엇을 바꿔서 나온 값인지 */
    change: z.string().optional(),
    /** 언제의 값인지 */
    period: z.string().optional(),
    ...basisFields,
  })
  .superRefine(checkBasis);

const verificationSchema = z.object({
  hypothesis: textSchema,
  metric: textSchema,
  splitBy: textSchema,
  /** 성공 기준과 표본 가정의 근거로 삼은 지표 사례 */
  metricCaseIds: z.array(idSchema).default([]),
  /** 누구를 몇 명쯤 볼지. 사용성 시험이면 인원, 로그 지표면 대상 집단 */
  sample: z.string().optional(),
  /** 얼마 동안 볼지 */
  period: z.string().optional(),
  /** 맞았다고 판정하는 기준. 이게 없으면 결과가 나와도 가설을 판정할 수 없다 */
  successCriteria: z.string().optional(),
  /** 성공하면 목표 지표가 몇 %p 오를지. 목표 지표를 안 움직이는 가설은 비운다 */
  expectedLiftPp: z.number().positive().optional(),
  /** 이 가설을 재는 이벤트. target.trackingPlan에서 상태를 본다 */
  events: z.array(textSchema).default([]),
  caveat: z.string().optional(),
});

export const videoClipSchema = z.object({
  id: idSchema,
  productId: idSchema,
  title: textSchema,
  kind: z.enum(VIDEO_KINDS),
  origin: z.enum(VIDEO_ORIGINS),
  url: httpsUrlSchema.optional(),
  durationSec: z.number().nonnegative().optional(),
});

export const videoFindingSchema = z.object({
  clipId: idSchema,
  group: z.enum(VIDEO_GROUPS),
  /** 구좌 이름이나 유형 이름처럼 묶음 안에서 가르는 말 */
  topic: textSchema,
  text: textSchema,
  /** 영상에서 본 시각(초). 관찰과 회사 발언은 출처를 남기려고 꼭 적는다 */
  at: z.number().nonnegative().optional(),
  /** 이 발견이 나온 프레임. 캡처 이미지는 1번 섹션 캡처에 있다 */
  captureId: idSchema.optional(),
  evidence: z.enum(EVIDENCE_KINDS),
  /** 방향성(회사가 가려는 쪽)인지 관례(업계가 하는 쪽)인지 */
  nature: z.enum(VIDEO_NATURES).optional(),
  /** 상시, 분기, 단독 중 어느 쪽 노출인지 */
  cadence: z.enum(VIDEO_CADENCES).optional(),
});

const videoSchema = z.object({
  clips: z.array(videoClipSchema).default([]),
  findings: z.array(videoFindingSchema).default([]),
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
        /** 누가 확인해야 풀리는지 */
        owner: z.enum(QUESTION_OWNERS).optional(),
        /** 다른 직군이면 어느 쪽인지. 예: 개발팀, 법무 */
        ownerNote: z.string().optional(),
      }),
    )
    .default([]),
});

/** 화면 A에서 B로 가는 사용자 행동 하나. 역기획의 빨간 화살표 */
const transitionSchema = z
  .object({
    id: idSchema,
    from: idSchema,
    to: idSchema,
    /** 예: "상품 카드 탭" */
    trigger: textSchema,
    gesture: z.enum(GESTURES),
    /** 분기 조건. 예: "로그인 상태" */
    condition: z.string().optional(),
    /** 같은 화면으로 되돌아오는 반복. 반복 비용을 note에 적는다 */
    loop: z.boolean().optional(),
    ...basisFields,
  })
  .superRefine(checkBasis);

/** 화면 위 번호 표시 하나. 기획서의 "1", "3-1" 같은 마커 */
const markerSchema = z.object({
  id: idSchema,
  screenMapId: idSchema,
  /** 화면 안에서 겹치지 않는 번호. 하위 팝업은 "3-1" 꼴 */
  no: textSchema,
  element: textSchema,
  /** "트리거 탭 시 → 결과" 꼴 */
  behavior: textSchema,
  /** 개수 상한 같은 제약 */
  limit: z.string().optional(),
  parentId: idSchema.optional(),
});

/** 무언가를 찾으려고 해본 기록. 실패도 결과로 남긴다 */
const attemptSchema = z.object({
  id: idSchema,
  referenceId: idSchema.optional(),
  what: textSchema,
  result: z.enum(ATTEMPT_RESULTS),
  text: textSchema,
  limit: z.string().optional(),
  captureIds: z.array(idSchema).default([]),
});

/** 사람이 입력하는 사용자 유형 카드. 도구는 인터뷰를 하지 못한다 */
const userTypeSchema = z.object({
  id: idSchema,
  name: textSchema,
  summary: textSchema,
  /** 인터뷰 자료의 이름. 내용은 옮기지 않는다 */
  source: textSchema,
});

const flowSchema = z
  .object({
    transitions: z.array(transitionSchema).default([]),
    markers: z.array(markerSchema).default([]),
    attempts: z.array(attemptSchema).default([]),
    userTypes: z.array(userTypeSchema).default([]),
  })
  .default({});

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
    /** 목표치를 기존 데이터에서 세운 근거. 0번 전제에 그린다 */
    target: targetSchema.optional(),
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
        findings: z.array(findingSchema).default([]),
      })
      .default({}),
    /** 시안이 리서치의 무엇을 가져오고 푸는지. 와우와 페인에서 시안으로 이어지는 선 */
    adoptions: z.array(adoptionSchema).default([]),
    /** 화면 전이, 번호 마커, 시도 기록, 사용자 유형. 역기획에서 채운다 */
    flow: flowSchema,
    reasons: z.array(reasonSchema).default([]),
    judgment: z.array(judgmentSchema).default([]),
    /** 다른 회사의 지표 사례. 7번 검증 제안의 근거가 된다 */
    metricCases: z.array(metricCaseSchema).default([]),
    verification: z.array(verificationSchema).default([]),
    openQuestions: openQuestionsSchema.optional(),
    /** 영상 분석. 본문에 합쳐 쓰거나 video-analysis 문서로 따로 쓴다 */
    video: videoSchema.optional(),
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
    checkUnique(
      'metricCases',
      r.metricCases.map((m) => m.id),
    );
    checkUnique(
      'video.clips',
      (r.video?.clips ?? []).map((c) => c.id),
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
    const clips = new Map((r.video?.clips ?? []).map((c) => [c.id, c]));
    const capturesById = new Map(r.captures.map((c) => [c.id, c]));
    (r.video?.clips ?? []).forEach((c, i) => {
      if (!products.has(c.productId))
        issue(['video', 'clips', i, 'productId'], `없는 제품: ${c.productId}`);
    });
    (r.video?.findings ?? []).forEach((f, i) => {
      const clip = clips.get(f.clipId);
      if (!clip) issue(['video', 'findings', i, 'clipId'], `없는 영상: ${f.clipId}`);
      if (f.at === undefined && f.evidence !== 'interpretation') {
        issue(['video', 'findings', i, 'at'], '관찰과 회사 발언은 영상 시각(초)을 적는다');
      }
      if (f.captureId) {
        const cap = capturesById.get(f.captureId);
        if (!cap) issue(['video', 'findings', i, 'captureId'], `없는 캡처: ${f.captureId}`);
        else if (clip && cap.productId !== clip.productId) {
          issue(['video', 'findings', i, 'captureId'], '영상과 캡처의 제품이 다르다');
        }
      }
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

    const checkEvidence = (path: (string | number)[], list: EvidenceRef[]): void => {
      list.forEach((ev, k) => {
        if (ev.type === 'capture' && !capturesById.has(ev.captureId)) {
          issue([...path, k, 'captureId'], `없는 캡처: ${ev.captureId}`);
        }
        if (ev.type === 'video' && !clips.has(ev.clipId)) {
          issue([...path, k, 'clipId'], `없는 영상: ${ev.clipId}`);
        }
      });
    };
    r.comparison.forEach((row, i) =>
      row.cells.forEach((cell, j) => {
        const base = ['comparison', i, 'cells', j];
        checkEvidence([...base, 'evidence'], cell.evidence);
        cell.captureIds.forEach((id, k) => {
          if (!capturesById.has(id)) issue([...base, 'captureIds', k], `없는 캡처: ${id}`);
        });
      }),
    );
    r.judgment.forEach((j, i) => checkEvidence(['judgment', i, 'evidence'], j.evidence));

    checkUnique(
      'wowPain.findings',
      r.wowPain.findings.map((f) => f.id),
    );
    r.wowPain.findings.forEach((f, i) => {
      checkRef('wowPain.findings', i, f.referenceId);
      checkEvidence(['wowPain', 'findings', i, 'evidence'], f.evidence);
      if (f.captureId && !capturesById.has(f.captureId)) {
        issue(['wowPain', 'findings', i, 'captureId'], `없는 캡처: ${f.captureId}`);
      }
      if (f.screenMapId && !screens.has(f.screenMapId)) {
        issue(['wowPain', 'findings', i, 'screenMapId'], `없는 화면: ${f.screenMapId}`);
      }
    });

    checkUnique(
      'adoptions',
      r.adoptions.map((a) => a.id),
    );
    const findingIds = new Set(r.wowPain.findings.map((f) => f.id));
    r.adoptions.forEach((a, i) => {
      a.referenceIds.forEach((id, k) => {
        if (!refs.has(id)) issue(['adoptions', i, 'referenceIds', k], `없는 레퍼런스: ${id}`);
      });
      for (const key of ['takesFindingIds', 'solvesFindingIds'] as const) {
        a[key].forEach((id, k) => {
          if (!findingIds.has(id)) issue(['adoptions', i, key, k], `없는 발견: ${id}`);
        });
      }
    });

    const caseIds = new Set(r.metricCases.map((m) => m.id));
    r.metricCases.forEach((m, i) => {
      if (m.productId && !products.has(m.productId)) {
        issue(['metricCases', i, 'productId'], `없는 제품: ${m.productId}`);
      }
      checkEvidence(['metricCases', i, 'evidence'], m.evidence);
    });
    if (r.target) {
      const t = r.target;
      checkUnique(
        'target.steps',
        t.steps.map((s) => s.id),
      );
      checkEvidence(['target', 'baseline', 'evidence'], t.baseline.evidence);
      if (t.dailyEntrants) {
        checkEvidence(['target', 'dailyEntrants', 'evidence'], t.dailyEntrants.evidence);
      }
      t.steps.forEach((s, i) => checkEvidence(['target', 'steps', i, 'evidence'], s.evidence));
    }
    r.verification.forEach((v, i) => {
      v.metricCaseIds.forEach((id, k) => {
        if (!caseIds.has(id))
          issue(['verification', i, 'metricCaseIds', k], `없는 지표 사례: ${id}`);
      });
    });

    checkUnique(
      'flow.transitions',
      r.flow.transitions.map((t) => t.id),
    );
    checkUnique(
      'flow.markers',
      r.flow.markers.map((m) => m.id),
    );
    checkUnique(
      'flow.attempts',
      r.flow.attempts.map((a) => a.id),
    );
    checkUnique(
      'flow.userTypes',
      r.flow.userTypes.map((u) => u.id),
    );
    r.flow.transitions.forEach((t, i) => {
      for (const key of ['from', 'to'] as const) {
        if (!screens.has(t[key])) issue(['flow', 'transitions', i, key], `없는 화면: ${t[key]}`);
      }
      checkEvidence(['flow', 'transitions', i, 'evidence'], t.evidence);
    });
    const markerIds = new Set(r.flow.markers.map((m) => m.id));
    const markerNos = new Set<string>();
    r.flow.markers.forEach((m, i) => {
      if (!screens.has(m.screenMapId)) {
        issue(['flow', 'markers', i, 'screenMapId'], `없는 화면: ${m.screenMapId}`);
      }
      if (m.parentId && !markerIds.has(m.parentId)) {
        issue(['flow', 'markers', i, 'parentId'], `없는 마커: ${m.parentId}`);
      }
      const key = `${m.screenMapId}#${m.no}`;
      if (markerNos.has(key))
        issue(['flow', 'markers', i, 'no'], `화면 안에서 번호가 겹친다: ${m.no}`);
      markerNos.add(key);
    });
    r.flow.attempts.forEach((a, i) => {
      if (a.referenceId) checkRef('flow.attempts', i, a.referenceId);
      a.captureIds.forEach((id, k) => {
        if (!capturesById.has(id))
          issue(['flow', 'attempts', i, 'captureIds', k], `없는 캡처: ${id}`);
      });
    });
  });

export type Research = z.infer<typeof researchSchema>;
export type ResearchInput = z.input<typeof researchSchema>;
export type MetricCase = z.infer<typeof metricCaseSchema>;

/** 못 찾았거나 없다고 확인한 사례는 근거로 못 쓴다 */
export function isUsableMetricCase(m: MetricCase): boolean {
  return m.basis !== 'unconfirmed' && m.basis !== 'absent';
}

/** 근거로 쓸 수 있는 지표 사례를 제품별로 묶는다. 레퍼런스 표에 지표가 있는 제품을 드러낼 때 쓴다 */
export function metricCasesByProduct(research: Research): Map<string, MetricCase[]> {
  const byProduct = new Map<string, MetricCase[]>();
  for (const m of research.metricCases) {
    if (!m.productId || !isUsableMetricCase(m)) continue;
    byProduct.set(m.productId, [...(byProduct.get(m.productId) ?? []), m]);
  }
  return byProduct;
}
export type ProductCandidate = z.infer<typeof productCandidateSchema>;
export type ScreenMapItem = z.infer<typeof screenMapItemSchema>;
export type Transition = z.infer<typeof transitionSchema>;
export type Marker = z.infer<typeof markerSchema>;
export type Attempt = z.infer<typeof attemptSchema>;
export type UserType = z.infer<typeof userTypeSchema>;
export type Capture = z.infer<typeof captureSchema>;
export type VideoClip = z.infer<typeof videoClipSchema>;
export type VideoFinding = z.infer<typeof videoFindingSchema>;
export type Finding = z.infer<typeof findingSchema>;
export type Adoption = z.infer<typeof adoptionSchema>;

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

/** 못 봤다고 말하는 문장의 낌새 */
const UNCONFIRMED_PATTERN = /확인 못|확인하지 못|확인되지 않|리서치에 없/;
const DIGIT = /\d/;

/** 와우와 페인이 비었거나 근거 상태가 비어 있는 자리를 본다. 근거 구조(basis, evidence)가 있어야 걸린다 */
function lintEvidenceStructure(research: Research, warnings: ResearchWarning[]): void {
  const { references, comparison, wowPain, adoptions, openQuestions } = research;
  const needsWowPain = ['ux-research', 'reverse-plan', 'market-scan'].includes(research.meta.kind);

  if (needsWowPain) {
    for (const ref of references) {
      const items = wowPain.items.filter((w) => w.referenceId === ref.id);
      const found = wowPain.findings.filter((f) => f.referenceId === ref.id);
      const wow =
        found.filter((f) => f.kind === 'wow').length +
        items.reduce((n, w) => n + w.userWow.length + w.bizWow.length, 0);
      const pain =
        found.filter((f) => f.kind === 'pain').length +
        items.reduce((n, w) => n + w.userPain.length + w.bizPain.length, 0);
      if (wow === 0 || pain === 0) {
        warnings.push({
          path: 'wowPain',
          message: `${ref.symbol}. ${ref.typeName}에 ${wow === 0 ? '와우' : '페인'} 포인트가 하나도 없다. 못 찾았으면 못 찾았다고 근거 상태(unconfirmed)로 적는다`,
        });
      }
    }
  }

  research.flow.transitions.forEach((t, i) => {
    if (t.loop && !t.note?.trim()) {
      warnings.push({
        path: `flow.transitions.${i}`,
        message: `반복 전이(${t.id})에 반복 비용이 없다. note에 "몇 번 되풀이하는지"를 적는다`,
      });
    }
  });

  wowPain.findings.forEach((f, i) => {
    const path = `wowPain.findings.${i}`;
    if (f.kind === 'pain' && f.basis === 'observation' && !f.concrete && !DIGIT.test(f.text)) {
      warnings.push({
        path,
        message: `본 페인에 조작 횟수나 수치가 없다 (${f.id}). concrete에 "몇 번 눌러야 하는지" 같은 값을 적는다`,
      });
    }
    if (
      f.slot &&
      comparison.length > 0 &&
      (f.kind === 'wow' || f.kind === 'pain') &&
      !comparison.some((row) => row.criterion === f.slot)
    ) {
      warnings.push({
        path: `${path}.slot`,
        message: `구좌 "${f.slot}"가 비교표 기준 이름과 달라 격자 칸에 안 붙는다 (${f.id}). 비교표의 기준 이름과 똑같이 적는다`,
      });
    }
    if (UNCONFIRMED_PATTERN.test(f.text) && f.basis !== 'unconfirmed') {
      warnings.push({
        path: `${path}.basis`,
        message: `확인 못했다고 적었는데 근거 상태가 ${f.basis}이다 (${f.id})`,
      });
    }
  });

  if (references.length > 0 && comparison.length > 0) {
    let noBasis = 0;
    comparison.forEach((row, i) => {
      const present = new Set(row.cells.map((c) => c.referenceId));
      const missing = references.filter((r) => !present.has(r.id));
      if (missing.length > 0) {
        warnings.push({
          path: `comparison.${i}.cells`,
          message: `${row.criterion} 행에 빠진 칸이 있다 (${missing.map((r) => r.symbol).join(', ')}). 못 본 칸은 빈칸으로 두지 않고 "확인 못함"과 이유를 적는다`,
        });
      }
      row.cells.forEach((cell, j) => {
        if (!cell.basis) noBasis++;
        if (UNCONFIRMED_PATTERN.test(cell.text) && cell.basis && cell.basis !== 'unconfirmed') {
          warnings.push({
            path: `comparison.${i}.cells.${j}.basis`,
            message: `확인 못했다고 적었는데 근거 상태가 ${cell.basis}이다 (${row.criterion})`,
          });
        }
      });
    });
    if (noBasis > 0) {
      warnings.push({
        path: 'comparison',
        message: `비교표 칸 ${noBasis}개에 근거 상태(basis)가 없다. 관찰, 회사 발언, 해석, 확인 못함, 없음 중 하나를 정한다`,
      });
    }
  }

  if (adoptions.length > 0) {
    adoptions.forEach((a, i) => {
      if (a.referenceIds.length === 0 && !a.placement?.trim()) {
        warnings.push({
          path: `adoptions.${i}`,
          message: `레퍼런스도 자리도 없는 시안이다 (${a.id}). 어디서 가져왔는지(referenceIds)나 어디에 넣는지(placement)를 적는다`,
        });
      }
    });
    const solved = new Set(adoptions.flatMap((a) => a.solvesFindingIds));
    wowPain.findings.forEach((f, i) => {
      if (f.kind !== 'pain') return;
      const excluded = Boolean(f.excludedReason?.trim());
      if (!solved.has(f.id) && !excluded) {
        warnings.push({
          path: `wowPain.findings.${i}`,
          message: `어느 시안도 풀지 않는 페인이다 (${f.id}). 시안의 solvesFindingIds에 걸거나 제외 이유(excludedReason)를 적는다`,
        });
      }
      if (solved.has(f.id) && excluded) {
        warnings.push({
          path: `wowPain.findings.${i}.excludedReason`,
          message: `푸는 시안이 있는데 제외 이유도 적힌 페인이다 (${f.id}). 둘 중 하나만 남긴다`,
        });
      }
    });
  }

  const items = openQuestions?.items ?? [];
  const noOwner = items.filter((q) => !q.owner).length;
  if (noOwner > 0) {
    warnings.push({
      path: 'openQuestions.items',
      message: `질문 ${noOwner}개에 확인 주체(owner)가 없다. 바로 정할 것, 데이터를 봐야 할 것, 다른 직군이 확인할 것으로 나눈다`,
    });
  }
}

// 전환율, 이탈률처럼 이름에 율이나 률이 붙은 지표도 비율로 본다
const RATE_PATTERN = /%|퍼센트|[율률]/;

/** 지표 사례가 성공 기준의 근거로 쓰일 수 있는지 본다 */
function lintMetricCases(research: Research, warnings: ResearchWarning[]): void {
  const { metricCases, verification } = research;
  // 기준값을 우리 데이터로 채웠으면 타사 사례는 교차 확인용이라 없어도 경고하지 않는다
  const crossCheckOnly = hasUsableBaseline(research);
  if (!crossCheckOnly && verification.length > 0 && metricCases.length === 0) {
    warnings.push({
      path: 'metricCases',
      message:
        '타사 지표 사례가 없다. 성공 기준과 표본 가정의 근거가 된다. 찾지 못했으면 basis를 unconfirmed로 두고 이유를 남긴다',
    });
  }
  metricCases.forEach((m, i) => {
    if (RATE_PATTERN.test(`${m.metric} ${m.value}`) && !m.denominator?.trim()) {
      warnings.push({
        path: `metricCases.${i}.denominator`,
        message: `분모가 없는 비율 사례다 (${m.id}). 무엇 대비 비율인지 모르면 우리 지표와 견줄 수 없다`,
      });
    }
  });
  const usable = metricCases.some(isUsableMetricCase);
  if (!usable || crossCheckOnly) return;
  verification.forEach((v, i) => {
    if (v.successCriteria?.trim() && v.metricCaseIds.length === 0) {
      warnings.push({
        path: `verification.${i}.metricCaseIds`,
        message: `지표 사례를 걸지 않은 성공 기준이다 (가설 ${i + 1}). 근거로 삼은 사례를 metricCaseIds에 건다`,
      });
    }
  });
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

  research.verification.forEach((v, i) => {
    if (!v.successCriteria?.trim()) {
      warnings.push({
        path: `verification.${i}`,
        message: `성공 기준이 없는 가설이다 (가설 ${i + 1}). 어떤 값이 나오면 맞았다고 볼지(successCriteria)를 적는다`,
      });
    }
  });
  lintMetricCases(research, warnings);

  const ownProducts = new Set(
    research.productCandidates.filter((p) => p.axis === 'own-service').map((p) => p.id),
  );
  if (ownProducts.size > 1) {
    warnings.push({
      path: 'products',
      message: `우리 서비스(own-service)는 하나만 둔다 (지금 ${ownProducts.size}개)`,
    });
  }
  research.captures.forEach((c, i) => {
    const ownKind = c.kind === 'own-app' || c.kind === 'own-web' || c.kind === 'figma';
    if (ownKind !== ownProducts.has(c.productId)) {
      warnings.push({
        path: `captures.${i}.kind`,
        message: ownKind
          ? `${c.kind} 캡처는 own-service 제품에만 붙인다 (${c.id})`
          : `own-service 제품의 캡처는 own-app, own-web, figma 중 하나로 적는다 (${c.id})`,
      });
    }
    if (c.kind === 'figma' && !c.figmaUrl) {
      warnings.push({
        path: `captures.${i}.figmaUrl`,
        message: `figma 캡처에 노드 링크가 없다 (${c.id}). 어느 프레임인지 되짚을 수 없다`,
      });
    }
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

  lintEvidenceStructure(research, warnings);
  lintTarget(research, warnings);

  const video = research.video;
  if (research.meta.kind === 'video-analysis' && (!video || video.clips.length === 0)) {
    warnings.push({ path: 'video.clips', message: '영상 분석 문서인데 영상이 하나도 없다' });
  }
  if (video) {
    const withFindings = new Set(video.findings.map((f) => f.clipId));
    video.clips.forEach((c, i) => {
      if (!withFindings.has(c.id)) {
        warnings.push({
          path: `video.clips.${i}`,
          message: `발견이 하나도 없는 영상이다 (${c.id})`,
        });
      }
    });
  }

  const openQuestionsOptional = research.meta.kind === 'video-analysis';
  if (
    !openQuestionsOptional &&
    (!research.openQuestions || research.openQuestions.items.length === 0)
  ) {
    warnings.push({
      path: 'openQuestions',
      message: '열린 질문 섹션이 비어 있다. 마지막 섹션이라 꼭 둔다',
    });
  }
  return warnings;
}
