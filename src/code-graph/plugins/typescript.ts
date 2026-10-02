import ts from 'typescript';
import { createHash } from 'node:crypto';
import { resolve, dirname, basename, extname } from 'node:path';
import { log } from '../../core/log.js';
import { extractTypeScriptSkeleton } from './typescript-skeleton.js';
import { docText } from '../ko-text.js';
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

/** 주석과 다음 토큰 사이가 빈 줄 없이 붙어 있는가 */
function attached(text: string, from: number, to: number): boolean {
  return (text.slice(from, to).match(/\n/g)?.length ?? 0) <= 1;
}

/**
 * 선언 바로 앞에 붙은 주석 묶음. 빈 줄로 떨어진 주석은 그 선언 설명으로 보지 않는다
 * (파일 머리 주석이나 앞 절의 구분 주석이기 쉽다).
 * 화살표 함수는 주석이 `const x = () => …` 문 앞에 붙으므로 그 문을 기준으로 본다.
 */
function leadingDoc(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  let anchor: ts.Node = node;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const p = node.parent;
    if (ts.isVariableDeclaration(p) && ts.isVariableStatement(p.parent.parent))
      anchor = p.parent.parent;
    else if (ts.isPropertyDeclaration(p)) anchor = p;
  }
  const text = sourceFile.getFullText();
  const ranges = ts.getLeadingCommentRanges(text, anchor.getFullStart()) ?? [];
  const block: string[] = [];
  let next = anchor.getStart(sourceFile);
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i]!;
    if (!attached(text, r.end, next)) break;
    block.unshift(text.slice(r.pos, r.end));
    next = r.pos;
  }
  return block.length > 0 ? docText(block.join('\n')) : undefined;
}

/**
 * 파일 맨 위 주석. 첫 문장에 빈 줄 없이 붙어 있으면 그 문장의 설명이라 머리 주석이 아니다.
 * 단 첫 문장이 import면 import를 설명하는 주석은 드무니 머리 주석으로 친다.
 */
function fileHeaderDoc(sourceFile: ts.SourceFile): string | undefined {
  const text = sourceFile.getFullText();
  // 위치 0에서 부르면 TS가 shebang을 알아서 건너뛴다. 그 다음 줄부터 부르면 오히려 못 찾는다
  const ranges = ts.getLeadingCommentRanges(text, 0) ?? [];
  if (ranges.length === 0) return undefined;
  const first = sourceFile.statements[0];
  const last = ranges[ranges.length - 1]!;
  if (
    first &&
    !ts.isImportDeclaration(first) &&
    attached(text, last.end, first.getStart(sourceFile))
  ) {
    return undefined;
  }
  return docText(ranges.map((r) => text.slice(r.pos, r.end)).join('\n'));
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
      doc: fileHeaderDoc(sourceFile),
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
              doc: leadingDoc(node, sourceFile),
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
              doc: leadingDoc(node, sourceFile),
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
              doc: leadingDoc(node, sourceFile),
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
              doc: leadingDoc(node, sourceFile),
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

  skeleton: extractTypeScriptSkeleton,
};
