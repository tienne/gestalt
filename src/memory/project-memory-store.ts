import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
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

  read(): ProjectMemory {
    if (!existsSync(this.memoryPath)) {
      return createEmptyMemory(this.repoRoot);
    }
    try {
      const raw = readFileSync(this.memoryPath, 'utf-8');
      const parsed = JSON.parse(raw) as ProjectMemory;
      // v1 → v2 자동 마이그레이션: architectureDecisions string[] → ArchitectureDecision[]
      if (Array.isArray(parsed.architectureDecisions)) {
        parsed.architectureDecisions = parsed.architectureDecisions.map((item) => {
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
      }
      return parsed;
    } catch {
      return createEmptyMemory(this.repoRoot);
    }
  }

  private write(memory: ProjectMemory): void {
    const dir = dirname(this.memoryPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    memory.lastUpdated = new Date().toISOString();
    writeFileSync(this.memoryPath, JSON.stringify(memory, null, 2), 'utf-8');
  }

  addSpec(entry: SpecHistoryEntry): ProjectMemory {
    const memory = this.read();
    // Prevent duplicate specId entries
    const exists = memory.specHistory.some((s) => s.specId === entry.specId);
    if (!exists) {
      memory.specHistory.push(entry);
    }
    this.write(memory);
    return memory;
  }

  addExecution(record: MemoryExecutionRecord): ProjectMemory {
    const memory = this.read();
    // Prevent duplicate executeSessionId entries
    const exists = memory.executionHistory.some(
      (e) => e.executeSessionId === record.executeSessionId,
    );
    if (!exists) {
      memory.executionHistory.push(record);
    }
    this.write(memory);
    return memory;
  }

  addArchitectureDecision(decision: ArchitectureDecision): ProjectMemory {
    const memory = this.read();
    // decision 내용 기준 중복 방지 (같은 결정을 중복 기록하지 않음)
    const exists = memory.architectureDecisions.some((d) => d.decision === decision.decision);
    if (!exists) {
      memory.architectureDecisions.push(decision);
    }
    this.write(memory);
    return memory;
  }

  addCompressedContext(sessionId: string, summary: string): ProjectMemory {
    const memory = this.read();
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
    this.write(memory);
    return memory;
  }

  async searchSimilarSpecs(query: string, topK = 3): Promise<SpecHistoryEntry[]> {
    const { searchSimilarSpecs } = await import('./semantic-search.js');
    const memory = this.read();
    return searchSimilarSpecs(query, memory, topK);
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
