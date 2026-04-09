import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { NodeKind, EdgeKind } from '../types.js';
import type { AnalyzerPlugin, ParseResult, CodeGraphNode, CodeGraphEdge } from '../types.js';

function isTestFile(filePath: string): boolean {
  return (
    filePath.includes('Test.m') || filePath.includes('Tests.m') || filePath.includes('/Tests/')
  );
}

export const objcPlugin: AnalyzerPlugin = {
  language: 'objective-c',
  extensions: ['.m', '.h'],

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
    // @interface ClassName : ParentClass
    const interfaceRegex = /^@interface\s+(\w+)(?:\s*:\s*(\w+))?/;
    // @implementation ClassName
    const implementationRegex = /^@implementation\s+(\w+)/;
    // - (ReturnType)methodName or + (ReturnType)methodName
    const methodRegex = /^[+-]\s*\(\s*[\w*\s]+\s*\)\s*(\w+)/;
    // #import "Header.h" or #import <Framework/Header.h>
    const importRegex = /^#import\s+(?:"([^"]+)"|<([^>]+)>)/;

    let currentClassId: string | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      const lineNum = i + 1;

      // Import
      const importMatch = importRegex.exec(line);
      if (importMatch) {
        const local = importMatch[1];
        const framework = importMatch[2];
        if (local) {
          // Local header — resolve relative to current file's directory
          const resolvedPath = resolve(dirname(filePath), local);
          const targetId = `file:${resolvedPath}`;
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
        } else if (framework) {
          const targetId = `file:${framework}`;
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

      // @interface (class declaration)
      const ifaceMatch = interfaceRegex.exec(line);
      if (ifaceMatch) {
        const name = ifaceMatch[1]!;
        const parent = ifaceMatch[2];
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

      // @implementation
      const implMatch = implementationRegex.exec(line);
      if (implMatch) {
        const name = implMatch[1]!;
        // Reuse or create the class node
        currentClassId = `class:${filePath}:${name}`;
        if (!nodes.find((n) => n.id === currentClassId)) {
          nodes.push({
            id: currentClassId,
            kind: NodeKind.Class,
            name,
            filePath,
            lineStart: lineNum,
            isTest,
            updatedAt: now,
          });
          const edgeKey = `CONTAINS:${fileNodeId}:${currentClassId}`;
          if (!edgeSet.has(edgeKey)) {
            edgeSet.add(edgeKey);
            edges.push({
              kind: EdgeKind.CONTAINS,
              sourceId: fileNodeId,
              targetId: currentClassId,
              line: lineNum,
              updatedAt: now,
            });
          }
        }
        continue;
      }

      // @end
      if (line === '@end') {
        currentClassId = null;
        continue;
      }

      // Methods
      if (currentClassId) {
        const methodMatch = methodRegex.exec(line);
        if (methodMatch) {
          const name = methodMatch[1]!;
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

    return { nodes, edges, fileHash };
  },
};
