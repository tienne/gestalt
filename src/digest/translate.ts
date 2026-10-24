import { z } from 'zod';
import { LANG_TAG_PATTERN, type Segment, type Transcript } from './schema.js';

/**
 * 스크립트 번역 한 벌. 세션이 쓰는 파일이라 영상 자막만큼 믿지 않는다.
 * 번역문은 뷰어에 글자로만 나가고 HTML로 해석되지 않는다
 */
export const translationInputSchema = z.object({
  lang: z.string().regex(LANG_TAG_PATTERN, '언어 태그(ko, en, pt-BR) 꼴이어야 한다'),
  items: z
    .array(
      z.object({
        i: z.number().int().nonnegative(),
        translation: z.string().trim().min(1).max(2000),
      }),
    )
    .min(1),
});

export type TranslationInput = z.infer<typeof translationInputSchema>;

export interface TranslationResult {
  transcript: Transcript;
  applied: number;
  /** 스크립트에 없는 문장 번호. 이 항목은 넣지 않는다 */
  unknown: number[];
  /** 번역이 안 붙은 문장 번호 */
  missing: number[];
}

/**
 * 번역을 문장 번호로 붙인다. 이미 다른 언어 번역이 붙어 있으면 통째로 갈아 끼운다.
 * 언어가 섞이면 토글 하나로 어느 언어를 보는지 알 수 없어서다
 */
export function applyTranslation(transcript: Transcript, input: unknown): TranslationResult {
  const parsed = translationInputSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(루트)'}: ${i.message}`);
    throw new Error(`번역 형식 오류: ${issues.join('; ')}`);
  }
  const { lang, items } = parsed.data;
  const sameLang = transcript.meta.translationLang === lang;
  const byIndex = new Map<number, string>();
  const unknown: number[] = [];
  for (const item of items) {
    if (item.i >= transcript.segments.length) unknown.push(item.i);
    else byIndex.set(item.i, item.translation);
  }
  const segments = transcript.segments.map((s): Segment => {
    const next = byIndex.get(s.i) ?? (sameLang ? s.translation : undefined);
    const { translation: _old, ...rest } = s;
    return next === undefined ? rest : { ...rest, translation: next };
  });
  return {
    transcript: { ...transcript, meta: { ...transcript.meta, translationLang: lang }, segments },
    applied: byIndex.size,
    unknown,
    missing: segments.filter((s) => s.translation === undefined).map((s) => s.i),
  };
}
