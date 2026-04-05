import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { NodeKind, EdgeKind } from '../types.js';
import type { AnalyzerPlugin, ParseResult, CodeGraphNode, CodeGraphEdge } from '../types.js';

function isTestFile(filePath: string): boolean {
  const name = basename(filePath);
  return (
    name.startsWith('test_') ||
    name.endsWith('_test.py') ||
    filePath.includes('__tests__') ||
    filePath.includes('/tests/') ||
    filePath.includes('.test.')
  );
}

export const pythonPlugin: AnalyzerPlugin = {
  language: 'python',
  extensions: ['.py'],

  parse(filePath: string, content: string): ParseResult {
    const fileHash = createHash('sha256').update(content).digest('hex');
    const now = Date.now();
    const isTest = isTestFile(filePath);
    const nodes: CodeGraphNode[] = [];
    const edges: CodeGraphEdge[] = [];
    const edgeSet = new Set<string>();

    const fileNodeId = `file:${filePath}`;
    nodes.push({
      id: fileNodeId,
      kind: NodeKind.File,
      name: basename(filePath),
      filePath,
      isTest,
      fileHash,
      updatedAt: now,
    });

    const lines = content.split('\n');

    // Parse functions and classes
    const funcRegex = /^(\s*)(async\s+)?def\s+(\w+)\s*\(/;
    const classRegex = /^(\s*)class\s+(\w+)(?:\s*\(([^)]*)\))?:/;
    const importRegex = /^(?:import\s+(\S+)|from\s+(\S+)\s+import\s+)/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineNum = i + 1;

      // Function
      const funcMatch = funcRegex.exec(line);
      if (funcMatch) {
        const indent = funcMatch[1]!.length;
        const name = funcMatch[3]!;
        if (indent === 0 || indent === 4) {
          const nodeId = `function:${filePath}:${name}`;
          nodes.push({
            id: nodeId,
            kind: NodeKind.Function,
            name,
            filePath,
            lineStart: lineNum,
            isTest,
            updatedAt: now,
          });
          const edgeKey = `CONTAINS:${fileNodeId}:${nodeId}`;
          if (!edgeSet.has(edgeKey)) {
            edgeSet.add(edgeKey);
            edges.push({ kind: EdgeKind.CONTAINS, sourceId: fileNodeId, targetId: nodeId, line: lineNum, updatedAt: now });
          }
        }
        continue;
      }

      // Class
      const classMatch = classRegex.exec(line);
      if (classMatch) {
        const name = classMatch[2]!;
        const parents = classMatch[3];
        const nodeId = `class:${filePath}:${name}`;
        nodes.push({
          id: nodeId,
          kind: NodeKind.Class,
          name,
          filePath,
          lineStart: lineNum,
          isTest,
          updatedAt: now,
        });
        const containsKey = `CONTAINS:${fileNodeId}:${nodeId}`;
        if (!edgeSet.has(containsKey)) {
          edgeSet.add(containsKey);
          edges.push({ kind: EdgeKind.CONTAINS, sourceId: fileNodeId, targetId: nodeId, line: lineNum, updatedAt: now });
        }
        // Inheritance
        if (parents) {
          for (const parent of parents.split(',').map((p) => p.trim())) {
            if (parent && parent !== 'object') {
              const parentId = `class:${filePath}:${parent}`;
              const inheritKey = `INHERITS:${nodeId}:${parentId}`;
              if (!edgeSet.has(inheritKey)) {
                edgeSet.add(inheritKey);
                edges.push({ kind: EdgeKind.INHERITS, sourceId: nodeId, targetId: parentId, line: lineNum, updatedAt: now });
              }
            }
          }
        }
        continue;
      }

      // Import (relative: from . import or from .module import)
      const importMatch = importRegex.exec(line);
      if (importMatch) {
        const fromModule = importMatch[2];
        if (fromModule && (fromModule.startsWith('.') || fromModule.startsWith('/'))) {
          const targetId = `file:${fromModule}`;
          const edgeKey = `IMPORTS_FROM:${fileNodeId}:${targetId}`;
          if (!edgeSet.has(edgeKey)) {
            edgeSet.add(edgeKey);
            edges.push({ kind: EdgeKind.IMPORTS_FROM, sourceId: fileNodeId, targetId, line: lineNum, updatedAt: now });
          }
        }
      }
    }

    return { nodes, edges, fileHash };
  },
};
