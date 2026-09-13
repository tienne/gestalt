import type { CodeGraphStore } from './storage.js';
import type {
  BlastRadiusResult,
  BlastRadiusNode,
  CoChangeLookup,
  RankedImpactFile,
} from './types.js';
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
  coChange?: CoChangeLookup,
): BlastRadiusResult {
  if (changedFiles.length === 0) {
    return {
      changedFiles: [],
      impactedFiles: [],
      impactedNodes: [],
      riskScore: 0,
      maxDepthUsed: maxDepth,
      depthExhausted: false,
      unexploredNodes: 0,
      rankedFiles: [],
      coChangeAvailable: coChange?.available ?? false,
      coChangeReason: coChange?.reason,
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

  // 루프는 두 이유로 끝난다 — 더 갈 데가 없거나(frontier 비었음),
  // maxDepth에 걸렸거나. 후자면 아직 안 가본 노드가 frontier에 남아 있고
  // impactedFiles와 riskScore는 실제값의 하한이 된다. 그 사실을 결과에 담는다.
  const depthExhausted = frontier.length > 0;
  const unexploredNodes = frontier.length;

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

  // 7. import 신호와 이력 신호를 합쳐 출처를 붙인다.
  //    impactedFiles는 건드리지 않는다 — 소비자가 vitest 인자로 직결한다.
  const rankedFiles = buildRankedFiles(changedFiles, impactedFiles, impactedNodes, coChange);
  const historyOnly = rankedFiles.filter((f) => f.origin === 'history').length;
  const both = rankedFiles.filter((f) => f.origin === 'both').length;

  // 8. Build summary
  const summary = buildSummary(
    changedFiles,
    impactedFiles,
    impactedNodes,
    riskScore,
    maxDepth,
    depthExhausted,
    unexploredNodes,
    coChange,
    historyOnly,
    both,
  );

  return {
    changedFiles,
    impactedFiles,
    impactedNodes,
    riskScore,
    maxDepthUsed: maxDepth,
    depthExhausted,
    unexploredNodes,
    rankedFiles,
    coChangeAvailable: coChange?.available ?? false,
    coChangeReason: coChange?.reason,
    summary,
  };
}

/**
 * both(두 신호 모두) → history(이력 전용) → import(import 전용) 순으로 세운다.
 * 두 신호에 함께 걸린 파일이 가장 먼저 읽혀야 할 파일이다.
 */
function buildRankedFiles(
  changedFiles: string[],
  impactedFiles: string[],
  impactedNodes: BlastRadiusNode[],
  coChange?: CoChangeLookup,
): RankedImpactFile[] {
  const hopByFile = new Map<string, number>();
  for (const f of changedFiles) hopByFile.set(f, 0);
  for (const node of impactedNodes) {
    const prev = hopByFile.get(node.filePath);
    if (prev === undefined || node.hopDistance < prev)
      hopByFile.set(node.filePath, node.hopDistance);
  }

  const importSet = new Set(impactedFiles);
  const neighbors = coChange?.neighbors ?? [];

  const both: RankedImpactFile[] = [];
  const history: RankedImpactFile[] = [];
  const seenFromHistory = new Set<string>();

  for (const n of neighbors) {
    seenFromHistory.add(n.filePath);
    const entry: RankedImpactFile = {
      filePath: n.filePath,
      origin: importSet.has(n.filePath) ? 'both' : 'history',
      coChangeCount: n.pairCount,
      confidence: n.confidence,
      lift: n.lift,
      isTest: isTestFile(n.filePath),
    };
    if (entry.origin === 'both') {
      entry.hopDistance = hopByFile.get(n.filePath);
      both.push(entry);
    } else {
      history.push(entry);
    }
  }

  const byScore = (a: RankedImpactFile, b: RankedImpactFile): number =>
    (b.confidence ?? 0) * (b.lift ?? 0) - (a.confidence ?? 0) * (a.lift ?? 0) ||
    (b.coChangeCount ?? 0) - (a.coChangeCount ?? 0);
  both.sort(byScore);
  history.sort(byScore);

  const importOnly: RankedImpactFile[] = impactedFiles
    .filter((f) => !seenFromHistory.has(f))
    .map((f) => ({
      filePath: f,
      origin: 'import' as const,
      hopDistance: hopByFile.get(f) ?? 0,
      isTest: isTestFile(f),
    }));
  importOnly.sort((a, b) => {
    if (a.isTest !== b.isTest) return a.isTest ? -1 : 1;
    return (a.hopDistance ?? 0) - (b.hopDistance ?? 0) || a.filePath.localeCompare(b.filePath);
  });

  return [...both, ...history, ...importOnly];
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
  maxDepth: number,
  depthExhausted: boolean,
  unexploredNodes: number,
  coChange: CoChangeLookup | undefined,
  historyOnly: number,
  both: number,
): string {
  const testFileCount = impactedFiles.filter(isTestFile).length;
  const riskLabel = riskScore > 0.6 ? 'HIGH' : riskScore > 0.3 ? 'MEDIUM' : 'LOW';
  const testNodes = impactedNodes.filter((n) => n.kind === NodeKind.Function && n.isTest).length;

  const base =
    `Changed ${changedFiles.length} file(s) impact ${impactedFiles.length} file(s) ` +
    `(${testFileCount} test files, ${testNodes} test functions). ` +
    `Risk: ${riskLabel} (${(riskScore * 100).toFixed(1)}%).`;

  // 이력 신호가 안 실린 것과 함께 바뀐 파일이 없는 것은 다르다. summary만 읽는
  // 자리가 있으므로 여기서도 둘을 갈라 말한다.
  const history = !coChange?.available
    ? ' Git history signal unavailable (import graph only).'
    : ` Git history adds ${historyOnly} file(s) imports cannot see, ${both} confirmed by both signals.`;

  // 잘렸으면 요약에서 먼저 말한다. 사람은 summary만 읽고 판단하는 일이 잦은데
  // "영향 12개, 위험 낮음"만 보면 그게 전부인 줄 안다.
  if (!depthExhausted) return `${base}${history}`;

  return (
    `${base} INCOMPLETE: search stopped at depth ${maxDepth} with ${unexploredNodes} node(s) ` +
    `still unexplored, so the impact list and risk are lower bounds, not totals. ` +
    `Re-run with a higher maxDepth to see the rest.${history}`
  );
}
