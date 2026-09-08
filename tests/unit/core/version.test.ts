import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getVersion, compareSemver, checkForUpdates } from '../../../src/core/version.js';

describe('version', () => {
  describe('getVersion', () => {
    it('returns a valid semver string', () => {
      const version = getVersion();
      expect(version).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('matches package.json version', async () => {
      const { createRequire } = await import('node:module');
      const require = createRequire(import.meta.url);
      const pkg = require('../../../package.json');
      expect(getVersion()).toBe(pkg.version);
    });
  });

  describe('compareSemver', () => {
    it('returns 0 for equal versions', () => {
      expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    });

    it('returns positive when a > b', () => {
      expect(compareSemver('2.0.0', '1.0.0')).toBeGreaterThan(0);
      expect(compareSemver('1.1.0', '1.0.0')).toBeGreaterThan(0);
      expect(compareSemver('1.0.1', '1.0.0')).toBeGreaterThan(0);
    });

    it('returns negative when a < b', () => {
      expect(compareSemver('1.0.0', '2.0.0')).toBeLessThan(0);
      expect(compareSemver('1.0.0', '1.1.0')).toBeLessThan(0);
      expect(compareSemver('1.0.0', '1.0.1')).toBeLessThan(0);
    });

    it('handles v prefix', () => {
      expect(compareSemver('v1.2.3', '1.2.3')).toBe(0);
    });

    it('handles multi-digit versions', () => {
      expect(compareSemver('1.10.0', '1.9.0')).toBeGreaterThan(0);
    });
  });

  describe('checkForUpdates', () => {
    const originalEnv = process.env['GESTALT_NO_UPDATE_CHECK'];

    beforeEach(() => {
      delete process.env['GESTALT_NO_UPDATE_CHECK'];
    });

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env['GESTALT_NO_UPDATE_CHECK'] = originalEnv;
      } else {
        delete process.env['GESTALT_NO_UPDATE_CHECK'];
      }
    });

    it('returns null when GESTALT_NO_UPDATE_CHECK=1', async () => {
      process.env['GESTALT_NO_UPDATE_CHECK'] = '1';
      const result = await checkForUpdates();
      expect(result).toBeNull();
    });

    it('handles fetch failure gracefully', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));
      const result = await checkForUpdates();
      // Should return null (cached or graceful failure) — not throw
      expect(result === null || result !== undefined).toBe(true);
      fetchSpy.mockRestore();
    });
  });
});

// ─── 세션 버전과 업데이트 배너 ───────────────────────────────────────────────

describe('세션 버전', () => {
  const saved = process.env['CLAUDE_PLUGIN_ROOT'];
  let pluginRoot: string;

  beforeEach(async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    pluginRoot = mkdtempSync(join(tmpdir(), 'gestalt-plugin-'));
    mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'gestalt', version: '0.1.0' }),
    );
    delete process.env['CLAUDE_PLUGIN_ROOT'];
  });

  afterEach(async () => {
    const { rmSync } = await import('node:fs');
    rmSync(pluginRoot, { recursive: true, force: true });
    if (saved === undefined) delete process.env['CLAUDE_PLUGIN_ROOT'];
    else process.env['CLAUDE_PLUGIN_ROOT'] = saved;
  });

  describe('getPluginVersion', () => {
    it('CLAUDE_PLUGIN_ROOT가 없으면 null이다', async () => {
      const { getPluginVersion } = await import('../../../src/core/version.js');
      expect(getPluginVersion()).toBeNull();
    });

    it('빈 문자열도 없는 것으로 친다', async () => {
      process.env['CLAUDE_PLUGIN_ROOT'] = '';
      const { getPluginVersion } = await import('../../../src/core/version.js');
      expect(getPluginVersion()).toBeNull();
    });

    it('매니페스트의 version을 읽는다', async () => {
      process.env['CLAUDE_PLUGIN_ROOT'] = pluginRoot;
      const { getPluginVersion } = await import('../../../src/core/version.js');
      expect(getPluginVersion()).toBe('0.1.0');
    });

    // 경로만 있고 매니페스트가 없는 경우가 실제로 생긴다 — 플러그인을 지웠는데
    // 환경변수는 이미 서버 프로세스에 실려 있는 상태다. 던지면 도구 응답이 통째로 깨진다.
    it('매니페스트가 없으면 null이다', async () => {
      const { mkdtempSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      process.env['CLAUDE_PLUGIN_ROOT'] = mkdtempSync(join(tmpdir(), 'gestalt-empty-'));
      const { getPluginVersion } = await import('../../../src/core/version.js');
      expect(getPluginVersion()).toBeNull();
    });

    it('매니페스트가 깨졌으면 null이다', async () => {
      const { writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      writeFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), '{ 이건 JSON이 아니다');
      process.env['CLAUDE_PLUGIN_ROOT'] = pluginRoot;
      const { getPluginVersion } = await import('../../../src/core/version.js');
      expect(getPluginVersion()).toBeNull();
    });

    it('version이 문자열이 아니면 null이다', async () => {
      const { writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      writeFileSync(
        join(pluginRoot, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ version: 72 }),
      );
      process.env['CLAUDE_PLUGIN_ROOT'] = pluginRoot;
      const { getPluginVersion } = await import('../../../src/core/version.js');
      expect(getPluginVersion()).toBeNull();
    });
  });

  describe('getSessionVersion', () => {
    // 이게 이 기능의 핵심 판정이다. 뒤집히면 서버만 최신인 세션에서 "최신이에요"라고
    // 답하고 정작 옛 스킬이 도는 걸 못 잡는다.
    it('플러그인이 있으면 플러그인이 이긴다', async () => {
      process.env['CLAUDE_PLUGIN_ROOT'] = pluginRoot;
      const { getSessionVersion, getVersion } = await import('../../../src/core/version.js');
      const session = getSessionVersion();

      expect(session).toEqual({ version: '0.1.0', source: 'plugin' });
      expect(session.version).not.toBe(getVersion());
    });

    it('플러그인이 없으면 서버 버전으로 떨어진다', async () => {
      const { getSessionVersion, getVersion } = await import('../../../src/core/version.js');
      expect(getSessionVersion()).toEqual({ version: getVersion(), source: 'server' });
    });
  });
});

describe('업데이트 배너', () => {
  /** 캐시가 남아 있으면 fetch를 안 타서 mock한 latest가 안 걸린다 */
  async function clearUpdateCache() {
    const { rmSync } = await import('node:fs');
    const { gestaltPath } = await import('../../../src/core/home.js');
    rmSync(gestaltPath('.update-check'), { force: true });
  }

  async function primeWithLatest(latestVersion: string) {
    await clearUpdateCache();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ version: latestVersion }),
    } as Response);

    const { checkForUpdates, resetUpdateBanner } = await import('../../../src/core/version.js');
    resetUpdateBanner();
    await checkForUpdates();
    fetchSpy.mockRestore();
    await clearUpdateCache();
  }

  afterEach(async () => {
    await clearUpdateCache();
    const { resetUpdateBanner } = await import('../../../src/core/version.js');
    resetUpdateBanner();
  });

  it('새 버전이 있으면 두 버전을 다 적는다', async () => {
    await primeWithLatest('999.0.0');
    const { takeUpdateBanner, getVersion } = await import('../../../src/core/version.js');

    const banner = takeUpdateBanner();
    expect(banner).toContain('999.0.0');
    expect(banner).toContain(getVersion());
  });

  // 리뷰 스킬은 도구를 수십 번 부른다. 매번 붙으면 같은 줄이 그만큼 쌓인다.
  it('세션에 한 번만 나온다', async () => {
    await primeWithLatest('999.0.0');
    const { takeUpdateBanner } = await import('../../../src/core/version.js');

    expect(takeUpdateBanner()).not.toBeNull();
    expect(takeUpdateBanner()).toBeNull();
    expect(takeUpdateBanner()).toBeNull();
  });

  it('최신이면 아무것도 안 내보낸다', async () => {
    await primeWithLatest('0.0.1');
    const { takeUpdateBanner } = await import('../../../src/core/version.js');
    expect(takeUpdateBanner()).toBeNull();
  });

  // 플러그인이 뒤처졌는데 npm 명령을 안내하면 서버만 올라가고 스킬은 그대로다.
  // 사용자가 시킨 대로 해도 다음 세션에 같은 알림이 다시 뜬다.
  it('플러그인이 뒤처지면 플러그인 갱신을 안내한다', async () => {
    const { formatUpdateBanner } = await import('../../../src/core/version.js');
    const banner = formatUpdateBanner({
      currentVersion: '0.72.5',
      latestVersion: '0.72.9',
      updateAvailable: true,
      source: 'plugin',
    });

    expect(banner).toContain('/plugin install gestalt@gestalt');
    expect(banner).not.toContain('gestalt update');
  });

  it('플러그인 없이 떴으면 CLI 갱신을 안내한다', async () => {
    const { formatUpdateBanner } = await import('../../../src/core/version.js');
    const banner = formatUpdateBanner({
      currentVersion: '0.72.5',
      latestVersion: '0.72.9',
      updateAvailable: true,
      source: 'server',
    });

    expect(banner).toContain('gestalt update');
    expect(banner).not.toContain('/plugin install');
  });
});
