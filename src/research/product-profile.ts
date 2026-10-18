import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { readJsonOrQuarantine, writeJsonAtomic } from '../core/json-file.js';
import { isValidSlug } from './store.js';
import { KEY_MESSAGE, looksLikeKey } from './target.js';

/**
 * 제품 코드에서 분석 이벤트를 미리 훑어 둔 지도. 리서치마다 다시 훑지 않으려고 제품 단위로 둔다.
 * 키 값은 담지 않고 키가 있는 파일 경로만 담는다.
 */
const text = z.string().trim().min(1);

const profileEventSchema = z.object({
  name: text,
  /** 이벤트가 나가는 화면. 코드에서 읽은 이름 그대로 */
  screen: text,
  /** 사용자가 한 일. 예: 상세 진입, 구매 버튼 누름 */
  action: text,
  /** 호출 자리. repo 기준 상대 경로 */
  file: text,
  properties: z.array(text).optional(),
});

export const productProfileSchema = z
  .object({
    product: text.refine(isValidSlug, '제품 이름은 소문자, 숫자, -만 쓴다(최대 64자)'),
    /** 제품 코드 경로. 상대 경로면 리서치를 돌린 레포 기준 */
    repo: text,
    commit: z.string().regex(/^[0-9a-f]{7,40}$/, '커밋은 해시로 적는다'),
    scannedAt: text,
    /** 예: @amplitude/analytics-browser 2.x, 사내 래퍼 이름 */
    sdk: text,
    /** 키가 있는 파일 경로. 값은 적지 않는다 */
    keyLocation: text,
    amplitudeProject: text.optional(),
    events: z.array(profileEventSchema).min(1, '이벤트를 하나도 못 찾았으면 저장하지 않는다'),
  })
  .superRefine((p, ctx) => {
    const { commit: _commit, ...rest } = p;
    for (const path of keyLikePaths(rest)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: KEY_MESSAGE });
    }
  });

export type ProductProfile = z.infer<typeof productProfileSchema>;

function keyLikePaths(value: unknown, path: (string | number)[] = []): (string | number)[][] {
  if (typeof value === 'string') return looksLikeKey(value) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => keyLikePaths(v, [...path, i]));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => keyLikePaths(v, [...path, k]));
  }
  return [];
}

/** `.gestalt/research/_products/`. slug는 `_`로 못 시작해서 리서치 디렉토리와 안 겹친다 */
export function productsDir(repoRoot: string): string {
  return join(repoRoot, '.gestalt', 'research', '_products');
}

export function profilePath(repoRoot: string, product: string): string {
  if (!isValidSlug(product)) throw new Error(`제품 이름이 올바르지 않다: ${product}`);
  return join(productsDir(repoRoot), `${product}.json`);
}

export function listProfiles(repoRoot: string): string[] {
  const dir = productsDir(repoRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .filter(isValidSlug)
    .sort();
}

/** 없으면 null. 깨졌으면 `.corrupt-*`로 옮기고 null */
export function loadProfile(repoRoot: string, product: string): ProductProfile | null {
  const raw = readJsonOrQuarantine(
    profilePath(repoRoot, product),
    (v) => productProfileSchema.safeParse(v).success,
  );
  if (raw === undefined) return null;
  const parsed = productProfileSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function saveProfile(repoRoot: string, profile: ProductProfile): string {
  const path = profilePath(repoRoot, profile.product);
  writeJsonAtomic(path, profile);
  return path;
}

/** 제품 코드의 지금 HEAD. git이 아니거나 못 읽으면 undefined */
export function currentCommit(repoRoot: string, repo: string): string | undefined {
  const dir = isAbsolute(repo) ? repo : resolve(repoRoot, repo);
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

/** 저장한 커밋이 HEAD와 같은지. 짧은 해시로 저장했으면 앞부분만 맞춘다 */
export function isStale(profile: ProductProfile, head: string | undefined): boolean | undefined {
  if (!head) return undefined;
  return !head.startsWith(profile.commit);
}
