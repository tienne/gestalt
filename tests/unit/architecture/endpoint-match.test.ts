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
