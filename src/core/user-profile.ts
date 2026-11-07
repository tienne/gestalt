import { readFileSync } from 'node:fs';
import { gestaltPath } from './home.js';

/**
 * 사용자 전역 프로필(`~/.gestalt/profile.json`).
 *
 * 리뷰를 부를 때마다 손으로 붙이던 옵션의 기본값을 사람마다 둔다. `gestaltPath()`가 낸
 * 경로 하나만 읽고 cwd나 레포의 `gestalt.json`은 안 본다. 여기 값은 자동 APPROVE처럼
 * 리뷰어 계정으로 판정을 내보내는 동작을 켠다. 레포 설정으로 켤 수 있으면 남의 레포 설정
 * 한 줄이 내 계정의 승인을 내게 된다.
 *
 * 파일이 없으면 빈 프로필이다. 값이 틀린 칸은 경고만 남기고 그 칸을 비워 둔다 — 스킬은
 * 비어 있는 칸에 자기 기본값을 쓰므로 프로필이 없을 때와 똑같이 돈다.
 */

export const PROFILE_FILE = 'profile.json';

export const REVIEW_AUDIENCES = ['peer', 'junior'] as const;
export type ReviewAudience = (typeof REVIEW_AUDIENCES)[number];

/** review 스킬 입력에 대응하는 칸. 프로필이 정하지 않은 칸은 키가 없다 */
export interface ReviewProfile {
  audience?: ReviewAudience;
  postVerdict?: boolean;
  approveWhenNoBlocking?: boolean;
}

export interface UserProfile {
  path: string;
  exists: boolean;
  review: ReviewProfile;
  warnings: string[];
}

type FieldReader<T> = (value: unknown) => { ok: true; value: T } | { ok: false; expected: string };

const bool: FieldReader<boolean> = (v) =>
  typeof v === 'boolean' ? { ok: true, value: v } : { ok: false, expected: 'true|false' };

function isAudience(v: unknown): v is ReviewAudience {
  return typeof v === 'string' && (REVIEW_AUDIENCES as readonly string[]).includes(v);
}

const REVIEW_FIELDS: {
  [K in keyof ReviewProfile]-?: FieldReader<NonNullable<ReviewProfile[K]>>;
} = {
  audience: (v) =>
    isAudience(v) ? { ok: true, value: v } : { ok: false, expected: REVIEW_AUDIENCES.join('|') },
  postVerdict: bool,
  approveWhenNoBlocking: bool,
};

const SECTIONS = ['review'] as const;

export function profilePath(): string {
  return gestaltPath(PROFILE_FILE);
}

function isReviewKey(k: string): k is keyof ReviewProfile {
  return Object.hasOwn(REVIEW_FIELDS, k);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 경고에 값을 그대로 실으면 긴 문자열 하나가 보고를 덮는다 */
function preview(v: unknown): string {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

function readReview(raw: unknown, warnings: string[]): ReviewProfile {
  if (!isPlainObject(raw)) {
    warnings.push('review 칸이 객체가 아니라 전부 기본값으로 둬요');
    return {};
  }
  // 칸마다 값 타입이 달라 키와 값의 짝을 TS가 못 따라간다. 리더 선언에서 타입을 묶고 여기서만 단언한다
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isReviewKey(key)) {
      warnings.push(`모르는 칸이라 무시해요: review.${key}`);
      continue;
    }
    const result = REVIEW_FIELDS[key](value);
    if (result.ok) out[key] = result.value;
    else
      warnings.push(
        `review.${key} 값이 틀려서 기본값으로 둬요: ${preview(value)} (${result.expected})`,
      );
  }
  return out as ReviewProfile;
}

export function loadUserProfile(): UserProfile {
  const path = profilePath();
  const fallback = (warning: string): UserProfile => ({
    path,
    exists: true,
    review: {},
    warnings: [warning],
  });

  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path, exists: false, review: {}, warnings: [] };
    }
    const reason = e instanceof Error ? e.message : String(e);
    return fallback(`프로필을 못 읽어서 전부 기본값으로 둬요: ${reason}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fallback('프로필이 JSON으로 안 읽혀서 전부 기본값으로 둬요');
  }
  if (!isPlainObject(parsed)) {
    return fallback('프로필 맨 바깥이 객체가 아니라 전부 기본값으로 둬요');
  }

  const warnings: string[] = [];
  for (const key of Object.keys(parsed)) {
    if (!(SECTIONS as readonly string[]).includes(key))
      warnings.push(`모르는 칸이라 무시해요: ${key}`);
  }
  const review = parsed.review === undefined ? {} : readReview(parsed.review, warnings);
  return { path, exists: true, review, warnings };
}
