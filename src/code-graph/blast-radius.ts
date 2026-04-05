import type { CodeGraphStore } from './storage.js';
import type { BlastRadiusResult, BlastRadiusNode } from './types.js';
import { NodeKind } from './types.js';

/**
 * Computes blast-radius for a set of changed files using reverse BFS.
 * Reverse BFS: finds all nodes that depend on (import/call) the changed files.
 * Test files are prioritized in the result.
 */
export function computeBlastRadius(
  store: CodeGraphStore,
  changedFiles: string[],
  maxDepth: number = 2,
): BlastRadiusResult {
  if (changedFiles.length === 0) {
    return {
      changedFiles: [],
      impactedFiles: [],
      impactedNodes: [],
      riskScore: 0,
      maxDepthUsed: maxDepth,
      summary: 'No changed files provided.',
    };
  }

  // 1. Collect seed nodes from changed files
  const seedNodeIds = new Set<string>();
  for (const filePath of changedFiles) {
    const nodes = store.getNodesByFile(filePath);
    for (const node of nodes) {
      seedNodeIds.add(node.id);
    }
    // Always include the file node itself
    seedNodeIds.add(`file:${filePath}`);
  }

  // 2. BFS: find all nodes that depend on seeds (reverse direction)
  // An edge (source → target) means source depends on target.
  // So we look for edges where target is in our current frontier.
  const visited = new Set<string>(seedNodeIds);
  const impactedNodeIds = new Set<string>();
  let frontier = Array.from(seedNodeIds);

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const nextFrontier: string[] = [];

    for (const targetId of frontier) {
      // Find all edges where this node is the target (i.e., who imports/calls this)
      const incomingEdges = store.getEdgesByTarget(targetId);
      for (const edge of incomingEdges) {
        if (!visited.has(edge.sourceId)) {
          visited.add(edge.sourceId);
          impactedNodeIds.add(edge.sourceId);
          nextFrontier.push(edge.sourceId);
        }
      }
    }

    frontier = nextFrontier;
  }

  // 3. Resolve impacted node details and extract file paths
  const impactedFileSet = new Set<string>(changedFiles);
  const impactedNodes: BlastRadiusNode[] = [];

  for (const nodeId of impactedNodeIds) {
    const node = store.getNodeById(nodeId);
    if (!node) continue;

    impactedFileSet.add(node.filePath);

    // Compute hop distance (approximate: BFS level)
    const hopDistance = computeHopDistance(nodeId, seedNodeIds, store, maxDepth);

    impactedNodes.push({
      nodeId: node.id,
      filePath: node.filePath,
      kind: node.kind,
      name: node.name,
      hopDistance,
      isTest: node.isTest,
    });
  }

  // 4. Sort: test files first, then by hop distance
  impactedNodes.sort((a, b) => {
    if (a.isTest && !b.isTest) return -1;
    if (!a.isTest && b.isTest) return 1;
    return a.hopDistance - b.hopDistance;
  });

  // 5. Build impactedFiles list: test files first
  const allFiles = Array.from(impactedFileSet);
  const testFiles = allFiles.filter((f) => isTestFile(f));
  const nonTestFiles = allFiles.filter((f) => !isTestFile(f));
  const impactedFiles = [...testFiles, ...nonTestFiles];

  // 6. Calculate risk score
  const stats = store.getStats('');
  const totalNodes = stats.totalNodes;
  const riskScore = totalNodes > 0 ? Math.min(1, impactedNodeIds.size / totalNodes) : 0;

  // 7. Build summary
  const summary = buildSummary(changedFiles, impactedFiles, impactedNodes, riskScore);

  return {
    changedFiles,
    impactedFiles,
    impactedNodes,
    riskScore,
    maxDepthUsed: maxDepth,
    summary,
  };
}

/**
 * Approximates the minimum hop distance from a node to the seed set.
 * Uses a simple BFS from the node backward toward the seeds.
 */
function computeHopDistance(
  nodeId: string,
  seedNodeIds: Set<string>,
  store: CodeGraphStore,
  maxDepth: number,
): number {
  if (seedNodeIds.has(nodeId)) return 0;

  const visited = new Set<string>([nodeId]);
  let frontier = [nodeId];

  for (let depth = 1; depth <= maxDepth; depth++) {
    const nextFrontier: string[] = [];
    for (const id of frontier) {
      // Check outgoing edges (what this node depends on)
      const outgoingEdges = store.getEdgesBySource(id);
      for (const edge of outgoingEdges) {
        if (seedNodeIds.has(edge.targetId)) return depth;
        if (!visited.has(edge.targetId)) {
          visited.add(edge.targetId);
          nextFrontier.push(edge.targetId);
        }
      }
    }
    frontier = nextFrontier;
  }

  return maxDepth; // fallback
}

function isTestFile(filePath: string): boolean {
  return (
    filePath.includes('.test.') ||
    filePath.includes('.spec.') ||
    filePath.includes('__tests__') ||
    filePath.includes('/tests/') ||
    filePath.includes('_test.') ||
    filePath.includes('test_')
  );
}

function buildSummary(
  changedFiles: string[],
  impactedFiles: string[],
  impactedNodes: BlastRadiusNode[],
  riskScore: number,
): string {
  const testFileCount = impactedFiles.filter(isTestFile).length;
  const riskLabel = riskScore > 0.6 ? 'HIGH' : riskScore > 0.3 ? 'MEDIUM' : 'LOW';
  const testNodes = impactedNodes.filter((n) => n.kind === NodeKind.Function && n.isTest).length;

  return (
    `Changed ${changedFiles.length} file(s) impact ${impactedFiles.length} file(s) ` +
    `(${testFileCount} test files, ${testNodes} test functions). ` +
    `Risk: ${riskLabel} (${(riskScore * 100).toFixed(1)}%).`
  );
}
