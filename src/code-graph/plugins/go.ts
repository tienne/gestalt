import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { NodeKind, EdgeKind } from '../types.js';
import type { AnalyzerPlugin, ParseResult, CodeGraphNode, CodeGraphEdge } from '../types.js';

function isTestFile(filePath: string): boolean {
  return basename(filePath).endsWith('_test.go') || filePath.includes('/testdata/');
}

export const goPlugin: AnalyzerPlugin = {
  language: 'go',
  extensions: ['.go'],

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
    // Regex for top-level func and method declarations
    const funcRegex = /^func\s+(?:\(\s*\w+\s+\*?\w+\s*\)\s+)?(\w+)\s*\(/;
    // type declaration
    const typeRegex = /^type\s+(\w+)\s+(struct|interface)/;
    // import single line
    const importSingleRegex = /^import\s+"([^"]+)"/;
    // inside import block
    const importBlockEntryRegex = /^\s+"([^"]+)"/;

    let inImportBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineNum = i + 1;

      if (line.trim() === 'import (') {
        inImportBlock = true;
        continue;
      }
      if (inImportBlock) {
        if (line.trim() === ')') {
          inImportBlock = false;
        } else {
          const m = importBlockEntryRegex.exec(line);
          if (m) {
            const mod = m[1]!;
            if (mod.includes('/')) {
              const targetId = `file:${mod}`;
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
          }
        }
        continue;
      }

      // Single import
      const singleImport = importSingleRegex.exec(line);
      if (singleImport) {
        const mod = singleImport[1]!;
        if (mod.includes('/')) {
          const targetId = `file:${mod}`;
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

      // Function / method
      const funcMatch = funcRegex.exec(line);
      if (funcMatch) {
        const name = funcMatch[1]!;
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
        continue;
      }

      // Type declaration
      const typeMatch = typeRegex.exec(line);
      if (typeMatch) {
        const name = typeMatch[1]!;
        const kind = typeMatch[2]! === 'struct' ? NodeKind.Class : NodeKind.Type;
        const nodeId = `${kind === NodeKind.Class ? 'class' : 'type'}:${filePath}:${name}`;
        nodes.push({
          id: nodeId,
          kind,
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

    return { nodes, edges, fileHash };
  },
};
