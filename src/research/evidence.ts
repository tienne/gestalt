import { z } from 'zod';
import { httpsUrlSchema, idSchema, textSchema } from './schema-base.js';

/**
 * 한 칸이나 한 문장의 근거 상태.
 * observation: 화면이나 영상에서 본 것. company-statement: 회사가 직접 말한 것. interpretation: 우리 해석.
 * unconfirmed: 못 봐서 비워 둔 칸. absent: 없다고 확인한 것. 둘 다 이유(note)를 적는다
 */
export const BASIS_KINDS = [
  'observation',
  'company-statement',
  'interpretation',
  'unconfirmed',
  'absent',
] as const;
export type BasisKind = (typeof BASIS_KINDS)[number];

/** 출처를 가리키는 한 줄. 캡처와 영상은 같은 문서 안의 id로, 내부 자료는 사람이 적은 이름으로 건다 */
export const evidenceRefSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('capture'), captureId: idSchema }),
  z.object({ type: z.literal('video'), clipId: idSchema, at: z.number().nonnegative() }),
  z.object({ type: z.literal('internal'), source: textSchema }),
  z.object({ type: z.literal('url'), url: httpsUrlSchema }),
]);
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

export const evidenceListSchema = z.array(evidenceRefSchema).default([]);

/** 근거를 달고 다니는 칸이 공통으로 가지는 필드 */
export const basisFields = {
  basis: z.enum(BASIS_KINDS),
  evidence: evidenceListSchema,
  /** 못 본 이유나 없다고 확인한 방법 */
  note: z.string().optional(),
};

interface BasisCarrier {
  basis?: BasisKind | undefined;
  evidence: EvidenceRef[];
  note?: string | undefined;
}

/** basis별 필수 조건. 관찰과 회사 발언은 출처가 있어야 하고 못 봤거나 없다는 칸은 이유가 있어야 한다 */
export function checkBasis(value: BasisCarrier, ctx: z.RefinementCtx): void {
  if (!value.basis) return;
  if (
    (value.basis === 'observation' || value.basis === 'company-statement') &&
    value.evidence.length === 0
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['evidence'],
      message: '관찰과 회사 발언에는 출처(evidence)를 하나 이상 건다',
    });
  }
  if ((value.basis === 'unconfirmed' || value.basis === 'absent') && !value.note?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['note'],
      message: '확인 못함과 없음에는 이유(note)를 적는다',
    });
  }
}
