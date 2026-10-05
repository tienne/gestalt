export interface FeCall {
  id: string;
  method: string;
  path: string;
  baseUrl?: string;
}

export interface BeRoute {
  id: string;
  method: string;
  path: string;
  repo: string;
}

export interface MatchEndpointsInput {
  feCalls: FeCall[];
  beRoutes: BeRoute[];
  prefixCandidates?: string[];
}

export interface EndpointMatch {
  feCallId: string;
  beRouteId: string;
  viaPrefix: string | null;
}

export type UnmatchedReason = 'no_route' | 'ambiguous_prefix' | 'multiple_routes';

export interface UnmatchedFeCall {
  feCallId: string;
  reason: UnmatchedReason;
  candidates: string[];
}

export interface MatchEndpointsResult {
  matches: EndpointMatch[];
  unmatched: UnmatchedFeCall[];
}

const ABSOLUTE_URL = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\/[^/]*/;
const PROTOCOL_RELATIVE_URL = /^\/\/[^/]*/;
// Spring @RequestMapping처럼 method를 안 박은 라우트는 어떤 method로 불러도 받는다
const ANY_METHOD = new Set(['*', 'ANY', 'ALL']);

/**
 * FE 호출 경로와 BE 라우트 경로를 같은 꼴로 맞춘다.
 * 경로 변수 표기(`{id}` `{id:[0-9]+}` `:id` `${expr}` `<int:id>` `[id]`)는 전부 `{}`가 된다.
 */
export function normalizePathTemplate(path: string): string {
  let p = path.trim().replace(/^['"`]+|['"`]+$/g, '');
  p = p.replace(ABSOLUTE_URL, '').replace(PROTOCOL_RELATIVE_URL, '');
  p = replaceBraceGroups(p);
  p = p.split(/[?#]/, 1)[0]!;
  p = p
    .replace(/(^|\/):[A-Za-z_]\w*(?:\([^)]*\))?\??(?=\/|$)/g, '$1{}')
    .replace(/<[^<>]+>/g, '{}')
    .replace(/\[\[?(?:\.\.\.)?[^\]]+\]\]?/g, '{}');
  p = p.replace(/\/{2,}/g, '/');
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p;
}

// `${a.b}`나 `{id:[0-9]{3}}`처럼 중괄호가 중첩될 수 있어 정규식 대신 깊이를 세어 통째로 바꾼다
function replaceBraceGroups(input: string): string {
  let out = '';
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    const opensTemplate = ch === '$' && input[i + 1] === '{';
    if (ch !== '{' && !opensTemplate) {
      out += ch;
      i++;
      continue;
    }
    let j = opensTemplate ? i + 2 : i + 1;
    let depth = 1;
    while (j < input.length && depth > 0) {
      if (input[j] === '{') depth++;
      else if (input[j] === '}') depth--;
      j++;
    }
    out += '{}';
    i = j;
  }
  return out;
}

function stripPrefix(template: string, prefix: string): string | null {
  if (prefix === '/') return null;
  if (template === prefix) return '/';
  if (template.startsWith(`${prefix}/`)) return template.slice(prefix.length);
  return null;
}

function methodMatches(feMethod: string, beMethod: string): boolean {
  const be = beMethod.toUpperCase();
  return ANY_METHOD.has(be) || be === feMethod;
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * FE 호출을 method와 정규화한 경로 템플릿으로 BE 라우트에 잇는다.
 * baseUrl의 path 부분과 prefixCandidates를 떼어본 경로도 함께 비교한다.
 */
export function matchEndpoints(input: MatchEndpointsInput): MatchEndpointsResult {
  const routes = input.beRoutes.map((r) => ({
    id: r.id,
    method: r.method,
    template: normalizePathTemplate(r.path),
  }));
  const sharedPrefixes = (input.prefixCandidates ?? []).map(normalizePathTemplate);

  const matches: EndpointMatch[] = [];
  const unmatched: UnmatchedFeCall[] = [];

  for (const call of input.feCalls) {
    const method = call.method.toUpperCase();
    const full = normalizePathTemplate(call.path);

    const variants: { prefix: string | null; template: string }[] = [
      { prefix: null, template: full },
    ];
    const prefixes = call.baseUrl
      ? [normalizePathTemplate(call.baseUrl), ...sharedPrefixes]
      : sharedPrefixes;
    for (const prefix of new Set(prefixes)) {
      const stripped = stripPrefix(full, prefix);
      if (stripped !== null) variants.push({ prefix, template: stripped });
    }

    // 라우트별로 처음 맞은 변형을 기억한다. 원래 경로가 먼저라 prefix를 안 뗀 쪽이 우선한다
    const hitBy = new Map<string, string | null>();
    let multiple: string[] | null = null;
    for (const variant of variants) {
      const hits = routes
        .filter((r) => r.template === variant.template && methodMatches(method, r.method))
        .map((r) => r.id);
      if (hits.length > 1 && multiple === null) multiple = hits;
      for (const id of hits) if (!hitBy.has(id)) hitBy.set(id, variant.prefix);
    }

    if (multiple !== null) {
      unmatched.push({
        feCallId: call.id,
        reason: 'multiple_routes',
        candidates: [...new Set(multiple)].sort(byText),
      });
    } else if (hitBy.size > 1) {
      unmatched.push({
        feCallId: call.id,
        reason: 'ambiguous_prefix',
        candidates: [...hitBy.keys()].sort(byText),
      });
    } else if (hitBy.size === 1) {
      const [[beRouteId, viaPrefix]] = [...hitBy.entries()] as [[string, string | null]];
      matches.push({ feCallId: call.id, beRouteId, viaPrefix });
    } else {
      unmatched.push({ feCallId: call.id, reason: 'no_route', candidates: [] });
    }
  }

  matches.sort((a, b) => byText(a.feCallId, b.feCallId) || byText(a.beRouteId, b.beRouteId));
  unmatched.sort((a, b) => byText(a.feCallId, b.feCallId));
  return { matches, unmatched };
}
