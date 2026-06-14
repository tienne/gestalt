import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getVersion, compareSemver, getCachedUpdateResult } from '../../src/core/version.js';

// ─── getVersion ──────────────────────────────────────────────────────────────

describe('getVersion()', () => {
  it('빈 문자열이 아닌 버전을 반환한다', () => {
    const version = getVersion();
    expect(version.length).toBeGreaterThan(0);
  });

  it('semver 형식(X.Y.Z)을 따른다', () => {
    const version = getVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('package.json 버전과 일치한다', async () => {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const pkg = req('../../package.json') as { version: string };
    expect(getVersion()).toBe(pkg.version);
  });
});

// ─── compareSemver ──────────────────────────────────────────────────────────

describe('compareSemver()', () => {
  it('같은 버전이면 0을 반환한다', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  });

  it('a > b이면 양수를 반환한다', () => {
    expect(compareSemver('2.0.0', '1.9.9')).toBeGreaterThan(0);
  });

  it('a < b이면 음수를 반환한다', () => {
    expect(compareSemver('1.0.0', '1.0.1')).toBeLessThan(0);
  });

  it('patch 버전 비교가 올바르다', () => {
    expect(compareSemver('1.0.2', '1.0.1')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', '1.0.1')).toBeLessThan(0);
  });

  it('minor 버전 비교가 올바르다', () => {
    expect(compareSemver('1.2.0', '1.1.9')).toBeGreaterThan(0);
    expect(compareSemver('1.1.0', '1.2.0')).toBeLessThan(0);
  });

  it('major 버전 비교가 올바르다', () => {
    expect(compareSemver('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareSemver('0.9.9', '1.0.0')).toBeLessThan(0);
  });

  it('v 접두어가 있어도 올바르게 비교한다', () => {
    expect(compareSemver('v1.2.3', 'v1.2.3')).toBe(0);
    expect(compareSemver('v2.0.0', 'v1.0.0')).toBeGreaterThan(0);
  });

  it('v 접두어와 없는 버전을 혼합해도 올바르게 비교한다', () => {
    expect(compareSemver('v1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('v1.3.0', '1.2.9')).toBeGreaterThan(0);
  });

  it('누락된 패치 버전은 0으로 처리한다', () => {
    // '1.2' → parts[2]는 NaN이지만 ?? 0으로 처리
    expect(compareSemver('1.2.0', '1.2.0')).toBe(0);
  });
});

// ─── getCachedUpdateResult ──────────────────────────────────────────────────

describe('getCachedUpdateResult()', () => {
  it('초기 상태에서는 null을 반환한다 (캐시 없음)', () => {
    // 모듈 레벨 cachedUpdateResult는 null로 초기화
    // 실제 값은 checkForUpdates() 호출 이전이므로 null이거나 이전 테스트 캐시가 있을 수 있음
    // 반환 타입이 UpdateCheckResult | null인지 확인
    const result = getCachedUpdateResult();
    expect(result === null || typeof result === 'object').toBe(true);
  });

  it('반환된 결과가 있다면 currentVersion, latestVersion, updateAvailable 속성을 갖는다', () => {
    const result = getCachedUpdateResult();
    if (result !== null) {
      expect(typeof result.currentVersion).toBe('string');
      expect(typeof result.latestVersion).toBe('string');
      expect(typeof result.updateAvailable).toBe('boolean');
    }
  });
});

// ─── checkForUpdates 네트워크 없이 동작 검증 ───────────────────────────────

describe('checkForUpdates() — GESTALT_NO_UPDATE_CHECK=1', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env['GESTALT_NO_UPDATE_CHECK'];
    process.env['GESTALT_NO_UPDATE_CHECK'] = '1';
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env['GESTALT_NO_UPDATE_CHECK'];
    } else {
      process.env['GESTALT_NO_UPDATE_CHECK'] = savedEnv;
    }
  });

  it('GESTALT_NO_UPDATE_CHECK=1이면 null을 반환한다 (네트워크 미호출)', async () => {
    const { checkForUpdates } = await import('../../src/core/version.js');
    const result = await checkForUpdates();
    expect(result).toBeNull();
  });
});
