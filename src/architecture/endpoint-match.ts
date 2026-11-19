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
  /** context-path나 global prefix처럼 라우트 경로 앞에 서버가 붙이는 조각 */
  mountPrefix?: string;
}

export interface MatchEndpointsInput {
  feCalls: FeCall[];
  beRoutes: BeRoute[];
  prefixCandidates?: string[];
}

/**
 * 1차 비교(경로 그대로, baseUrl이나 prefixCandidates 떼기)로 못 맞춘 호출을 어떤 방법으로 이었는지.
 * 1차에서 맞았으면 칸이 없다.
 */
export type MatchedBy = 'base_url_join' | 'mount_prefix' | 'learned_prefix';

export interface EndpointMatch {
  feCallId: string;
  beRouteId: string;
  viaPrefix: string | null;
  matchedBy?: MatchedBy;
}

export type UnmatchedReason = 'no_route' | 'ambiguous_prefix' | 'multiple_routes';

/**
 * 경로 뒤쪽부터 맞춰 본 후보. matches에는 넣지 않는다.
 * fePrefix는 FE 경로 앞에 남은 조각, routePrefix는 라우트 경로 앞에 남은 조각이다.
 */
export interface SuggestedRoute {
  beRouteId: string;
  score: number;
  fePrefix: string | null;
  routePrefix: string | null;
}

export interface UnmatchedFeCall {
  feCallId: string;
  reason: UnmatchedReason;
  candidates: string[];
  suggested?: SuggestedRoute[];
}

/** 한 배치 안에서 baseUrl이나 mountPrefix로 하나로 맞춘 매치에서 모은 prefix */
export interface LearnedPrefix {
  prefix: string;
  repo: string;
  support: number;
}

export interface MatchEndpointsResult {
  matches: EndpointMatch[];
  unmatched: UnmatchedFeCall[];
  learnedPrefixes: LearnedPrefix[];
}

const ABSOLUTE_URL = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\/[^/]*/;
const PROTOCOL_RELATIVE_URL = /^\/\/[^/]*/;
// Spring @RequestMapping처럼 method를 안 박은 라우트는 어떤 method로 불러도 받는다
const ANY_METHOD = new Set(['*', 'ANY', 'ALL']);

// 같은 레포에서 이만큼 이상 쓰인 prefix만 3단계 비교로 잇는다. 한 번 맞은 prefix로 넓히면 우연히 맞은 걸 퍼뜨린다
const LEARNED_MIN_SUPPORT = 2;

// suggested 점수. 실제 FE와 BE 한 쌍으로 맞춰 본 임시값이다
const SUGGEST = {
  literal: 3,
  param: 1,
  paramForLiteral: 1,
  leftoverPenalty: 0.5,
  minScore: 2,
  minAlignedSegments: 2,
  max: 3,
} as const;

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

function joinPrefix(prefix: string, template: string): string {
  return normalizePathTemplate(`${prefix}/${template}`);
}

function isAbsoluteUrl(path: string): boolean {
  const p = path.trim().replace(/^['"`]+/, '');
  return ABSOLUTE_URL.test(p) || PROTOCOL_RELATIVE_URL.test(p);
}

function methodMatches(feMethod: string, beMethod: string): boolean {
  const be = beMethod.toUpperCase();
  return ANY_METHOD.has(be) || be === feMethod;
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface PreparedRoute {
  id: string;
  method: string;
  repo: string;
  /** 비교에 쓰는 템플릿. mountPrefix를 붙인 묶음에서는 붙인 꼴이다 */
  template: string;
  raw: string;
  mount: string | null;
}

interface Attempt {
  template: string;
  /** null이면 맞은 라우트의 mountPrefix를 viaPrefix로 쓴다 */
  prefix: string | null;
  routes: PreparedRoute[];
}

type Outcome =
  | { kind: 'match'; beRouteId: string; viaPrefix: string | null }
  | { kind: 'multiple_routes' | 'ambiguous_prefix'; candidates: string[] };

/**
 * 한 단계 안의 비교를 판정한다. 라우트별로 처음 맞은 비교의 prefix를 기억하고
 * 한 비교에 라우트가 여럿 맞으면 multiple_routes, 다른 비교끼리 다른 라우트에 맞으면 ambiguous_prefix다.
 */
function decide(method: string, attempts: Attempt[], usePrefixField: boolean): Outcome | null {
  const hitBy = new Map<string, string | null>();
  let multiple: string[] | null = null;
  for (const attempt of attempts) {
    const hits = attempt.routes.filter(
      (r) => r.template === attempt.template && methodMatches(method, r.method),
    );
    if (hits.length > 1 && multiple === null) multiple = hits.map((r) => r.id);
    for (const r of hits) {
      if (hitBy.has(r.id)) continue;
      hitBy.set(r.id, usePrefixField ? attempt.prefix : (attempt.prefix ?? r.mount));
    }
  }
  if (multiple !== null) {
    return { kind: 'multiple_routes', candidates: [...new Set(multiple)].sort(byText) };
  }
  if (hitBy.size > 1)
    return { kind: 'ambiguous_prefix', candidates: [...hitBy.keys()].sort(byText) };
  if (hitBy.size === 1) {
    const [[beRouteId, viaPrefix]] = [...hitBy.entries()] as [[string, string | null]];
    return { kind: 'match', beRouteId, viaPrefix };
  }
  return null;
}

function segments(template: string): string[] {
  return template.split('/').filter((s) => s !== '');
}

function restPath(rest: string[]): string | null {
  return rest.length === 0 ? null : `/${rest.join('/')}`;
}

/** 경로 끝에서부터 조각을 맞춰 점수를 낸다. 리터럴이 어긋나면 거기서 멈추고 남은 앞 조각마다 깎는다 */
function scoreTail(
  feTemplate: string,
  routeTemplate: string,
): { score: number; fePrefix: string | null; routePrefix: string | null } | null {
  const fe = segments(feTemplate);
  const be = segments(routeTemplate);
  let i = fe.length - 1;
  let j = be.length - 1;
  let score = 0;
  let aligned = 0;
  let literals = 0;
  while (i >= 0 && j >= 0) {
    const f = fe[i]!;
    const b = be[j]!;
    if (f === b) {
      if (f === '{}') score += SUGGEST.param;
      else {
        score += SUGGEST.literal;
        literals++;
      }
    } else if (b === '{}') {
      score += SUGGEST.paramForLiteral;
    } else {
      break;
    }
    aligned++;
    i--;
    j--;
  }
  if (aligned < SUGGEST.minAlignedSegments || literals === 0) return null;
  const feRest = fe.slice(0, i + 1);
  const beRest = be.slice(0, j + 1);
  score -= (feRest.length + beRest.length) * SUGGEST.leftoverPenalty;
  if (score < SUGGEST.minScore) return null;
  return { score, fePrefix: restPath(feRest), routePrefix: restPath(beRest) };
}

function suggestRoutes(
  method: string,
  feTemplates: string[],
  routes: PreparedRoute[],
): SuggestedRoute[] {
  const best = new Map<string, SuggestedRoute>();
  for (const route of routes) {
    if (!methodMatches(method, route.method)) continue;
    const routeTemplates = route.mount ? [route.raw, route.template] : [route.raw];
    for (const fe of feTemplates) {
      for (const rt of routeTemplates) {
        const scored = scoreTail(fe, rt);
        if (scored === null) continue;
        const prev = best.get(route.id);
        if (prev === undefined || scored.score > prev.score) {
          best.set(route.id, { beRouteId: route.id, ...scored });
        }
      }
    }
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || byText(a.beRouteId, b.beRouteId))
    .slice(0, SUGGEST.max);
}

/**
 * FE 호출을 method와 정규화한 경로 템플릿으로 BE 라우트에 잇는다. matches는 템플릿이 정확히 같을 때만 만든다.
 *
 * 1단계는 경로 그대로와 baseUrl, prefixCandidates를 뗀 경로를 비교한다. 1단계에서 하나라도 맞으면 판정은 거기서 끝난다.
 * 2단계는 1단계에서 아무것도 못 맞춘 호출만 본다. 상대 경로 앞에 baseUrl을 붙인 경로와 mountPrefix를 붙인 라우트를 비교한다.
 * 3단계는 baseUrl 없는 호출 중 남은 것에 2단계까지 같은 레포에서 두 번 이상 쓰인 prefix를 붙이거나 떼서 다시 비교한다.
 * 끝까지 못 맞춘 호출에는 뒤쪽 조각을 맞춘 후보를 suggested로만 단다.
 */
export function matchEndpoints(input: MatchEndpointsInput): MatchEndpointsResult {
  const routes: PreparedRoute[] = input.beRoutes.map((r) => {
    const raw = normalizePathTemplate(r.path);
    const mount = r.mountPrefix ? normalizePathTemplate(r.mountPrefix) : null;
    return {
      id: r.id,
      method: r.method,
      repo: r.repo,
      template: raw,
      raw,
      mount: mount === '/' ? null : mount,
    };
  });
  const mountedRoutes: PreparedRoute[] = routes
    .filter((r) => r.mount !== null)
    .map((r) => ({ ...r, template: joinPrefix(r.mount!, r.raw) }));
  const sharedPrefixes = (input.prefixCandidates ?? []).map(normalizePathTemplate);

  const matches: EndpointMatch[] = [];
  const unmatched: UnmatchedFeCall[] = [];
  const pending: { call: FeCall; method: string; full: string; composed: string | null }[] = [];
  const learnedCount = new Map<string, LearnedPrefix>();

  const learn = (repo: string, prefix: string | null) => {
    if (prefix === null || prefix === '/') return;
    const key = `${repo}\u0000${prefix}`;
    const entry = learnedCount.get(key);
    if (entry) entry.support++;
    else learnedCount.set(key, { prefix, repo, support: 1 });
  };
  const routeRepo = new Map(routes.map((r) => [r.id, r.repo]));

  for (const call of input.feCalls) {
    const method = call.method.toUpperCase();
    const full = normalizePathTemplate(call.path);
    const base = call.baseUrl ? normalizePathTemplate(call.baseUrl) : null;

    // 1단계: 예전과 같은 비교. 빈 경로에 baseUrl이 있으면 실제 요청은 baseUrl 그대로라 루트(/) 비교는 건너뛴다
    const emptyPath = call.path.trim().replace(/^['"`]+|['"`]+$/g, '') === '';
    const first: Attempt[] =
      emptyPath && base !== null ? [] : [{ template: full, prefix: null, routes }];
    const prefixes = base ? [base, ...sharedPrefixes] : sharedPrefixes;
    for (const prefix of new Set(prefixes)) {
      const stripped = stripPrefix(full, prefix);
      if (stripped !== null) first.push({ template: stripped, prefix, routes });
    }
    const firstOutcome = decide(method, first, true);
    if (firstOutcome !== null) {
      if (firstOutcome.kind === 'match') {
        matches.push({
          feCallId: call.id,
          beRouteId: firstOutcome.beRouteId,
          viaPrefix: firstOutcome.viaPrefix,
        });
        if (base !== null && firstOutcome.viaPrefix === base) {
          learn(routeRepo.get(firstOutcome.beRouteId)!, base);
        }
      } else {
        unmatched.push({
          feCallId: call.id,
          reason: firstOutcome.kind,
          candidates: firstOutcome.candidates,
        });
      }
      continue;
    }

    // 2단계: baseUrl 붙이기, mountPrefix 붙인 라우트
    const composed =
      base !== null && base !== '/' && !isAbsoluteUrl(call.path) && stripPrefix(full, base) === null
        ? joinPrefix(base, full)
        : null;
    const second: { attempt: Attempt; how: MatchedBy }[] = [];
    if (composed !== null) {
      second.push({ attempt: { template: composed, prefix: base, routes }, how: 'base_url_join' });
    }
    if (mountedRoutes.length > 0) {
      second.push({
        attempt: { template: full, prefix: null, routes: mountedRoutes },
        how: 'mount_prefix',
      });
    }
    const secondOutcome = decide(
      method,
      second.map((s) => s.attempt),
      false,
    );
    if (secondOutcome !== null) {
      if (secondOutcome.kind === 'match') {
        const how = second.find((s) =>
          s.attempt.routes.some(
            (r) => r.id === secondOutcome.beRouteId && r.template === s.attempt.template,
          ),
        )!.how;
        matches.push({
          feCallId: call.id,
          beRouteId: secondOutcome.beRouteId,
          viaPrefix: secondOutcome.viaPrefix,
          matchedBy: how,
        });
        learn(routeRepo.get(secondOutcome.beRouteId)!, secondOutcome.viaPrefix);
      } else {
        unmatched.push({
          feCallId: call.id,
          reason: secondOutcome.kind,
          candidates: secondOutcome.candidates,
        });
      }
      continue;
    }
    pending.push({ call, method, full, composed });
  }

  const seenPrefixes = [...learnedCount.values()].sort(
    (a, b) => byText(a.repo, b.repo) || byText(a.prefix, b.prefix),
  );
  const learnedPrefixes = seenPrefixes.filter((l) => l.support >= LEARNED_MIN_SUPPORT);
  const supported = new Set(learnedPrefixes.map((l) => `${l.repo}\u0000${l.prefix}`));

  for (const { call, method, full, composed } of pending) {
    // 3단계: baseUrl 없는 호출에만 같은 레포에서 배운 prefix를 붙이거나 떼 본다.
    // 한 번만 쓰인 prefix도 비교에는 넣는다. 그쪽이 다른 라우트에 맞으면 모호한 걸로 보고 잇지 않는다
    if (!call.baseUrl && learnedPrefixes.length > 0) {
      const third: Attempt[] = [];
      for (const learned of seenPrefixes) {
        const repoRoutes = routes.filter((r) => r.repo === learned.repo && r.mount === null);
        if (repoRoutes.length === 0) continue;
        if (!isAbsoluteUrl(call.path)) {
          third.push({
            template: joinPrefix(learned.prefix, full),
            prefix: learned.prefix,
            routes: repoRoutes,
          });
        }
        const stripped = stripPrefix(full, learned.prefix);
        if (stripped !== null) {
          third.push({ template: stripped, prefix: learned.prefix, routes: repoRoutes });
        }
      }
      const decided = decide(method, third, true);
      // 덜 쓰인 prefix로만 맞은 건 잇지 않고 suggested로 넘긴다
      const thirdOutcome =
        decided?.kind === 'match' &&
        !supported.has(`${routeRepo.get(decided.beRouteId)!}\u0000${decided.viaPrefix!}`)
          ? null
          : decided;
      if (thirdOutcome !== null) {
        if (thirdOutcome.kind === 'match') {
          matches.push({
            feCallId: call.id,
            beRouteId: thirdOutcome.beRouteId,
            viaPrefix: thirdOutcome.viaPrefix,
            matchedBy: 'learned_prefix',
          });
        } else {
          unmatched.push({
            feCallId: call.id,
            reason: thirdOutcome.kind,
            candidates: thirdOutcome.candidates,
          });
        }
        continue;
      }
    }

    const feTemplates = composed !== null ? [full, composed] : [full];
    const suggested = suggestRoutes(method, feTemplates, routes);
    unmatched.push({
      feCallId: call.id,
      reason: 'no_route',
      candidates: [],
      ...(suggested.length > 0 ? { suggested } : {}),
    });
  }

  matches.sort((a, b) => byText(a.feCallId, b.feCallId) || byText(a.beRouteId, b.beRouteId));
  unmatched.sort((a, b) => byText(a.feCallId, b.feCallId));
  return { matches, unmatched, learnedPrefixes };
}
