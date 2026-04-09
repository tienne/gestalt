import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { NodeKind, EdgeKind } from '../types.js';
import type { AnalyzerPlugin, ParseResult, CodeGraphNode, CodeGraphEdge } from '../types.js';

function isTestFile(filePath: string): boolean {
  return (
    filePath.includes('Test.java') || filePath.includes('/test/') || filePath.includes('/tests/')
  );
}

export const javaPlugin: AnalyzerPlugin = {
  language: 'java',
  extensions: ['.java'],

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
    const classRegex =
      /(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+)*(?:class|enum)\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+))?/;
    const interfaceRegex = /(?:public\s+)?interface\s+(\w+)/;
    const methodRegex =
      /(?:public|private|protected|static|final|abstract|synchronized|native|default)\s+[\w<>\[\]]+\s+(\w+)\s*\(/;
    const importRegex = /^import\s+(?:static\s+)?([\w.]+);/;

    let currentClassId: string | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      const lineNum = i + 1;

      // Import
      const importMatch = importRegex.exec(line);
      if (importMatch) {
        const pkg = importMatch[1]!;
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
        continue;
      }

      // Interface
      const ifaceMatch = interfaceRegex.exec(line);
      if (ifaceMatch) {
        const name = ifaceMatch[1]!;
        const nodeId = `type:${filePath}:${name}`;
        nodes.push({
          id: nodeId,
          kind: NodeKind.Type,
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
        currentClassId = nodeId;
        continue;
      }

      // Class
      const classMatch = classRegex.exec(line);
      if (classMatch) {
        const name = classMatch[1]!;
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

        // Inheritance
        const parent = classMatch[2];
        if (parent) {
          const parentId = `class:${filePath}:${parent}`;
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
        currentClassId = nodeId;
        continue;
      }

      // Method (only inside a class)
      if (currentClassId) {
        const methodMatch = methodRegex.exec(line);
        if (methodMatch && !line.includes('class ') && !line.includes('interface ')) {
          const name = methodMatch[1]!;
          if (name !== 'if' && name !== 'while' && name !== 'for' && name !== 'return') {
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
            const edgeKey = `CONTAINS:${currentClassId}:${nodeId}`;
            if (!edgeSet.has(edgeKey)) {
              edgeSet.add(edgeKey);
              edges.push({
                kind: EdgeKind.CONTAINS,
                sourceId: currentClassId,
                targetId: nodeId,
                line: lineNum,
                updatedAt: now,
              });
            }
          }
        }
      }
    }

    return { nodes, edges, fileHash };
  },
};
