import { z } from 'zod';

export const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/, 'id는 영문, 숫자, -, _만 쓴다');
export const textSchema = z.string().min(1);

export const httpsUrlSchema = z
  .string()
  .url()
  .refine((u) => u.startsWith('https://'), 'https 주소만 쓴다');
