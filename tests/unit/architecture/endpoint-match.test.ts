import { describe, it, expect } from 'vitest';
import { matchEndpoints, normalizePathTemplate } from '../../../src/architecture/endpoint-match.js';

describe('normalizePathTemplate', () => {
  it('경로 변수 표기를 전부 {}로 맞춘다', () => {
    const expected = '/api/v1/orders/{}';
    expect(normalizePathTemplate('/api/v1/orders/{id}')).toBe(expected);
    expect(normalizePathTemplate('/api/v1/orders/:orderId')).toBe(expected);
    expect(normalizePathTemplate('/api/v1/orders/${orderId}')).toBe(expected);
    expect(normalizePathTemplate('/api/v1/orders/<int:id>')).toBe(expected);
    expect(normalizePathTemplate('/api/v1/orders/[id]')).toBe(expected);
    expect(normalizePathTemplate('/api/v1/orders/{orderId:[0-9]+}')).toBe(expected);
    expect(normalizePathTemplate('/api/v1/orders/{id:[0-9]{3}}')).toBe(expected);
    expect(normalizePathTemplate('/api/v1/orders/${order.id}')).toBe(expected);
    expect(normalizePathTemplate('/api/v1/orders/${fn({ a: 1 })}')).toBe(expected);
  });

  it('쿼리, 끝 슬래시, 연속 슬래시를 정리하고 대소문자는 유지한다', () => {
    expect(normalizePathTemplate('/api//Orders/?page=1')).toBe('/api/Orders');
    expect(normalizePathTemplate('/api/orders#top')).toBe('/api/orders');
    expect(normalizePathTemplate('api/orders')).toBe('/api/orders');
    expect(normalizePathTemplate('/')).toBe('/');
    expect(normalizePathTemplate('')).toBe('/');
  });

  it('절대 URL은 path만 쓴다', () => {
    expect(normalizePathTemplate('https://api.acme.test:8443/api/v1/orders/${id}?x=1')).toBe(
      '/api/v1/orders/{}',
    );
    expect(normalizePathTemplate('//cdn.acme.test/assets')).toBe('/assets');
    expect(normalizePathTemplate('https://api.acme.test')).toBe('/');
  });

  it('템플릿 리터럴 따옴표를 벗긴다', () => {
    expect(normalizePathTemplate('`/orders/${id}`')).toBe('/orders/{}');
  });
});

describe('matchEndpoints', () => {
  const route = (id: string, method: string, path: string) => ({
    id,
    method,
    path,
    repo: 'acme-api',
  });

  it('표기가 달라도 같은 템플릿이면 잇는다', () => {
    const result = matchEndpoints({
      feCalls: [
        { id: 'fe-b', method: 'get', path: '/api/v1/orders/${orderId}' },
        { id: 'fe-a', method: 'GET', path: '/api/v1/orders/:orderId' },
      ],
      beRoutes: [route('be-1', 'GET', '/api/v1/orders/{id}')],
    });
    expect(result.matches).toEqual([
      { feCallId: 'fe-a', beRouteId: 'be-1', viaPrefix: null },
      { feCallId: 'fe-b', beRouteId: 'be-1', viaPrefix: null },
    ]);
    expect(result.unmatched).toEqual([]);
  });

  it('Spring 클래스 매핑을 합친 경로와 정규식 변수도 맞춘다', () => {
    const result = matchEndpoints({
      feCalls: [{ id: 'fe', method: 'GET', path: '/api/v1/orders/${order.id}' }],
      beRoutes: [route('be', 'GET', '/api/v1/orders/{orderId:[0-9]+}')],
    });
    expect(result.matches).toEqual([{ feCallId: 'fe', beRouteId: 'be', viaPrefix: null }]);
  });

  it('method가 다르면 잇지 않는다', () => {
    const result = matchEndpoints({
      feCalls: [{ id: 'fe', method: 'POST', path: '/api/v1/orders/1' }],
      beRoutes: [route('be', 'GET', '/api/v1/orders/1')],
    });
    expect(result.matches).toEqual([]);
    expect(result.unmatched).toEqual([{ feCallId: 'fe', reason: 'no_route', candidates: [] }]);
  });

  it('method 없는 라우트(ANY)는 어떤 method와도 맞는다', () => {
    const result = matchEndpoints({
      feCalls: [{ id: 'fe', method: 'delete', path: '/orders/{id}' }],
      beRoutes: [route('be', 'ANY', '/orders/{id}')],
    });
    expect(result.matches).toEqual([{ feCallId: 'fe', beRouteId: 'be', viaPrefix: null }]);
  });

  it('prefixCandidates를 떼면 맞는다', () => {
    const result = matchEndpoints({
      feCalls: [{ id: 'fe', method: 'GET', path: '/gateway/orders/${id}' }],
      beRoutes: [route('be', 'GET', '/orders/{orderId}')],
      prefixCandidates: ['/gateway/'],
    });
    expect(result.matches).toEqual([{ feCallId: 'fe', beRouteId: 'be', viaPrefix: '/gateway' }]);
  });

  it('baseUrl의 path 부분을 떼면 맞는다', () => {
    const result = matchEndpoints({
      feCalls: [
        {
          id: 'fe',
          method: 'GET',
          path: 'https://api.acme.test/bff/orders/1',
          baseUrl: 'https://api.acme.test/bff',
        },
      ],
      beRoutes: [route('be', 'GET', '/orders/1')],
    });
    expect(result.matches).toEqual([{ feCallId: 'fe', beRouteId: 'be', viaPrefix: '/bff' }]);
  });

  it('서로 다른 prefix가 다른 라우트에 맞으면 ambiguous_prefix', () => {
    const result = matchEndpoints({
      feCalls: [{ id: 'fe', method: 'GET', path: '/a/b/orders' }],
      beRoutes: [route('be-2', 'GET', '/orders'), route('be-1', 'GET', '/b/orders')],
      prefixCandidates: ['/a', '/a/b'],
    });
    expect(result.matches).toEqual([]);
    expect(result.unmatched).toEqual([
      { feCallId: 'fe', reason: 'ambiguous_prefix', candidates: ['be-1', 'be-2'] },
    ]);
  });

  it('같은 템플릿 라우트가 둘 이상이면 multiple_routes', () => {
    const result = matchEndpoints({
      feCalls: [{ id: 'fe', method: 'GET', path: '/orders/${id}' }],
      beRoutes: [
        { id: 'be-z', method: 'GET', path: '/orders/{id}', repo: 'acme-api' },
        { id: 'be-y', method: 'GET', path: '/orders/:orderId', repo: 'acme-legacy' },
      ],
    });
    expect(result.unmatched).toEqual([
      { feCallId: 'fe', reason: 'multiple_routes', candidates: ['be-y', 'be-z'] },
    ]);
  });

  it('맞는 라우트가 없으면 no_route', () => {
    const result = matchEndpoints({
      feCalls: [{ id: 'fe', method: 'GET', path: '/payments' }],
      beRoutes: [route('be', 'GET', '/orders')],
      prefixCandidates: ['/api'],
    });
    expect(result.unmatched).toEqual([{ feCallId: 'fe', reason: 'no_route', candidates: [] }]);
  });
});

describe('matchEndpoints 2단계와 3단계, suggested', () => {
  const route = (id: string, method: string, path: string, extra: object = {}) => ({
    id,
    method,
    path,
    repo: 'acme-api',
    ...extra,
  });

  it('상대 경로 앞에 baseUrl을 붙여야 맞으면 base_url_join으로 잇는다', () => {
    const result = matchEndpoints({
      feCalls: [{ id: 'fe', method: 'GET', path: '/orders/${id}', baseUrl: '/api/v1' }],
      beRoutes: [route('be', 'GET', '/api/v1/orders/{id}')],
    });
    expect(result.matches).toEqual([
      { feCallId: 'fe', beRouteId: 'be', viaPrefix: '/api/v1', matchedBy: 'base_url_join' },
    ]);
    expect(result.unmatched).toEqual([]);
  });

  it('라우트 앞에 mountPrefix를 붙여야 맞으면 mount_prefix로 잇는다', () => {
    const result = matchEndpoints({
      feCalls: [{ id: 'fe', method: 'GET', path: '/api/orders/${id}' }],
      beRoutes: [route('be', 'GET', '/orders/{id}', { mountPrefix: '/api/' })],
    });
    expect(result.matches).toEqual([
      { feCallId: 'fe', beRouteId: 'be', viaPrefix: '/api', matchedBy: 'mount_prefix' },
    ]);
  });

  it('1단계에서 맞으면 2단계를 보지 않아 matchedBy가 없다', () => {
    const result = matchEndpoints({
      feCalls: [{ id: 'fe', method: 'GET', path: '/api/v1/orders/${id}', baseUrl: '/api/v1' }],
      beRoutes: [
        route('be-raw', 'GET', '/orders/{id}'),
        route('be-mounted', 'GET', '/v1/orders/{id}', { mountPrefix: '/api' }),
      ],
    });
    expect(result.matches).toEqual([{ feCallId: 'fe', beRouteId: 'be-raw', viaPrefix: '/api/v1' }]);
  });

  it('baseUrl 붙이기와 mountPrefix가 서로 다른 라우트에 맞으면 ambiguous_prefix', () => {
    const result = matchEndpoints({
      feCalls: [{ id: 'fe', method: 'GET', path: '/v1/orders', baseUrl: '/api' }],
      beRoutes: [
        route('be-a', 'GET', '/api/v1/orders'),
        route('be-b', 'GET', '/orders', { mountPrefix: '/v1' }),
      ],
    });
    expect(result.matches).toEqual([]);
    expect(result.unmatched).toEqual([
      { feCallId: 'fe', reason: 'ambiguous_prefix', candidates: ['be-a', 'be-b'] },
    ]);
  });

  it('빈 경로에 baseUrl이 있으면 루트 라우트에 잇지 않고 baseUrl 경로로 본다', () => {
    const result = matchEndpoints({
      feCalls: [{ id: 'fe', method: 'GET', path: "''", baseUrl: '/api/v1' }],
      beRoutes: [route('be-root', 'GET', '/'), route('be-base', 'GET', '/api/v1')],
    });
    expect(result.matches).toEqual([
      { feCallId: 'fe', beRouteId: 'be-base', viaPrefix: '/api/v1', matchedBy: 'base_url_join' },
    ]);
  });

  it('두 번 이상 쓰인 prefix를 배워 baseUrl 없는 호출에 붙여 본다', () => {
    const result = matchEndpoints({
      feCalls: [
        { id: 'fe-1', method: 'GET', path: '/orders', baseUrl: '/api/v1' },
        { id: 'fe-2', method: 'POST', path: '/orders', baseUrl: '/api/v1' },
        { id: 'fe-3', method: 'GET', path: '/orders/${id}/items' },
      ],
      beRoutes: [
        route('be-list', 'GET', '/api/v1/orders'),
        route('be-create', 'POST', '/api/v1/orders'),
        route('be-items', 'GET', '/api/v1/orders/{id}/items'),
      ],
    });
    expect(result.learnedPrefixes).toEqual([{ prefix: '/api/v1', repo: 'acme-api', support: 2 }]);
    expect(result.matches).toContainEqual({
      feCallId: 'fe-3',
      beRouteId: 'be-items',
      viaPrefix: '/api/v1',
      matchedBy: 'learned_prefix',
    });
    expect(result.unmatched).toEqual([]);
  });

  it('한 번만 쓰인 prefix로는 잇지 않는다', () => {
    const result = matchEndpoints({
      feCalls: [
        { id: 'fe-1', method: 'GET', path: '/orders', baseUrl: '/api/v1' },
        { id: 'fe-2', method: 'GET', path: '/orders/${id}/items' },
      ],
      beRoutes: [
        route('be-list', 'GET', '/api/v1/orders'),
        route('be-items', 'GET', '/api/v1/orders/{id}/items'),
      ],
    });
    expect(result.learnedPrefixes).toEqual([]);
    expect(result.matches.map((m) => m.feCallId)).toEqual(['fe-1']);
    expect(result.unmatched).toEqual([
      expect.objectContaining({ feCallId: 'fe-2', reason: 'no_route', candidates: [] }),
    ]);
  });

  it('덜 쓰인 prefix가 다른 라우트에 맞으면 학습한 prefix로도 잇지 않고 ambiguous_prefix', () => {
    const result = matchEndpoints({
      feCalls: [
        { id: 'fe-1', method: 'GET', path: '/a', baseUrl: '/web/v1' },
        { id: 'fe-2', method: 'GET', path: '/b', baseUrl: '/web/v1' },
        { id: 'fe-3', method: 'GET', path: '/c', baseUrl: '/web/v2' },
        { id: 'fe-4', method: 'GET', path: '/x/list' },
      ],
      beRoutes: [
        route('be-a', 'GET', '/web/v1/a'),
        route('be-b', 'GET', '/web/v1/b'),
        route('be-c', 'GET', '/web/v2/c'),
        route('be-v1', 'GET', '/web/v1/x/list'),
        route('be-v2', 'GET', '/web/v2/x/list'),
      ],
    });
    expect(result.learnedPrefixes).toEqual([{ prefix: '/web/v1', repo: 'acme-api', support: 2 }]);
    expect(result.unmatched).toEqual([
      { feCallId: 'fe-4', reason: 'ambiguous_prefix', candidates: ['be-v1', 'be-v2'] },
    ]);
  });

  it('학습한 prefix는 배운 레포의 라우트에만 쓴다', () => {
    const result = matchEndpoints({
      feCalls: [
        { id: 'fe-1', method: 'GET', path: '/a', baseUrl: '/api' },
        { id: 'fe-2', method: 'GET', path: '/b', baseUrl: '/api' },
        { id: 'fe-3', method: 'GET', path: '/legacy/report' },
      ],
      beRoutes: [
        route('be-a', 'GET', '/api/a'),
        route('be-b', 'GET', '/api/b'),
        { id: 'be-other', method: 'GET', path: '/api/legacy/report', repo: 'acme-legacy' },
      ],
    });
    expect(result.learnedPrefixes).toEqual([{ prefix: '/api', repo: 'acme-api', support: 2 }]);
    expect(result.matches.map((m) => m.feCallId)).toEqual(['fe-1', 'fe-2']);
    expect(result.unmatched).toEqual([
      expect.objectContaining({ feCallId: 'fe-3', reason: 'no_route' }),
    ]);
  });

  it('못 맞춘 호출에 뒤쪽 조각부터 맞춘 후보를 점수 순으로 셋까지 달고 matches에는 넣지 않는다', () => {
    const result = matchEndpoints({
      feCalls: [{ id: 'fe', method: 'GET', path: '/orders/${id}/items' }],
      beRoutes: [
        route('r-xyz', 'GET', '/x/y/z/orders/{id}/items'),
        route('r-v2', 'GET', '/v2/orders/{id}/items'),
        route('r-ab', 'GET', '/a/b/orders/{id}/items'),
        route('r-shop', 'GET', '/shop/orders/{id}/items'),
        route('r-far', 'GET', '/a/b/c/d/e/{id}/items'),
        route('r-post', 'POST', '/shop/orders/{id}/items'),
        route('r-other', 'GET', '/orders/{id}/details'),
      ],
    });
    expect(result.matches).toEqual([]);
    expect(result.unmatched).toEqual([
      {
        feCallId: 'fe',
        reason: 'no_route',
        candidates: [],
        suggested: [
          { beRouteId: 'r-shop', score: 6.5, fePrefix: null, routePrefix: '/shop' },
          { beRouteId: 'r-v2', score: 6.5, fePrefix: null, routePrefix: '/v2' },
          { beRouteId: 'r-ab', score: 6, fePrefix: null, routePrefix: '/a/b' },
        ],
      },
    ]);
  });

  it('맞춘 조각이 하나뿐이거나 리터럴이 없으면 후보로 안 단다', () => {
    const result = matchEndpoints({
      feCalls: [
        { id: 'fe-1', method: 'GET', path: '/orders' },
        { id: 'fe-2', method: 'GET', path: '/orders/${id}' },
      ],
      beRoutes: [route('be-1', 'GET', '/v1/items/orders/x'), route('be-2', 'GET', '/{a}/{b}')],
    });
    expect(result.unmatched).toEqual([
      { feCallId: 'fe-1', reason: 'no_route', candidates: [] },
      { feCallId: 'fe-2', reason: 'no_route', candidates: [] },
    ]);
  });

  it('새 칸이 없는 입력은 matchedBy와 suggested 없이 learnedPrefixes만 빈 배열로 붙는다', () => {
    const result = matchEndpoints({
      feCalls: [
        { id: 'fe-1', method: 'GET', path: '/gateway/orders/${id}' },
        { id: 'fe-2', method: 'GET', path: '/payments' },
      ],
      beRoutes: [route('be', 'GET', '/orders/{orderId}')],
      prefixCandidates: ['/gateway'],
    });
    expect(result).toEqual({
      matches: [{ feCallId: 'fe-1', beRouteId: 'be', viaPrefix: '/gateway' }],
      unmatched: [{ feCallId: 'fe-2', reason: 'no_route', candidates: [] }],
      learnedPrefixes: [],
    });
  });
});
