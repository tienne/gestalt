import ts from 'typescript';
import { createHash } from 'node:crypto';
import { resolve, dirname, basename, extname } from 'node:path';
import { log } from '../../core/log.js';
import {
  NodeKind,
  EdgeKind,
  type AnalyzerPlugin,
  type ParseResult,
  type CodeGraphNode,
  type CodeGraphEdge,
} from '../types.js';

const SUPPORTED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

function isTestFile(filePath: string): boolean {
  return (
    filePath.includes('.test.') || filePath.includes('.spec.') || filePath.includes('__tests__')
  );
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function getNodePosition(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): { lineStart: number; lineEnd: number } {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return { lineStart: start.line + 1, lineEnd: end.line + 1 };
}

function getFunctionName(
  node: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration,
): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    return node.name?.getText();
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.text;
    }
    if (ts.isPropertyDeclaration(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.text;
    }
  }
  return undefined;
}

function resolveImportPath(moduleSpecifier: string, currentFilePath: string): string | undefined {
  if (!moduleSpecifier.startsWith('./') && !moduleSpecifier.startsWith('../')) {
    return undefined;
  }
  const dir = dirname(currentFilePath);
  let resolved = resolve(dir, moduleSpecifier);

  // .js 확장자를 .ts로 치환 (ESM import 대응)
  if (extname(resolved) === '.js') {
    resolved = resolved.slice(0, -3) + '.ts';
  } else if (extname(resolved) === '') {
    // 확장자 없는 경우 .ts 붙이기
    resolved = resolved + '.ts';
  }

  return resolved;
}

export const typescriptPlugin: AnalyzerPlugin = {
  language: 'typescript',
  extensions: SUPPORTED_EXTENSIONS,

  parse(filePath: string, content: string): ParseResult {
    const fileHash = hashContent(content);
    const nodes: CodeGraphNode[] = [];
    const edges: CodeGraphEdge[] = [];
    const now = Date.now();
    const isTest = isTestFile(filePath);
    const edgeSet = new Set<string>();

    function addEdge(kind: EdgeKind, sourceId: string, targetId: string, line?: number): void {
      const key = `${kind}:${sourceId}:${targetId}`;
      if (edgeSet.has(key)) return;
      edgeSet.add(key);
      edges.push({ kind, sourceId, targetId, line, updatedAt: now });
    }

    let sourceFile: ts.SourceFile;
    try {
      sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
    } catch (err) {
      log(`TypescriptPlugin: parse error for ${filePath}: ${err}`);
      return { nodes: [], edges: [], fileHash };
    }

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

    function visit(node: ts.Node): void {
      // 함수 선언
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node) ||
        ts.isMethodDeclaration(node)
      ) {
        const name = getFunctionName(
          node as
            | ts.FunctionDeclaration
            | ts.ArrowFunction
            | ts.FunctionExpression
            | ts.MethodDeclaration,
        );
        if (name) {
          const { lineStart, lineEnd } = getNodePosition(node, sourceFile);
          const fnId = `function:${filePath}:${name}`;
          const existing = nodes.find((n) => n.id === fnId);
          if (!existing) {
            nodes.push({
              id: fnId,
              kind: NodeKind.Function,
              name,
              filePath,
              lineStart,
              lineEnd,
              isTest,
              updatedAt: now,
            });
            addEdge(EdgeKind.CONTAINS, fileNodeId, fnId, lineStart);
          }
        }
      }

      // 클래스 선언
      if (ts.isClassDeclaration(node)) {
        const name = node.name?.getText(sourceFile);
        if (name) {
          const { lineStart, lineEnd } = getNodePosition(node, sourceFile);
          const classId = `class:${filePath}:${name}`;
          const existing = nodes.find((n) => n.id === classId);
          if (!existing) {
            nodes.push({
              id: classId,
              kind: NodeKind.Class,
              name,
              filePath,
              lineStart,
              lineEnd,
              isTest,
              updatedAt: now,
            });
            addEdge(EdgeKind.CONTAINS, fileNodeId, classId, lineStart);

            // 상속 관계 (INHERITS)
            for (const heritage of node.heritageClauses ?? []) {
              if (heritage.token === ts.SyntaxKind.ExtendsKeyword) {
                for (const type of heritage.types) {
                  const parentName = type.expression.getText(sourceFile);
                  if (parentName) {
                    // 부모 클래스 노드 id는 같은 파일 내에서 먼저 찾고, 없으면 bare id 사용
                    const parentId = `class:${filePath}:${parentName}`;
                    addEdge(EdgeKind.INHERITS, classId, parentId, lineStart);
                  }
                }
              }
            }
          }
        }
      }

      // 인터페이스 선언
      if (ts.isInterfaceDeclaration(node)) {
        const name = node.name.getText(sourceFile);
        if (name) {
          const { lineStart, lineEnd } = getNodePosition(node, sourceFile);
          const typeId = `type:${filePath}:${name}`;
          const existing = nodes.find((n) => n.id === typeId);
          if (!existing) {
            nodes.push({
              id: typeId,
              kind: NodeKind.Type,
              name,
              filePath,
              lineStart,
              lineEnd,
              isTest,
              updatedAt: now,
            });
          }
        }
      }

      // 타입 별칭 선언
      if (ts.isTypeAliasDeclaration(node)) {
        const name = node.name.getText(sourceFile);
        if (name) {
          const { lineStart, lineEnd } = getNodePosition(node, sourceFile);
          const typeId = `type:${filePath}:${name}`;
          const existing = nodes.find((n) => n.id === typeId);
          if (!existing) {
            nodes.push({
              id: typeId,
              kind: NodeKind.Type,
              name,
              filePath,
              lineStart,
              lineEnd,
              isTest,
              updatedAt: now,
            });
          }
        }
      }

      // 임포트 선언
      if (ts.isImportDeclaration(node)) {
        const moduleSpecifier = (node.moduleSpecifier as ts.StringLiteral).text;
        const resolvedPath = resolveImportPath(moduleSpecifier, filePath);
        if (resolvedPath) {
          const { lineStart } = getNodePosition(node, sourceFile);
          const targetId = `file:${resolvedPath}`;
          addEdge(EdgeKind.IMPORTS_FROM, fileNodeId, targetId, lineStart);
        }
      }

      ts.forEachChild(node, visit);
    }

    try {
      ts.forEachChild(sourceFile, visit);
    } catch (err) {
      log(`TypescriptPlugin: traversal error for ${filePath}: ${err}`);
      return { nodes: [], edges: [], fileHash };
    }

    return { nodes, edges, fileHash };
  },
};
