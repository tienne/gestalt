import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../core/log.js';
import type { RepoVisibilityVerdict } from './repo-visibility.js';
import { writeTextAtomic } from './store.js';
import type { IgnoredFileTrackedWarning } from './validator.js';

/** 공개 레포에서 무시 대상 산출물을 git이 이미 추적할 때 내는 경고 코드 */
export const IGNORED_FILE_TRACKED = 'IGNORED_FILE_TRACKED' as const;

/** 레포 루트 기준 산출물 폴더 */
export const ARCHITECTURE_DIR = join('.gestalt', 'architecture');

/**
 * 공개 레포에서 커밋하지 않을 산출물. 본인용 HTML과 저장 IR(투영 포함)을 막고
 * 공유본(`<그림>.shared.html`, `<그림>.delta.shared.html`)만 풀어 둔다
 */
export const PUBLIC_IGNORE_PATTERNS = ['*.html', '*.json', 'views/', '!*.shared.html'] as const;

const BEGIN =
  '# >>> gestalt architecture (render가 관리한다. 이 구역 밖에 적은 줄은 건드리지 않는다)';
const END = '# <<< gestalt architecture';
const GIT_TIMEOUT_MS = 5_000;

export interface CommitPolicyResult {
  /** 관리 구역이 들어 있는 .gitignore 절대 경로. 비공개 레포면 없다 */
  ignoreFilePath?: string;
  /** 이번에 적용한 무시 패턴. 비공개 레포면 빈 배열이다 */
  ignored: string[];
  trackedWarning?: IgnoredFileTrackedWarning;
}

export interface CommitPolicyDeps {
  /** dir 아래에서 git이 추적하면서 무시 규칙에도 걸리는 파일(레포 루트 기준 경로). git이 없거나 실패하면 던진다 */
  listTrackedIgnored(repoRoot: string, dir: string): string[];
}

const defaultDeps: CommitPolicyDeps = {
  listTrackedIgnored(repoRoot, dir) {
    const out = execFileSync(
      'git',
      ['-C', repoRoot, 'ls-files', '-z', '--cached', '--ignored', '--exclude-standard', '--', dir],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_TIMEOUT_MS },
    );
    return out.split('\0').filter((p) => p.length > 0);
  },
};

function managedBlock(): string {
  return [BEGIN, ...PUBLIC_IGNORE_PATTERNS, END].join('\n');
}

/** 관리 구역을 걷어낸 나머지 줄. 구역이 없으면 원문 그대로 */
function withoutManagedBlock(text: string): string {
  const start = text.indexOf(BEGIN);
  if (start < 0) return text;
  const endAt = text.indexOf(END, start);
  // 끝 표식이 지워졌으면 구역이 어디서 끝나는지 모르니 시작 표식부터 끝까지 관리 구역으로 본다
  const stop = endAt < 0 ? text.length : endAt + END.length;
  const before = text.slice(0, start).replace(/\n+$/, '');
  const after = text.slice(stop).replace(/^\n+/, '');
  return [before, after].filter((s) => s.length > 0).join('\n');
}

function shellQuote(p: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

function trackedWarningOf(paths: string[]): IgnoredFileTrackedWarning {
  const sorted = [...paths].sort();
  return {
    code: IGNORED_FILE_TRACKED,
    message:
      `공개 레포라 커밋하지 않을 산출물 ${sorted.length}개를 git이 이미 추적하고 있다. ` +
      `다음 커밋에서 빼려면 \`git rm --cached -- ${sorted.map(shellQuote).join(' ')}\`를 직접 실행한다(작업 폴더의 파일은 남는다).`,
    paths: sorted,
  };
}

/**
 * 레포 공개 여부에 맞춰 `.gestalt/architecture/.gitignore`를 맞춘다.
 * 공개면 관리 구역을 쓰고, 비공개면 예전에 쓴 관리 구역만 걷어낸다. 사람이 적은 줄은 남긴다.
 * 이미 추적 중인 파일은 경고 한 건으로만 알리고 git rm은 실행하지 않는다
 */
export function applyCommitPolicy(
  repoRoot: string,
  verdict: RepoVisibilityVerdict,
  deps: Partial<CommitPolicyDeps> = {},
): CommitPolicyResult {
  const d = { ...defaultDeps, ...deps };
  const path = join(repoRoot, ARCHITECTURE_DIR, '.gitignore');
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const rest = current === null ? '' : withoutManagedBlock(current).replace(/\n+$/, '');

  if (verdict === 'private') {
    if (current !== null && current.includes(BEGIN)) {
      if (rest.trim().length === 0) unlinkSync(path);
      else writeTextAtomic(path, `${rest}\n`);
    }
    return { ignored: [] };
  }

  const next = `${[rest, managedBlock()].filter((s) => s.length > 0).join('\n')}\n`;
  if (next !== current) writeTextAtomic(path, next);

  let tracked: string[] = [];
  try {
    tracked = d.listTrackedIgnored(repoRoot, ARCHITECTURE_DIR);
  } catch (err) {
    log(
      `architecture: git으로 추적 중인 산출물을 못 읽어 건너뜁니다 (${(err as Error).message ?? err})`,
    );
  }
  return {
    ignoreFilePath: path,
    ignored: [...PUBLIC_IGNORE_PATTERNS],
    ...(tracked.length > 0 ? { trackedWarning: trackedWarningOf(tracked) } : {}),
  };
}
