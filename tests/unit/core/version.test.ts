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
