import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// 부수기와 다시 잡기가 겹친 상황을 실제 프로세스로 재현하기는 어렵다. 잠금이 쓰기 직전에
// 남의 것이 됐다고 알려주는 쪽으로 바꿔 끼운다
vi.mock('../../../src/core/file-lock.js', () => ({
  withFileLock: <T>(_lockPath: string, fn: (ctx: { stillMine: () => boolean }) => T): T =>
    fn({ stillMine: () => false }),
}));

const { ProjectMemoryStore } = await import('../../../src/memory/project-memory-store.js');
const { UserProfileStore } = await import('../../../src/memory/user-profile-store.js');

describe('잠금을 뺏긴 쓰기', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `gestalt-lock-lost-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"name":"test"}');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('memory.json을 쓰지 않고 던진다', () => {
    const store = new ProjectMemoryStore(dir);
    expect(() =>
      store.addSpec({ specId: 'x', goal: 'G', createdAt: '', sourceType: 'text' }),
    ).toThrow('메모리 잠금을 뺏겨서');
    expect(existsSync(join(dir, '.gestalt', 'memory.json'))).toBe(false);
  });

  it('profile.json을 쓰지 않고 던진다', () => {
    const profilePath = join(dir, 'profile.json');
    const store = new UserProfileStore(profilePath);
    expect(() => store.setPreference('k', 'v')).toThrow('프로필 잠금을 뺏겨서');
    expect(existsSync(profilePath)).toBe(false);
  });
});
