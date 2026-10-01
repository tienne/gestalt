import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { withFileLock } from '../core/file-lock.js';
import { isPlainObject, readJsonOrQuarantine, writeJsonAtomic } from '../core/json-file.js';
import { log } from '../core/log.js';
import type {
  ProjectMemory,
  SpecHistoryEntry,
  MemoryExecutionRecord,
  ArchitectureDecision,
} from '../core/types.js';

const MEMORY_FILENAME = '.gestalt/memory.json';
const MEMORY_VERSION = '1.0.0';

function detectRepoRoot(startDir: string): string {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, 'package.json')) || existsSync(join(dir, '.git'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      // Reached filesystem root without finding markers — use startDir
      return startDir;
    }
    dir = parent;
  }
}

function createEmptyMemory(repoRoot: string): ProjectMemory {
  return {
    version: MEMORY_VERSION,
    repoRoot,
    specHistory: [],
    executionHistory: [],
    architectureDecisions: [],
    lastUpdated: new Date().toISOString(),
  };
}

export class ProjectMemoryStore {
  private memoryPath: string;
  private repoRoot: string;

  constructor(cwd?: string) {
    this.repoRoot = detectRepoRoot(cwd ?? process.cwd());
    this.memoryPath = join(this.repoRoot, MEMORY_FILENAME);
  }

  /**
   * 메모리를 읽는다. 읽기 자체가 실패하면 빈 메모리를 돌려준다.
   *
   * 인터뷰에 맥락을 끼워 넣는 자리라 여기서 던지면 인터뷰가 멈춘다. 고쳐 쓰는 경로는
   * 이 메서드 대신 `load()`를 직접 불러, 못 읽은 채로 빈 메모리를 덮어쓰지 않는다.
   * 잠금 없이 읽으므로 깨진 파일을 옮기지 않는다. 옮기는 건 잠금을 쥔 `update()`만 한다.
   */
  read(): ProjectMemory {
    try {
      return this.load({ quarantine: false });
    } catch (e) {
      log(`${this.memoryPath}를 읽지 못했어요:`, e);
      return createEmptyMemory(this.repoRoot);
    }
  }

  private load(options: { quarantine: boolean }): ProjectMemory {
    const raw = readJsonOrQuarantine(this.memoryPath, isPlainObject, options);
    if (raw === undefined) return createEmptyMemory(this.repoRoot);
    const parsed = raw as Partial<ProjectMemory>;
    const memory: ProjectMemory = {
      ...createEmptyMemory(this.repoRoot),
      ...parsed,
      specHistory: Array.isArray(parsed.specHistory) ? parsed.specHistory : [],
      executionHistory: Array.isArray(parsed.executionHistory) ? parsed.executionHistory : [],
      architectureDecisions: Array.isArray(parsed.architectureDecisions)
        ? parsed.architectureDecisions
        : [],
      compressedContexts: Array.isArray(parsed.compressedContexts)
        ? parsed.compressedContexts
        : undefined,
    };
    // v1 → v2 자동 마이그레이션: architectureDecisions string[] → ArchitectureDecision[]
    memory.architectureDecisions = memory.architectureDecisions.map((item: unknown) => {
      if (typeof item === 'string') {
        return {
          decision: item,
          rationale: '',
          specId: '',
          timestamp: new Date().toISOString(),
        } satisfies ArchitectureDecision;
      }
      return item as ArchitectureDecision;
    });
    return memory;
  }

  /**
   * 잠금을 쥔 채 읽고 고쳐 쓴다.
   *
   * 워크트리나 프로세스 여럿이 같은 메모리에 동시에 기록하면, 잠금 없이는 늦게 쓴 쪽이
   * 먼저 쓴 쪽의 항목을 덮는다.
   */
  private update(mutate: (memory: ProjectMemory) => void): ProjectMemory {
    return withFileLock(
      `${this.memoryPath}.lock`,
      ({ stillMine }) => {
        const memory = this.load({ quarantine: true });
        mutate(memory);
        if (!stillMine()) {
          throw new Error('메모리 잠금을 뺏겨서 안 썼어요. 다시 불러주세요');
        }
        memory.lastUpdated = new Date().toISOString();
        writeJsonAtomic(this.memoryPath, memory);
        return memory;
      },
      { busyMessage: '메모리 파일이 잠겨 있어서 못 고쳤어요' },
    );
  }

  addSpec(entry: SpecHistoryEntry): ProjectMemory {
    return this.update((memory) => {
      // Prevent duplicate specId entries
      const exists = memory.specHistory.some((s) => s.specId === entry.specId);
      if (!exists) {
        memory.specHistory.push(entry);
      }
    });
  }

  addExecution(record: MemoryExecutionRecord): ProjectMemory {
    return this.update((memory) => {
      // Prevent duplicate executeSessionId entries
      const exists = memory.executionHistory.some(
        (e) => e.executeSessionId === record.executeSessionId,
      );
      if (!exists) {
        memory.executionHistory.push(record);
      }
    });
  }

  addArchitectureDecision(decision: ArchitectureDecision): ProjectMemory {
    return this.update((memory) => {
      // decision 내용 기준 중복 방지 (같은 결정을 중복 기록하지 않음)
      const exists = memory.architectureDecisions.some((d) => d.decision === decision.decision);
      if (!exists) {
        memory.architectureDecisions.push(decision);
      }
    });
  }

  addCompressedContext(sessionId: string, summary: string): ProjectMemory {
    return this.update((memory) => {
      if (!memory.compressedContexts) {
        memory.compressedContexts = [];
      }
      // Replace existing entry for same sessionId
      const idx = memory.compressedContexts.findIndex((c) => c.sessionId === sessionId);
      const entry = { sessionId, summary, compressedAt: new Date().toISOString() };
      if (idx >= 0) {
        memory.compressedContexts[idx] = entry;
      } else {
        memory.compressedContexts.push(entry);
      }
    });
  }

  /**
   * local과 remote ProjectMemory를 머지한다.
   *
   * - specHistory: specId 기준 dedupe (remote에 없는 local 항목 추가)
   * - executionHistory: executeSessionId 기준 dedupe (동일 방식)
   * - architectureDecisions: timestamp+decision 기준 dedupe
   * - 그 외 스칼라 필드: local 값 우선, lastUpdated는 최신값
   */
  mergeMemory(local: ProjectMemory, remote: ProjectMemory): ProjectMemory {
    // specHistory: specId 기준 dedupe — remote 기준에서 local에만 있는 항목 추가
    const remoteSpecIds = new Set(remote.specHistory.map((s) => s.specId));
    const mergedSpecHistory: SpecHistoryEntry[] = [
      ...remote.specHistory,
      ...local.specHistory.filter((s) => !remoteSpecIds.has(s.specId)),
    ];

    // executionHistory: executeSessionId 기준 dedupe
    const remoteExecIds = new Set(remote.executionHistory.map((e) => e.executeSessionId));
    const mergedExecutionHistory: MemoryExecutionRecord[] = [
      ...remote.executionHistory,
      ...local.executionHistory.filter((e) => !remoteExecIds.has(e.executeSessionId)),
    ];

    // architectureDecisions: timestamp+decision 기준 dedupe
    const remoteDecisionKeys = new Set(
      remote.architectureDecisions.map((d) => `${d.timestamp}::${d.decision}`),
    );
    const mergedArchitectureDecisions: ArchitectureDecision[] = [
      ...remote.architectureDecisions,
      ...local.architectureDecisions.filter(
        (d) => !remoteDecisionKeys.has(`${d.timestamp}::${d.decision}`),
      ),
    ];

    // compressedContexts: sessionId 기준 dedupe (remote 우선)
    const localContexts = local.compressedContexts ?? [];
    const remoteContexts = remote.compressedContexts ?? [];
    const remoteContextIds = new Set(remoteContexts.map((c) => c.sessionId));
    const mergedContexts = [
      ...remoteContexts,
      ...localContexts.filter((c) => !remoteContextIds.has(c.sessionId)),
    ];

    // lastUpdated: 더 최신 값 사용
    const lastUpdated =
      local.lastUpdated > remote.lastUpdated ? local.lastUpdated : remote.lastUpdated;

    return {
      version: local.version,
      repoRoot: local.repoRoot,
      specHistory: mergedSpecHistory,
      executionHistory: mergedExecutionHistory,
      architectureDecisions: mergedArchitectureDecisions,
      compressedContexts: mergedContexts.length > 0 ? mergedContexts : undefined,
      lastUpdated,
    };
  }

  getRepoRoot(): string {
    return this.repoRoot;
  }
}
