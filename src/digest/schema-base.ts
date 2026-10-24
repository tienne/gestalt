import { z } from 'zod';

// src/research/schema-base.ts를 복제했다. research는 읽기만 하기로 해서 import하지 않는다
export const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/, 'id는 영문, 숫자, -, _만 쓴다');
export const textSchema = z.string().min(1);

/** 폴더 이름이자 뷰어가 복사하는 명령의 인자라서 공백이나 따옴표가 끼지 않게 좁힌다 */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const sentenceIndex = z.number().int().nonnegative();

export const citeSchema = z
  .object({
    key: sentenceIndex,
    from: sentenceIndex,
    to: sentenceIndex,
  })
  .refine((c) => c.from <= c.to, 'from이 to보다 크다');

export type Cite = z.infer<typeof citeSchema>;

/** HTML lang 속성과 리포트 키, 파일 이름에 실려서 언어 태그 꼴만 받는다 */
export const LANG_TAG_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
