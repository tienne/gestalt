/**
 * 이름으로 가리키는 참조를 선언에 잇는다. http-endpoint와 mcp-tool처럼 세션이 레포에서 양쪽을 모아 넘기면
 * 서버가 같은 규칙으로 짝을 찾는다. 팩마다 이름을 적는 습관이 달라서 비교 키를 만드는 규칙만 다르다
 */

export const NAME_REF_MATCHERS = ['name-ref', 'iac-ref', 'dataset-io', 'state-value'] as const;
export type NameRefMatcher = (typeof NAME_REF_MATCHERS)[number];

/** 참조하는 쪽. 잡이 읽는 테이블, 리소스가 쓰는 다른 리소스 속성, 코드의 상태 값 */
export interface NameRef {
  id: string;
  name: string;
}

/** 선언된 쪽. 테이블 정의, IaC 리소스 블록, 흐름 단계의 상태 값 */
export interface NameDecl {
  id: string;
  name: string;
}

export interface MatchNameRefsInput {
  matcher: NameRefMatcher;
  refs: NameRef[];
  decls: NameDecl[];
}

export interface NameRefMatch {
  refId: string;
  declId: string;
}

export type NameRefUnmatchedReason = 'no_decl' | 'multiple_decls';

export interface UnmatchedNameRef {
  refId: string;
  reason: NameRefUnmatchedReason;
  candidates: string[];
}

export interface MatchNameRefsResult {
  matcher: NameRefMatcher;
  matches: NameRefMatch[];
  unmatched: UnmatchedNameRef[];
}

function stripQuotes(s: string): string {
  return s.replace(/["'`[\]]/g, '');
}

/**
 * terraform 참조는 `aws_lb.main.arn`처럼 속성까지 붙는다. 리소스는 앞 두 마디, data 소스와 module은 접두까지 센다.
 * 쿠버네티스는 `Service/api`처럼 kind와 이름을 슬래시로 적는다. kind는 대소문자를 안 가린다
 */
function iacKey(name: string): string {
  const s = name
    .trim()
    .replace(/^\$\{(.*)\}$/, '$1')
    .trim();
  const slash = s.indexOf('/');
  if (slash > 0 && !s.includes('.'))
    return `${s.slice(0, slash).toLowerCase()}/${s.slice(slash + 1)}`;
  const parts = s.split('.').map((p) => p.replace(/\[.*\]$/, ''));
  if (parts[0] === 'data') return parts.slice(0, 3).join('.');
  if (parts[0] === 'module') return parts.slice(0, 2).join('.');
  return parts.slice(0, 2).join('.');
}

/** dbt의 ref('x')와 source('s', 't'), 따옴표 친 SQL 식별자를 같은 꼴로 편다 */
function datasetKey(name: string): string {
  const s = name.trim();
  const ref = /^ref\(\s*['"]([^'"]+)['"]\s*\)$/.exec(s);
  if (ref) return ref[1]!.toLowerCase();
  const source = /^source\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)$/.exec(s);
  if (source) return `${source[1]!}.${source[2]!}`.toLowerCase();
  return stripQuotes(s).toLowerCase();
}

/** CHANGES_REQUESTED, changesRequested, 'changes-requested'를 같은 값으로 본다 */
function stateKey(name: string): string {
  return stripQuotes(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function keyOf(matcher: NameRefMatcher, name: string): string {
  switch (matcher) {
    case 'iac-ref':
      return iacKey(name);
    case 'dataset-io':
      return datasetKey(name);
    case 'state-value':
      return stateKey(name);
    case 'name-ref':
      return name.trim().toLowerCase();
  }
}

/** 스키마 없이 적은 테이블 이름은 마지막 마디로 찾는다. 같은 이름이 스키마 여럿에 있으면 고르지 않고 후보로 돌려준다 */
function tablePart(key: string): string {
  return key.slice(key.lastIndexOf('.') + 1);
}

export function matchNameRefs(input: MatchNameRefsInput): MatchNameRefsResult {
  const byKey = new Map<string, string[]>();
  const byTable = new Map<string, string[]>();
  for (const d of input.decls) {
    const k = keyOf(input.matcher, d.name);
    byKey.set(k, [...(byKey.get(k) ?? []), d.id]);
    if (input.matcher === 'dataset-io') {
      const t = tablePart(k);
      byTable.set(t, [...(byTable.get(t) ?? []), d.id]);
    }
  }
  const matches: NameRefMatch[] = [];
  const unmatched: UnmatchedNameRef[] = [];
  for (const r of input.refs) {
    const k = keyOf(input.matcher, r.name);
    let found = byKey.get(k) ?? [];
    if (found.length === 0 && input.matcher === 'dataset-io') {
      // 한쪽만 스키마를 적었으면 테이블 이름으로 찾는다. 양쪽 다 스키마가 있는데 다르면 다른 테이블이다
      const t = tablePart(k);
      found = (byTable.get(t) ?? []).filter((id) => {
        const declKey = keyOf('dataset-io', input.decls.find((d) => d.id === id)!.name);
        return !k.includes('.') || !declKey.includes('.');
      });
    }
    const ids = [...new Set(found)].sort();
    if (ids.length === 1) matches.push({ refId: r.id, declId: ids[0]! });
    else
      unmatched.push({
        refId: r.id,
        reason: ids.length === 0 ? 'no_decl' : 'multiple_decls',
        candidates: ids,
      });
  }
  return { matcher: input.matcher, matches, unmatched };
}
