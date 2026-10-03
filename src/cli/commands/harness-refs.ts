import { loadConfig } from '../../core/config.js';
import {
  COLLECT_BACKENDS,
  collectReferenceCandidates,
  type CollectBackend,
  type CollectResult,
} from '../../harness-review/collect.js';
import {
  DEFAULT_CLONE_MAX_IDLE_MS,
  defaultCloneRoot,
  pruneWorktreeClones,
  type PrunedClone,
} from '../../harness-review/related-clones.js';
import { REFERENCE_CANDIDATE_KINDS } from '../../harness-review/types.js';

/**
 * `gestalt harness-refs collect`.
 *
 * review 스킬이 다른 레포에서 `gestalt` 바이너리로 부른다. --json이면 stdout에는 JSON 한 줄만
 * 나간다. 후보 수집이 리뷰를 막으면 안 되므로 검출기가 실패해도 종료 코드는 0이다. 인자가
 * 잘못됐을 때만 1로 끝난다.
 */

export interface HarnessRefsCollectOptions {
  base: string;
  head: string;
  backend: string;
  repoDir: string[];
  refresh?: boolean;
  json?: boolean;
}

function parseBackend(value: string): CollectBackend {
  if ((COLLECT_BACKENDS as readonly string[]).includes(value)) return value as CollectBackend;
  throw new Error(`--backend는 ${COLLECT_BACKENDS.join('|')} 중 하나다: ${value}`);
}

export function formatCollectSummary(r: CollectResult): string {
  const lines = [
    `레포: ${r.repo} (백엔드 ${r.backendUsed})`,
    `관련 레포: ${r.relatedRepos.length > 0 ? r.relatedRepos.join(', ') : '없음'}`,
    ...REFERENCE_CANDIDATE_KINDS.map((k) => `${k}: ${r.counts[k]}`),
  ];
  const cov = r.backwardSearchCoverage;
  if (cov) {
    const ow = cov.orgWide ? `, 조직 전체 ${cov.orgWide.searched}/${cov.orgWide.planned}` : '';
    lines.push(`역방향 검색: 질의 ${cov.searched}/${cov.planned}${ow}`);
  }
  if (r.noGitHubRemote) lines.push('GitHub 원격이 없다');
  for (const b of r.lookupBlocked) lines.push(`조회 막힘 (${b.source}): ${b.reason}`);
  if (r.referenceCheckSkipped)
    lines.push('참조 검사를 다 보지 못했다. 사용자에게 진행 여부를 묻는다');
  return lines.join('\n');
}

export async function harnessRefsCollectCommand(opts: HarnessRefsCollectOptions): Promise<void> {
  let backend: CollectBackend;
  try {
    backend = parseBackend(opts.backend);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  let extraRepos: string[] = [];
  try {
    extraRepos = loadConfig({}, { skipDotEnv: true }).relatedRepos;
  } catch (e) {
    // 설정이 깨져도 자동 탐지만으로 돈다. 추가 레포가 빠진 건 stderr로만 알린다
    console.error('[gestalt] gestalt.json의 relatedRepos를 읽지 못했다:', e);
  }

  const result = await collectReferenceCandidates({
    repoRoot: process.cwd(),
    base: opts.base,
    head: opts.head,
    backend,
    repoDirs: opts.repoDir,
    extraRepos,
    refresh: opts.refresh,
  });
  console.log(opts.json ? JSON.stringify(result) : formatCollectSummary(result));
}

export interface HarnessRefsClonesPruneOptions {
  all?: boolean;
  maxIdleDays?: string;
  json?: boolean;
}

const PRUNE_REASON_LABEL: Record<PrunedClone['reason'], string> = {
  worktreeGone: '워크트리 없음',
  idle: '오래 안 씀',
  all: '--all',
};

/**
 * `gestalt harness-refs clones prune`. collect가 워크트리마다 받아 둔 관련 레포 클론을 지운다.
 * collect도 시작할 때 같은 기준으로 정리하므로, 이 명령은 수집을 안 돌리는 동안 디스크를 비울 때 쓴다.
 */
export function harnessRefsClonesPruneCommand(opts: HarnessRefsClonesPruneOptions): void {
  let maxIdleMs = DEFAULT_CLONE_MAX_IDLE_MS;
  if (opts.maxIdleDays !== undefined) {
    const days = Number(opts.maxIdleDays);
    if (!Number.isFinite(days) || days < 0) {
      console.error(`--max-idle-days는 0 이상의 숫자여야 한다: ${opts.maxIdleDays}`);
      process.exit(1);
    }
    maxIdleMs = days * 24 * 60 * 60 * 1000;
  }

  const base = defaultCloneRoot();
  const pruned = pruneWorktreeClones(base, { all: opts.all, maxIdleMs });
  if (opts.json) {
    console.log(JSON.stringify({ base, pruned }));
    return;
  }
  if (pruned.length === 0) {
    console.log(`지울 클론이 없다 (${base})`);
    return;
  }
  for (const p of pruned) {
    console.log(
      `${PRUNE_REASON_LABEL[p.reason]}\t${p.root}${p.worktree ? `\t(${p.worktree})` : ''}`,
    );
  }
  console.log(`클론 루트 ${pruned.length}개를 지웠다`);
}
