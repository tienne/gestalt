import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { NodeKind, EdgeKind } from '../types.js';
import type { AnalyzerPlugin, ParseResult, CodeGraphNode, CodeGraphEdge } from '../types.js';

function isTestFile(filePath: string): boolean {
  return (
    filePath.includes('/tests/') || filePath.includes('/test/') || basename(filePath) === 'tests.rs'
  );
}

export const rustPlugin: AnalyzerPlugin = {
  language: 'rust',
  extensions: ['.rs'],

  parse(filePath: string, content: string): ParseResult {
    const fileHash = createHash('sha256').update(content).digest('hex');
    const now = Date.now();
    // Rust test files have #[cfg(test)] or are in tests/ directories
    const isTest = isTestFile(filePath) || content.includes('#[cfg(test)]');
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
    const funcRegex = /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(/;
    const structRegex = /^(?:pub\s+)?struct\s+(\w+)/;
    const enumRegex = /^(?:pub\s+)?enum\s+(\w+)/;
    const traitRegex = /^(?:pub\s+)?trait\s+(\w+)/;
    const useRegex = /^use\s+([\w:]+)/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineNum = i + 1;

      // use statement
      const useMatch = useRegex.exec(line.trim());
      if (useMatch) {
        const mod = useMatch[1]!;
        if (mod.startsWith('crate::') || mod.startsWith('super::') || mod.startsWith('self::')) {
          const targetId = `file:${mod.replace(/::/g, '/')}`;
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

      // Function
      const funcMatch = funcRegex.exec(line.trim());
      if (funcMatch) {
        const name = funcMatch[1]!;
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
        continue;
      }

      // Struct
      const structMatch = structRegex.exec(line.trim());
      if (structMatch) {
        const name = structMatch[1]!;
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
        continue;
      }

      // Enum
      const enumMatch = enumRegex.exec(line.trim());
      if (enumMatch) {
        const name = enumMatch[1]!;
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
        continue;
      }

      // Trait (interface-like)
      const traitMatch = traitRegex.exec(line.trim());
      if (traitMatch) {
        const name = traitMatch[1]!;
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
      }
    }

    return { nodes, edges, fileHash };
  },
};
