import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { Dirent } from 'node:fs';
import { execSync } from 'node:child_process';
import { CodeGraphStore } from './storage.js';
import { computeBlastRadius } from './blast-radius.js';
import { getPluginForFile } from './plugins/index.js';
import type {
  BuildOptions,
  BuildResult,
  BlastRadiusOptions,
  BlastRadiusResult,
  DiffRadiusOptions,
  QueryPattern,
  QueryResult,
  CodeGraphStats,
} from './types.js';

function getFilesRecursively(repoRoot: string, excludePatterns: string[], include?: string[]): string[] {
  const excludeSegments = new Set(
    excludePatterns.filter(p => p.endsWith('/**')).map(p => p.slice(0, -3)),
  );
  const excludeSuffixes = excludePatterns
    .filter(p => !p.includes('/') && p.startsWith('*.'))
    .map(p => p.slice(1));
  const includeRoots = include?.filter(p => !p.startsWith('**')).map(p => p.replace(/\*\*.*$/, '').replace(/\/$/, ''));

  const results: string[] = [];
  try {
    const entries = readdirSync(repoRoot, { withFileTypes: true, recursive: true }) as Dirent[];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fullPath = join(entry.parentPath, entry.name);
      const rel = fullPath.slice(repoRoot.length + 1);
      const segments = rel.split('/');
      if (segments.some(s => excludeSegments.has(s))) continue;
      if (excludeSuffixes.some(s => entry.name.endsWith(s))) continue;
      if (includeRoots && includeRoots.length > 0 && !includeRoots.some(r => rel.startsWith(r))) continue;
      results.push(fullPath);
    }
  } catch {
    // directory doesn't exist or not readable
  }
  return results;
}

const DEFAULT_EXCLUDE = [
  'node_modules/**',
  '.git/**',
  '.gestalt/**',
  'dist/**',
  'build/**',
  'coverage/**',
  '*.min.js',
];

export class CodeGraphEngine {
  private storeCache = new Map<string, CodeGraphStore>();

  private getDbPath(repoRoot: string): string {
    return join(repoRoot, '.gestalt', 'code-graph.db');
  }

  private getStore(repoRoot: string): CodeGraphStore {
    const dbPath = this.getDbPath(repoRoot);
    if (!this.storeCache.has(dbPath)) {
      this.storeCache.set(dbPath, new CodeGraphStore(dbPath));
    }
    return this.storeCache.get(dbPath)!;
  }

  /**
   * Build or incrementally update the code graph for a repository.
   */
  build(repoRoot: string, opts: BuildOptions = {}): BuildResult {
    const start = Date.now();
    const store = this.getStore(repoRoot);
    const { include, exclude = [], mode = 'full' } = opts;

    // Collect files
    const excludePatterns = [...DEFAULT_EXCLUDE, ...exclude];
    const files = getFilesRecursively(repoRoot, excludePatterns, include);

    // Filter files that have supported plugins
    const supportedFiles = files.filter((f) => getPluginForFile(f) !== null);

    let nodesBuilt = 0;
    let edgesBuilt = 0;

    for (const filePath of supportedFiles) {
      // Incremental: skip unchanged files (hash comparison)
      if (mode === 'incremental') {
        const existingHash = store.getFileHash(filePath);
        if (existingHash) {
          try {
            const content = readFileSync(filePath, 'utf-8');
            const currentHash = createHash('sha256').update(content).digest('hex');
            if (currentHash === existingHash) continue;
          } catch {
            // If can't read, skip
            continue;
          }
        }
      }

      const plugin = getPluginForFile(filePath);
      if (!plugin) continue;

      try {
        const content = readFileSync(filePath, 'utf-8');
        const result = plugin.parse(filePath, content);

        // Delete old data for this file before updating
        store.deleteByFile(filePath);

        for (const node of result.nodes) {
          store.upsertNode(node);
          nodesBuilt++;
        }
        for (const edge of result.edges) {
          store.upsertEdge(edge);
          edgesBuilt++;
        }
      } catch {
        // Skip files that fail to parse
      }
    }

    return {
      nodesBuilt,
      edgesBuilt,
      timeTakenMs: Date.now() - start,
      installedHook: false, // Hook installation handled separately via GitHookManager
    };
  }

  /**
   * Compute blast-radius for changed files.
   * Auto-detects changed files from git diff if not provided.
   */
  blastRadius(repoRoot: string, opts: BlastRadiusOptions = {}): BlastRadiusResult {
    const store = this.getStore(repoRoot);
    const { changedFiles, base = 'HEAD~1', maxDepth = 2 } = opts;

    let files = changedFiles;
    if (!files || files.length === 0) {
      files = this.getGitChangedFiles(repoRoot, base);
    }

    // Convert to absolute paths
    const absoluteFiles = files.map((f) =>
      f.startsWith('/') ? f : resolve(repoRoot, f),
    );

    return computeBlastRadius(store, absoluteFiles, maxDepth);
  }

  /**
   * Compute blast-radius for uncommitted changes (staged / unstaged / all).
   * - staged: git diff --cached --name-only
   * - unstaged: git diff --name-only
   * - all (default): git diff HEAD --name-only
   */
  diffRadius(repoRoot: string, opts: DiffRadiusOptions = {}): BlastRadiusResult {
    const { mode = 'all', maxDepth = 2 } = opts;
    const store = this.getStore(repoRoot);

    const gitCmd =
      mode === 'staged'
        ? 'git diff --cached --name-only'
        : mode === 'unstaged'
          ? 'git diff --name-only'
          : 'git diff HEAD --name-only';

    let files: string[];
    try {
      const output = execSync(gitCmd, {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      files = output
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((f) => resolve(repoRoot, f));
    } catch {
      files = [];
    }

    return computeBlastRadius(store, files, maxDepth);
  }

  /**
   * Query the graph with a specific pattern.
   */
  query(repoRoot: string, pattern: QueryPattern, target: string): QueryResult {
    const store = this.getStore(repoRoot);
    const nodes = [];
    const edges = [];

    switch (pattern) {
      case 'callers_of': {
        // Find all nodes that call the target
        const targetEdges = store.getEdgesByTarget(`function:${repoRoot}:${target}`);
        for (const edge of targetEdges) {
          if (edge.kind === 'CALLS') {
            const node = store.getNodeById(edge.sourceId);
            if (node) nodes.push(node);
            edges.push(edge);
          }
        }
        break;
      }
      case 'callees_of': {
        // Find all nodes called by the target
        const outEdges = store.getEdgesBySource(`function:${repoRoot}:${target}`);
        for (const edge of outEdges) {
          if (edge.kind === 'CALLS') {
            const node = store.getNodeById(edge.targetId);
            if (node) nodes.push(node);
            edges.push(edge);
          }
        }
        break;
      }
      case 'tests_for': {
        // Find test nodes that depend on the target file
        const targetFileId = `file:${target.startsWith('/') ? target : resolve(repoRoot, target)}`;
        const incomingEdges = store.getEdgesByTarget(targetFileId);
        for (const edge of incomingEdges) {
          const node = store.getNodeById(edge.sourceId);
          if (node?.isTest) {
            nodes.push(node);
            edges.push(edge);
          }
        }
        break;
      }
      case 'imports_of': {
        // Find files that import the target
        const targetFileId = `file:${target.startsWith('/') ? target : resolve(repoRoot, target)}`;
        const incomingEdges = store.getEdgesByTarget(targetFileId);
        for (const edge of incomingEdges) {
          if (edge.kind === 'IMPORTS_FROM') {
            const node = store.getNodeById(edge.sourceId);
            if (node) nodes.push(node);
            edges.push(edge);
          }
        }
        break;
      }
    }

    return { nodes, edges };
  }

  /**
   * Returns statistics about the code graph.
   */
  stats(repoRoot: string): CodeGraphStats {
    const dbPath = this.getDbPath(repoRoot);
    const store = this.getStore(repoRoot);
    return store.getStats(dbPath);
  }

  /**
   * Checks if a code-graph.db exists for the given repo root.
   */
  dbExists(repoRoot: string): boolean {
    return existsSync(this.getDbPath(repoRoot));
  }

  /**
   * Search for files whose paths or node names contain any of the given keywords.
   * Returns unique file paths sorted by match count descending.
   */
  searchByKeywords(repoRoot: string, keywords: string[]): string[] {
    if (keywords.length === 0) return [];
    const store = this.getStore(repoRoot);
    const nodes = store.getAllNodes();
    const lower = keywords.map((k) => k.toLowerCase());

    const scoreMap = new Map<string, number>();
    for (const node of nodes) {
      const fileLower = node.filePath.toLowerCase();
      const nameLower = node.name.toLowerCase();
      let score = 0;
      for (const kw of lower) {
        if (fileLower.includes(kw) || nameLower.includes(kw)) {
          score++;
        }
      }
      if (score > 0) {
        const prev = scoreMap.get(node.filePath) ?? 0;
        scoreMap.set(node.filePath, Math.max(prev, score));
      }
    }

    return [...scoreMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([filePath]) => filePath);
  }

  /**
   * Close all open database connections.
   */
  close(): void {
    for (const store of this.storeCache.values()) {
      store.close();
    }
    this.storeCache.clear();
  }

  private getGitChangedFiles(repoRoot: string, base: string): string[] {
    try {
      const output = execSync(`git diff --name-only ${base}`, {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return output
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((f) => resolve(repoRoot, f));
    } catch {
      // Not a git repo or no changes — return empty
      return [];
    }
  }
}

// Singleton for shared use across MCP tools
export const codeGraphEngine = new CodeGraphEngine();
