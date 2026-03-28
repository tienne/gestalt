import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { ProjectMemory, SpecHistoryEntry, MemoryExecutionRecord } from '../core/types.js';

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
      return JSON.parse(raw) as ProjectMemory;
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

  addArchitectureDecision(decision: string): ProjectMemory {
    const memory = this.read();
    if (!memory.architectureDecisions.includes(decision)) {
      memory.architectureDecisions.push(decision);
    }
    this.write(memory);
    return memory;
  }

  getRepoRoot(): string {
    return this.repoRoot;
  }
}
