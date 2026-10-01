import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import {
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { UserProfileStore } from '../../../src/memory/user-profile-store.js';

const STORE_MODULE_URL = new URL('../../../src/memory/user-profile-store.ts', import.meta.url).href;
const TSX_BIN = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url));

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
    vi.restoreAllMocks();
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
  });

  it('profile.json은 본인만 읽을 수 있게 쓴다', () => {
    store.setUserId('user-123');
    expect(statSync(tmpProfilePath).mode & 0o777).toBe(0o600);
  });

  it('여러 프로세스가 동시에 기록해도 항목이 안 사라진다', async () => {
    const dir = join(tmpProfilePath, '..');
    const script = join(dir, 'add-patterns.mjs');
    writeFileSync(
      script,
      `const { UserProfileStore } = await import(${JSON.stringify(STORE_MODULE_URL)});\n` +
        `const store = new UserProfileStore(process.argv[2]);\n` +
        `for (let i = 0; i < 15; i++) store.addCrossRepoPattern(process.argv[3] + '-' + i);\n`,
      'utf-8',
    );

    const workers = ['a', 'b', 'c', 'd'];
    await Promise.all(
      workers.map((w) => promisify(execFile)(TSX_BIN, [script, tmpProfilePath, w])),
    );

    expect(store.read().crossRepoPatterns).toHaveLength(workers.length * 15);
  }, 60_000);

  it('쓰고 나면 임시 파일과 잠금이 안 남는다', () => {
    store.setPreference('key', 'val');
    expect(readdirSync(join(tmpProfilePath, '..'))).toEqual(['profile.json']);
  });
});
