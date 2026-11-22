import { execFileSync } from 'node:child_process';
import { log } from '../core/log.js';

export type RepoVisibilityVerdict = 'public' | 'private';

/**
 * 판정을 못 해 공개로 본 이유. 원격이 없거나 GitHub 밖이면 gh로 물을 수 없다.
 * gh가 없거나 실패했거나 응답을 못 읽었으면 물어도 답을 못 얻은 것이다
 */
export type VisibilityFallbackReason =
  | 'no_remote'
  | 'non_github_remote'
  | 'gh_failed'
  | 'gh_bad_output'
  | 'unknown_visibility';

export interface RepoVisibility {
  verdict: RepoVisibilityVerdict;
  source: 'gh' | 'fallback';
  /** gh가 돌려준 값 그대로(PUBLIC, PRIVATE, INTERNAL). gh 답을 못 얻었으면 없다 */
  visibility?: string;
  fallbackReason?: VisibilityFallbackReason;
}

export interface RepoVisibilityDeps {
  /** origin 원격 주소. 원격이 없으면 null */
  readRemoteUrl(repoRoot: string): string | null;
  /** `gh repo view <owner/repo> --json visibility`의 표준 출력. 실패하면 던진다 */
  ghRepoView(slug: string, repoRoot: string): string;
}

/**
 * GitHub INTERNAL(엔터프라이즈 조직 안에서만 보이는 레포)을 어느 쪽으로 볼지.
 * 조직 밖에는 안 보이는 레포라 프라이빗으로 둔다
 */
export const INTERNAL_VISIBILITY_VERDICT: RepoVisibilityVerdict = 'private';

const GH_TIMEOUT_MS = 5_000;
const GIT_TIMEOUT_MS = 5_000;
// owner와 레포 이름에 GitHub가 허용하는 글자만. 맨 앞 '-'를 막아 gh가 옵션으로 읽지 않게 한다
const SLUG = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*\/[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;

const defaultDeps: RepoVisibilityDeps = {
  readRemoteUrl(repoRoot) {
    try {
      const out = execFileSync('git', ['-C', repoRoot, 'remote', 'get-url', 'origin'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: GIT_TIMEOUT_MS,
      }).trim();
      return out || null;
    } catch {
      return null;
    }
  },
  ghRepoView(slug, repoRoot) {
    return execFileSync('gh', ['repo', 'view', slug, '--json', 'visibility'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GH_TIMEOUT_MS,
      env: { ...process.env, GH_PROMPT_DISABLED: '1' },
    });
  },
};

/** github.com 원격 주소에서 `owner/repo`를 꺼낸다. GitHub 밖이거나 꼴이 낯설면 null */
export function githubSlugOf(remoteUrl: string): string | null {
  const url = remoteUrl.trim();
  const m =
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/(.+)$/i.exec(url) ??
    /^(?:[^@/]+@)?github\.com:(.+)$/i.exec(url);
  if (!m) return null;
  const slug = m[1]!.replace(/\/+$/, '').replace(/\.git$/i, '');
  return SLUG.test(slug) ? slug : null;
}

function fallback(reason: VisibilityFallbackReason): RepoVisibility {
  return { verdict: 'public', source: 'fallback', fallbackReason: reason };
}

/**
 * 레포가 공개인지 gh로 묻는다. 답을 못 얻으면 전부 공개로 본다.
 * 본인용 산출물이 공개 레포에 올라가는 쪽이 더 큰 사고라서다. 예외를 밖으로 던지지 않는다
 */
export function resolveRepoVisibility(
  repoRoot: string,
  deps: Partial<RepoVisibilityDeps> = {},
): RepoVisibility {
  const d = { ...defaultDeps, ...deps };
  let remote: string | null;
  try {
    remote = d.readRemoteUrl(repoRoot);
  } catch {
    remote = null;
  }
  if (!remote) return fallback('no_remote');
  const slug = githubSlugOf(remote);
  if (!slug) return fallback('non_github_remote');

  let raw: string;
  try {
    raw = d.ghRepoView(slug, repoRoot);
  } catch (err) {
    log(
      `architecture: gh로 레포 공개 여부를 못 읽어 공개로 봅니다 (${(err as Error).message ?? err})`,
    );
    return fallback('gh_failed');
  }
  let visibility: unknown;
  try {
    visibility = (JSON.parse(raw) as { visibility?: unknown }).visibility;
  } catch {
    return fallback('gh_bad_output');
  }
  if (typeof visibility !== 'string') return fallback('gh_bad_output');
  const v = visibility.toUpperCase();
  if (v === 'PRIVATE') return { verdict: 'private', source: 'gh', visibility: v };
  if (v === 'PUBLIC') return { verdict: 'public', source: 'gh', visibility: v };
  if (v === 'INTERNAL')
    return { verdict: INTERNAL_VISIBILITY_VERDICT, source: 'gh', visibility: v };
  return { ...fallback('unknown_visibility'), visibility: v };
}
