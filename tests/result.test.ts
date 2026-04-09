import { describe, it, expect } from 'vitest';
import {
  ok,
  err,
  isOk,
  isErr,
  unwrap,
  unwrapOr,
  map,
  flatMap,
  tryCatch,
  tryCatchSync,
} from '../src/core/result.js';

describe('Result monad', () => {
  describe('ok / err', () => {
    it('ok wraps a value', () => {
      const r = ok(42);
      expect(r.ok).toBe(true);
      expect(r.value).toBe(42);
    });

    it('err wraps an error', () => {
      const r = err('bad');
      expect(r.ok).toBe(false);
      expect(r.error).toBe('bad');
    });
  });

  describe('isOk / isErr', () => {
    it('isOk returns true for Ok', () => {
      expect(isOk(ok(1))).toBe(true);
      expect(isOk(err('x'))).toBe(false);
    });

    it('isErr returns true for Err', () => {
      expect(isErr(err('x'))).toBe(true);
      expect(isErr(ok(1))).toBe(false);
    });
  });

  describe('unwrap / unwrapOr', () => {
    it('unwrap returns value for Ok', () => {
      expect(unwrap(ok('hello'))).toBe('hello');
    });

    it('unwrap throws for Err', () => {
      expect(() => unwrap(err(new Error('fail')))).toThrow('fail');
    });

    it('unwrapOr returns value for Ok', () => {
      expect(unwrapOr(ok(10), 0)).toBe(10);
    });

    it('unwrapOr returns default for Err', () => {
      expect(unwrapOr(err('x'), 0)).toBe(0);
    });
  });

  describe('map / flatMap', () => {
    it('map transforms Ok value', () => {
      const r = map(ok(2), (x) => x * 3);
      expect(isOk(r) && r.value).toBe(6);
    });

    it('map passes Err through', () => {
      const r = map(err('x') as ReturnType<typeof err<string>>, (x: number) => x * 3);
      expect(isErr(r) && r.error).toBe('x');
    });

    it('flatMap chains Ok results', () => {
      const r = flatMap(ok(5), (x) => ok(x + 1));
      expect(isOk(r) && r.value).toBe(6);
    });

    it('flatMap short-circuits on Err', () => {
      const r = flatMap(err('x') as ReturnType<typeof err<string>>, (_x: number) => ok(99));
      expect(isErr(r) && r.error).toBe('x');
    });
  });

  describe('tryCatch', () => {
    it('returns Ok for successful async fn', async () => {
      const r = await tryCatch(async () => 42);
      expect(isOk(r) && r.value).toBe(42);
    });

    it('returns Err for throwing async fn', async () => {
      const r = await tryCatch(async () => {
        throw new Error('async fail');
      });
      expect(isErr(r) && r.error.message).toBe('async fail');
    });
  });

  describe('tryCatchSync', () => {
    it('returns Ok for successful sync fn', () => {
      const r = tryCatchSync(() => 'sync');
      expect(isOk(r) && r.value).toBe('sync');
    });

    it('returns Err for throwing sync fn', () => {
      const r = tryCatchSync(() => {
        throw new Error('sync fail');
      });
      expect(isErr(r) && r.error.message).toBe('sync fail');
    });
  });
});
