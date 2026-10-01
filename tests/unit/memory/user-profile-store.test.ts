import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { UserProfileStore } from '../../../src/memory/user-profile-store.js';

describe('UserProfileStore', () => {
  let tmpProfilePath: string;
  let store: UserProfileStore;

  beforeEach(() => {
    const dir = join(tmpdir(), `gestalt-profile-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    tmpProfilePath = join(dir, 'profile.json');
    store = new UserProfileStore(tmpProfilePath);
  });

  afterEach(() => {
    const dir = join(tmpProfilePath, '..');
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty profile when no file exists', () => {
    const profile = store.read();
    expect(profile.crossRepoPatterns).toHaveLength(0);
    expect(profile.personalPreferences).toEqual({});
    expect(profile.preferredModel).toBeUndefined();
  });

  it('sets and reads a preference', () => {
    store.setPreference('theme', 'dark');
    const profile = store.read();
    expect(profile.personalPreferences['theme']).toBe('dark');
  });

  it('sets preferred model', () => {
    store.setPreferredModel('claude-opus-4-6');
    const profile = store.read();
    expect(profile.preferredModel).toBe('claude-opus-4-6');
  });

  it('sets userId', () => {
    store.setUserId('user-123');
    const profile = store.read();
    expect(profile.userId).toBe('user-123');
  });

  it('adds cross-repo patterns without duplicates', () => {
    store.addCrossRepoPattern('use-typescript');
    store.addCrossRepoPattern('use-pnpm');
    store.addCrossRepoPattern('use-typescript');

    const profile = store.read();
    expect(profile.crossRepoPatterns).toHaveLength(2);
    expect(profile.crossRepoPatterns).toContain('use-typescript');
    expect(profile.crossRepoPatterns).toContain('use-pnpm');
  });

  it('merges partial updates', () => {
    store.setPreference('lang', 'ko');
    store.addCrossRepoPattern('pattern-a');

    store.merge({
      preferredModel: 'claude-haiku-4-5',
      crossRepoPatterns: ['pattern-b'],
      personalPreferences: { editor: 'neovim' },
    });

    const profile = store.read();
    expect(profile.preferredModel).toBe('claude-haiku-4-5');
    expect(profile.crossRepoPatterns).toContain('pattern-a');
    expect(profile.crossRepoPatterns).toContain('pattern-b');
    expect(profile.personalPreferences['lang']).toBe('ko');
    expect(profile.personalPreferences['editor']).toBe('neovim');
  });

  it('updatedAt changes on write', () => {
    const before = new Date().toISOString();
    store.setPreference('key', 'val');
    const profile = store.read();
    expect(profile.updatedAt >= before).toBe(true);
  });
  it('깨진 profile.json은 백업하고 다음 쓰기가 기존 기록을 덮지 않는다', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = join(tmpProfilePath, '..');
    writeFileSync(tmpProfilePath, '{"crossRepoPatterns": [', 'utf-8');

    store.setPreference('lang', 'ko');

    const backups = readdirSync(dir).filter((n) => n.startsWith('profile.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dir, backups[0]!), 'utf-8')).toBe('{"crossRepoPatterns": [');
    expect(store.read().personalPreferences['lang']).toBe('ko');
    vi.restoreAllMocks();
  });

  it('쓰고 나면 임시 파일과 잠금이 안 남는다', () => {
    store.setPreference('key', 'val');
    expect(readdirSync(join(tmpProfilePath, '..'))).toEqual(['profile.json']);
  });
});
