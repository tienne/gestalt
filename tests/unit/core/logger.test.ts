import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logger } from '../../../src/core/logger.js';

describe('logger', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const originalLevel = process.env.GESTALT_LOG_LEVEL;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    if (originalLevel === undefined) {
      delete process.env.GESTALT_LOG_LEVEL;
    } else {
      process.env.GESTALT_LOG_LEVEL = originalLevel;
    }
  });

  it('does not emit debug events when level is info', () => {
    process.env.GESTALT_LOG_LEVEL = 'info';
    logger.debug('debug.event', { module: 'test' });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('emits debug events when level is debug', () => {
    process.env.GESTALT_LOG_LEVEL = 'debug';
    logger.debug('debug.event', { module: 'test' });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('emits info events via console.error (stderr) with [gestalt] prefix', () => {
    process.env.GESTALT_LOG_LEVEL = 'info';
    logger.info('info.event', { module: 'interview' });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const args = errorSpy.mock.calls[0]!;
    expect(args[0]).toBe('[gestalt]');
    expect(args[1]).toBe('INFO info.event');
  });

  it('serializes context fields as JSON', () => {
    process.env.GESTALT_LOG_LEVEL = 'info';
    logger.info('spec.generated', { module: 'spec', sessionId: 'abc-123' });
    const args = errorSpy.mock.calls[0]!;
    const json = args[2] as string;
    expect(JSON.parse(json)).toEqual({ module: 'spec', sessionId: 'abc-123' });
  });

  it('omits undefined fields from serialized output', () => {
    process.env.GESTALT_LOG_LEVEL = 'info';
    logger.info('execute.task_completed', {
      module: 'execute',
      sessionId: 'sess-1',
      taskId: undefined,
      durationMs: undefined,
    });
    const args = errorSpy.mock.calls[0]!;
    const json = args[2] as string;
    const parsed = JSON.parse(json);
    expect(parsed).toEqual({ module: 'execute', sessionId: 'sess-1' });
    expect(parsed).not.toHaveProperty('taskId');
    expect(parsed).not.toHaveProperty('durationMs');
  });

  it('emits without context payload when no fields remain', () => {
    process.env.GESTALT_LOG_LEVEL = 'info';
    logger.warn('warn.event');
    const args = errorSpy.mock.calls[0]!;
    expect(args[0]).toBe('[gestalt]');
    expect(args[1]).toBe('WARN warn.event');
    expect(args[2]).toBeUndefined();
  });

  it('respects level ordering — warn suppressed at error level', () => {
    process.env.GESTALT_LOG_LEVEL = 'error';
    logger.warn('warn.event', { module: 'test' });
    expect(errorSpy).not.toHaveBeenCalled();
    logger.error('error.event', { module: 'test' });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to info level for invalid GESTALT_LOG_LEVEL', () => {
    process.env.GESTALT_LOG_LEVEL = 'verbose';
    logger.debug('debug.event');
    expect(errorSpy).not.toHaveBeenCalled();
    logger.info('info.event');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
