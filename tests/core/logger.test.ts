import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '../../src/core/logger.js';

// ─── Env isolation ──────────────────────────────────────────────────────────

let savedLevel: string | undefined;

beforeEach(() => {
  savedLevel = process.env['GESTALT_LOG_LEVEL'];
  delete process.env['GESTALT_LOG_LEVEL'];
});

afterEach(() => {
  if (savedLevel === undefined) {
    delete process.env['GESTALT_LOG_LEVEL'];
  } else {
    process.env['GESTALT_LOG_LEVEL'] = savedLevel;
  }
});

// ─── Helper: stderr spy ─────────────────────────────────────────────────────

function withStderrSpy(fn: (spy: ReturnType<typeof vi.spyOn>) => void): void {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    fn(spy);
  } finally {
    spy.mockRestore();
  }
}

// ─── 기본 출력 ──────────────────────────────────────────────────────────────

describe('logger — 기본 출력', () => {
  it('logger.info()는 stderr에 INFO 접두어로 출력한다', () => {
    withStderrSpy((spy) => {
      logger.info('test_event');
      expect(spy).toHaveBeenCalledOnce();
      const args = spy.mock.calls[0]!;
      expect(String(args[1])).toContain('INFO');
      expect(String(args[1])).toContain('test_event');
    });
  });

  it('logger.warn()은 stderr에 WARN 접두어로 출력한다', () => {
    withStderrSpy((spy) => {
      logger.warn('warn_event');
      expect(spy).toHaveBeenCalledOnce();
      const args = spy.mock.calls[0]!;
      expect(String(args[1])).toContain('WARN');
      expect(String(args[1])).toContain('warn_event');
    });
  });

  it('logger.error()는 stderr에 ERROR 접두어로 출력한다', () => {
    withStderrSpy((spy) => {
      logger.error('error_event');
      expect(spy).toHaveBeenCalledOnce();
      const args = spy.mock.calls[0]!;
      expect(String(args[1])).toContain('ERROR');
      expect(String(args[1])).toContain('error_event');
    });
  });
});

// ─── 컨텍스트 직렬화 ────────────────────────────────────────────────────────

describe('logger — 컨텍스트 직렬화', () => {
  it('컨텍스트가 있으면 JSON 문자열로 직렬화된다', () => {
    withStderrSpy((spy) => {
      logger.info('event', { module: 'test', sessionId: 'abc' });
      expect(spy).toHaveBeenCalledOnce();
      const args = spy.mock.calls[0]!;
      // log()가 (prefix, serialized) 형태로 호출하므로 args[2]에 JSON
      const jsonStr = String(args[2]);
      expect(jsonStr).toContain('"module"');
      expect(jsonStr).toContain('"test"');
      expect(jsonStr).toContain('"sessionId"');
      expect(jsonStr).toContain('"abc"');
    });
  });

  it('undefined 값은 컨텍스트에서 제거된다', () => {
    withStderrSpy((spy) => {
      logger.info('event', { module: 'test', taskId: undefined });
      const args = spy.mock.calls[0]!;
      const jsonStr = String(args[2]);
      expect(jsonStr).not.toContain('taskId');
    });
  });

  it('빈 컨텍스트(undefined만)는 JSON 인수 없이 출력한다', () => {
    withStderrSpy((spy) => {
      logger.info('event', { taskId: undefined });
      expect(spy).toHaveBeenCalledOnce();
      const args = spy.mock.calls[0]!;
      // JSON 직렬화 인수가 없어야 함 (args length = 2: '[gestalt]', 'INFO event')
      expect(args.length).toBe(2);
    });
  });

  it('컨텍스트 없이 호출하면 접두어만 출력한다', () => {
    withStderrSpy((spy) => {
      logger.info('bare_event');
      const args = spy.mock.calls[0]!;
      expect(args.length).toBe(2);
    });
  });
});

// ─── 레벨 필터링 ────────────────────────────────────────────────────────────

describe('logger — 레벨 필터링 (GESTALT_LOG_LEVEL)', () => {
  it('GESTALT_LOG_LEVEL=warn이면 debug, info는 출력하지 않는다', () => {
    process.env['GESTALT_LOG_LEVEL'] = 'warn';
    withStderrSpy((spy) => {
      logger.debug('debug_event');
      logger.info('info_event');
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it('GESTALT_LOG_LEVEL=warn이면 warn, error는 출력한다', () => {
    process.env['GESTALT_LOG_LEVEL'] = 'warn';
    withStderrSpy((spy) => {
      logger.warn('warn_event');
      logger.error('error_event');
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });

  it('GESTALT_LOG_LEVEL=error이면 error만 출력한다', () => {
    process.env['GESTALT_LOG_LEVEL'] = 'error';
    withStderrSpy((spy) => {
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  it('GESTALT_LOG_LEVEL=debug이면 모든 레벨을 출력한다', () => {
    process.env['GESTALT_LOG_LEVEL'] = 'debug';
    withStderrSpy((spy) => {
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');
      expect(spy).toHaveBeenCalledTimes(4);
    });
  });

  it('기본값(env 없음)은 info이므로 debug는 출력하지 않는다', () => {
    withStderrSpy((spy) => {
      logger.debug('debug_event');
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it('기본값(env 없음)은 info이므로 info는 출력한다', () => {
    withStderrSpy((spy) => {
      logger.info('info_event');
      expect(spy).toHaveBeenCalledOnce();
    });
  });

  it('유효하지 않은 레벨은 info로 폴백한다', () => {
    process.env['GESTALT_LOG_LEVEL'] = 'INVALID';
    withStderrSpy((spy) => {
      logger.debug('d');
      logger.info('i');
      expect(spy).toHaveBeenCalledTimes(1); // info만
    });
  });
});

// ─── logger 메서드 존재 확인 ────────────────────────────────────────────────

describe('logger — 인터페이스', () => {
  it('debug, info, warn, error 메서드가 모두 존재한다', () => {
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });

  it('각 메서드는 void를 반환한다', () => {
    withStderrSpy(() => {
      expect(logger.info('x')).toBeUndefined();
      expect(logger.warn('x')).toBeUndefined();
      expect(logger.error('x')).toBeUndefined();
    });
  });
});
