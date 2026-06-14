import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { log } from '../../src/core/log.js';

describe('log()', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('console.error를 호출한다 (stdout이 아닌 stderr)', () => {
    log('hello');
    expect(stderrSpy).toHaveBeenCalledOnce();
  });

  it('[gestalt] 접두어를 포함하여 출력한다', () => {
    log('world');
    expect(stderrSpy).toHaveBeenCalledWith('[gestalt]', 'world');
  });

  it('여러 인수를 전달한다', () => {
    log('key', 'value', 42);
    expect(stderrSpy).toHaveBeenCalledWith('[gestalt]', 'key', 'value', 42);
  });

  it('인수 없이 호출하면 접두어만 출력한다', () => {
    log();
    expect(stderrSpy).toHaveBeenCalledWith('[gestalt]');
  });

  it('객체를 인수로 전달해도 동작한다', () => {
    const obj = { a: 1 };
    log('ctx', obj);
    expect(stderrSpy).toHaveBeenCalledWith('[gestalt]', 'ctx', obj);
  });

  it('null, undefined도 전달한다', () => {
    log(null, undefined);
    expect(stderrSpy).toHaveBeenCalledWith('[gestalt]', null, undefined);
  });

  it('반환값은 void(undefined)다', () => {
    const result = log('test');
    expect(result).toBeUndefined();
  });
});
