import { log } from './log.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  module?: string;
  sessionId?: string;
  taskId?: string;
  durationMs?: number;
  [k: string]: unknown;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * GESTALT_LOG_LEVEL 환경변수로 출력 레벨을 제어한다. 기본값 'info'.
 * 유효하지 않은 값이면 'info'로 폴백.
 */
function getConfiguredLevel(): LogLevel {
  const raw = process.env.GESTALT_LOG_LEVEL?.toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw;
  }
  return 'info';
}

/**
 * undefined 값을 제거한 컨텍스트를 JSON 문자열로 직렬화한다.
 * 컨텍스트가 비어 있으면 undefined 반환.
 */
function serializeContext(ctx?: LogContext): string | undefined {
  if (!ctx) return undefined;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ctx)) {
    if (value !== undefined) {
      cleaned[key] = value;
    }
  }
  if (Object.keys(cleaned).length === 0) return undefined;
  return JSON.stringify(cleaned);
}

/**
 * 구조화 로그를 stderr(log() 경유)로 출력한다.
 * 설정 레벨보다 낮은 레벨은 무시된다.
 */
function emit(level: LogLevel, event: string, ctx?: LogContext): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[getConfiguredLevel()]) return;

  const prefix = `${level.toUpperCase()} ${event}`;
  const serialized = serializeContext(ctx);
  if (serialized) {
    log(prefix, serialized);
  } else {
    log(prefix);
  }
}

export const logger = {
  debug(event: string, ctx?: LogContext): void {
    emit('debug', event, ctx);
  },
  info(event: string, ctx?: LogContext): void {
    emit('info', event, ctx);
  },
  warn(event: string, ctx?: LogContext): void {
    emit('warn', event, ctx);
  },
  error(event: string, ctx?: LogContext): void {
    emit('error', event, ctx);
  },
};
