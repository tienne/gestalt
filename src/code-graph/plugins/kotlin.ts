import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { NodeKind, EdgeKind } from '../types.js';
import type { AnalyzerPlugin, ParseResult, CodeGraphNode, CodeGraphEdge } from '../types.js';

function isTestFile(filePath: string): boolean {
  return (
    filePath.includes('Test.kt') ||
    filePath.includes('/test/') ||
    filePath.includes('/androidTest/')
  );
}

export const kotlinPlugin: AnalyzerPlugin = {
  language: 'kotlin',
  extensions: ['.kt', '.kts'],

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
    const funcRegex =
      /(?:override\s+|suspend\s+|inline\s+|private\s+|internal\s+|public\s+|protected\s+)*fun\s+(\w+)\s*(?:<[^>]*>)?\s*\(/;
    const classRegex =
      /(?:data\s+|sealed\s+|abstract\s+|open\s+|inner\s+)?(?:class|object|interface)\s+(\w+)(?:\s*(?::\s*([\w<>, ]+))?)?/;
    const importRegex = /^import\s+([\w.]+)/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineNum = i + 1;

      // Import
      const importMatch = importRegex.exec(line.trim());
      if (importMatch) {
        const pkg = importMatch[1]!;
        if (pkg.includes('.')) {
          const targetId = `file:${pkg.replace(/\./g, '/')}`;
          const edgeKey = `IMPORTS_FROM:${fileNodeId}:${targetId}`;
          if (!edgeSet.has(edgeKey)) {
            edgeSet.add(edgeKey);
            edges.push({
              kind: EdgeKind.IMPORTS_FROM,
              sourceId: fileNodeId,
              targetId,
              line: lineNum,
              updatedAt: now,
            });
          }
        }
        continue;
      }

      // Class / object / interface
      const classMatch = classRegex.exec(line.trim());
      if (classMatch && !line.trim().startsWith('//')) {
        const name = classMatch[1]!;
        const parentStr = classMatch[2];
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
        const edgeKey = `CONTAINS:${fileNodeId}:${nodeId}`;
        if (!edgeSet.has(edgeKey)) {
          edgeSet.add(edgeKey);
          edges.push({
            kind: EdgeKind.CONTAINS,
            sourceId: fileNodeId,
            targetId: nodeId,
            line: lineNum,
            updatedAt: now,
          });
        }
        // Inheritance (first part before comma = superclass)
        if (parentStr) {
          const firstParent = (parentStr.split(',')[0] ?? '')
            .trim()
            .replace(/\(.*\)/, '')
            .trim();
          if (firstParent) {
            const parentId = `class:${filePath}:${firstParent}`;
            const inheritKey = `INHERITS:${nodeId}:${parentId}`;
            if (!edgeSet.has(inheritKey)) {
              edgeSet.add(inheritKey);
              edges.push({
                kind: EdgeKind.INHERITS,
                sourceId: nodeId,
                targetId: parentId,
                line: lineNum,
                updatedAt: now,
              });
            }
          }
        }
        continue;
      }

      // Function
      const funcMatch = funcRegex.exec(line.trim());
      if (funcMatch) {
        const name = funcMatch[1];
        if (name) {
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
            edges.push({
              kind: EdgeKind.CONTAINS,
              sourceId: fileNodeId,
              targetId: nodeId,
              line: lineNum,
              updatedAt: now,
            });
          }
        }
      }
    }

    return { nodes, edges, fileHash };
  },
};
