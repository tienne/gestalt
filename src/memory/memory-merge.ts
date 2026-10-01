import { readFileSync, writeFileSync } from 'node:fs';
import type {
  ProjectMemory,
  SpecHistoryEntry,
  MemoryExecutionRecord,
  ArchitectureDecision,
} from '../core/types.js';

function unionBy<T>(remote: T[], local: T[], key: (item: T) => string): T[] {
  const seen = new Set(remote.map(key));
  return [...remote, ...local.filter((item) => !seen.has(key(item)))];
}

/**
 * local과 remote ProjectMemory를 합친다. 양쪽 모두 쌓기만 하는 기록이라
 * 공통 조상 없이 합집합으로 충분하다.
 *
 * - specHistory: specId 기준, executionHistory: executeSessionId 기준
 * - architectureDecisions: decision 기준. 한쪽에만 outcome이 있으면 그쪽을 남긴다
 * - compressedContexts: sessionId 기준
 * - 같은 키가 양쪽에 있으면 remote가 이긴다. lastUpdated는 더 최신 값
 */
export function mergeMemory(local: ProjectMemory, remote: ProjectMemory): ProjectMemory {
  const specHistory: SpecHistoryEntry[] = unionBy(
    remote.specHistory,
    local.specHistory,
    (s) => s.specId,
  );

  const executionHistory: MemoryExecutionRecord[] = unionBy(
    remote.executionHistory,
    local.executionHistory,
    (e) => e.executeSessionId,
  );

  // addArchitectureDecision이 decision 문자열로 중복을 막으므로 여기서도 같은 키를 쓴다.
  // timestamp까지 키에 넣으면 양쪽에서 같은 결정을 따로 기록했을 때 둘 다 남는다
  const localDecisions = new Map(local.architectureDecisions.map((d) => [d.decision, d]));
  const architectureDecisions: ArchitectureDecision[] = unionBy(
    remote.architectureDecisions,
    local.architectureDecisions,
    (d) => d.decision,
  ).map((d) => {
    const other = localDecisions.get(d.decision);
    return !d.outcome && other?.outcome ? other : d;
  });

  const compressedContexts = unionBy(
    remote.compressedContexts ?? [],
    local.compressedContexts ?? [],
    (c) => c.sessionId,
  );

  const lastUpdated =
    local.lastUpdated > remote.lastUpdated ? local.lastUpdated : remote.lastUpdated;

  return {
    version: local.version,
    repoRoot: local.repoRoot,
    specHistory,
    executionHistory,
    architectureDecisions,
    compressedContexts: compressedContexts.length > 0 ? compressedContexts : undefined,
    lastUpdated,
  };
}

// ProjectMemoryStore.read()와 같은 v1 마이그레이션. 드라이버는 저장소 경로가 아니라
// git이 넘겨준 임시 파일을 읽으므로 store를 거치지 못한다
function readMemoryFile(path: string): ProjectMemory {
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as ProjectMemory;
  parsed.architectureDecisions = (parsed.architectureDecisions ?? []).map((item) =>
    typeof item === 'string'
      ? { decision: item, rationale: '', specId: '', timestamp: parsed.lastUpdated ?? '' }
      : item,
  );
  parsed.specHistory ??= [];
  parsed.executionHistory ??= [];
  return parsed;
}

/**
 * git merge driver 진입점. `%A`(현재 브랜치) 자리에 합친 결과를 쓴다.
 * 어느 쪽이든 JSON으로 못 읽으면 던진다 — 호출부가 0이 아닌 코드로 끝내야
 * git이 충돌 표시를 남기고 사람에게 넘긴다.
 */
export function runMemoryMergeDriver(oursPath: string, theirsPath: string): ProjectMemory {
  const merged = mergeMemory(readMemoryFile(oursPath), readMemoryFile(theirsPath));
  writeFileSync(oursPath, JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}
