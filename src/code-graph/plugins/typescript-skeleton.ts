import ts from 'typescript';
import type { SkeletonEntry } from '../types.js';

/** 이보다 긴 초기값은 `…`로 접는다. 상수 값 정도만 보이게 하려는 폭이다 */
const MAX_INITIALIZER_CHARS = 60;

/** 여러 줄 인자 목록을 한 줄로 접으며 생기는 `( a`와 `b, )`도 함께 정리한다. `<`, `>`는 비교식과 헷갈려 손대지 않는다 */
function oneLine(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/([([]) /g, '$1')
    .replace(/,? ([)\]])/g, '$1')
    .trim();
}

/**
 * TS/JS 파일에서 본문을 뺀 시그니처를 뽑는다.
 * 최상위 선언과 클래스, 인터페이스, enum, namespace 멤버를 담고 import는 뺀다.
 */
export function extractTypeScriptSkeleton(filePath: string, content: string): SkeletonEntry[] {
  const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const entries: SkeletonEntry[] = [];

  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const push = (node: ts.Node, depth: number, signature: string): void => {
    entries.push({
      lineStart: lineOf(node.getStart(sf)),
      lineEnd: lineOf(node.getEnd()),
      depth,
      signature: oneLine(signature),
    });
  };
  /** node 시작부터 upTo 직전까지. 본문이나 초기값 앞에서 자를 때 쓴다 */
  const head = (node: ts.Node, upTo: number): string =>
    content.slice(node.getStart(sf), upTo).replace(/[\s=:]+$/, '');
  const full = (node: ts.Node): string => node.getText(sf).replace(/;\s*$/, '');

  const visitStatements = (statements: ts.NodeArray<ts.Statement>, depth: number): void => {
    for (const st of statements) visitStatement(st, depth);
  };

  const visitStatement = (st: ts.Statement, depth: number): void => {
    if (ts.isImportDeclaration(st) || ts.isImportEqualsDeclaration(st)) return;

    if (ts.isFunctionDeclaration(st)) {
      push(st, depth, st.body ? head(st, st.body.getStart(sf)) : full(st));
      return;
    }
    if (ts.isClassDeclaration(st)) {
      push(st, depth, head(st, openBrace(st)));
      for (const m of st.members) visitClassMember(m, depth + 1);
      return;
    }
    if (ts.isInterfaceDeclaration(st)) {
      push(st, depth, head(st, openBrace(st)));
      for (const m of st.members) push(m, depth + 1, full(m).replace(/[;,]$/, ''));
      return;
    }
    if (ts.isEnumDeclaration(st)) {
      push(st, depth, head(st, openBrace(st)));
      for (const m of st.members) push(m, depth + 1, m.name.getText(sf));
      return;
    }
    if (ts.isModuleDeclaration(st)) {
      const body = st.body;
      if (body && ts.isModuleBlock(body)) {
        push(st, depth, head(st, body.getStart(sf)));
        visitStatements(body.statements, depth + 1);
      } else {
        push(st, depth, full(st));
      }
      return;
    }
    if (ts.isTypeAliasDeclaration(st)) {
      push(st, depth, full(st));
      return;
    }
    if (ts.isVariableStatement(st)) {
      visitVariableStatement(st, depth);
      return;
    }
    if (ts.isExportAssignment(st)) {
      const expr = st.expression;
      push(
        st,
        depth,
        ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)
          ? `${head(st, expr.getStart(sf))} ${functionHead(expr)}`
          : foldInitializer(full(st)),
      );
      return;
    }
    if (ts.isExportDeclaration(st)) push(st, depth, foldInitializer(full(st)));
  };

  const visitVariableStatement = (st: ts.VariableStatement, depth: number): void => {
    // `export const a = 1, b = 2`처럼 묶인 선언도 하나씩 줄을 나눈다
    const prefix = content
      .slice(st.getStart(sf), st.declarationList.declarations[0]!.getStart(sf))
      .trimEnd();
    for (const decl of st.declarationList.declarations) {
      const name = decl.name.getText(sf);
      const type = decl.type ? `: ${decl.type.getText(sf)}` : '';
      const init = decl.initializer;
      let signature: string;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        signature = `${prefix} ${name}${type} = ${functionHead(init)}`;
      } else if (init) {
        signature = `${prefix} ${name}${type} = ${foldInitializer(init.getText(sf))}`;
      } else {
        signature = `${prefix} ${name}${type}`;
      }
      entries.push({
        lineStart: lineOf(decl.getStart(sf)),
        lineEnd: lineOf(decl.getEnd()),
        depth,
        signature: oneLine(signature),
      });
    }
  };

  const functionHead = (fn: ts.ArrowFunction | ts.FunctionExpression): string => {
    if (ts.isArrowFunction(fn)) {
      return `${content.slice(fn.getStart(sf), fn.equalsGreaterThanToken.getEnd())} …`;
    }
    return `${head(fn, fn.body.getStart(sf))} …`;
  };

  const visitClassMember = (m: ts.ClassElement, depth: number): void => {
    if (
      ts.isMethodDeclaration(m) ||
      ts.isConstructorDeclaration(m) ||
      ts.isGetAccessorDeclaration(m) ||
      ts.isSetAccessorDeclaration(m)
    ) {
      push(m, depth, m.body ? head(m, m.body.getStart(sf)) : full(m));
      return;
    }
    if (ts.isPropertyDeclaration(m)) {
      const init = m.initializer;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        push(m, depth, `${head(m, init.getStart(sf))} = ${functionHead(init)}`);
      } else {
        push(m, depth, init ? head(m, init.getStart(sf)) : full(m));
      }
      return;
    }
    if (ts.isClassStaticBlockDeclaration(m)) {
      push(m, depth, 'static { … }');
      return;
    }
    push(m, depth, full(m));
  };

  const openBrace = (
    node: ts.ClassDeclaration | ts.InterfaceDeclaration | ts.EnumDeclaration,
  ): number => {
    const brace = node.getChildren(sf).find((c) => c.kind === ts.SyntaxKind.OpenBraceToken);
    return brace ? brace.getStart(sf) : node.getEnd();
  };

  visitStatements(sf.statements, 0);
  return entries;
}

function foldInitializer(text: string): string {
  const flat = oneLine(text);
  return flat.length > MAX_INITIALIZER_CHARS ? `${flat.slice(0, MAX_INITIALIZER_CHARS)}…` : flat;
}
