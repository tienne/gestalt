import { describe, it, expect } from 'vitest';
import { ok, err, isOk, isErr, unwrap, unwrapOr, map, flatMap, tryCatch, tryCatchSync } from '../../../src/core/result.js';

describe('Result', () => {
  describe('ok / err', () => {
    it('creates Ok result', () => {
      const result = ok(42);
      expect(result.ok).toBe(true);
      expect(result.value).toBe(42);
    });

    it('creates Err result', () => {
      const error = new Error('fail');
      const result = err(error);
      expect(result.ok).toBe(false);
      expect(result.error).toBe(error);
    });
  });

  describe('isOk / isErr', () => {
    it('detects Ok', () => {
      expect(isOk(ok(1))).toBe(true);
      expect(isOk(err('nope'))).toBe(false);
    });

    it('detects Err', () => {
      expect(isErr(err('nope'))).toBe(true);
      expect(isErr(ok(1))).toBe(false);
    });
  });

  describe('unwrap', () => {
    it('unwraps Ok value', () => {
      expect(unwrap(ok('hello'))).toBe('hello');
    });

    it('throws on Err', () => {
      expect(() => unwrap(err(new Error('boom')))).toThrow('boom');
    });
  });

  describe('unwrapOr', () => {
    it('returns value for Ok', () => {
      expect(unwrapOr(ok(42), 0)).toBe(42);
    });

    it('returns default for Err', () => {
      expect(unwrapOr(err(new Error('fail')), 0)).toBe(0);
    });
  });

  describe('map', () => {
    it('transforms Ok value', () => {
      const result = map(ok(2), (x) => x * 3);
      expect(unwrap(result)).toBe(6);
    });

    it('passes through Err', () => {
      const error = new Error('nope');
      const result = map(err(error), (x: number) => x * 3);
      expect(isErr(result)).toBe(true);
    });
  });

  describe('flatMap', () => {
    it('chains Ok results', () => {
      const result = flatMap(ok(10), (x) => ok(x + 5));
      expect(unwrap(result)).toBe(15);
    });

    it('short-circuits on Err', () => {
      const error = new Error('first');
      const result = flatMap(err(error), (x: number) => ok(x + 5));
      expect(isErr(result)).toBe(true);
    });
  });

  describe('tryCatch', () => {
    it('wraps successful async', async () => {
      const result = await tryCatch(async () => 42);
      expect(isOk(result)).toBe(true);
      expect(unwrap(result)).toBe(42);
    });

    it('catches async error', async () => {
      const result = await tryCatch(async () => {
        throw new Error('async fail');
      });
      expect(isErr(result)).toBe(true);
    });
  });

  describe('tryCatchSync', () => {
    it('wraps successful sync', () => {
      const result = tryCatchSync(() => 'ok');
      expect(unwrap(result)).toBe('ok');
    });

    it('catches sync error', () => {
      const result = tryCatchSync(() => {
        throw new Error('sync fail');
      });
      expect(isErr(result)).toBe(true);
    });

    it('wraps non-Error throws', () => {
      const result = tryCatchSync(() => {
        throw 'string error';
      });
      expect(isErr(result)).toBe(true);
      if (!result.ok) {
        expect(result.error.message).toBe('string error');
      }
    });
  });
});
