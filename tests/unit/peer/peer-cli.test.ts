import { describe, expect, it, vi } from 'vitest';
import { makeStopHandler } from '../../../src/cli/commands/peer.js';

const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('makeStopHandler', () => {
  it('정리가 끝나면 0으로 끝낸다', async () => {
    const exit = vi.fn();
    const logErr = vi.fn();
    makeStopHandler({ stop: () => Promise.resolve() }, exit, logErr)();
    await settle();
    expect(exit.mock.calls).toEqual([[0]]);
    expect(logErr).not.toHaveBeenCalled();
  });

  it('정리가 실패하면 메시지를 남기고 1로 끝낸다', async () => {
    const exit = vi.fn();
    const logErr = vi.fn();
    makeStopHandler({ stop: () => Promise.reject(new Error('socket busy')) }, exit, logErr)();
    await settle();
    expect(logErr.mock.calls).toEqual([['socket busy']]);
    expect(exit.mock.calls).toEqual([[1]]);
  });

  it('정리 중에 한 번 더 부르면 기다리지 않고 1로 끝내고 정리는 다시 안 부른다', () => {
    const exit = vi.fn();
    const stop = vi.fn(() => new Promise<void>(() => {}));
    const handler = makeStopHandler({ stop }, exit, vi.fn());
    handler();
    expect(exit).not.toHaveBeenCalled();
    handler();
    expect(exit.mock.calls).toEqual([[1]]);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
