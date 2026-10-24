import { z } from 'zod';

// src/research/schema-base.ts를 복제했다. research는 읽기만 하기로 해서 import하지 않는다
export const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/, 'id는 영문, 숫자, -, _만 쓴다');
export const textSchema = z.string().min(1);
