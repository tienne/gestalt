import { describe, it, expect } from 'vitest';
import {
  ok,
  err,
  isOk,
  isErr,
  map,
  flatMap,
  flatMapAsync,
  tryCatch,
  tryCatchSync,
} from '../../src/core/result.js';

describe('Result monad', () => {
  // ─── ok / err 생성 ───────────────────────────────────────────────────────
  describe('ok()', () => {
    it('ok가 참으로 표시된다', () => {
      const r = ok(42);
      expect(r.ok).toBe(true);
    });

    it('ok 값을 정확히 래핑한다', () => {
      expect(ok('hello').value).toBe('hello');
      expect(ok(null).value).toBe(null);
      expect(ok(0).value).toBe(0);
    });

    it('객체도 레퍼런스 동일성을 유지한다', () => {
      const obj = { x: 1 };
      expect(ok(obj).value).toBe(obj);
    });
  });

  describe('err()', () => {
    it('err가 거짓으로 표시된다', () => {
      const r = err(new Error('boom'));
      expect(r.ok).toBe(false);
    });

    it('err 값을 정확히 래핑한다', () => {
      const e = new Error('fail');
      expect(err(e).error).toBe(e);
    });

    it('문자열 에러도 래핑한다', () => {
      expect(err('string error').error).toBe('string error');
    });
  });

  // ─── isOk / isErr 판별 ───────────────────────────────────────────────────
  describe('isOk()', () => {
    it('Ok 결과에 대해 true를 반환한다', () => {
      expect(isOk(ok(1))).toBe(true);
    });

    it('Err 결과에 대해 false를 반환한다', () => {
      expect(isOk(err('x'))).toBe(false);
    });
  });

  describe('isErr()', () => {
    it('Err 결과에 대해 true를 반환한다', () => {
      expect(isErr(err('x'))).toBe(true);
    });

    it('Ok 결과에 대해 false를 반환한다', () => {
      expect(isErr(ok(1))).toBe(false);
    });
  });

  // ─── map ─────────────────────────────────────────────────────────────────
  describe('map()', () => {
    it('Ok 경로: 값을 변환한다', () => {
      const r = map(ok(2), (x) => x * 3);
      expect(isOk(r)).toBe(true);
      if (isOk(r)) expect(r.value).toBe(6);
    });

    it('Err 경로: fn을 호출하지 않고 에러를 통과시킨다', () => {
      let called = false;
      const e = new Error('original');
      const r = map(err(e) as ReturnType<typeof err<Error>>, (_x: number) => {
        called = true;
        return 99;
      });
      expect(isErr(r)).toBe(true);
      expect(called).toBe(false);
      if (isErr(r)) expect(r.error).toBe(e);
    });

    it('map 결과에 다시 map을 체인할 수 있다', () => {
      const r = map(map(ok(1), (x) => x + 1), (x) => x * 10);
      expect(isOk(r) && r.value).toBe(20);
    });
  });

  // ─── flatMap ─────────────────────────────────────────────────────────────
  describe('flatMap()', () => {
    it('Ok 경로: Ok를 반환하는 fn을 체인한다', () => {
      const r = flatMap(ok(5), (x) => ok(x + 1));
      expect(isOk(r) && r.value).toBe(6);
    });

    it('Ok 경로: fn이 Err를 반환하면 Err가 된다', () => {
      const e = new Error('inner');
      const r = flatMap(ok(5), (_x) => err(e));
      expect(isErr(r)).toBe(true);
      if (isErr(r)) expect(r.error).toBe(e);
    });

    it('Err 경로: fn을 호출하지 않고 에러를 통과시킨다', () => {
      let called = false;
      const e = new Error('original');
      const r = flatMap(err(e) as ReturnType<typeof err<Error>>, (_x: number) => {
        called = true;
        return ok(99);
      });
      expect(isErr(r)).toBe(true);
      expect(called).toBe(false);
      if (isErr(r)) expect(r.error).toBe(e);
    });
  });

  // ─── flatMapAsync ─────────────────────────────────────────────────────────
  describe('flatMapAsync()', () => {
    it('Ok 경로: 비동기 fn을 체인한다', async () => {
      const r = await flatMapAsync(ok(10), async (x) => ok(x + 5));
      expect(isOk(r) && r.value).toBe(15);
    });

    it('Ok 경로: 비동기 fn이 Err를 반환하면 Err가 된다', async () => {
      const e = new Error('inner async');
      const r = await flatMapAsync(ok(10), async () => err(e));
      expect(isErr(r)).toBe(true);
      if (isErr(r)) expect(r.error).toBe(e);
    });

    it('Err 경로: fn을 호출하지 않고 에러를 통과시킨다', async () => {
      const e = new Error('first');
      let called = false;
      const r = await flatMapAsync(err(e), async (x: number) => {
        called = true;
        return ok(x + 5);
      });
      expect(isErr(r)).toBe(true);
      expect(called).toBe(false);
      if (isErr(r)) expect(r.error).toBe(e);
    });
  });

  // ─── tryCatch ─────────────────────────────────────────────────────────────
  describe('tryCatch()', () => {
    it('성공 경로: 비동기 함수 결과를 Ok로 래핑한다', async () => {
      const r = await tryCatch(async () => 42);
      expect(isOk(r) && r.value).toBe(42);
    });

    it('예외 경로: Error 인스턴스를 Err로 래핑한다', async () => {
      const r = await tryCatch(async () => {
        throw new Error('async fail');
      });
      expect(isErr(r)).toBe(true);
      if (isErr(r)) expect(r.error.message).toBe('async fail');
    });

    it('예외 경로: 비-Error 예외를 Error로 변환한다', async () => {
      const r = await tryCatch(async () => {
        throw 'string error';
      });
      expect(isErr(r)).toBe(true);
      if (isErr(r)) expect(r.error.message).toBe('string error');
    });
  });

  // ─── tryCatchSync ─────────────────────────────────────────────────────────
  describe('tryCatchSync()', () => {
    it('성공 경로: 동기 함수 결과를 Ok로 래핑한다', () => {
      const r = tryCatchSync(() => 'sync value');
      expect(isOk(r) && r.value).toBe('sync value');
    });

    it('예외 경로: Error 인스턴스를 Err로 래핑한다', () => {
      const r = tryCatchSync(() => {
        throw new Error('sync fail');
      });
      expect(isErr(r)).toBe(true);
      if (isErr(r)) expect(r.error.message).toBe('sync fail');
    });

    it('예외 경로: 비-Error 예외를 Error로 변환한다', () => {
      const r = tryCatchSync(() => {
        throw 42;
      });
      expect(isErr(r)).toBe(true);
      if (isErr(r)) expect(r.error.message).toBe('42');
    });
  });

  // ─── 망가진 체인 (에러 전파) ────────────────────────────────────────────
  describe('망가진 체인: 에러 전파', () => {
    it('err.map().map() — 에러가 두 번 통과한다', () => {
      const e = new Error('original');
      const r = map(
        map(err(e) as ReturnType<typeof err<Error>>, (_x: number) => _x + 1),
        (_x: number) => _x * 2,
      );
      expect(isErr(r)).toBe(true);
      if (isErr(r)) expect(r.error).toBe(e);
    });

    it('err.flatMap().map() — 에러가 flatMap, map 모두 통과한다', () => {
      const e = new Error('chain error');
      const r = map(
        flatMap(err(e) as ReturnType<typeof err<Error>>, (_x: number) => ok(_x + 1)),
        (_x: number) => _x * 10,
      );
      expect(isErr(r)).toBe(true);
      if (isErr(r)) expect(r.error).toBe(e);
    });

    it('ok → flatMap(err) → map() — 중간 err이 이후 map을 건너뛴다', () => {
      let mapCalled = false;
      const inner = new Error('inner fail');
      const r = map(
        flatMap(ok(100), (_x) => err(inner) as ReturnType<typeof err<Error>>,),
        (_x: number) => {
          mapCalled = true;
          return _x + 1;
        },
      );
      expect(isErr(r)).toBe(true);
      expect(mapCalled).toBe(false);
      if (isErr(r)) expect(r.error).toBe(inner);
    });

    it('err.flatMapAsync().map() — 비동기 체인도 에러가 전파한다', async () => {
      const e = new Error('async chain');
      let asyncCalled = false;
      const r = await flatMapAsync(err(e), async (_x: number) => {
        asyncCalled = true;
        return ok(_x);
      });
      expect(isErr(r)).toBe(true);
      expect(asyncCalled).toBe(false);
      if (isErr(r)) expect(r.error).toBe(e);
    });

    it('tryCatchSync 에러 → map() — err 래핑 후 map이 건너뛰어진다', () => {
      let mapCalled = false;
      const caught = tryCatchSync<number>(() => {
        throw new Error('tryCatch error');
      });
      const r = map(caught, (_x: number) => {
        mapCalled = true;
        return _x + 1;
      });
      expect(isErr(r)).toBe(true);
      expect(mapCalled).toBe(false);
    });
  });
});
